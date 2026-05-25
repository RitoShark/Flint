//! Tauri commands for importing ModPkg mods into Flint projects
//!
//! Provides analysis and import of ModPkg-packaged mods, with automatic
//! champion/skin detection, thumbnail extraction, and optional refathering.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use tauri::{AppHandle, Emitter};

use flint_ltk::ltk_types::Modpkg;

use crate::commands::fantome_import::{
    extract_champion_from_paths, extract_skin_id_from_path, ImportOptions,
};
use flint_ltk::project::Project;

// =============================================================================
// Types
// =============================================================================

/// Analysis result of a ModPkg file (mirrors FantomeAnalysis for frontend reuse)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModpkgAnalysis {
    /// Detected champion name (if any)
    pub champion: Option<String>,
    /// Detected skin IDs from file paths
    pub skin_ids: Vec<u32>,
    /// Whether this appears to be a champion mod
    pub is_champion_mod: bool,
    /// Total number of content files (excluding _meta_/)
    pub file_count: usize,
    /// Sample of file paths (first 50)
    pub file_paths: Vec<String>,
    /// Mod name from metadata
    pub name: Option<String>,
    /// Mod display name from metadata
    pub display_name: Option<String>,
    /// Mod description from metadata
    pub description: Option<String>,
    /// Mod version from metadata
    pub version: Option<String>,
    /// Author names from metadata
    pub authors: Vec<String>,
    /// Whether thumbnail is available
    pub has_thumbnail: bool,
}

// =============================================================================
// Commands
// =============================================================================

/// Analyze a ModPkg file to detect champion, skin IDs, metadata, and mod type
#[tauri::command]
pub async fn analyze_modpkg(modpkg_path: String) -> Result<ModpkgAnalysis, String> {
    tokio::task::spawn_blocking(move || analyze_modpkg_internal(&modpkg_path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

fn analyze_modpkg_internal(modpkg_path: &str) -> Result<ModpkgAnalysis, String> {
    let file = File::open(modpkg_path)
        .map_err(|e| format!("Failed to open modpkg file: {}", e))?;
    let reader = BufReader::new(file);

    let mut modpkg = Modpkg::mount_from_reader(reader)
        .map_err(|e| format!("Failed to read modpkg: {}", e))?;

    // Load metadata (optional — older modpkg files might not have it)
    let metadata = modpkg.load_metadata().ok();

    // Check if thumbnail exists
    let has_thumbnail = modpkg.load_thumbnail().is_ok();

    // Collect content file paths (skip _meta_/ entries)
    let content_paths: Vec<String> = modpkg
        .chunk_paths
        .values()
        .filter(|p| !p.starts_with("_meta_/"))
        .cloned()
        .collect();

    let file_count = content_paths.len();

    // Detect champion from paths
    let champion = extract_champion_from_paths(&content_paths);

    // Detect skin IDs from paths
    let mut skin_id_set: HashSet<u32> = HashSet::new();
    for path in &content_paths {
        if let Some(skin_id) = extract_skin_id_from_path(path) {
            skin_id_set.insert(skin_id);
        }
    }
    let mut skin_ids: Vec<u32> = skin_id_set.into_iter().collect();
    skin_ids.sort_unstable();

    let is_champion_mod = champion.is_some();

    // Get sample paths (first 50)
    let file_paths: Vec<String> = content_paths.into_iter().take(50).collect();

    // Extract metadata fields
    let (name, display_name, description, version, authors) = match &metadata {
        Some(m) => (
            Some(m.name.clone()),
            Some(m.display_name.clone()),
            m.description.clone(),
            Some(m.version.to_string()),
            m.authors.iter().map(|a| a.name.clone()).collect(),
        ),
        None => (None, None, None, None, vec![]),
    };

    Ok(ModpkgAnalysis {
        champion,
        skin_ids,
        is_champion_mod,
        file_count,
        file_paths,
        name,
        display_name,
        description,
        version,
        authors,
        has_thumbnail,
    })
}

/// Import a ModPkg file into a Flint project
#[tauri::command]
pub async fn import_modpkg(
    app: AppHandle,
    modpkg_path: String,
    project_dir: String,
    options: ImportOptions,
) -> Result<Project, String> {
    tokio::task::spawn_blocking(move || {
        import_modpkg_internal(&app, &modpkg_path, &project_dir, &options)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

fn import_modpkg_internal(
    app: &AppHandle,
    modpkg_path: &str,
    project_dir: &str,
    options: &ImportOptions,
) -> Result<Project, String> {
    use flint_ltk::project::save_project as core_save_project;

    let _ = app.emit(
        "modpkg-import-progress",
        serde_json::json!({
            "status": "starting",
            "message": "Initializing import..."
        }),
    );

    let project_path = Path::new(project_dir);

    // Create project directory structure
    std::fs::create_dir_all(project_path)
        .map_err(|e| format!("Failed to create project directory: {}", e))?;

    let content_path = project_path.join("content");
    std::fs::create_dir_all(&content_path)
        .map_err(|e| format!("Failed to create content directory: {}", e))?;

    let _ = app.emit(
        "modpkg-import-progress",
        serde_json::json!({
            "status": "progress",
            "message": "Opening ModPkg archive..."
        }),
    );

    // Open modpkg
    let file = File::open(modpkg_path)
        .map_err(|e| format!("Failed to open modpkg file: {}", e))?;
    let reader = BufReader::new(file);

    let mut modpkg = Modpkg::mount_from_reader(reader)
        .map_err(|e| format!("Failed to read modpkg: {}", e))?;

    // Load metadata
    let metadata = modpkg.load_metadata().ok();

    // Try to load thumbnail
    let thumbnail = modpkg.load_thumbnail().ok();

    // Collect all content chunk entries: (path_hash, layer_hash, path)
    // Skip _meta_/ entries (metadata, thumbnail, etc.)
    let chunk_entries: Vec<(u64, u64, String)> = modpkg
        .chunks
        .keys()
        .filter_map(|(path_hash, layer_hash)| {
            let path = modpkg.chunk_paths.get(path_hash)?;
            if path.starts_with("_meta_/") {
                return None;
            }
            Some((*path_hash, *layer_hash, path.clone()))
        })
        .collect();

    let total_files = chunk_entries.len();

    let _ = app.emit(
        "modpkg-import-progress",
        serde_json::json!({
            "status": "progress",
            "message": format!("Detected {} files in ModPkg...", total_files)
        }),
    );

    // Detect champion from file paths
    let paths: Vec<String> = chunk_entries.iter().map(|(_, _, p)| p.clone()).collect();
    let champion = extract_champion_from_paths(&paths)
        .ok_or("Failed to detect champion from ModPkg paths")?;

    // Detect skin IDs
    let mut skin_id_set: HashSet<u32> = HashSet::new();
    for path in &paths {
        if let Some(skin_id) = extract_skin_id_from_path(path) {
            skin_id_set.insert(skin_id);
        }
    }

    // Create WAD folder structure: content/{champion}.wad.client/
    let champion_lower = champion.to_lowercase();
    let wad_folder_name = format!("{}.wad.client", champion_lower);
    let wad_base = content_path.join(&wad_folder_name);
    std::fs::create_dir_all(&wad_base)
        .map_err(|e| format!("Failed to create WAD folder: {}", e))?;

    tracing::info!(
        "Extracting ModPkg to WAD folder: {}",
        wad_base.display()
    );

    let _ = app.emit(
        "modpkg-import-progress",
        serde_json::json!({
            "status": "progress",
            "message": format!("Extracting {} files...", total_files)
        }),
    );

    // Extract all content chunks into WAD folder
    let mut extracted_count = 0;
    let mut path_mappings = HashMap::new();

    for (path_hash, layer_hash, path) in &chunk_entries {
        // Skip testcuberenderer debug files
        let path_lower = path.to_lowercase();
        if path_lower.contains("testcuberenderer") {
            tracing::debug!("Skipping testcuberenderer file: {}", path);
            continue;
        }

        // Load and decompress chunk data
        let data = modpkg
            .load_chunk_decompressed_by_hash(*path_hash, *layer_hash)
            .map_err(|e| format!("Failed to decompress chunk '{}': {}", path, e))?;

        // Write to WAD folder
        let file_path = wad_base.join(path.trim_start_matches('/'));
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        std::fs::write(&file_path, &*data)
            .map_err(|e| format!("Failed to write file: {}", e))?;

        // Track path mappings for refathering
        path_mappings.insert(format!("{:016x}", path_hash), path.clone());
        extracted_count += 1;

        // Emit progress periodically
        let progress_interval = (total_files / 10).max(50).min(total_files);
        if extracted_count % progress_interval == 0 || extracted_count == total_files {
            let _ = app.emit(
                "modpkg-import-progress",
                serde_json::json!({
                    "status": "progress",
                    "message": format!("Extracting files... ({}/{})", extracted_count, total_files)
                }),
            );
        }
    }

    tracing::info!(
        "Extracted {} files from ModPkg to {}",
        extracted_count,
        wad_folder_name
    );

    // Save thumbnail if available
    if let Some(thumb_data) = thumbnail {
        let thumb_path = project_path.join("thumbnail.webp");
        if let Err(e) = std::fs::write(&thumb_path, &thumb_data) {
            tracing::warn!("Failed to save thumbnail: {}", e);
        } else {
            tracing::info!("Saved thumbnail from ModPkg");
        }
    }

    // Get project metadata from modpkg metadata or import options
    let creator_name = metadata
        .as_ref()
        .and_then(|m| m.authors.first())
        .map(|a| a.name.as_str())
        .or(options.creator_name.as_deref())
        .unwrap_or("FlintUser");

    let project_name = metadata
        .as_ref()
        .map(|m| {
            if m.display_name.is_empty() {
                &m.name
            } else {
                &m.display_name
            }
        })
        .filter(|n| !n.is_empty())
        .map(|s| s.as_str())
        .or(options.project_name.as_deref())
        .unwrap_or("ImportedMod");

    let description = metadata
        .as_ref()
        .and_then(|m| m.description.as_deref())
        .map(|s| s.to_string());

    let version = metadata
        .as_ref()
        .map(|m| m.version.to_string());

    let target_skin_id = options
        .target_skin_id
        .or_else(|| skin_id_set.iter().min().copied())
        .unwrap_or(0);

    tracing::info!(
        "Import metadata: creator='{}', project='{}', champion='{}', skin={}, version={:?}",
        creator_name,
        project_name,
        champion,
        target_skin_id,
        version
    );

    // Apply refathering if enabled
    if options.refather {
        let _ = app.emit(
            "modpkg-import-progress",
            serde_json::json!({
                "status": "progress",
                "message": "Applying refathering (organizing files)..."
            }),
        );

        use flint_ltk::repath::organizer::{organize_project, OrganizerConfig};

        let config = OrganizerConfig {
            enable_concat: true,
            enable_repath: true,
            creator_name: creator_name.to_string(),
            project_name: project_name.to_string(),
            champion: champion.clone(),
            target_skin_id,
            cleanup_unused: false,
            use_jade_engine: options.use_jade.unwrap_or(false),
        };

        organize_project(&content_path, &config, &path_mappings)
            .map_err(|e| format!("Failed to apply refathering: {}", e))?;

        tracing::info!("Refathering completed successfully");
    }

    // Create project
    let league_path_buf = options.league_path.as_ref().map(std::path::PathBuf::from);

    let mut project = Project::new(
        project_name,
        &champion,
        target_skin_id,
        league_path_buf.unwrap_or_else(|| std::path::PathBuf::from("")),
        project_path,
        Some(creator_name.to_string()),
    );

    // Override with modpkg metadata if available
    if let Some(desc) = description {
        project.description = desc;
    }
    if let Some(ver) = version {
        project.version = ver;
    }
    // Add all modpkg authors
    if let Some(meta) = &metadata {
        if meta.authors.len() > 1 {
            project.authors = meta.authors.iter().map(|a| a.name.clone()).collect();
        }
    }

    let _ = app.emit(
        "modpkg-import-progress",
        serde_json::json!({
            "status": "progress",
            "message": "Saving project metadata..."
        }),
    );

    // Save project files (mod.config.json and flint.json)
    core_save_project(&project).map_err(|e| format!("Failed to save project: {}", e))?;

    tracing::info!(
        "ModPkg import complete: {} files imported to {}",
        extracted_count,
        project_dir
    );

    let _ = app.emit(
        "modpkg-import-progress",
        serde_json::json!({
            "status": "complete",
            "message": format!("Import complete! {} files imported", extracted_count)
        }),
    );

    Ok(project)
}
