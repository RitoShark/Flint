use walkdir::WalkDir;
use crate::core::ipc_trace;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderEntry {
    /// Filename only (no parent path).
    pub name: String,
    /// Project-relative path (forward slashes).
    pub relative_path: String,
    pub absolute_path: String,
    pub is_directory: bool,
    /// Size in bytes. 0 for directories.
    pub size: u64,
    /// Lowercase extension without dot. Empty for directories and
    /// extensionless files.
    pub extension: String,
}

#[tauri::command]
pub async fn is_directory(path: String) -> bool {
    let _t = ipc_trace::enter("is_directory");
    std::path::Path::new(&path).is_dir()
}

/// Return immediate children of `folder_path`. Entries are split into
/// directories first then files, both alphabetically. Hidden files
/// (starting with `.`) are included so users can see what's in their
/// project root, but `.ritobin` sidecars are skipped — those are derived
/// content and clutter the grid view.
#[tauri::command]
pub async fn list_folder_contents(
    project_path: String,
    folder_path: String,
) -> Result<Vec<FolderEntry>, String> {
    let _t = ipc_trace::enter("list_folder_contents");
    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("Not a folder: {}", folder_path));
    }

    let project_root = PathBuf::from(&project_path);

    let mut entries: Vec<FolderEntry> = Vec::new();
    let read_dir = fs::read_dir(&folder)
        .map_err(|e| format!("Failed to read folder: {}", e))?;

    for entry in read_dir.filter_map(|e| e.ok()) {
        let path = entry.path();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let lower = name.to_lowercase();

        // Skip ritobin sidecars — BIN-editor cache artifacts, not content.
        if lower.ends_with(".ritobin") {
            continue;
        }

        let is_directory = metadata.is_dir();
        let size = if is_directory { 0 } else { metadata.len() };
        let extension = if is_directory {
            String::new()
        } else {
            path.extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default()
        };
        let relative_path = path
            .strip_prefix(&project_root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        entries.push(FolderEntry {
            name,
            relative_path,
            absolute_path: path.to_string_lossy().into_owned(),
            is_directory,
            size,
            extension,
        });
    }

    // Directories first, then files; each group sorted case-insensitively.
    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// Import (copy) external files/folders from the OS into a destination folder
/// inside the project. Used by drag-and-drop from Windows Explorer.
/// Returns the list of relative paths (project-relative, forward slashes) that
/// were created.
#[tauri::command]
pub async fn import_external_files(
    project_path: String,
    dest_folder: String,
    sources: Vec<String>,
) -> Result<Vec<String>, String> {
    let project_root = PathBuf::from(&project_path);
    let dest_dir_full = project_root.join(&dest_folder);

    if !dest_dir_full.is_dir() {
        return Err(format!("Destination is not a directory: {}", dest_folder));
    }

    let canonical_project = project_root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project path: {}", e))?;

    let mut created: Vec<String> = Vec::new();

    for src_str in sources {
        let src = PathBuf::from(&src_str);
        if !src.exists() {
            return Err(format!("Source does not exist: {}", src_str));
        }

        // Refuse a source already inside the project — that's what move is for.
        if let Ok(canonical_src) = src.canonicalize() {
            if canonical_src.starts_with(&canonical_project) {
                continue;
            }
        }

        let file_name = src
            .file_name()
            .ok_or("Cannot get filename from source path")?
            .to_string_lossy()
            .to_string();

        let dest_full = unique_dest(&dest_dir_full, &file_name);
        if dest_full.exists() {
            return Err(format!("'{}' already exists and uniquification failed", file_name));
        }

        if src.is_dir() {
            copy_dir_recursive(&src, &dest_full)
                .map_err(|e| format!("Failed to copy directory '{}': {}", file_name, e))?;
        } else {
            fs::copy(&src, &dest_full)
                .map_err(|e| format!("Failed to copy file '{}': {}", file_name, e))?;
        }

        let rel = dest_full
            .strip_prefix(&project_root)
            .map_err(|_| "Failed to compute relative path")?
            .to_string_lossy()
            .replace('\\', "/");
        created.push(rel);
    }

    Ok(created)
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in WalkDir::new(src).min_depth(1) {
        let entry = entry?;
        let rel = entry.path().strip_prefix(src).unwrap();
        let target = dest.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Resolve a non-colliding path inside `dest_dir` for `file_name`. If the name
/// is free it's returned as-is; otherwise a `" (n)"` suffix is inserted before
/// the extension until a free name is found (gives up after 10000 tries and
/// returns the still-colliding base path so the caller can error).
fn unique_dest(dest_dir: &Path, file_name: &str) -> PathBuf {
    let base = dest_dir.join(file_name);
    if !base.exists() {
        return base;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.to_string());
    let ext = Path::new(file_name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for n in 1..10000 {
        let candidate = dest_dir.join(format!("{} ({}){}", stem, n, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    base
}

/// Copy or move files/folders from one project into a folder of ANOTHER
/// project. `source_rel_paths` are project-relative (forward slashes) within
/// `source_project`; `dest_folder` is relative to `dest_project`. Collisions
/// are auto-uniquified with a `" (n)"` suffix. Moves use `rename` and fall back
/// to copy-then-delete across volumes. Returns the dest-project-relative paths
/// created.
fn transfer_between_projects(
    source_project: &str,
    source_rel_paths: &[String],
    dest_project: &str,
    dest_folder: &str,
    do_move: bool,
    on_conflict: &str,
) -> Result<Vec<String>, String> {
    let src_root = PathBuf::from(source_project);
    let dst_root = PathBuf::from(dest_project);
    let dst_dir = dst_root.join(dest_folder);

    if !dst_dir.is_dir() {
        return Err(format!("Destination is not a directory: {}", dest_folder));
    }

    let canonical_dst_dir = dst_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve destination path: {}", e))?;

    let mut created: Vec<String> = Vec::new();

    for rel in source_rel_paths {
        let src_full = src_root.join(rel);
        if !src_full.exists() {
            return Err(format!("Source does not exist: {}", rel));
        }

        if src_full.is_dir() {
            if let Ok(canonical_src) = src_full.canonicalize() {
                if canonical_dst_dir.starts_with(&canonical_src) {
                    return Err("Cannot transfer a folder into itself or its subdirectory".to_string());
                }
            }
        }

        let file_name = src_full
            .file_name()
            .ok_or("Cannot get filename from source path")?
            .to_string_lossy()
            .to_string();

        let dest_full = if on_conflict == "replace" {
            let target = dst_dir.join(&file_name);
            if target.exists() {
                if target.is_dir() {
                    fs::remove_dir_all(&target)
                        .map_err(|e| format!("Failed to replace directory '{}': {}", file_name, e))?;
                } else {
                    fs::remove_file(&target)
                        .map_err(|e| format!("Failed to replace file '{}': {}", file_name, e))?;
                }
            }
            target
        } else {
            unique_dest(&dst_dir, &file_name)
        };
        if dest_full.exists() {
            return Err(format!("'{}' already exists and could not be resolved", file_name));
        }

        if do_move {
            // rename fails across volumes; fall back to copy-then-delete.
            if fs::rename(&src_full, &dest_full).is_err() {
                if src_full.is_dir() {
                    copy_dir_recursive(&src_full, &dest_full)
                        .map_err(|e| format!("Failed to move directory '{}': {}", file_name, e))?;
                    fs::remove_dir_all(&src_full)
                        .map_err(|e| format!("Failed to remove source directory '{}': {}", file_name, e))?;
                } else {
                    fs::copy(&src_full, &dest_full)
                        .map_err(|e| format!("Failed to move file '{}': {}", file_name, e))?;
                    fs::remove_file(&src_full)
                        .map_err(|e| format!("Failed to remove source file '{}': {}", file_name, e))?;
                }
            }
        } else if src_full.is_dir() {
            copy_dir_recursive(&src_full, &dest_full)
                .map_err(|e| format!("Failed to copy directory '{}': {}", file_name, e))?;
        } else {
            fs::copy(&src_full, &dest_full)
                .map_err(|e| format!("Failed to copy file '{}': {}", file_name, e))?;
        }

        let rel_out = dest_full
            .strip_prefix(&dst_root)
            .map_err(|_| "Failed to compute relative path")?
            .to_string_lossy()
            .replace('\\', "/");
        created.push(rel_out);
    }

    Ok(created)
}

/// Copy files/folders from one project into a folder of another project.
/// `on_conflict` is `"rename"` (keep both, default) or `"replace"` (overwrite).
#[tauri::command]
pub async fn copy_between_projects(
    source_project: String,
    source_rel_paths: Vec<String>,
    dest_project: String,
    dest_folder: String,
    on_conflict: Option<String>,
) -> Result<Vec<String>, String> {
    let policy = on_conflict.unwrap_or_else(|| "rename".to_string());
    transfer_between_projects(&source_project, &source_rel_paths, &dest_project, &dest_folder, false, &policy)
}

/// Move files/folders from one project into a folder of another project.
/// `on_conflict` is `"rename"` (keep both, default) or `"replace"` (overwrite).
#[tauri::command]
pub async fn move_between_projects(
    source_project: String,
    source_rel_paths: Vec<String>,
    dest_project: String,
    dest_folder: String,
    on_conflict: Option<String>,
) -> Result<Vec<String>, String> {
    let policy = on_conflict.unwrap_or_else(|| "rename".to_string());
    transfer_between_projects(&source_project, &source_rel_paths, &dest_project, &dest_folder, true, &policy)
}

/// Return the filenames that would collide if `source_rel_paths` were
/// transferred into `dest_folder` of `dest_project` (i.e. already exist there).
#[tauri::command]
pub async fn check_transfer_conflicts(
    source_rel_paths: Vec<String>,
    dest_project: String,
    dest_folder: String,
) -> Result<Vec<String>, String> {
    let dst_dir = PathBuf::from(&dest_project).join(&dest_folder);
    let mut conflicts = Vec::new();
    for rel in &source_rel_paths {
        if let Some(name) = Path::new(rel).file_name().map(|n| n.to_string_lossy().into_owned()) {
            if dst_dir.join(&name).exists() {
                conflicts.push(name);
            }
        }
    }
    Ok(conflicts)
}

