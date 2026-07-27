use walkdir::WalkDir;
use std::process::Command;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

// =============================================================================
// File Management Commands (rename, delete, open, create directory)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameResult {
    pub old_path: String,
    pub new_path: String,
    pub bin_updates: u32,
}

/// Rename a file or directory, updating references in .bin files when inside `content/`.
#[tauri::command]
pub async fn rename_file(
    project_path: String,
    file_path: String,
    new_name: String,
) -> Result<RenameResult, String> {
    let full_path = PathBuf::from(&project_path).join(&file_path);
    if !full_path.exists() {
        return Err(format!("Path does not exist: {}", file_path));
    }

    let parent = full_path.parent().ok_or("Cannot get parent directory")?;
    let new_full_path = parent.join(&new_name);

    if new_full_path.exists() {
        return Err(format!("A file or folder named '{}' already exists", new_name));
    }

    let project_root = PathBuf::from(&project_path);
    let new_rel_path = new_full_path
        .strip_prefix(&project_root)
        .map_err(|_| "Failed to compute relative path")?
        .to_string_lossy()
        .replace('\\', "/");

    fs::rename(&full_path, &new_full_path)
        .map_err(|e| format!("Failed to rename: {}", e))?;

    let bin_updates = if file_path.starts_with("content/") || file_path.starts_with("content\\") {
        update_bin_references(&project_root, &file_path, &new_rel_path)
    } else {
        0
    };

    Ok(RenameResult {
        old_path: file_path,
        new_path: new_rel_path,
        bin_updates,
    })
}

/// Replace a filename in path strings (case-insensitive).
/// Searches for `/old_name` (with leading slash) so only exact filenames match —
/// e.g. renaming `white.tex` won't touch `blablabla_white.tex`.
fn replace_filename_in_paths(text: &str, old_name: &str, new_name: &str) -> String {
    let search = format!("/{}", old_name).to_lowercase();
    let replace = format!("/{}", new_name);
    let text_lower = text.to_lowercase();
    let mut result = String::with_capacity(text.len());
    let mut last_end = 0;

    for (start, _) in text_lower.match_indices(&search) {
        result.push_str(&text[last_end..start]);
        result.push_str(&replace);
        last_end = start + search.len();
    }
    result.push_str(&text[last_end..]);
    result
}

/// Walk all .bin files in the project and update filename references after a rename.
///
/// Uses the BIN parse→text→modify→write pipeline so that different-length renames
/// are handled correctly (string length prefixes are updated by the serializer).
/// Matches by filename only (case-insensitive) because BIN text uses mixed-case
/// game paths (e.g. `ASSETS/Characters/...`) that differ from the project's lowercase paths.
fn update_bin_references(project_root: &Path, old_rel: &str, new_rel: &str) -> u32 {
    use flint_core::bin::{read_bin, write_bin, tree_to_text_cached, text_to_tree};

    // Match by filename only — BIN text paths have different casing/prefixes.
    let old_name = match Path::new(old_rel).file_name().and_then(|n| n.to_str()) {
        Some(n) => n.to_string(),
        None => return 0,
    };
    let new_name = match Path::new(new_rel).file_name().and_then(|n| n.to_str()) {
        Some(n) => n.to_string(),
        None => return 0,
    };

    if old_name.eq_ignore_ascii_case(&new_name) {
        return 0;
    }

    let old_name_lower = old_name.to_lowercase();

    let mut count = 0u32;
    for entry in WalkDir::new(project_root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
        if ext != "bin" {
            continue;
        }

        let data = match fs::read(path) {
            Ok(d) => d,
            Err(_) => continue,
        };

        // Skip BIN files that don't contain the old filename at all.
        let old_bytes = old_name_lower.as_bytes();
        let data_lower: Vec<u8> = data.iter().map(|b| b.to_ascii_lowercase()).collect();
        if !data_lower.windows(old_bytes.len()).any(|w| w == old_bytes) {
            continue;
        }

        let tree = match read_bin(&data) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("Skipping BIN (parse failed) {}: {}", path.display(), e);
                continue;
            }
        };

        let text = match tree_to_text_cached(&tree) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("Skipping BIN (text conv failed) {}: {}", path.display(), e);
                continue;
            }
        };

        let modified_text = replace_filename_in_paths(&text, &old_name, &new_name);
        if modified_text == text {
            continue;
        }

        let new_tree = match text_to_tree(&modified_text) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("Skipping BIN (re-parse failed) {}: {}", path.display(), e);
                continue;
            }
        };

        let new_data = match write_bin(&new_tree) {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!("Skipping BIN (write failed) {}: {}", path.display(), e);
                continue;
            }
        };

        if let Err(e) = fs::write(path, &new_data) {
            tracing::warn!("Failed to save updated BIN {}: {}", path.display(), e);
            continue;
        }

        let ritobin_path = format!("{}.ritobin", path.display());
        if Path::new(&ritobin_path).exists() {
            let _ = fs::write(&ritobin_path, &modified_text);
        }

        tracing::info!("Updated BIN references in {}", path.display());
        count += 1;
    }
    count
}

#[tauri::command]
pub async fn delete_file(
    project_path: String,
    file_path: String,
) -> Result<(), String> {
    let full_path = PathBuf::from(&project_path).join(&file_path);
    if !full_path.exists() {
        return Err(format!("Path does not exist: {}", file_path));
    }

    if full_path.is_dir() {
        fs::remove_dir_all(&full_path)
            .map_err(|e| format!("Failed to delete directory: {}", e))?;
    } else {
        fs::remove_file(&full_path)
            .map_err(|e| format!("Failed to delete file: {}", e))?;
    }

    Ok(())
}

/// Open a path in the system file explorer (Windows Explorer).
#[tauri::command]
pub async fn open_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if p.is_file() {
        Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    } else {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    Ok(())
}

/// Open a file with the system's default application.
#[tauri::command]
pub async fn open_with_default_app(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    opener::open(&path).map_err(|e| format!("Failed to open file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn create_directory(
    project_path: String,
    dir_path: String,
) -> Result<String, String> {
    let full_path = PathBuf::from(&project_path).join(&dir_path);
    if full_path.exists() {
        return Err(format!("Directory already exists: {}", dir_path));
    }

    fs::create_dir_all(&full_path)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    Ok(dir_path)
}

/// Copy a file to the same directory with a " (copy)" suffix.
#[tauri::command]
pub async fn duplicate_file(
    project_path: String,
    file_path: String,
) -> Result<String, String> {
    let full_path = PathBuf::from(&project_path).join(&file_path);
    if !full_path.is_file() {
        return Err(format!("Not a file: {}", file_path));
    }

    let stem = full_path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = full_path.extension().and_then(|e| e.to_str());

    let parent = full_path.parent().ok_or("Cannot get parent directory")?;
    let mut copy_name = match ext {
        Some(e) => format!("{} (copy).{}", stem, e),
        None => format!("{} (copy)", stem),
    };

    let mut dest = parent.join(&copy_name);
    let mut counter = 2;
    while dest.exists() {
        copy_name = match ext {
            Some(e) => format!("{} (copy {}).{}", stem, counter, e),
            None => format!("{} (copy {})", stem, counter),
        };
        dest = parent.join(&copy_name);
        counter += 1;
    }

    fs::copy(&full_path, &dest)
        .map_err(|e| format!("Failed to duplicate file: {}", e))?;

    let project_root = PathBuf::from(&project_path);
    let new_rel = dest
        .strip_prefix(&project_root)
        .map_err(|_| "Failed to compute relative path")?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(new_rel)
}

/// Move a file or directory to a different folder within the project.
/// Returns the new relative path of the moved item.
#[tauri::command]
pub async fn move_file(
    project_path: String,
    source_path: String,
    dest_folder: String,
) -> Result<String, String> {
    let project_root = PathBuf::from(&project_path);
    let src_full = project_root.join(&source_path);

    if !src_full.exists() {
        return Err(format!("Source does not exist: {}", source_path));
    }

    let dest_dir_full = project_root.join(&dest_folder);
    if !dest_dir_full.is_dir() {
        return Err(format!("Destination is not a directory: {}", dest_folder));
    }

    // Prevent moving a directory into itself or its own subtree
    if src_full.is_dir() {
        let canonical_src = src_full.canonicalize()
            .map_err(|e| format!("Failed to resolve source path: {}", e))?;
        let canonical_dest = dest_dir_full.canonicalize()
            .map_err(|e| format!("Failed to resolve destination path: {}", e))?;
        if canonical_dest.starts_with(&canonical_src) {
            return Err("Cannot move a folder into itself or its subdirectory".to_string());
        }
    }

    let file_name = src_full
        .file_name()
        .ok_or("Cannot get filename from source path")?
        .to_string_lossy()
        .to_string();

    let dest_full = dest_dir_full.join(&file_name);
    if dest_full.exists() {
        return Err(format!("'{}' already exists in the destination folder", file_name));
    }

    fs::rename(&src_full, &dest_full)
        .map_err(|e| format!("Failed to move: {}", e))?;

    let new_rel = dest_full
        .strip_prefix(&project_root)
        .map_err(|_| "Failed to compute relative path")?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(new_rel)
}

