//! Per-file "compare" tools: find the original chunk in the user's League
//! installation, and manage local per-file backups under `.flint/backups/`.
//!
//! Original lookup tolerates the suffix churn that happens between patches —
//! e.g. `crazygood.ambessa.tex` becoming `crazygood.boba.tex` (or
//! `crazygood.tex` losing a suffix entirely). We match by:
//!   1. exact internal path (case-insensitive),
//!   2. same directory + same extension + same leading stem token,
//!      ranked by how many leading dot-separated tokens both filenames share.

use flint_ltk::hash::{HashResolver, ResolvedHashes};
use flint_ltk::wad_jade::adapter::WadHandle as WadReader;
use crate::state::{HashOverlayState, WadCacheState};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

/// Metadata describing what (if anything) we found in the original game files
/// for a given project file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OriginalFileMeta {
    /// Did we locate a chunk that plausibly corresponds to this file?
    pub found: bool,
    /// True when the matched chunk's path is byte-for-byte equal to the
    /// project file's internal path. False when fuzzy-matched across suffixes.
    pub exact: bool,
    /// Did we even find the WAD itself in the League install?
    pub wad_found: bool,
    /// Absolute path of the WAD we searched (None if not located).
    pub wad_path: Option<String>,
    /// Hex (16-char) hash of the matched chunk — feed this to
    /// `read_wad_chunk_data(wadPath, hash)` to read the bytes.
    pub matched_hash: Option<String>,
    /// The matched WAD-internal path (e.g. `data/.../crazygood.boba.tex`).
    pub matched_internal_path: Option<String>,
    /// The internal path we derived from the project file — surfaced so the UI
    /// can show "looked for X, found Y" in fuzzy matches.
    pub queried_internal_path: String,
    /// The WAD folder name we derived (e.g. `ambessa.wad.client`).
    pub queried_wad_name: String,
}

/// Parse a project-relative path and pull out the WAD folder name + the
/// WAD-internal path. Handles both layouts:
///   - `content/<wad>.wad.client/<rest>` (legacy)
///   - `content/<layer>/<wad>.wad.client/<rest>` (current — `base` is the
///     default layer, but mods can have multiple layers)
fn split_project_path(rel: &str) -> Option<(String, String)> {
    let normalized = rel.replace('\\', "/");
    let stripped = normalized.strip_prefix("content/")?;
    let segments: Vec<&str> = stripped.split('/').collect();
    let wad_idx = segments
        .iter()
        .position(|s| s.to_lowercase().ends_with(".wad.client"))?;
    if wad_idx + 1 >= segments.len() {
        return None;
    }
    let wad_folder = segments[wad_idx].to_string();
    let internal = segments[wad_idx + 1..].join("/");
    Some((wad_folder, internal))
}

/// Locate a WAD by filename inside a League installation. Searches
/// `Game/DATA/FINAL/**` for a case-insensitive match — covers Champions,
/// shared, maps, etc.
fn find_wad_in_league(league_path: &Path, wad_folder_name: &str) -> Option<PathBuf> {
    let wanted = wad_folder_name.to_lowercase();
    let roots = [
        league_path.join("Game").join("DATA").join("FINAL"),
        league_path.join("DATA").join("FINAL"),
    ];
    for root in roots.iter().filter(|p| p.exists()) {
        for entry in walkdir::WalkDir::new(root)
            .max_depth(5)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                if name.to_lowercase() == wanted {
                    return Some(entry.into_path());
                }
            }
        }
    }
    None
}

/// True if two extensions name the same on-disk asset family. Today this just
/// covers `.dds` ↔ `.tex` — old mods often stored textures as `.dds` while
/// the in-game asset is `.tex` (or vice versa), and the engine treats them
/// interchangeably.
fn ext_equivalent(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    matches!((a, b), ("dds", "tex") | ("tex", "dds"))
}

/// Swap a path's texture extension between `.dds` and `.tex`. Returns `None`
/// for any other extension.
fn swap_texture_ext(path_lower: &str) -> Option<String> {
    if let Some(stem) = path_lower.strip_suffix(".dds") {
        return Some(format!("{}.tex", stem));
    }
    if let Some(stem) = path_lower.strip_suffix(".tex") {
        return Some(format!("{}.dds", stem));
    }
    None
}

/// Score how well `candidate` matches `target`. Higher is better; `None`
/// means "no match at all". Cross-format texture matches (dds ↔ tex) are
/// allowed because old mods often ship the wrong container for what the
/// engine actually serves.
///
/// The scoring rule: split filename by `.`, compare leading tokens, return
/// how many shared tokens line up before the first divergence.
/// `crazygood.ambessa.tex` vs `crazygood.boba.tex` → 1 shared (`crazygood`).
/// `crazygood.tex` vs `crazygood.tex` → handled as `Some(usize::MAX)` here
/// for the cross-format case; the same-ext exact-match early return up the
/// call stack handles the byte-identical-path case before we get here.
fn fuzzy_filename_score(target: &str, candidate: &str) -> Option<usize> {
    let t = target.to_lowercase();
    let c = candidate.to_lowercase();
    if t == c {
        return Some(usize::MAX);
    }
    let t_path = Path::new(&t);
    let c_path = Path::new(&c);
    let t_ext = t_path.extension()?.to_str()?;
    let c_ext = c_path.extension()?.to_str()?;
    if !ext_equivalent(t_ext, c_ext) {
        return None;
    }
    let t_stem = t_path.file_stem()?.to_str()?;
    let c_stem = c_path.file_stem()?.to_str()?;
    // Cross-format full-stem equality is as good as a full-path match.
    if t_stem == c_stem {
        return Some(usize::MAX);
    }
    let t_tokens: Vec<&str> = t_stem.split('.').collect();
    let c_tokens: Vec<&str> = c_stem.split('.').collect();
    if t_tokens.first() != c_tokens.first() {
        return None;
    }
    let mut score = 0usize;
    for (a, b) in t_tokens.iter().zip(c_tokens.iter()) {
        if a == b {
            score += 1;
        } else {
            break;
        }
    }
    Some(score)
}

/// Pull the directory portion of an internal WAD path, normalized + lowered.
fn dir_of(p: &str) -> String {
    let lower = p.to_lowercase().replace('\\', "/");
    match lower.rfind('/') {
        Some(i) => lower[..i].to_string(),
        None => String::new(),
    }
}

fn file_of(p: &str) -> &str {
    match p.rfind(['/', '\\']) {
        Some(i) => &p[i + 1..],
        None => p,
    }
}

#[tauri::command]
pub async fn find_original_file(
    league_path: String,
    project_path: String,
    file_rel_path: String,
    hash_overlay_state: State<'_, HashOverlayState>,
    wad_cache_state: State<'_, WadCacheState>,
) -> Result<OriginalFileMeta, String> {
    let (wad_name, internal_path) = split_project_path(&file_rel_path)
        .ok_or_else(|| format!(
            "File '{}' isn't inside a content/<name>.wad.client/ folder — \
             nothing to compare against",
            file_rel_path
        ))?;

    let _ = project_path; // reserved — currently we only need the relative path

    let mut meta = OriginalFileMeta {
        found: false,
        exact: false,
        wad_found: false,
        wad_path: None,
        matched_hash: None,
        matched_internal_path: None,
        queried_internal_path: internal_path.clone(),
        queried_wad_name: wad_name.clone(),
    };

    let league = Path::new(&league_path);
    let wad_path = match find_wad_in_league(league, &wad_name) {
        Some(p) => p,
        None => return Ok(meta),
    };
    meta.wad_found = true;
    meta.wad_path = Some(wad_path.to_string_lossy().to_string());

    // Reuse the parsed-TOC cache so we don't re-parse the WAD on every compare.
    let cache = wad_cache_state.get();
    let wad_path_str = wad_path.to_string_lossy().into_owned();
    let chunks = if let Some(cached) = cache.get(&wad_path_str) {
        cached
    } else {
        let reader = WadReader::open(&wad_path_str)?;
        let chunks: Vec<_> = reader.chunks().iter().cloned().collect();
        let chunks = Arc::new(chunks);
        let _ = cache.insert(&wad_path_str, Arc::clone(&chunks));
        chunks
    };

    // Bulk-resolve all paths — project overlay first, then global LMDB.
    // `resolve_wad_bulk` is the rayon-parallel bulk path and omits misses
    // natively, so no hex-filter is needed to strip unresolved entries back
    // out.
    let hash_dir = flint_ltk::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let overlay = hash_overlay_state.get();
    let resolver = HashResolver::new(&hash_dir, overlay.as_ref());
    let hashes: Vec<u64> = chunks.iter().map(|c| c.path_hash).collect();
    let resolved: ResolvedHashes = resolver.resolve_wad_bulk(&hashes);

    let target_lower = internal_path.to_lowercase().replace('\\', "/");
    let target_swapped_ext = swap_texture_ext(&target_lower);
    let target_dir = dir_of(&target_lower);
    let target_file = file_of(&target_lower).to_string();
    let target_last_segment = target_dir.rsplit('/').next().unwrap_or("").to_string();

    // Composite score: (filename_score, dir_bonus). Larger is better.
    // We search by FILENAME across the whole WAD, because the project file's
    // directory has usually been repathed to `assets/<creator>/<project>/...`
    // and bears no resemblance to the original WAD-internal directory.
    // Dir bonus is just a tie-breaker when filenames are equally good — e.g.
    // both have the same `skin8/` trailing segment.
    let mut best: Option<(usize, u32, u64, String)> = None;
    for chunk in chunks.iter() {
        let h = chunk.path_hash;
        let Some(resolved_path) = resolved.get(&h) else { continue };
        let cand_lower = resolved_path.to_lowercase().replace('\\', "/");

        if cand_lower == target_lower
            || target_swapped_ext.as_deref() == Some(cand_lower.as_str())
        {
            meta.found = true;
            meta.exact = true;
            meta.matched_hash = Some(format!("{:016x}", h));
            meta.matched_internal_path = Some(resolved_path.to_string());
            return Ok(meta);
        }

        let cand_file = file_of(&cand_lower);
        let Some(name_score) = fuzzy_filename_score(&target_file, cand_file) else {
            continue;
        };

        let cand_dir = dir_of(&cand_lower);
        let mut dir_bonus: u32 = 0;
        if cand_dir == target_dir {
            // Same full directory (rare once repathing has happened).
            dir_bonus = 2;
        } else if !target_last_segment.is_empty() {
            // `skin8` etc. — strong hint when present.
            let cand_last = cand_dir.rsplit('/').next().unwrap_or("");
            if cand_last == target_last_segment {
                dir_bonus = 1;
            }
        }

        let take = match &best {
            None => true,
            Some((s, b, _, _)) => name_score > *s || (name_score == *s && dir_bonus > *b),
        };
        if take {
            best = Some((name_score, dir_bonus, h, resolved_path.to_string()));
        }
    }

    if let Some((_, _, h, p)) = best {
        meta.found = true;
        meta.exact = false;
        meta.matched_hash = Some(format!("{:016x}", h));
        meta.matched_internal_path = Some(p);
    }
    Ok(meta)
}

// ── Per-file backups ─────────────────────────────────────────────────────

/// Resolve `<project>/.flint/backups/<rel>` and refuse anything that escapes
/// the backups dir (defensive against `..` in user-supplied relative paths).
fn backup_path_for(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    let normalized = rel.replace('\\', "/");
    if normalized.split('/').any(|seg| seg == ".." || seg.is_empty()) {
        return Err("Invalid file path".to_string());
    }
    let root = Path::new(project_path).join(".flint").join("backups");
    Ok(root.join(normalized))
}

#[tauri::command]
pub async fn has_file_backup(
    project_path: String,
    file_rel_path: String,
) -> Result<bool, String> {
    let p = backup_path_for(&project_path, &file_rel_path)?;
    Ok(p.is_file())
}

#[tauri::command]
pub async fn create_file_backup(
    project_path: String,
    file_rel_path: String,
) -> Result<(), String> {
    let src = Path::new(&project_path).join(file_rel_path.replace('\\', "/"));
    if !src.is_file() {
        return Err(format!("File not found: {}", src.display()));
    }
    let dst = backup_path_for(&project_path, &file_rel_path)?;
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create backup dir: {}", e))?;
    }
    std::fs::copy(&src, &dst)
        .map_err(|e| format!("Failed to copy file to backup: {}", e))?;
    tracing::info!("Backed up {} → {}", src.display(), dst.display());
    Ok(())
}

#[tauri::command]
pub async fn read_file_backup(
    project_path: String,
    file_rel_path: String,
) -> Result<tauri::ipc::Response, String> {
    let p = backup_path_for(&project_path, &file_rel_path)?;
    if !p.is_file() {
        return Err(format!("No backup found for {}", file_rel_path));
    }
    let bytes = std::fs::read(&p)
        .map_err(|e| format!("Failed to read backup: {}", e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn delete_file_backup(
    project_path: String,
    file_rel_path: String,
) -> Result<(), String> {
    let p = backup_path_for(&project_path, &file_rel_path)?;
    if p.is_file() {
        std::fs::remove_file(&p)
            .map_err(|e| format!("Failed to delete backup: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_project_path_legacy() {
        let (w, r) = split_project_path(
            "content/Ambessa.wad.client/data/characters/ambessa/skins/skin19/crazygood.ambessa.tex",
        )
        .unwrap();
        assert_eq!(w, "Ambessa.wad.client");
        assert_eq!(r, "data/characters/ambessa/skins/skin19/crazygood.ambessa.tex");
    }

    #[test]
    fn split_project_path_layered() {
        let (w, r) = split_project_path(
            "content/base/kayn.wad.client/assets/SirDexal/foo/skin8/x.tex",
        )
        .unwrap();
        assert_eq!(w, "kayn.wad.client");
        assert_eq!(r, "assets/SirDexal/foo/skin8/x.tex");
    }

    #[test]
    fn fuzzy_score_suffix_swap() {
        // crazygood.ambessa.tex ↔ crazygood.boba.tex — share leading token only.
        let s = fuzzy_filename_score("crazygood.ambessa.tex", "crazygood.boba.tex").unwrap();
        assert_eq!(s, 1);
    }

    #[test]
    fn fuzzy_score_suffix_added() {
        // crazygood.tex ↔ crazygood.ambessa.tex — also share leading token only.
        let s = fuzzy_filename_score("crazygood.tex", "crazygood.ambessa.tex").unwrap();
        assert_eq!(s, 1);
    }

    #[test]
    fn fuzzy_score_unrelated() {
        assert!(fuzzy_filename_score("foo.tex", "bar.tex").is_none());
        assert!(fuzzy_filename_score("crazygood.tex", "crazygood.skn").is_none());
    }

    #[test]
    fn fuzzy_score_cross_format_dds_tex() {
        // Same name, different container — old-mod vs current-game pairing.
        assert_eq!(
            fuzzy_filename_score("crazygood.dds", "crazygood.tex"),
            Some(usize::MAX)
        );
        // Same name + suffix tokens, different container.
        assert_eq!(
            fuzzy_filename_score("crazygood.ambessa.dds", "crazygood.boba.tex"),
            Some(1)
        );
        // Cross-format never matches across unrelated extensions.
        assert!(fuzzy_filename_score("crazygood.dds", "crazygood.skn").is_none());
    }

    #[test]
    fn swap_texture_ext_round_trip() {
        assert_eq!(
            swap_texture_ext("foo/bar.dds").as_deref(),
            Some("foo/bar.tex")
        );
        assert_eq!(
            swap_texture_ext("foo/bar.tex").as_deref(),
            Some("foo/bar.dds")
        );
        assert_eq!(swap_texture_ext("foo/bar.skn"), None);
    }

    #[test]
    fn fuzzy_score_more_overlap_wins() {
        // a.b.c.tex shares 3 tokens with itself.
        let s = fuzzy_filename_score("a.b.c.tex", "a.b.c.tex").unwrap();
        assert_eq!(s, usize::MAX);
        // a.b.c.tex vs a.b.x.tex shares 2 leading tokens.
        let s = fuzzy_filename_score("a.b.c.tex", "a.b.x.tex").unwrap();
        assert_eq!(s, 2);
    }

    #[test]
    fn backup_path_rejects_traversal() {
        assert!(backup_path_for("/proj", "../etc/passwd").is_err());
        assert!(backup_path_for("/proj", "data/foo.tex").is_ok());
    }
}
