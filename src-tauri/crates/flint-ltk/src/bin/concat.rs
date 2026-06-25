//! Linked BIN concatenation module
//!
//! This module implements the linked BIN system that:
//! 1. Classifies BINs into three categories (ChampionRoot, Animation, LinkedData)
//! 2. Concatenates all LinkedData BINs into a single concat BIN
//! 3. Updates the main BIN's linked list to reference the new concat BIN
//!
//! This prevents conflicts when multiple linked BINs reference the same assets.

use crate::bin::ltk_bridge::{read_bin, write_bin};
use crate::error::{Error, Result};
use ritoshark::bin::{Bin, BinEntry};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// Category of a BIN file based on its path pattern
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinCategory {
    /// Type 1: Champion root BIN (DATA/Characters/{Champion}/{Champion}.bin)
    /// Never modify - contains core champion data
    ChampionRoot,

    /// Type 2: Animation BINs (DATA/Characters/{Champion}/Animations/*.bin)
    /// Never modify - contains animation data
    Animation,

    /// Type 3: Linked data BINs (everything else)
    /// Concatenate these into a single BIN
    LinkedData,

    /// Filtered: Ignore these files
    /// Corrupted, recursive, or explicitly ignored files
    Ignore,
}

/// Result of a concatenation operation
#[derive(Debug, Clone)]
pub struct ConcatResult {
    /// The path where the concat BIN was saved (relative DATA path)
    pub concat_path: String,
    /// Number of source BINs that were concatenated
    pub source_count: usize,
    /// Paths of source BINs that were concatenated (for deletion)
    pub source_paths: Vec<String>,
}

/// Classify a BIN file path into its category
pub fn classify_bin(path: &str) -> BinCategory {
    let normalized = path.replace('\\', "/");
    let lower = normalized.to_lowercase();

    let filename = lower.split('/').next_back().unwrap_or("");

    // e.g. data/characters/kayn/kayn.bin
    if lower.starts_with("data/characters/") && !lower.contains("/animations/") {
        let parts: Vec<&str> = normalized.split('/').collect();
        if parts.len() == 4 && parts[3].to_lowercase().ends_with(".bin") {
            let champion_folder = parts[2].to_lowercase();
            let bin_filename = parts[3].to_lowercase();
            if bin_filename == format!("{}.bin", champion_folder) {
                return BinCategory::ChampionRoot;
            }
        }
    }

    if filename == "root.bin" {
        return BinCategory::ChampionRoot;
    }

    if lower.starts_with("data/characters/") && lower.contains("/animations/") {
        return BinCategory::Animation;
    }

    BinCategory::LinkedData
}

pub fn get_linked_paths(bin: &Bin) -> Vec<String> {
    bin.linked.clone()
}

pub fn set_linked_paths(bin: &mut Bin, paths: Vec<String>) {
    bin.linked = paths;
}

/// Concatenates all Type 3 (LinkedData) BINs.
pub fn create_concat_bin(
    main_bin: &Bin,
    project_name: &str,
    creator_name: &str,
    _champion: &str,
    content_base: &Path,
    path_mappings: &HashMap<String, String>,
) -> Result<ConcatResult> {
    let linked_paths = get_linked_paths(main_bin);

    let type3_paths: Vec<String> = linked_paths
        .iter()
        .filter(|path| {
            let cat = classify_bin(path);
            if cat == BinCategory::Ignore {
                tracing::warn!("Ignoring suspicious linked BIN: {}", path);
            }
            cat == BinCategory::LinkedData
        })
        .cloned()
        .collect();

    tracing::info!(
        "Found {} Type 3 (LinkedData) BINs to concatenate",
        type3_paths.len()
    );

    if type3_paths.is_empty() {
        return Err(Error::InvalidInput(
            "No Type 3 (LinkedData) BINs found in linked list".to_string(),
        ));
    }

    let mut all_objects: HashMap<u32, BinEntry> = HashMap::new();
    let mut collision_count = 0;
    let mut source_count = 0;
    let mut processed_paths: Vec<String> = Vec::new();

    for bin_path in &type3_paths {
        let normalized_path = bin_path.to_lowercase().replace('\\', "/");

        let actual_path = path_mappings.get(&normalized_path)
            .cloned()
            .unwrap_or_else(|| normalized_path.clone());

        let full_path = content_base.join(&actual_path);

        if !full_path.exists() {
            tracing::warn!("Type 3 BIN not found, skipping: {} (tried: {})", normalized_path, actual_path);
            continue;
        }

        let data = fs::read(&full_path).map_err(|e| Error::io_with_path(e, &full_path))?;

        let magic = if data.len() >= 4 {
            String::from_utf8_lossy(&data[0..4]).to_string()
        } else {
            "SHORT".to_string()
        };

        tracing::debug!(
            "Processing Type 3 BIN: {} (actual: {}, size: {} bytes, magic: {})",
            bin_path, actual_path, data.len(), magic
        );

        // catch_unwind requires 'UnwindSafe'. references are usually fine.
        let source_bin_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            read_bin(&data)
        }));

        let source_bin = match source_bin_result {
            Ok(Ok(bin)) => bin,
            Ok(Err(e)) => {
                tracing::warn!("Failed to parse BIN {}: {}", actual_path, e);
                continue;
            }
            Err(_) => {
                tracing::error!("CRASH PREVENTED: Parser panicked/crashed on BIN {}. Skipping.", actual_path);
                continue;
            }
        };

        if !source_bin.linked.is_empty() {
            tracing::warn!(
                "Type 3 BIN has non-empty linked list ({}), may cause issues: {}",
                source_bin.linked.len(),
                bin_path
            );
        }

        for entry in source_bin.entries {
            let path_hash = entry.path_hash;
            if all_objects.contains_key(&path_hash) {
                collision_count += 1;
                tracing::debug!("Hash collision for 0x{:08x} in {}, last-write-wins", path_hash, bin_path);
            }
            all_objects.insert(path_hash, entry);
        }

        source_count += 1;
        processed_paths.push(actual_path.clone());
    }

    /* rs_bin has no builder — construct with a struct literal over an empty v3 doc. */
    let concat_bin = Bin {
        entries: all_objects.into_values().collect(),
        ..Bin::new()
    };
    let object_count = concat_bin.entries.len();

    let creator_sanitized = creator_name.replace(' ', "-");
    let project_sanitized = project_name.replace(' ', "-");
    let concat_path = format!(
        "data/{}_{}_Concat.bin",
        creator_sanitized, project_sanitized
    );

    let concat_full_path = content_base.join(&concat_path);
    if let Some(parent) = concat_full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
    }

    let concat_data = write_bin(&concat_bin)
        .map_err(|e| Error::InvalidInput(format!("Failed to write concat BIN: {}", e)))?;

    fs::write(&concat_full_path, &concat_data)
        .map_err(|e| Error::io_with_path(e, &concat_full_path))?;

    if let Err(e) = read_bin(&concat_data) {
        let _ = fs::remove_file(&concat_full_path);
        return Err(Error::InvalidInput(format!(
            "Generated concat BIN is corrupt and cannot be read back: {}", 
            e
        )));
    }

    tracing::info!(
        "Created concat BIN with {} objects from {} sources ({} collisions)",
        object_count,
        source_count,
        collision_count
    );

    Ok(ConcatResult {
        concat_path,
        source_count,
        source_paths: processed_paths,
    })
}

pub fn update_main_bin_links(main_bin: &mut Bin, concat_path: String) -> Result<()> {
    let current_links = get_linked_paths(main_bin);

    let type1_path = current_links
        .iter()
        .find(|path| classify_bin(path) == BinCategory::ChampionRoot)
        .cloned();

    let type2_path = current_links
        .iter()
        .find(|path| classify_bin(path) == BinCategory::Animation)
        .cloned();

    // concat first, then type1, then type2
    let mut new_links = vec![concat_path];

    if let Some(path) = type1_path {
        new_links.push(path);
    }

    if let Some(path) = type2_path {
        new_links.push(path);
    }

    tracing::debug!("Updated main BIN linked list: {:?}", new_links);

    set_linked_paths(main_bin, new_links);

    Ok(())
}

pub fn concatenate_linked_bins(
    main_bin_path: &Path,
    project_name: &str,
    creator_name: &str,
    champion: &str,
    content_base: &Path,
    path_mappings: &HashMap<String, String>,
    delete_sources: bool,
) -> Result<ConcatResult> {
    tracing::info!(
        "Starting linked BIN concatenation for: {}",
        main_bin_path.display()
    );

    let data = fs::read(main_bin_path).map_err(|e| Error::io_with_path(e, main_bin_path))?;
    let mut main_bin = read_bin(&data)
        .map_err(|e| Error::InvalidInput(format!("Failed to parse main BIN: {}", e)))?;
    drop(data);

    tracing::debug!("Original linked paths:");
    for (i, path) in main_bin.linked.iter().enumerate() {
        tracing::debug!("  [{}] {} - {:?}", i, path, classify_bin(path));
    }

    let result = create_concat_bin(&main_bin, project_name, creator_name, champion, content_base, path_mappings)?;

    tracing::info!("Created concat BIN: {}", result.concat_path);

    update_main_bin_links(&mut main_bin, result.concat_path.clone())?;
    let updated_data = write_bin(&main_bin)
        .map_err(|e| Error::InvalidInput(format!("Failed to write updated BIN: {}", e)))?;
    fs::write(main_bin_path, updated_data).map_err(|e| Error::io_with_path(e, main_bin_path))?;
    tracing::info!("Updated main BIN linked list: {}", main_bin_path.display());

    if delete_sources {
        let mut deleted_count = 0;
        for source_path in &result.source_paths {
            let full_path = content_base.join(source_path);
            if full_path.exists() {
                match fs::remove_file(&full_path) {
                    Ok(_) => {
                        tracing::debug!("Deleted source BIN: {}", source_path);
                        deleted_count += 1;
                    }
                    Err(e) => {
                        tracing::warn!("Failed to delete source BIN {}: {}", source_path, e);
                    }
                }
            } else {
                tracing::debug!("Source BIN already gone: {}", source_path);
            }
        }
        tracing::info!("Deleted {} source BINs after concatenation", deleted_count);
    } else {
        tracing::info!("Skipped deleting {} source BINs because delete_sources is false", result.source_paths.len());
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_bin_champion_root() {
        assert_eq!(
            classify_bin("DATA/Characters/Kayn/Kayn.bin"),
            BinCategory::ChampionRoot
        );
        assert_eq!(
            classify_bin("data/characters/kayn/kayn.bin"),
            BinCategory::ChampionRoot
        );
    }

    #[test]
    fn test_classify_bin_animation() {
        assert_eq!(
            classify_bin("DATA/Characters/Kayn/Animations/Skin8.bin"),
            BinCategory::Animation
        );
    }

    #[test]
    fn test_classify_bin_linked_data() {
        assert_eq!(
            classify_bin("DATA/Kayn_Skins_Skin0_Skins_Skin1.bin"),
            BinCategory::LinkedData
        );
    }
}
