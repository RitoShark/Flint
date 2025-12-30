//! Repathing engine for modifying asset paths in BIN files
//!
//! This module implements the "bumpath" algorithm that:
//! 1. Scans BIN files for string values containing asset paths (assets/, data/)
//! 2. Prefixes those paths with a unique identifier (ASSETS/{creator}/{project})
//! 3. Relocates the actual asset files to match the new paths
//! 4. Optionally combines linked BINs into a single concat BIN

use crate::core::bin::ltk_bridge::{read_bin, write_bin};
use crate::error::{Error, Result};
use ltk_meta::PropertyValueEnum;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Configuration for repathing operations
/// 
/// Note: BIN concatenation is now handled separately by the organizer module.
/// This config is purely for path modification operations.
#[derive(Debug, Clone)]
pub struct RepathConfig {
    pub creator_name: String,
    pub project_name: String,
    pub champion: String,
    pub target_skin_id: u32,
    pub cleanup_unused: bool,
}

impl RepathConfig {
    pub fn prefix(&self) -> String {
        let creator = self.creator_name.replace(' ', "-");
        let project = self.project_name.replace(' ', "-");
        format!("{}/{}", creator, project)
    }
}

/// Result of a repathing operation
#[derive(Debug, Clone)]
pub struct RepathResult {
    pub bins_processed: usize,
    pub paths_modified: usize,
    pub files_relocated: usize,
    pub files_removed: usize,
    pub missing_paths: Vec<String>,
}

/// Repath all assets in a project directory
pub fn repath_project(
    content_base: &Path,
    config: &RepathConfig,
    path_mappings: &HashMap<String, String>,
) -> Result<RepathResult> {
    tracing::info!(
        "Starting repathing for project with prefix: ASSETS/{}",
        config.prefix()
    );

    if !content_base.exists() {
        return Err(Error::InvalidInput(format!(
            "Content base directory not found: {}",
            content_base.display()
        )));
    }

    // Compute the WAD folder path: content_base/{champion}.wad.client/
    // This is required for league-mod compatible project structure
    let champion_lower = config.champion.to_lowercase();
    let wad_folder_name = format!("{}.wad.client", champion_lower);
    let wad_base = content_base.join(&wad_folder_name);
    
    // Determine which base to use for file operations
    // Use WAD folder if it exists (new structure), otherwise fall back to content_base (legacy)
    let file_base = if wad_base.exists() {
        tracing::info!("Using WAD folder structure: {}", wad_base.display());
        &wad_base
    } else {
        tracing::info!("Using legacy folder structure (no WAD folder found)");
        content_base
    };

    let mut result = RepathResult {
        bins_processed: 0,
        paths_modified: 0,
        files_relocated: 0,
        files_removed: 0,
        missing_paths: Vec::new(),
    };

    // Step 0: Find the main skin BIN (now using file_base)
    let main_bin_path = if !config.champion.is_empty() {
        find_main_skin_bin(file_base, &config.champion, config.target_skin_id)
    } else {
        None
    };

    let mut bin_files: Vec<PathBuf> = Vec::new();

    if let Some(ref main_path) = main_bin_path {
        tracing::info!("Found main skin BIN: {}", main_path.display());
        bin_files.push(main_path.clone());

        // Read the main BIN to get its linked BINs
        if let Ok(data) = fs::read(main_path) {
            if let Ok(bin) = read_bin(&data) {
                tracing::info!("Main skin BIN has {} dependencies", bin.dependencies.len());
                
                for dep_path in &bin.dependencies {
                    let normalized_path = dep_path.to_lowercase().replace('\\', "/");

                    let actual_path = path_mappings.get(&normalized_path)
                        .cloned()
                        .unwrap_or_else(|| normalized_path.clone());
                    
                    let full_path = file_base.join(&actual_path);
                    if full_path.exists() {
                        bin_files.push(full_path);
                    } else {
                        tracing::warn!("Linked BIN not found: {}", normalized_path);
                    }
                }
            }
        }
    } else {
        tracing::warn!("No main skin BIN found, falling back to scanning all BINs");
        bin_files = WalkDir::new(file_base)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .map(|ext| ext.eq_ignore_ascii_case("bin"))
                    .unwrap_or(false)
            })
            .map(|e| e.path().to_path_buf())
            .collect();
    }

    tracing::info!("Processing {} BIN files", bin_files.len());

    // Note: BIN concatenation is now handled by the organizer module.
    // This function focuses purely on path modification.

    // Step 2: Scan BINs to collect referenced asset paths
    let mut all_asset_paths: HashSet<String> = HashSet::new();
    for bin_path in &bin_files {
        if let Ok(paths) = scan_bin_for_paths(bin_path) {
            all_asset_paths.extend(paths);
        }
    }
    tracing::info!("Found {} unique asset paths in BINs", all_asset_paths.len());

    // Step 3: Determine which paths actually exist
    // Use case-insensitive matching since Windows filesystem is case-insensitive
    let existing_paths: HashSet<String> = all_asset_paths
        .iter()
        .filter(|path| {
            let full_path = file_base.join(path);
            if full_path.exists() {
                return true;
            }
            
            // Try case-insensitive lookup by checking parent directory
            if let Some(parent) = full_path.parent() {
                if parent.exists() {
                    if let Some(filename) = full_path.file_name() {
                        let filename_lower = filename.to_string_lossy().to_lowercase();
                        if let Ok(entries) = std::fs::read_dir(parent) {
                            for entry in entries.filter_map(|e| e.ok()) {
                                let entry_name = entry.file_name().to_string_lossy().to_lowercase();
                                if entry_name == filename_lower {
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            
            false
        })
        .cloned()
        .collect();

    // Log missing paths for debugging
    let missing_count = all_asset_paths.len() - existing_paths.len();
    if missing_count > 0 {
        tracing::warn!("{} asset paths referenced in BINs but not found on disk:", missing_count);
        for path in all_asset_paths.difference(&existing_paths).take(10) {
            tracing::warn!("  Missing: {}", path);
        }
        if missing_count > 10 {
            tracing::warn!("  ... and {} more", missing_count - 10);
        }
    }

    for path in all_asset_paths.difference(&existing_paths) {
        result.missing_paths.push(path.clone());
    }

    // Step 4: Repath BIN files
    let prefix = config.prefix();
    for bin_path in &bin_files {
        match repath_bin_file(bin_path, &existing_paths, &prefix) {
            Ok(modified_count) => {
                result.bins_processed += 1;
                result.paths_modified += modified_count;
            }
            Err(e) => {
                tracing::warn!("Failed to repath {}: {}", bin_path.display(), e);
            }
        }
    }

    // Step 5: Relocate asset files
    result.files_relocated = relocate_assets(file_base, &existing_paths, &prefix)?;

    // Step 6: Clean up unused files
    if config.cleanup_unused {
        result.files_removed = cleanup_unused_files(file_base, &existing_paths, &prefix)?;
    }

    // Step 7: Clean up irrelevant extracted BINs
    cleanup_irrelevant_bins(file_base, &config.champion, config.target_skin_id)?;

    // Step 8: Clean up empty directories
    cleanup_empty_dirs(file_base)?;

    tracing::info!(
        "Repathing complete: {} bins, {} paths modified, {} files relocated",
        result.bins_processed,
        result.paths_modified,
        result.files_relocated
    );

    Ok(result)
}

/// Scan a BIN file for asset path references
fn scan_bin_for_paths(bin_path: &Path) -> Result<Vec<String>> {
    let data = fs::read(bin_path).map_err(|e| Error::io_with_path(e, bin_path))?;
    let bin = read_bin(&data)
        .map_err(|e| Error::InvalidInput(format!("Failed to parse BIN: {}", e)))?;

    let mut paths = Vec::new();

    for object in bin.objects.values() {
        for prop in object.properties.values() {
            collect_paths_from_value(&prop.value, &mut paths);
        }
    }

    Ok(paths)
}

/// Recursively collect asset paths from a PropertyValueEnum
fn collect_paths_from_value(value: &PropertyValueEnum, paths: &mut Vec<String>) {
    match value {
        PropertyValueEnum::String(s) => {
            if is_asset_path(&s.0) {
                paths.push(normalize_path(&s.0));
            }
        }
        PropertyValueEnum::Container(c) => {
            for item in &c.items {
                collect_paths_from_value(item, paths);
            }
        }
        PropertyValueEnum::UnorderedContainer(c) => {
            for item in &c.0.items {
                collect_paths_from_value(item, paths);
            }
        }
        PropertyValueEnum::Struct(s) => {
            for prop in s.properties.values() {
                collect_paths_from_value(&prop.value, paths);
            }
        }
        PropertyValueEnum::Embedded(e) => {
            for prop in e.0.properties.values() {
                collect_paths_from_value(&prop.value, paths);
            }
        }
        PropertyValueEnum::Optional(o) => {
            if let Some(inner) = &o.value {
                collect_paths_from_value(inner.as_ref(), paths);
            }
        }
        PropertyValueEnum::Map(m) => {
            for (key, val) in &m.entries {
                collect_paths_from_value(&key.0, paths);
                collect_paths_from_value(val, paths);
            }
        }
        _ => {}
    }
}

fn is_asset_path(s: &str) -> bool {
    let lower = s.to_lowercase();
    lower.starts_with("assets/") || lower.starts_with("data/")
}

fn normalize_path(s: &str) -> String {
    s.to_lowercase().replace('\\', "/")
}

fn apply_prefix_to_path(path: &str, prefix: &str) -> String {
    let lower = path.to_lowercase();
    if lower.starts_with("assets/") {
        format!("ASSETS/{}{}", prefix, &path[6..])
    } else if lower.starts_with("data/") {
        format!("ASSETS/{}{}", prefix, &path[4..])
    } else {
        format!("ASSETS/{}/{}", prefix, path)
    }
}

/// Repath a single BIN file
fn repath_bin_file(bin_path: &Path, existing_paths: &HashSet<String>, prefix: &str) -> Result<usize> {
    let data = fs::read(bin_path).map_err(|e| Error::io_with_path(e, bin_path))?;
    let mut bin = read_bin(&data)
        .map_err(|e| Error::InvalidInput(format!("Failed to parse BIN: {}", e)))?;

    let mut modified_count = 0;

    for object in bin.objects.values_mut() {
        for prop in object.properties.values_mut() {
            modified_count += repath_value(&mut prop.value, existing_paths, prefix);
        }
    }

    if modified_count > 0 {
        let new_data = write_bin(&bin)
            .map_err(|e| Error::InvalidInput(format!("Failed to write BIN: {}", e)))?;

        fs::write(bin_path, new_data).map_err(|e| Error::io_with_path(e, bin_path))?;
        tracing::debug!("Repathed {} paths in {}", modified_count, bin_path.display());
    }

    Ok(modified_count)
}

/// Recursively repath string values in a PropertyValueEnum
fn repath_value(value: &mut PropertyValueEnum, existing_paths: &HashSet<String>, prefix: &str) -> usize {
    let mut count = 0;

    match value {
        PropertyValueEnum::String(s) => {
            if is_asset_path(&s.0) {
                let normalized = normalize_path(&s.0);
                if existing_paths.contains(&normalized) {
                    s.0 = apply_prefix_to_path(&s.0, prefix);
                    count += 1;
                }
            }
        }
        PropertyValueEnum::Container(c) => {
            for item in &mut c.items {
                count += repath_value(item, existing_paths, prefix);
            }
        }
        PropertyValueEnum::UnorderedContainer(c) => {
            for item in &mut c.0.items {
                count += repath_value(item, existing_paths, prefix);
            }
        }
        PropertyValueEnum::Struct(s) => {
            for prop in s.properties.values_mut() {
                count += repath_value(&mut prop.value, existing_paths, prefix);
            }
        }
        PropertyValueEnum::Embedded(e) => {
            for prop in e.0.properties.values_mut() {
                count += repath_value(&mut prop.value, existing_paths, prefix);
            }
        }
        PropertyValueEnum::Optional(o) => {
            if let Some(inner) = &mut o.value {
                count += repath_value(inner.as_mut(), existing_paths, prefix);
            }
        }
        PropertyValueEnum::Map(m) => {
            // Note: Map keys are immutable (wrapped in PropertyValueUnsafeEq)
            // Only values can be repathed
            for val in m.entries.values_mut() {
                count += repath_value(val, existing_paths, prefix);
            }
        }
        _ => {}
    }

    count
}

fn relocate_assets(content_base: &Path, existing_paths: &HashSet<String>, prefix: &str) -> Result<usize> {
    let mut relocated = 0;

    for path in existing_paths {
        if path.to_lowercase().ends_with(".bin") {
            continue;
        }
        
        let source = content_base.join(path);
        let new_path = apply_prefix_to_path(path, prefix);
        let dest = content_base.join(&new_path);

        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
        }

        if source.exists() {
            fs::copy(&source, &dest).map_err(|e| Error::io_with_path(e, &source))?;
            fs::remove_file(&source).map_err(|e| Error::io_with_path(e, &source))?;
            relocated += 1;
        }
    }

    Ok(relocated)
}

fn cleanup_unused_files(content_base: &Path, referenced_paths: &HashSet<String>, prefix: &str) -> Result<usize> {
    let mut removed = 0;

    let expected_paths: HashSet<String> = referenced_paths
        .iter()
        .map(|p| normalize_path(&apply_prefix_to_path(p, prefix)))
        .collect();

    for entry in WalkDir::new(content_base)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if ext.eq_ignore_ascii_case("bin") {
                continue;
            }
        }

        if let Ok(rel_path) = path.strip_prefix(content_base) {
            let normalized = normalize_path(&rel_path.to_string_lossy());
            if !expected_paths.contains(&normalized) {
                if let Err(e) = fs::remove_file(path) {
                    tracing::warn!("Failed to remove {}: {}", path.display(), e);
                } else {
                    removed += 1;
                }
            }
        }
    }

    Ok(removed)
}

/// Remove all extracted BINs except:
/// 1. Main skin BIN (skins/skin{ID}.bin)
/// 2. Animation BIN (animations/skin{ID}.bin) 
/// 3. Concat BIN (__Concat.bin)
/// 
/// This uses a whitelist approach - everything else is deleted.
fn cleanup_irrelevant_bins(content_base: &Path, champion: &str, target_skin_id: u32) -> Result<usize> {
    let mut removed = 0;
    let champion_lower = champion.to_lowercase();
    
    // Patterns for BINs we want to KEEP
    let target_skin_name = format!("skin{}.bin", target_skin_id);
    let target_skin_name_padded = format!("skin{:02}.bin", target_skin_id);

    tracing::info!(
        "Cleaning up BINs (keeping only: {}, {}, and __Concat.bin)",
        target_skin_name,
        target_skin_name_padded
    );

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

            // === WHITELIST: BINs we KEEP ===
            
            // 1. Keep the concatenated BIN
            if filename.contains("__concat") {
                tracing::debug!("Keeping concat BIN: {}", rel_str);
                continue;
            }

            // 2. Keep the main skin BIN in skins folder
            if rel_str.contains("/skins/") && 
               (filename == target_skin_name || filename == target_skin_name_padded) {
                tracing::debug!("Keeping main skin BIN: {}", rel_str);
                continue;
            }

            // 3. Keep the animation BIN for the target skin
            if rel_str.contains("/animations/") && 
               (filename == target_skin_name || filename == target_skin_name_padded) {
                tracing::debug!("Keeping animation BIN: {}", rel_str);
                continue;
            }

            // === EVERYTHING ELSE IS DELETED ===
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
    
    if removed > 0 {
        tracing::info!("Cleaned up {} irrelevant BIN files", removed);
    }
    
    Ok(removed)
}

fn cleanup_empty_dirs(dir: &Path) -> Result<()> {
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

fn find_main_skin_bin(content_base: &Path, champion: &str, skin_id: u32) -> Option<PathBuf> {
    let champion_lower = champion.to_lowercase();
    
    let patterns = vec![
        format!("data/characters/{}/skins/skin{}.bin", champion_lower, skin_id),
        format!("data/characters/{}/skins/skin{:02}.bin", champion_lower, skin_id),
    ];
    
    for pattern in &patterns {
        let direct_path = content_base.join(pattern);
        if direct_path.exists() {
            return Some(direct_path);
        }
    }

    // Fallback: search for any matching BIN
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
                if rel_str == *pattern {
                    return Some(path.to_path_buf());
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_asset_path() {
        assert!(is_asset_path("assets/characters/ahri/skin0.bin"));
        assert!(is_asset_path("data/effects.bin"));
        assert!(!is_asset_path("some/other/path.txt"));
    }

    #[test]
    fn test_apply_prefix_to_path() {
        assert_eq!(
            apply_prefix_to_path("assets/characters/ahri/skin.dds", "SirDexal/MyMod"),
            "ASSETS/SirDexal/MyMod/characters/ahri/skin.dds"
        );
    }
}
