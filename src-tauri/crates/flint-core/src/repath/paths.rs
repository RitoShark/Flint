//! Asset-path parsing, normalisation and prefix rewriting.

use crate::bin::codec::read_bin;
use crate::error::{Error, Result};
use ritoshark::bin::BinValue;
use std::fs;
use std::path::Path;
use super::refather::{AssetPath, RepathConfig};
pub(crate) fn scan_bin_for_paths(bin_path: &Path) -> Result<Vec<String>> {
    let data = fs::read(bin_path).map_err(|e| Error::io_with_path(e, bin_path))?;

    let bin = read_bin(&data)
        .map_err(|e| Error::InvalidInput(format!("Failed to parse BIN: {}", e)))?;

    let mut paths = Vec::new();

    for entry in &bin.entries {
        for value in entry.fields.values() {
            collect_paths_from_value(value, &mut paths);
        }
    }

    Ok(paths)
}

pub(crate) fn collect_paths_from_value(value: &BinValue, paths: &mut Vec<String>) {
    match value {
        BinValue::String(s) => {
            if is_asset_path(s) {
                paths.push(normalize_path(s));
            }
        }
        BinValue::File(hash) => {
            let known = flint_hash::hash::get_cached_bin_hashes().read();
            if let Some(s) = known.get(*hash) {
                if is_asset_path(s) {
                    paths.push(normalize_path(s));
                }
            }
        }
        BinValue::List { items, .. } => {
            for item in items {
                collect_paths_from_value(item, paths);
            }
        }
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for v in fields.values() {
                collect_paths_from_value(v, paths);
            }
        }
        BinValue::Option { value: Some(inner), .. } => {
            collect_paths_from_value(inner, paths);
        }
        BinValue::Map { entries, .. } => {
            for (key, val) in entries {
                collect_paths_from_value(key, paths);
                collect_paths_from_value(val, paths);
            }
        }
        _ => {}
    }
}

pub(crate) fn is_asset_path(s: &str) -> bool {
    if s.len() < 5 {
        return false;
    }

    (s.len() >= 7 && s[..7].eq_ignore_ascii_case("assets/")) ||
    (s.len() >= 5 && s[..5].eq_ignore_ascii_case("data/"))
}

/// Lowercase with forward slashes.
pub(crate) fn normalize_path(s: &str) -> String {
    s.to_lowercase().replace('\\', "/")
}

/// Find the byte index where a `particles/` path segment begins (case-insensitive).
/// A segment match requires `particles/` to be at the start of `subpath` or
/// immediately preceded by `/` (so `myparticles/x` does NOT match).
pub(crate) fn particles_segment_start(subpath: &str) -> Option<usize> {
    let lower = subpath.to_lowercase();
    let needle = "particles/";
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(needle) {
        let idx = from + rel;
        if idx == 0 || lower.as_bytes()[idx - 1] == b'/' {
            return Some(idx);
        }
        from = idx + 1;
    }
    None
}

pub(crate) fn apply_prefix_to_path(path: &str, _prefix: &str, config: &RepathConfig) -> String {
    if let Some(asset_path) = AssetPath::parse(path, &config.champion, &config.sub_characters) {
        asset_path.to_repathed(config)
    } else {
        tracing::warn!("Invalid asset path (no assets/ or data/ prefix): {}", path);
        path.to_string()
    }
}

pub(crate) fn strip_skin_layout(subpath: &str, target_skin_id: u32) -> String {
    let after_skins = AssetPath::strip_prefix_ignore_case(subpath, "skins/").unwrap_or(subpath);
    let without_skin_folder = strip_skin_folder(after_skins);
    let without_base = strip_base_folder(without_skin_folder);
    remap_animation_bin_filename(&without_base, target_skin_id)
}

/// Strips a leading `skin<digits>/`. Case-insensitive; League writes both spellings.
fn strip_skin_folder(path: &str) -> &str {
    let bytes = path.as_bytes();
    if bytes.len() <= 4 || !bytes[..4].eq_ignore_ascii_case(b"skin") {
        return path;
    }
    let end = 4 + bytes[4..].iter().take_while(|b| b.is_ascii_digit()).count();
    if end > 4 && bytes.get(end) == Some(&b'/') {
        &path[end + 1..]
    } else {
        path
    }
}

/// Strips a leading or mid-path `base/` folder. Case-insensitive.
pub(crate) fn strip_base_folder(path: &str) -> String {
    if path.len() >= 5 && path.as_bytes()[..5].eq_ignore_ascii_case(b"base/") {
        return path[5..].to_string();
    }

    let bytes = path.as_bytes();
    let mut out = String::with_capacity(path.len());
    let mut at = 0;
    while let Some(hit) = bytes[at..]
        .windows(6)
        .position(|w| w.eq_ignore_ascii_case(b"/base/"))
    {
        out.push_str(&path[at..at + hit]);
        out.push('/');
        at += hit + 6;
    }
    if at == 0 {
        return path.to_string();
    }
    out.push_str(&path[at..]);
    out
}

/// Remaps `animations/skinN.bin` → `animations/skin{target}.bin`; other paths unchanged.
pub(crate) fn remap_animation_bin_filename(path: &str, target_skin_id: u32) -> String {
    let lower = path.to_lowercase();

    if (lower.contains("/animations/skin") || lower.contains("animations/skin")) && lower.ends_with(".bin") {
        if let Some(last_slash) = path.rfind('/') {
            let dir = &path[..=last_slash];
            let filename = &path[last_slash + 1..];

            if filename.starts_with("skin") && filename.ends_with(".bin") {
                let without_ext = &filename[..filename.len() - 4];
                if without_ext.len() > 4 {
                    let number_part = &without_ext[4..];
                    if number_part.chars().all(|c| c.is_ascii_digit()) {
                        return format!("{}skin{}.bin", dir, target_skin_id);
                    }
                }
            }
        }
    }

    path.to_string()
}

pub(crate) fn replace_base_folder_in_animation_path(path: &str, _target_skin_id: u32) -> String {
    strip_base_folder(path)
}


#[cfg(test)]
mod scan_tests {
    use super::*;

    // These two replaced `(?i)^(skin)(\d+)(/)` and `(?i)/base/`. The cases below are the
    // ones where a hand-written scan and a pattern are easy to make disagree.

    #[test]
    fn strips_a_leading_skin_folder_in_either_spelling() {
        assert_eq!(strip_skin_folder("skin19/body.tex"), "body.tex");
        assert_eq!(strip_skin_folder("Skin19/body.tex"), "body.tex");
        assert_eq!(strip_skin_folder("SKIN0/x/y.tex"), "x/y.tex");
        assert_eq!(strip_skin_folder("skin7/"), "");
    }

    #[test]
    fn leaves_anything_that_is_not_a_skin_folder() {
        assert_eq!(strip_skin_folder("skins/skin19/body.tex"), "skins/skin19/body.tex");
        assert_eq!(strip_skin_folder("skin/body.tex"), "skin/body.tex");
        assert_eq!(strip_skin_folder("skin19body.tex"), "skin19body.tex");
        assert_eq!(strip_skin_folder("a/skin19/body.tex"), "a/skin19/body.tex");
        assert_eq!(strip_skin_folder("skin"), "skin");
        assert_eq!(strip_skin_folder(""), "");
    }

    #[test]
    fn strips_every_base_segment_not_just_the_first() {
        assert_eq!(strip_base_folder("a/base/b/Base/c.tex"), "a/b/c.tex");
        assert_eq!(strip_base_folder("base/"), "");
        assert_eq!(strip_base_folder("basement/x.tex"), "basement/x.tex");
        assert_eq!(strip_base_folder("a/basement/x.tex"), "a/basement/x.tex");
    }
}
