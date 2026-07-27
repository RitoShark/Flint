//! Project file listing, tree building, and BIN preconversion.

use flint_core::project::Project;
use flint_core::bin::{classify_bin, BinCategory};
use crate::core::ipc_trace;
use super::project::open_project;
use std::path::{Path, PathBuf};
use tauri::Emitter;
#[tauri::command]
pub async fn list_project_files(project_path: String) -> Result<serde_json::Value, String> {
    let _t = ipc_trace::enter("list_project_files");
    use serde_json::{json, Map, Value};
    use std::collections::HashMap;
    use std::path::PathBuf as StdPathBuf;
    use walkdir::WalkDir;

    let path = PathBuf::from(&project_path);

    if !path.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    // Iterative tree builder (must stay iterative — recursion overflows rayon
    // worker stacks on deep WAD trees):
    //   1. WalkDir collects all entries depth-first (dir before its children).
    //   2. Pre-allocate a Map for every directory keyed by its absolute path.
    //   3. Iterate in REVERSE so every child is fully assembled before its
    //      parent, then pop the child's map and embed it as "children".
    fn build_tree(root: &std::path::Path, base: &std::path::Path) -> Value {
        let entries: Vec<_> = WalkDir::new(root)
            .into_iter()
            .filter_map(|e| e.ok())
            .skip(1)
            .filter(|e| !e.file_name().to_string_lossy().ends_with(".ritobin"))
            .collect();

        let mut dir_maps: HashMap<StdPathBuf, Map<String, Value>> = HashMap::new();
        dir_maps.insert(root.to_path_buf(), Map::new());
        for e in &entries {
            if e.file_type().is_dir() {
                dir_maps.insert(e.path().to_path_buf(), Map::new());
            }
        }

        for entry in entries.into_iter().rev() {
            let entry_path = entry.path().to_path_buf();
            let parent = match entry_path.parent() {
                Some(p) => p.to_path_buf(),
                None => continue,
            };
            let name = entry_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let rel = entry_path
                .strip_prefix(base)
                .unwrap_or(&entry_path)
                .to_string_lossy()
                .replace('\\', "/");

            let node = if entry.file_type().is_dir() {
                let children = dir_maps.remove(&entry_path).unwrap_or_default();
                json!({ "path": rel, "children": Value::Object(children) })
            } else {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                json!({ "path": rel, "size": size })
            };

            if let Some(parent_map) = dir_maps.get_mut(&parent) {
                parent_map.insert(name, node);
            }
        }

        Value::Object(dir_maps.remove(root).unwrap_or_default())
    }

    let tree = tokio::task::spawn_blocking(move || build_tree(&path, &path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?;

    Ok(tree)
}

/// Combined open + list-files. One IPC round-trip replacing the
/// `open_project` + `list_project_files` sequence used in
/// [FileTree.handleOpenProject] every time the user opens a project.
#[derive(serde::Serialize)]
pub struct OpenProjectWithTree {
    pub project: Project,
    pub file_tree: serde_json::Value,
}

#[tauri::command]
pub async fn open_project_with_tree(path: String) -> Result<OpenProjectWithTree, String> {
    let _t = ipc_trace::enter("open_project_with_tree");
    let project = open_project(path).await?;
    let project_path = project.project_path.to_string_lossy().to_string();
    let file_tree = list_project_files(project_path).await?;
    Ok(OpenProjectWithTree { project, file_tree })
}

/// Pre-convert all BIN files in a project to .ritobin format so opening them
/// later is instant. Returns the number of BIN files converted.
#[tauri::command]
pub async fn preconvert_project_bins(
    project_path: String,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use rayon::prelude::*;
    use walkdir::WalkDir;

    tracing::info!("Pre-converting BIN files in project: {}", project_path);

    let path = std::path::PathBuf::from(&project_path);
    if !path.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    // Pre-warm the hash cache on this thread before workers access it.
    tracing::info!("Pre-warming BIN hash cache...");
    let _ = flint_core::bin::get_cached_bin_hashes();
    tracing::info!("Hash cache ready");

    let bin_files: Vec<_> = WalkDir::new(&path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().extension()
                .map(|ext| ext == "bin")
                .unwrap_or(false)
        })
        .filter(|e| {
            if let Ok(rel_path) = e.path().strip_prefix(&path) {
                let rel_str = rel_path.to_string_lossy();
                let category = classify_bin(&rel_str);

                // Corrupt/recursive names.
                if category == BinCategory::Ignore {
                    tracing::warn!("Skipping suspicious BIN file: {}", rel_str);
                    return false;
                }

                // Animation BINs can have metadata that doesn't round-trip.
                if category == BinCategory::Animation {
                    tracing::debug!("Skipping animation BIN: {}", rel_str);
                    return false;
                }

                // ChampionRoot BINs reference game data.
                if category == BinCategory::ChampionRoot {
                    tracing::debug!("Skipping champion root BIN: {}", rel_str);
                    return false;
                }
            }
            true
        })
        .map(|e| e.path().to_path_buf())
        .collect();

    let total = bin_files.len();
    tracing::info!("Found {} BIN files to convert", total);

    let _ = app.emit("bin-convert-progress", serde_json::json!({
        "current": 0,
        "total": total,
        "file": "",
        "status": "starting"
    }));

    // Skip files whose .ritobin cache is already up-to-date.
    let files_to_convert: Vec<_> = bin_files.iter()
        .filter(|bin_path| {
            let ritobin_path = format!("{}.ritobin", bin_path.display());
            let ritobin_file = std::path::Path::new(&ritobin_path);
            
            if ritobin_file.exists() {
                if let (Ok(bin_meta), Ok(ritobin_meta)) = (fs::metadata(bin_path), fs::metadata(ritobin_file)) {
                    if let (Ok(bin_time), Ok(ritobin_time)) = (bin_meta.modified(), ritobin_meta.modified()) {
                        if ritobin_time >= bin_time {
                            tracing::debug!("[PRECONVERT] CACHE HIT - skipping: {}", bin_path.file_name().unwrap_or_default().to_string_lossy());
                            return false;
                        } else {
                            tracing::debug!("[PRECONVERT] CACHE STALE - will convert: {}", bin_path.file_name().unwrap_or_default().to_string_lossy());
                        }
                    }
                }
            } else {
                tracing::debug!("[PRECONVERT] NO CACHE - will convert: {}", bin_path.file_name().unwrap_or_default().to_string_lossy());
            }
            true
        })
        .cloned()
        .collect();

    let cache_hits = total - files_to_convert.len();
    let to_convert_count = files_to_convert.len();
    tracing::info!("[PRECONVERT] {} files need conversion, {} CACHE HITS (already up-to-date)",
        to_convert_count, cache_hits);

    let converted = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicUsize::new(0));

    // Batch to control peak memory usage.
    const BATCH_SIZE: usize = 50;

    for (batch_idx, batch) in files_to_convert.chunks(BATCH_SIZE).enumerate() {
        let batch_start = batch_idx * BATCH_SIZE;

        let _ = app.emit("bin-convert-progress", serde_json::json!({
            "current": batch_start,
            "total": to_convert_count,
            "file": format!("Batch {}/{}", batch_idx + 1, to_convert_count.div_ceil(BATCH_SIZE)),
            "status": "converting"
        }));

        let converted_clone = Arc::clone(&converted);
        let failed_clone = Arc::clone(&failed);

        batch.par_iter().for_each(|bin_path| {
            let bin_path_str = bin_path.to_string_lossy().to_string();
            
            match convert_bin_file_sync(&bin_path_str) {
                Ok(_) => {
                    converted_clone.fetch_add(1, Ordering::Relaxed);
                    tracing::debug!("Converted: {}", bin_path.display());
                }
                Err(e) => {
                    failed_clone.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!("Failed to convert {}: {}", bin_path.display(), e);
                }
            }
        });

        let current_converted = converted.load(Ordering::Relaxed);
        tracing::info!("Batch {} complete: {} converted so far", batch_idx + 1, current_converted);
    }

    let final_converted = converted.load(Ordering::Relaxed);
    let final_failed = failed.load(Ordering::Relaxed);

    let _ = app.emit("bin-convert-progress", serde_json::json!({
        "current": total,
        "total": total,
        "file": "",
        "status": "complete"
    }));
    
    tracing::info!("Pre-converted {} BIN files ({} failed, {} skipped)", 
        final_converted, final_failed, total - to_convert_count);
    Ok(final_converted)
}

/// Synchronously convert a single BIN file to ritobin (used from rayon workers).
fn convert_bin_file_sync(bin_path: &str) -> Result<(), String> {
    use std::fs;
    use flint_core::bin::{read_bin, tree_to_text_cached, MAX_BIN_SIZE};

    let metadata = fs::metadata(bin_path)
        .map_err(|e| format!("Failed to get file metadata for '{}': {}", bin_path, e))?;

    let file_size = metadata.len() as usize;

    if file_size > MAX_BIN_SIZE {
        return Err(format!(
            "BIN file too large ({} bytes, max {} bytes) - likely corrupt, skipping: {}",
            file_size, MAX_BIN_SIZE, bin_path
        ));
    }
    
    let data = fs::read(bin_path)
        .map_err(|e| format!("Failed to read file '{}': {}", bin_path, e))?;

    let bin = read_bin(&data)
        .map_err(|e| format!("Failed to parse bin file '{}': {}", bin_path, e))?;

    let text = tree_to_text_cached(&bin)
        .map_err(|e| format!("Failed to convert to text for '{}': {}", bin_path, e))?;

    let ritobin_path = format!("{}.ritobin", bin_path);
    fs::write(&ritobin_path, &text)
        .map_err(|e| format!("Failed to write ritobin '{}': {}", ritobin_path, e))?;

    Ok(())
}

/// Evict a project from every `projects.json` that could be holding it.
///
/// Without this, `discover_projects`' index-only pass re-emits the row on the
/// next scan and the "deleted" project reappears in the list. Preferring `pid`
/// keeps a relocated project's row from being clobbered by a stale path match;
/// the path sweep is the fallback for folders already gone from disk.
pub(super) fn purge_from_index(project_path: &Path, projects_root: Option<&Path>, pid: Option<&str>) {
    // The configured root, plus the parent directory, which is the real root
    // for the standard `<projectsRoot>/<projectDir>` layout.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(root) = projects_root {
        roots.push(root.to_path_buf());
    }
    if let Some(parent) = project_path.parent() {
        if !roots.iter().any(|r| r == parent) {
            roots.push(parent.to_path_buf());
        }
    }

    for root in roots {
        if !flint_core::project::index_path(&root).is_file() {
            continue;
        }
        let removed = match pid {
            Some(pid) => flint_core::project::remove_from_index(&root, pid)
                .map(|hit| if hit { 1 } else { 0 }),
            None => Ok(0),
        };
        let removed = match removed {
            Ok(n) if n > 0 => n,
            Ok(_) => flint_core::project::remove_from_index_by_path(&root, project_path)
                .unwrap_or_else(|e| {
                    tracing::warn!("Failed to purge {} from index at {}: {}", project_path.display(), root.display(), e);
                    0
                }),
            Err(e) => {
                tracing::warn!("Failed to purge pid from index at {}: {}", root.display(), e);
                0
            }
        };
        if removed > 0 {
            tracing::info!("Purged {} index row(s) for {}", removed, project_path.display());
        }
    }
}

