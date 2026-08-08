//! Orchestrates concat and refather workflows with independent control.

use crate::bin::concat::{concatenate_linked_bins, ConcatResult};
use crate::repath::refather::{repath_project, RepathConfig, RepathResult};
use crate::error::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone)]
pub struct OrganizerConfig {
    /// Merges linked Type 3 BINs into a single file.
    pub enable_concat: bool,
    /// Prefixes paths with creator/project.
    pub enable_repath: bool,
    pub creator_name: String,
    pub project_name: String,
    /// Champion internal name (e.g., "Kayn").
    pub champion: String,
    pub target_skin_id: u32,
    pub cleanup_unused: bool,
    /// Override the WAD folder name (e.g. "Companions.wad.client" for TFT).
    /// When None, defaults to "{champion}.wad.client".
    pub wad_folder_override: Option<String>,
    pub skip_bin_cleanup: bool,
    pub delete_sources: bool,
    /// When true, consolidate via the VFX-organize pass (VFX → data/<vfx>.bin,
    /// everything else → main skin BIN). When false, use legacy concat. Only the
    /// import pipeline sets this true; project-creation and export keep concat.
    pub consolidate_vfx: bool,
    /// When true, run the import cleanup pass (unhash, dds->tex, sco->scb, BIN
    /// extension rewrite, 2x/4x strip) after consolidation+repath. Import only.
    pub cleanup_pipeline: bool,
}

#[derive(Debug, Clone)]
pub struct OrganizerResult {
    pub concat_result: Option<ConcatResult>,
    pub repath_result: Option<RepathResult>,
}

/// Runs concat (if enabled) then repath (if enabled). `path_mappings` maps
/// original paths to actual paths (for hash-named files).
pub fn organize_project(
    content_base: &Path,
    config: &OrganizerConfig,
    path_mappings: &HashMap<String, String>,
) -> Result<OrganizerResult> {
    tracing::info!(
        "Starting project organization (concat: {}, repath: {})",
        config.enable_concat,
        config.enable_repath
    );

    let mut result = OrganizerResult {
        concat_result: None,
        repath_result: None,
    };

    // League doesn't support spaces in asset paths or folder names.
    let champion_sanitized = config.champion.to_lowercase().replace(' ', "-");

    let wad_folder_name = config.wad_folder_override.clone()
        .unwrap_or_else(|| format!("{}.wad.client", flint_wad::wad::extractor::wad_champion_name(&champion_sanitized)));
    let wad_base = content_base.join(&wad_folder_name);

    let file_base = if wad_base.exists() {
        tracing::info!("Using WAD folder structure: {}", wad_base.display());
        wad_base.clone()
    } else {
        tracing::info!("Using legacy folder structure (no WAD folder found)");
        content_base.to_path_buf()
    };

    let main_bin_path = if !champion_sanitized.is_empty() {
        find_main_skin_bin(&file_base, &champion_sanitized, config.target_skin_id)
    } else {
        None
    };

    // Sub-champions only exist in regular champion WADs, not TFT or imports.
    let sub_bins = if config.wad_folder_override.is_none() && !config.consolidate_vfx {
        let declared = main_bin_path
            .as_ref()
            .map(|p| declared_sub_characters(p, &champion_sanitized))
            .unwrap_or_default();
        find_sub_skin_bins(
            &file_base,
            &champion_sanitized,
            config.target_skin_id,
            &declared,
        )
    } else {
        Vec::new()
    };

    // CONSOLIDATION: VFX-organize on the import path, legacy concat otherwise.
    if config.enable_concat {
        if config.consolidate_vfx {
            // *** Import path: VFX → data/<vfx>.bin, everything else → main skin BIN ***
            let bins = crate::bin::split::collect_folder_bins(&file_base);
            if bins.is_empty() {
                tracing::warn!("Cannot consolidate: no BINs found under {}", file_base.display());
            } else {
                let owner = main_bin_path.clone().or_else(|| {
                    let with_counts: Vec<(std::path::PathBuf, usize)> = bins
                        .iter()
                        .filter_map(|p| {
                            let data = std::fs::read(p).ok()?;
                            let bin = crate::bin::read_bin(&data).ok()?;
                            Some((p.clone(), bin.entries.len()))
                        })
                        .collect();
                    crate::bin::split::pick_owner_bin(&with_counts)
                });
                match owner {
                    Some(owner_path) => {
                        let project_root = crate::bin::split::find_wad_root(&file_base);
                        let vfx_name = format!("{}_vfx.bin", config.project_name.replace(' ', "-").to_lowercase());
                        match crate::bin::split::organize_vfx_in_folder(&bins, &owner_path, &project_root, &vfx_name) {
                            Ok(r) => tracing::info!(
                                "VFX consolidation: {} VFX moved, {} merged, {} sources removed",
                                r.vfx_objects_moved, r.main_objects_merged, r.sources_deleted.len()
                            ),
                            Err(e) => tracing::warn!("VFX consolidation failed: {}", e),
                        }
                    }
                    None => tracing::warn!("Cannot consolidate: no owner BIN found"),
                }
            }
        } else if let Some(ref main_path) = main_bin_path {
            // *** Project-creation / export path: legacy concat ***
            // Shared Type-3 BINs can be linked from several roots, so sources
            // are deleted only after every root has been concatenated.
            tracing::info!("Running BIN concatenation...");
            let mut source_paths: Vec<String> = Vec::new();

            let roots = std::iter::once((config.project_name.clone(), main_path.clone()))
                .chain(sub_bins.iter().map(|(sub, path)| {
                    (format!("{}_{}", config.project_name, capitalize(sub)), path.clone())
                }));

            for (project_name, root) in roots {
                match concatenate_linked_bins(
                    &root,
                    &project_name,
                    &config.creator_name,
                    &champion_sanitized,
                    &file_base,
                    path_mappings,
                ) {
                    Ok(concat_result) => {
                        tracing::info!(
                            "Concatenation complete: {} BINs merged into {}",
                            concat_result.source_count,
                            concat_result.concat_path
                        );
                        source_paths.extend(concat_result.source_paths.iter().cloned());
                        if result.concat_result.is_none() {
                            result.concat_result = Some(concat_result);
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Concatenation failed for {}: {}", root.display(), e);
                    }
                }
            }

            if config.delete_sources {
                source_paths.sort_unstable();
                source_paths.dedup();
                for source_path in &source_paths {
                    let full_path = file_base.join(source_path);
                    if full_path.exists() {
                        if let Err(e) = std::fs::remove_file(&full_path) {
                            tracing::warn!("Failed to delete source BIN {}: {}", source_path, e);
                        }
                    }
                }
            }
        } else {
            tracing::warn!("Cannot run concat: main skin BIN not found");
        }
    }

    if config.enable_repath {
        tracing::info!("Running asset repathing...");

        let repath_config = RepathConfig {
            creator_name: config.creator_name.clone(),
            project_name: config.project_name.clone(),
            champion: champion_sanitized.clone(),
            target_skin_id: config.target_skin_id,
            cleanup_unused: config.cleanup_unused,
            skip_bin_cleanup: config.skip_bin_cleanup,
            sub_characters: sub_bins.iter().map(|(sub, _)| sub.clone()).collect(),
        };

        match repath_project(content_base, &repath_config, path_mappings) {
            Ok(repath_result) => {
                tracing::info!(
                    "Repathing complete: {} paths modified, {} files relocated",
                    repath_result.paths_modified,
                    repath_result.files_relocated
                );
                result.repath_result = Some(repath_result);
            }
            Err(e) => {
                tracing::warn!("Repathing failed: {}", e);
            }
        }
    }

    if config.cleanup_pipeline {
        let wad_root = file_base.clone(); // the .wad.client folder used above
        if let Ok(hash_dir) = crate::hash::get_hash_dir() {
            let hash_dir = hash_dir.to_string_lossy().to_string();
            if let Some(env) = crate::hash::lmdb_cache::get_or_open_env(&hash_dir) {
                let resolve = |hs: &[u64]| crate::hash::lmdb_cache::resolve_hashes_lmdb(hs, &env);
                let _ = crate::repath::cleanup::run_cleanup_pipeline(&wad_root, &resolve);
            }
        }
    }

    tracing::info!("Project organization complete");
    Ok(result)
}

/// The characters the skin BIN itself preloads (Zyra's plants, Annie's Tibbers, …),
/// minus the champion. Empty when the BIN is unreadable or declares none.
fn declared_sub_characters(main_bin_path: &Path, champion: &str) -> Vec<String> {
    let champion_lower = champion.to_lowercase();
    std::fs::read(main_bin_path)
        .ok()
        .and_then(|data| crate::bin::read_bin(&data).ok())
        .map(|bin| crate::bin::extra_character_preloads(&bin))
        .unwrap_or_default()
        .into_iter()
        .filter(|c| *c != champion_lower)
        .collect()
}

/// Sub-champions (Tibbers, Skaarl, …) ship as `characters/<sub>/` trees inside
/// the champion WAD with a `skins/skin{N}.bin` matching the target skin id.
/// Returns `(lowercased character name, skin BIN path)` per sub.
///
/// `declared` is the skin's own `extraCharacterPreloads` list and, when non-empty,
/// is the authority on which characters count. Falling back to the bare glob would
/// also match Riot's `jade_*` classic-mode roster, which belongs to no skin.
fn find_sub_skin_bins(
    file_base: &Path,
    champion: &str,
    skin_id: u32,
    declared: &[String],
) -> Vec<(String, PathBuf)> {
    let champion_lower = champion.to_lowercase();
    let targets = [
        format!("skins/skin{}.bin", skin_id),
        format!("skins/skin{:02}.bin", skin_id),
    ];

    let accepts = |character: &str| {
        if declared.is_empty() {
            !character.starts_with(crate::bin::preloads::ALT_MODE_CHARACTER_PREFIX)
        } else {
            declared.iter().any(|d| d == character)
        }
    };

    let mut seen = std::collections::HashSet::new();
    let mut subs = Vec::new();
    for entry in WalkDir::new(file_base).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let Ok(rel) = path.strip_prefix(file_base) else { continue };
        let rel_str = rel.to_string_lossy().to_lowercase().replace('\\', "/");
        let Some(rest) = rel_str.strip_prefix("data/characters/") else { continue };
        let Some((character, tail)) = rest.split_once('/') else { continue };
        if character != champion_lower
            && accepts(character)
            && targets.iter().any(|t| tail == t)
            && seen.insert(character.to_string())
        {
            tracing::info!("Detected sub-champion: {} ({})", character, rel_str);
            subs.push((character.to_string(), path.to_path_buf()));
        }
    }
    subs
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn find_main_skin_bin(content_base: &Path, champion: &str, skin_id: u32) -> Option<PathBuf> {
    let champion_lower = champion.to_lowercase();

    let wad_folder = format!("{}.wad.client", flint_wad::wad::extractor::wad_champion_name(&champion_lower));
    let wad_path = content_base.join(&wad_folder);

    let patterns = vec![
        format!("data/characters/{}/skins/skin{}.bin", champion_lower, skin_id),
        format!("data/characters/{}/skins/skin{:02}.bin", champion_lower, skin_id),
    ];

    if wad_path.exists() {
        for pattern in &patterns {
            let direct_path = wad_path.join(pattern);
            if direct_path.exists() {
                tracing::debug!("Found main skin BIN in WAD folder: {}", direct_path.display());
                return Some(direct_path);
            }
        }

        for entry in WalkDir::new(&wad_path)
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
            if let Ok(rel_path) = path.strip_prefix(&wad_path) {
                let rel_str = rel_path.to_string_lossy().to_lowercase().replace('\\', "/");
                for pattern in &patterns {
                    if rel_str == *pattern {
                        tracing::debug!("Found main skin BIN via search: {}", path.display());
                        return Some(path.to_path_buf());
                    }
                }
            }
        }
    }

    for pattern in &patterns {
        let direct_path = content_base.join(pattern);
        if direct_path.exists() {
            tracing::debug!("Found main skin BIN (legacy path): {}", direct_path.display());
            return Some(direct_path);
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
        if let Ok(rel_path) = path.strip_prefix(content_base) {
            let rel_str = rel_path.to_string_lossy().to_lowercase().replace('\\', "/");
            for pattern in &patterns {
                if rel_str.ends_with(pattern) {
                    tracing::debug!("Found main skin BIN (fallback): {}", path.display());
                    return Some(path.to_path_buf());
                }
            }
        }
    }

    tracing::warn!("Main skin BIN not found for {} skin {}", champion, skin_id);
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> OrganizerConfig {
        OrganizerConfig {
            enable_concat: true,
            enable_repath: true,
            creator_name: "TestCreator".to_string(),
            project_name: "TestProject".to_string(),
            champion: "Kayn".to_string(),
            target_skin_id: 8,
            cleanup_unused: true,
            wad_folder_override: None,
            skip_bin_cleanup: false,
            delete_sources: true,
            consolidate_vfx: false,
            cleanup_pipeline: false,
        }
    }

    fn companion_tree() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for rel in [
            "data/characters/annie/skins/skin22.bin",
            "data/characters/annietibbers/skins/skin22.bin",
            "data/characters/annietibbers/skins/skin03.bin",
            "data/characters/petball/skins/skin03.bin",
            "data/characters/sona/skins/skin5.bin",
            "data/characters/jade_annie/skins/skin22.bin",
            "data/characters/jade_annie_tibbers/skins/skin22.bin",
        ] {
            let p = dir.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"").unwrap();
        }
        dir
    }

    #[test]
    fn find_sub_skin_bins_detects_companions() {
        let dir = companion_tree();
        let base = dir.path();

        let subs = find_sub_skin_bins(base, "annie", 22, &[]);
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].0, "annietibbers");

        let subs = find_sub_skin_bins(base, "annie", 3, &[]);
        let mut names: Vec<&str> = subs.iter().map(|(s, _)| s.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["annietibbers", "petball"]);

        assert!(find_sub_skin_bins(base, "annie", 7, &[]).is_empty());
    }

    #[test]
    fn a_declared_list_is_the_authority() {
        let dir = companion_tree();
        let declared = vec!["annietibbers".to_string()];

        let subs = find_sub_skin_bins(dir.path(), "annie", 22, &declared);
        let names: Vec<&str> = subs.iter().map(|(s, _)| s.as_str()).collect();
        assert_eq!(names, ["annietibbers"]);

        // A companion the skin does not preload is not this skin's business.
        let subs = find_sub_skin_bins(dir.path(), "annie", 3, &declared);
        let names: Vec<&str> = subs.iter().map(|(s, _)| s.as_str()).collect();
        assert_eq!(names, ["annietibbers"]);
    }

    #[test]
    fn the_glob_never_yields_the_classic_mode_roster() {
        let dir = companion_tree();
        let subs = find_sub_skin_bins(dir.path(), "annie", 22, &[]);
        assert!(!subs.iter().any(|(s, _)| s.starts_with("jade_")));
    }

    #[test]
    fn capitalize_first_char() {
        assert_eq!(capitalize("annietibbers"), "Annietibbers");
        assert_eq!(capitalize(""), "");
    }

    #[test]
    fn test_organizer_config_full() {
        let config = sample_config();
        assert!(config.enable_concat);
        assert!(config.enable_repath);
        assert!(config.cleanup_unused);
    }

    #[test]
    fn test_organizer_config_concat_only() {
        let config = OrganizerConfig {
            enable_repath: false,
            ..sample_config()
        };
        assert!(config.enable_concat);
        assert!(!config.enable_repath);
    }

    #[test]
    fn test_organizer_config_repath_only() {
        let config = OrganizerConfig {
            enable_concat: false,
            ..sample_config()
        };
        assert!(!config.enable_concat);
        assert!(config.enable_repath);
    }
}
