use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use flint_core::export::Modpkg;

use crate::commands::import_export::fantome_import::{
    extract_champion_from_paths, extract_skin_id_from_path, is_unresolved_hash, ImportOptions,
};
use flint_core::hash::{HashResolver, ProjectHashOverlay};
use flint_core::project::Project;
use crate::state::HashOverlayState;

// =============================================================================
// Types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModpkgAnalysis {
    pub champion: Option<String>,
    pub skin_ids: Vec<u32>,
    pub is_champion_mod: bool,
    pub file_count: usize,
    pub file_paths: Vec<String>,
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub authors: Vec<String>,
    pub has_thumbnail: bool,
}

// =============================================================================
// Commands
// =============================================================================

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

    let metadata = modpkg.load_metadata().ok();

    let has_thumbnail = modpkg.load_thumbnail().is_ok();

    let content_paths: Vec<String> = modpkg
        .chunk_paths
        .values()
        .filter(|p| !p.starts_with("_meta_/"))
        .cloned()
        .collect();

    let file_count = content_paths.len();

    let champion = extract_champion_from_paths(&content_paths);

    let mut skin_id_set: HashSet<u32> = HashSet::new();
    for path in &content_paths {
        if let Some(skin_id) = extract_skin_id_from_path(path) {
            skin_id_set.insert(skin_id);
        }
    }
    let mut skin_ids: Vec<u32> = skin_id_set.into_iter().collect();
    skin_ids.sort_unstable();

    let is_champion_mod = champion.is_some();

    let file_paths: Vec<String> = content_paths.into_iter().take(50).collect();

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

#[tauri::command]
pub async fn import_modpkg(
    app: AppHandle,
    modpkg_path: String,
    project_dir: String,
    options: ImportOptions,
    overlay_state: State<'_, HashOverlayState>,
) -> Result<Project, String> {
    let overlay = overlay_state.get();

    tokio::task::spawn_blocking(move || {
        import_modpkg_internal(&app, &modpkg_path, &project_dir, &options, overlay)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

fn import_modpkg_internal(
    app: &AppHandle,
    modpkg_path: &str,
    project_dir: &str,
    options: &ImportOptions,
    overlay: Option<Arc<ProjectHashOverlay>>,
) -> Result<Project, String> {
    use flint_core::project::save_project as core_save_project;

    let _ = app.emit(
        "modpkg-import-progress",
        serde_json::json!({
            "status": "starting",
            "message": "Initializing import..."
        }),
    );

    let project_path = Path::new(project_dir);

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

    let file = File::open(modpkg_path)
        .map_err(|e| format!("Failed to open modpkg file: {}", e))?;
    let reader = BufReader::new(file);

    let mut modpkg = Modpkg::mount_from_reader(reader)
        .map_err(|e| format!("Failed to read modpkg: {}", e))?;

    let metadata = modpkg.load_metadata().ok();

    let thumbnail = modpkg.load_thumbnail().ok();

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

    // We will extract files and scan them for hashes in a single pass later.
    let hash_dir = flint_core::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("Hash directory not found: {}", e))?;

    let total_files = chunk_entries.len();

    let _ = app.emit(
        "modpkg-import-progress",
        serde_json::json!({
            "status": "progress",
            "message": format!("Detected {} files in ModPkg...", total_files)
        }),
    );

    let paths: Vec<String> = chunk_entries.iter().map(|(_, _, p)| p.clone()).collect();
    let resolver = HashResolver::new(&hash_dir, overlay.as_ref());

    let mut resolved_modpkg_paths: Vec<String> = Vec::with_capacity(paths.len());
    for (i, path) in paths.iter().enumerate() {
        if is_unresolved_hash(path) {
            let path_hash = chunk_entries[i].0;
            let resolved = resolver.resolve_wad(&[path_hash]);
            if let Some(res) = resolved.first() {
                if !is_unresolved_hash(res) {
                    resolved_modpkg_paths.push(res.to_string());
                    continue;
                }
            }
        }
        resolved_modpkg_paths.push(path.clone());
    }
    
    // Update chunk_entries to use resolved paths
    let chunk_entries: Vec<(u64, u64, String)> = chunk_entries.into_iter().enumerate().map(|(i, (ph, lh, _))| {
        (ph, lh, resolved_modpkg_paths[i].clone())
    }).collect();

    let champion = options.champion.clone().or_else(|| {
        extract_champion_from_paths(&resolved_modpkg_paths)
    }).ok_or("Failed to detect champion from ModPkg paths, and no champion provided")?;

    let mut skin_id_set: HashSet<u32> = HashSet::new();
    for path in &resolved_modpkg_paths {
        if let Some(skin_id) = extract_skin_id_from_path(path) {
            skin_id_set.insert(skin_id);
        }
    }

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

    let mut extracted_count = 0;
    let mut path_mappings = HashMap::new();
    let mut unresolved_files = Vec::new();
    let mut unresolved_count = 0;
    let total_files = chunk_entries.len();

    let mut game = std::collections::BTreeMap::new();
    let mut bin = std::collections::BTreeMap::new();

    for (path_hash, layer_hash, path) in &chunk_entries {
        let path_lower = path.to_lowercase();
        if path_lower.contains("testcuberenderer") {
            tracing::debug!("Skipping testcuberenderer file: {}", path);
            continue;
        }

        let data = modpkg
            .load_chunk_decompressed_by_hash(*path_hash, *layer_hash)
            .map_err(|e| format!("Failed to decompress chunk '{}': {}", path, e))?;

        if data.len() >= 4 {
            let head = &data[..4];
            let is_bin = head == b"PROP" || head == b"PTCH";
            let is_skn = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) == 0x0011_2233;
            if is_bin || is_skn {
                crate::commands::wad::extract_hashes::scan_one(&data, &mut game, &mut bin);
            }
        }

        let mut final_path = PathBuf::from(path.clone());
        let mut is_unresolved = false;
        if is_unresolved_hash(path) {
            unresolved_count += 1;
            is_unresolved = true;
            tracing::debug!("Unresolved hash in ModPkg: {}", path);
            let ext = crate::commands::import_export::fantome_import::guess_extension(&data);
            final_path.set_extension(ext);
        }

        let filename_len = final_path.to_string_lossy().len();

        let out_path = if filename_len > 200 {
            let parent = final_path.parent().unwrap_or_else(|| Path::new("data"));
            let ext = final_path.extension().and_then(|e| e.to_str()).unwrap_or("bin");
            let hash_name = format!("{:016x}.{}", path_hash, ext);
            let hash_path = parent.join(&hash_name);

            let orig = final_path.to_string_lossy().to_lowercase().replace('\\', "/");
            let act  = hash_path.to_string_lossy().to_lowercase().replace('\\', "/");
            path_mappings.insert(orig, act);

            wad_base.join(hash_path)
        } else {
            wad_base.join(&final_path)
        };

        let file_path = out_path.clone();
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        std::fs::write(&file_path, &*data)
            .map_err(|e| format!("Failed to write file: {}", e))?;

        if is_unresolved {
            let ext = final_path.extension().and_then(|e| e.to_str()).unwrap_or("dat").to_string();
            unresolved_files.push((
                *path_hash,
                ext,
                out_path,
                path.clone(),
            ));
        }

        extracted_count += 1;

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

    if unresolved_count > 0 {
        tracing::warn!(
            "Found {} unresolved hashes (custom repathed files) - preserving as-is",
            unresolved_count
        );
    }

    tracing::info!(
        "Extracted {} files from ModPkg to {}",
        extracted_count,
        wad_folder_name
    );

    // Merge discovered hashes into LMDB database immediately after extraction
    if !game.is_empty() || !bin.is_empty() {
        let hash_dir_path = Path::new(&hash_dir);
        if let Err(e) = crate::commands::wad::extract_hashes::extract_and_merge_hashes(hash_dir_path, game, bin) {
            tracing::warn!("Failed to auto-unhash modpkg files during import: {}", e);
        }
    }

    flint_core::hash::lmdb_cache::drop_lmdb_cache();

    // Re-resolve unresolved paths and rename files on disk
    if !unresolved_files.is_empty() {
        let hashes_to_resolve: Vec<u64> = unresolved_files.iter().map(|(h, _, _, _)| *h).collect();
        let resolver = HashResolver::new(&hash_dir, overlay.as_ref());
        let newly_resolved = resolver.resolve_wad(&hashes_to_resolve);

        let mut resolved_count = 0;
        for ((hash, guessed_ext, old_path_on_disk, original_path_key), resolved_path) in unresolved_files.iter().zip(newly_resolved.iter()) {
            if !is_unresolved_hash(resolved_path) {
                // It is now resolved!
                let final_path = PathBuf::from(resolved_path.clone());
                let filename_len = final_path.to_string_lossy().len();

                if filename_len > 200 {
                    let parent = final_path.parent().unwrap_or_else(|| Path::new("data"));
                    let ext = final_path.extension().and_then(|e| e.to_str()).unwrap_or(guessed_ext.as_str());
                    let hash_name = format!("{:016x}.{}", hash, ext);
                    let hash_path = parent.join(&hash_name);

                    let orig = final_path.to_string_lossy().to_lowercase().replace('\\', "/");
                    let act  = hash_path.to_string_lossy().to_lowercase().replace('\\', "/");
                    path_mappings.insert(orig, act);

                    let new_out_path = wad_base.join(hash_path);
                    if old_path_on_disk.exists() {
                        if let Some(p) = new_out_path.parent() {
                            std::fs::create_dir_all(p).unwrap_or_default();
                        }
                        if let Err(e) = std::fs::rename(old_path_on_disk, &new_out_path) {
                            tracing::warn!("Failed to rename resolved long path file: {}", e);
                        }
                    }
                } else {
                    let new_out_path = wad_base.join(&final_path);
                    if old_path_on_disk.exists() {
                        if let Some(p) = new_out_path.parent() {
                            std::fs::create_dir_all(p).unwrap_or_default();
                        }
                        if let Err(e) = std::fs::rename(old_path_on_disk, &new_out_path) {
                            tracing::warn!("Failed to rename resolved file to {}: {}", new_out_path.display(), e);
                        } else {
                            resolved_count += 1;
                        }
                    }
                }
            } else {
                // Still unresolved. Add to path_mappings to map the extensionless path to the file with extension
                let orig = original_path_key.to_lowercase().replace('\\', "/");
                if let Ok(rel_path) = old_path_on_disk.strip_prefix(&wad_base) {
                    let act = rel_path.to_string_lossy().to_lowercase().replace('\\', "/");
                    path_mappings.insert(orig, act);
                }
            }
        }
        tracing::info!("Re-resolved and renamed {}/{} unresolved files after hash extraction", resolved_count, unresolved_files.len());
    }

    if let Some(thumb_data) = thumbnail {
        let thumb_path = project_path.join("thumbnail.webp");
        
        // Try decoding using the image crate and converting to WebP
        if let Ok(img) = image::load_from_memory(&thumb_data) {
            match File::create(&thumb_path) {
                Ok(webp_file) => {
                    let mut writer = std::io::BufWriter::new(webp_file);
                    if let Err(e) = img.write_to(&mut writer, image::ImageFormat::WebP) {
                        tracing::warn!("Failed to write WebP thumbnail, saving raw: {}", e);
                        let _ = std::fs::write(&thumb_path, &thumb_data);
                    } else {
                        tracing::info!("Saved converted thumbnail to WebP format from ModPkg");
                    }
                }
                Err(_) => {
                    let _ = std::fs::write(&thumb_path, &thumb_data);
                }
            }
        } else if let Err(e) = std::fs::write(&thumb_path, &thumb_data) {
            tracing::warn!("Failed to save thumbnail: {}", e);
        } else {
            tracing::info!("Saved thumbnail from ModPkg as-is");
        }
    }

    // Recover game files the ModPkg references but doesn't bundle, pulling them
    // from the League install. Must run BEFORE refathering so the recovered files
    // are organised and repathed alongside everything else.
    if options.match_from_league {
        if let Some(ref league_path) = options.league_path {
            let _ = app.emit(
                "modpkg-import-progress",
                serde_json::json!({
                    "status": "progress",
                    "message": "Matching missing files from League..."
                }),
            );

            let hash_dir = flint_core::hash::get_hash_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| format!("Hash directory not found: {}", e))?;

            let existing_hashes: HashSet<u64> =
                chunk_entries.iter().map(|(path_hash, _, _)| *path_hash).collect();

            let report = super::missing_files::recover_missing_files_from_league(
                app,
                "modpkg-import-progress",
                &wad_base,
                league_path,
                &hash_dir,
                overlay.clone(),
                &champion,
                &existing_hashes,
            )
            .map_err(|e| format!("Failed to recover missing files: {}", e))?;

            tracing::info!(
                "Recovery: {} file(s) pulled from League across {} scanned BIN(s)",
                report.recovered_files,
                report.scanned_bins
            );

            if !report.still_missing.is_empty() {
                tracing::warn!(
                    "{} linked file(s) could not be recovered from League: {:?}",
                    report.still_missing.len(),
                    report.still_missing
                );
                let _ = app.emit(
                    "modpkg-import-progress",
                    serde_json::json!({
                        "status": "progress",
                        "message": format!("{} referenced file(s) could not be recovered", report.still_missing.len())
                    }),
                );
            }
        }
    }

    let creator_name = options.creator_name.as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            metadata.as_ref()
                .and_then(|m| m.authors.first())
                .map(|a| a.name.as_str())
        })
        .unwrap_or("FlintUser");

    let project_name = options.project_name.as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            metadata.as_ref()
                .map(|m| {
                    if m.display_name.is_empty() {
                        &m.name
                    } else {
                        &m.display_name
                    }
                })
                .filter(|n| !n.is_empty())
                .map(|s| s.as_str())
        })
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

    if options.refather {
        let _ = app.emit(
            "modpkg-import-progress",
            serde_json::json!({
                "status": "progress",
                "message": "Applying refathering (organizing files)..."
            }),
        );

        use flint_core::repath::organizer::{organize_project, OrganizerConfig};

        let config = OrganizerConfig {
            enable_concat: true,
            enable_repath: true,
            creator_name: creator_name.to_string(),
            project_name: project_name.to_string(),
            champion: champion.clone(),
            target_skin_id,
            cleanup_unused: false,
            wad_folder_override: None,
            skip_bin_cleanup: true,
            delete_sources: false,
            consolidate_vfx: true,
            cleanup_pipeline: true,
        };

        organize_project(&content_path, &config, &path_mappings)
            .map_err(|e| format!("Failed to apply refathering: {}", e))?;

        tracing::info!("Refathering completed successfully");
    }

    let league_path_buf = options.league_path.as_ref().map(std::path::PathBuf::from);

    let mut project = Project::new(
        project_name,
        &champion,
        target_skin_id,
        league_path_buf.unwrap_or_else(|| std::path::PathBuf::from("")),
        project_path,
        Some(creator_name.to_string()),
    );

    if let Some(desc) = description {
        project.description = desc;
    }
    if let Some(ver) = version {
        project.version = ver;
    }
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
