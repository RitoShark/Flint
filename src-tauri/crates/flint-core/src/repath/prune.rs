//! Removal passes: unreferenced assets, orphaned sources, empty dirs.

use crate::bin::codec::{read_bin, write_bin};
use crate::error::{Error, Result};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use super::refather::RepathConfig;
use super::paths::*;
use super::refather::find_main_skin_bin;
pub(crate) fn cleanup_unused_files(
    content_base: &Path,
    referenced_paths: &HashSet<String>,
    prefix: &str,
    config: &RepathConfig,
    // Paths referenced only by non-shipping champion-root BINs — kept in place.
    preserved_paths: &HashSet<String>,
) -> Result<usize> {
    use rayon::prelude::*;

    let expected_paths: HashSet<String> = referenced_paths
        .iter()
        .flat_map(|p| {
            let raw = normalize_path(p);
            let repathed = normalize_path(&apply_prefix_to_path(p, prefix, config));
            [raw, repathed]
        })
        .collect();

    // Walk serially (WalkDir holds file-handle state), then delete in parallel.
    let to_delete: Vec<PathBuf> = WalkDir::new(content_base)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            // BIN files are handled by cleanup_irrelevant_bins.
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if ext.eq_ignore_ascii_case("bin") {
                    return None;
                }
            }
            let rel_path = path.strip_prefix(content_base).ok()?;
            let normalized = normalize_path(&rel_path.to_string_lossy());
            let filename = path.file_stem().unwrap_or_default().to_string_lossy();
            let is_unresolved = filename.len() == 16 && filename.chars().all(|c| c.is_ascii_hexdigit());

            if is_unresolved {
                tracing::debug!("Preserving unresolved hash file: {}", path.display());
                return None;
            }

            // Referenced (raw OR repathed) → always keep.
            if expected_paths.contains(&normalized) {
                return None;
            }
            // Referenced only by a non-shipping champion-root BIN → stays at its
            // original path (it overrides the live game path the real root uses).
            if preserved_paths.contains(&normalized) {
                return None;
            }
            // Not referenced → delete candidate (original behavior: non-expected was
            // always deleted, in BOTH in_new_tree states).
            Some(path.to_path_buf())
        })
        .collect();

    let removed = to_delete
        .par_iter()
        .filter(|path| match fs::remove_file(path) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!("Failed to remove {}: {}", path.display(), e);
                false
            }
        })
        .count();

    Ok(removed)
}

/// Project-creation safety net: delete non-BIN files still sitting under the
/// ORIGINAL game-layout `characters/` tree that were NOT relocated (i.e. their
/// path is not referenced by any BIN). These are un-relocated orphans —
/// unreferenced HD twins (`2x_`/`4x_`) or leftover clones whose real copy has
/// already moved to the project folder. Scoped strictly to `assets/characters/`
/// and `data/characters/` so it can never touch the relocated project tree.
pub(crate) fn sweep_source_tree_orphans(
    content_base: &Path,
    referenced_paths: &HashSet<String>,
    prefix: &str,
    config: &RepathConfig,
    // Paths referenced only by non-shipping champion-root BINs — kept in place.
    preserved_paths: &HashSet<String>,
) -> usize {
    use rayon::prelude::*;

    // A file is "referenced" if its raw OR repathed form is in existing_paths.
    let expected: HashSet<String> = referenced_paths
        .iter()
        .flat_map(|p| {
            let raw = normalize_path(p);
            let repathed = normalize_path(&apply_prefix_to_path(p, prefix, config));
            [raw, repathed]
        })
        .collect();

    let to_delete: Vec<PathBuf> = WalkDir::new(content_base)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let rel = path.strip_prefix(content_base).ok()?;
            let normalized = normalize_path(&rel.to_string_lossy());

            // Only the original game-layout characters/ tree.
            if !(normalized.starts_with("assets/characters/")
                || normalized.starts_with("data/characters/"))
            {
                return None;
            }
            // Never touch BINs (cleanup_irrelevant_bins owns those).
            if normalized.ends_with(".bin") {
                return None;
            }
            // Preserve unresolved hash files (16-hex stem) — recovered later.
            let stem = path.file_stem().unwrap_or_default().to_string_lossy();
            if stem.len() == 16 && stem.chars().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            // Referenced (raw or repathed) → keep; the relocate pass handles it.
            if expected.contains(&normalized) {
                return None;
            }
            // Champion-root-only references stay at their original paths.
            if preserved_paths.contains(&normalized) {
                return None;
            }
            Some(path.to_path_buf())
        })
        .collect();

    to_delete
        .par_iter()
        .filter(|path| match fs::remove_file(path) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!("Failed to sweep orphan {}: {}", path.display(), e);
                false
            }
        })
        .count()
}

pub(crate) fn referenced_bin_keep_set(
    content_base: &Path,
) -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    let mut keep: HashSet<String> = HashSet::new();
    for entry in WalkDir::new(content_base)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("bin"))
                .unwrap_or(false)
        })
    {
        let path = entry.path();
        let Ok(data) = fs::read(path) else { continue };
        let Ok(bin) = read_bin(&data) else { continue };
        for dep in bin.linked {
            if crate::bin::classify_bin(&dep) == crate::bin::BinCategory::ChampionRoot {
                continue;
            }
            keep.insert(dep.replace('\\', "/").trim_start_matches('/').to_lowercase());
        }
    }
    keep
}

fn remove_champion_root_links(path: &Path) -> Result<bool> {
    let Ok(data) = fs::read(path) else {
        return Ok(false);
    };
    let Ok(mut bin) = read_bin(&data) else {
        return Ok(false);
    };
    let original_len = bin.linked.len();
    bin.linked
        .retain(|dep| crate::bin::classify_bin(dep) != crate::bin::BinCategory::ChampionRoot);
    if bin.linked.len() == original_len {
        return Ok(false);
    }

    let data = write_bin(&bin)
        .map_err(|error| Error::bin_conversion_with_path(error.to_string(), path))?;
    fs::write(path, data).map_err(|error| Error::io_with_path(error, path))?;
    Ok(true)
}

/// Whitelist approach: keeps the main skin BIN (skins/skin{ID}.bin), the
/// animation BIN (animations/skin{ID}.bin), and the concat BIN (_Concat.bin);
/// everything else is deleted.
pub(crate) fn cleanup_irrelevant_bins(
    content_base: &Path,
    champion: &str,
    target_skin_id: u32,
    keep: &std::collections::HashSet<String>,
) -> Result<usize> {
    let mut removed = 0;
    let champion_lower = champion.to_lowercase();

    let target_skin_name = format!("skin{}.bin", target_skin_id);
    let target_skin_name_padded = format!("skin{:02}.bin", target_skin_id);

    let mut referenced_animation_bin: Option<String> = None;
    if let Some(main_bin_path) = find_main_skin_bin(content_base, champion, target_skin_id) {
        if let Ok(data) = fs::read(&main_bin_path) {
            if let Ok(bin) = read_bin(&data) {
                for dep in &bin.linked {
                    if crate::bin::classify_bin(dep) == crate::bin::BinCategory::Animation {
                        if let Some(filename) = Path::new(dep).file_name() {
                            referenced_animation_bin = Some(filename.to_string_lossy().to_lowercase());
                            break;
                        }
                    }
                }
            }
        }
    }

    if let Some(ref ref_anim) = referenced_animation_bin {
        tracing::info!(
            "Cleaning up BINs (keeping only: {}, {}, referenced animation: {}, and _Concat.bin)",
            target_skin_name,
            target_skin_name_padded,
            ref_anim
        );
    } else {
        tracing::info!(
            "Cleaning up BINs (keeping only: {}, {}, and _Concat.bin)",
            target_skin_name,
            target_skin_name_padded
        );
    }

    for entry in WalkDir::new(content_base)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("bin"))
                .unwrap_or(false)
        })
    {
        let path = entry.path();
        if let Ok(rel_path) = path.strip_prefix(content_base) {
            let rel_str = rel_path.to_string_lossy().to_lowercase().replace('\\', "/");
            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();

            if keep.contains(&rel_str) {
                tracing::debug!("Keeping referenced BIN (keep-set): {}", rel_str);
                continue;
            }

            if filename.contains("_concat") {
                tracing::debug!("Keeping concat BIN: {}", rel_str);
                continue;
            }

            if rel_str.contains("/skins/") &&
               (filename == target_skin_name || filename == target_skin_name_padded) {
                tracing::debug!("Keeping main skin BIN: {}", rel_str);
                continue;
            }

            let file_stem = path.file_stem().unwrap_or_default().to_string_lossy();
            let is_unresolved = file_stem.len() == 16 && file_stem.chars().all(|c| c.is_ascii_hexdigit());
            if is_unresolved {
                tracing::debug!("Keeping unresolved hash BIN: {}", rel_str);
                continue;
            }

            if rel_str.contains("/animations/") {
                let is_match = filename == target_skin_name
                    || filename == target_skin_name_padded
                    || referenced_animation_bin.as_ref().is_some_and(|ref_anim| filename == *ref_anim);
                if is_match {
                    tracing::debug!("Keeping animation BIN: {}", rel_str);
                    continue;
                }
            }

            let reason = if rel_str.contains("/animations/") {
                "wrong animation"
            } else if rel_str.contains("/skins/") {
                "wrong skin"
            } else if filename == format!("{}.bin", champion_lower) {
                "champion root"
            } else if filename.contains("_skins_") || filename.contains("_skin") {
                "linked data"
            } else {
                "unreferenced"
            };

            if let Err(e) = fs::remove_file(path) {
                tracing::warn!("Failed to remove {} BIN {}: {}", reason, path.display(), e);
            } else {
                tracing::debug!("Removed {} BIN: {}", reason, rel_str);
                removed += 1;
            }
        }
    }

    for entry in WalkDir::new(content_base)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("bin"))
                .unwrap_or(false)
        })
    {
        let path = entry.path();
        if remove_champion_root_links(path)? {
            tracing::debug!("Removed champion root link(s) from BIN: {}", path.display());
        }
    }
    
    if removed > 0 {
        tracing::info!("Cleaned up {} irrelevant BIN files", removed);
    }
    
    Ok(removed)
}

pub(crate) fn cleanup_empty_dirs(dir: &Path) -> Result<()> {
    for entry in WalkDir::new(dir)
        .contents_first(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(entries) = fs::read_dir(path) {
                if entries.count() == 0 {
                    let _ = fs::remove_dir(path);
                }
            }
        }
    }
    Ok(())
}

