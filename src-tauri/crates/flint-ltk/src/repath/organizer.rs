//! Orchestrates concat and refather workflows with independent control.

use crate::bin::concat::ConcatResult;
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
        .unwrap_or_else(|| format!("{}.wad.client", champion_sanitized));
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

    // *** ORDER 1: CONSOLIDATE VFX (replaces the old concat on the import path) ***
    if config.enable_concat {
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

    tracing::info!("Project organization complete");
    Ok(result)
}

fn find_main_skin_bin(content_base: &Path, champion: &str, skin_id: u32) -> Option<PathBuf> {
    let champion_lower = champion.to_lowercase();

    let wad_folder = format!("{}.wad.client", champion_lower);
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
        }
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
