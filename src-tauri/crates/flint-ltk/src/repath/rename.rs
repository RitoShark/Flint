//! Hard-rename support: when a project is renamed, its asset prefix
//! `ASSETS/{creator}/{project}` changes its `{project}` segment everywhere — in
//! the path strings inside every BIN and in the on-disk asset folders. This
//! module does both.
//!
//! The `{project}` segment is matched in context (`ASSETS/<creator>/<old>/`) via
//! regex rather than assuming a creator, because the creator segment comes from
//! the global creator setting at refather time (not a per-project field) and may
//! have drifted. This makes the rename robust to whatever creator the project
//! was actually refathered with. The BIN read+write mirrors refather's
//! dual-engine (LTK / Jade) handling.

use crate::bin::ltk_bridge::{read_bin, write_bin};
use crate::error::{Error, Result};
use regex::Regex;
use ritoshark::bin::BinValue;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Recursively apply `re` (which rewrites `ASSETS/<creator>/<old>/` →
/// `ASSETS/<creator>/<new>/`) to every string value of a BIN value tree.
/// Mirrors the variant coverage of `refather::repath_value`.
fn replace_in_value(value: &mut BinValue, re: &Regex, replacement: &str) -> usize {
    let mut count = 0;
    match value {
        BinValue::String(s) => {
            if re.is_match(s) {
                let new = re.replace_all(s, replacement).into_owned();
                if new != *s {
                    *s = new;
                    count += 1;
                }
            }
        }
        BinValue::List { items, .. } => {
            for item in items.iter_mut() {
                count += replace_in_value(item, re, replacement);
            }
        }
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for v in fields.values_mut() {
                count += replace_in_value(v, re, replacement);
            }
        }
        BinValue::Option { value: Some(inner), .. } => {
            count += replace_in_value(inner, re, replacement);
        }
        BinValue::Map { entries, .. } => {
            for (k, v) in entries.iter_mut() {
                count += replace_in_value(k, re, replacement);
                count += replace_in_value(v, re, replacement);
            }
        }
        _ => {}
    }
    count
}

/// Outcome of a hard rename.
#[derive(Debug, Default, Clone)]
pub struct RenameResult {
    pub bins_changed: usize,
    pub strings_changed: usize,
    pub folders_renamed: usize,
    /// BIN files that couldn't be parsed and were skipped (may still reference
    /// the old name — surfaced so the caller can warn).
    pub skipped_bins: Vec<String>,
}

/// Read a BIN as a tree using the LTK engine, falling back to Jade.
fn read_bin_any(data: &[u8]) -> Result<(ritoshark::bin::Bin, bool)> {
    match read_bin(data) {
        Ok(bin) => Ok((bin, false)),
        Err(_) => {
            let text = crate::bin::jade::convert_bin_to_text(data)
                .map_err(|e| Error::InvalidInput(format!("Jade parse failed: {}", e)))?;
            let bin = crate::bin::text_to_tree(&text)
                .map_err(|e| Error::InvalidInput(format!("Failed to parse Jade text: {}", e)))?;
            Ok((bin, true))
        }
    }
}

/// Serialize a BIN tree back to bytes with the engine it was read with.
fn write_bin_any(bin: &ritoshark::bin::Bin, used_jade: bool) -> Result<Vec<u8>> {
    if used_jade {
        let text = crate::bin::tree_to_text_cached(bin)
            .map_err(|e| Error::InvalidInput(format!("Failed to convert to text: {}", e)))?;
        crate::bin::jade::convert_text_to_bin(&text)
            .map_err(|e| Error::InvalidInput(format!("Jade write failed: {}", e)))
    } else {
        write_bin(bin).map_err(|e| Error::InvalidInput(format!("Failed to write BIN: {}", e)))
    }
}

/// Rewrite every `.bin` under `content_base`, applying the prefix regex.
fn rename_bin_prefix(content_base: &Path, re: &Regex, replacement: &str, result: &mut RenameResult) -> Result<()> {
    for entry in WalkDir::new(content_base).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.extension().map(|e| e.eq_ignore_ascii_case("bin")).unwrap_or(false) {
            continue;
        }
        let data = match fs::read(path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let (mut bin, used_jade) = match read_bin_any(&data) {
            Ok(v) => v,
            Err(_) => {
                result.skipped_bins.push(path.to_string_lossy().into_owned());
                continue;
            }
        };

        let mut n = 0;
        for e in bin.entries.iter_mut() {
            for (_name, value) in e.fields.iter_mut() {
                n += replace_in_value(value, re, replacement);
            }
        }

        if n > 0 {
            let out = write_bin_any(&bin, used_jade)?;
            fs::write(path, out).map_err(|e| Error::io_with_path(e, path))?;
            result.bins_changed += 1;
            result.strings_changed += n;
        }
    }
    Ok(())
}

/// Rename on-disk asset folders: any directory whose path matches
/// `.../ASSETS/<creator>/<old_seg>` (creator optional) → sibling `<new_seg>`.
fn rename_asset_folders(content_base: &Path, dir_re: &Regex, new_seg: &str, result: &mut RenameResult) -> Result<()> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(content_base).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_dir() {
            continue;
        }
        let norm = entry.path().to_string_lossy().replace('\\', "/");
        if dir_re.is_match(&norm) {
            candidates.push(entry.path().to_path_buf());
        }
    }

    for src in candidates {
        let dst = src.with_file_name(new_seg);
        if src.exists() && !dst.exists() {
            fs::rename(&src, &dst).map_err(|e| Error::io_with_path(e, &src))?;
            result.folders_renamed += 1;
        }
    }
    Ok(())
}

/// Rewrite a project's asset prefix `ASSETS/{creator}/{old_project}` →
/// `ASSETS/{creator}/{new_project}` inside every BIN under `content_base` and on
/// disk. Spaces in the names are converted to hyphens to match the refather
/// prefix convention; the creator segment is auto-detected.
pub fn rename_project_asset_prefix(content_base: &Path, old_project: &str, new_project: &str) -> Result<RenameResult> {
    let old_seg = old_project.replace(' ', "-");
    let new_seg = new_project.replace(' ', "-");

    let mut result = RenameResult::default();
    if old_seg.is_empty() || old_seg == new_seg {
        return Ok(result);
    }

    let esc = regex::escape(&old_seg);
    // String form: ASSETS/<creator?>/<old>/  →  capture the prefix up to <old>.
    let str_re = Regex::new(&format!(r"(?i)(ASSETS/(?:[^/]+/)?){}/", esc))
        .map_err(|e| Error::InvalidInput(format!("regex build failed: {}", e)))?;
    let replacement = format!("${{1}}{}/", new_seg);
    // Directory form: same, anchored at the path end (no trailing slash).
    let dir_re = Regex::new(&format!(r"(?i)/ASSETS/(?:[^/]+/)?{}$", esc))
        .map_err(|e| Error::InvalidInput(format!("regex build failed: {}", e)))?;

    rename_bin_prefix(content_base, &str_re, &replacement, &mut result)?;
    rename_asset_folders(content_base, &dir_re, &new_seg, &mut result)?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn re_for(old: &str) -> (Regex, String) {
        let esc = regex::escape(old);
        (
            Regex::new(&format!(r"(?i)(ASSETS/(?:[^/]+/)?){}/", esc)).unwrap(),
            "new-proj".to_string(),
        )
    }

    #[test]
    fn rewrites_with_creator() {
        let (re, _) = re_for("old-proj");
        let mut v = BinValue::String("ASSETS/Bob/old-proj/skin.dds".to_string());
        let n = replace_in_value(&mut v, &re, "${1}new-proj/");
        assert_eq!(n, 1);
        if let BinValue::String(s) = v {
            assert_eq!(s, "ASSETS/Bob/new-proj/skin.dds");
        } else {
            panic!();
        }
    }

    #[test]
    fn rewrites_case_insensitive_and_no_creator() {
        let (re, _) = re_for("old-proj");
        let mut v = BinValue::String("assets/old-proj/x.tex".to_string());
        let n = replace_in_value(&mut v, &re, "${1}new-proj/");
        assert_eq!(n, 1);
        if let BinValue::String(s) = v {
            assert!(s.to_lowercase().ends_with("new-proj/x.tex"));
        } else {
            panic!();
        }
    }

    #[test]
    fn leaves_unrelated_paths() {
        let (re, _) = re_for("old-proj");
        let mut v = BinValue::String("data/characters/ahri/x.bin".to_string());
        assert_eq!(replace_in_value(&mut v, &re, "${1}new-proj/"), 0);
    }

    #[test]
    fn dir_regex_matches_leaf_only() {
        let esc = regex::escape("old-proj");
        let dir_re = Regex::new(&format!(r"(?i)/ASSETS/(?:[^/]+/)?{}$", esc)).unwrap();
        assert!(dir_re.is_match("C:/p/content/x.wad.client/ASSETS/Bob/old-proj"));
        assert!(!dir_re.is_match("C:/p/content/x.wad.client/ASSETS/Bob/old-proj/particles"));
    }
}
