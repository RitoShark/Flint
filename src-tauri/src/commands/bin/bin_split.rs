use flint_core::bin::split::{collect_folder_bins, find_wad_root, pick_owner_bin};
use flint_core::bin::{
    analyze_multi, classify_vfx_objects, group_by_class, organize_vfx_in_folder, read_bin,
    split_bin, split_bin_multi,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinSplitClassGroup {
    pub class_hash: String,
    pub class_name: Option<String>,
    pub path_hashes: Vec<String>,
    pub is_vfx_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinSplitAnalysis {
    pub total_objects: usize,
    pub groups: Vec<BinSplitClassGroup>,
}

#[tauri::command]
pub async fn analyze_bin_for_split(bin_path: String) -> Result<BinSplitAnalysis, String> {
    tracing::info!("analyze_bin_for_split: reading {}", bin_path);
    let path = PathBuf::from(&bin_path);
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read BIN: {}", e))?;
    let bin = read_bin(&data).map_err(|e| format!("Failed to parse BIN: {}", e))?;

    let total = bin.entries.len();
    let vfx_set: HashSet<u32> = classify_vfx_objects(&bin).into_iter().collect();

    let class_cache = flint_core::bin::get_cached_bin_hashes();
    let cache = class_cache.read();

    let groups: Vec<BinSplitClassGroup> = group_by_class(&bin)
        .into_iter()
        .map(|(class_hash, hashes)| {
            let class_name = lookup_bin_hash_name(&cache, class_hash);
            let is_vfx_default = hashes.iter().any(|h| vfx_set.contains(h));
            BinSplitClassGroup {
                class_hash: format!("{:08x}", class_hash),
                class_name,
                path_hashes: hashes.iter().map(|h| format!("{:08x}", h)).collect(),
                is_vfx_default,
            }
        })
        .collect();

    Ok(BinSplitAnalysis {
        total_objects: total,
        groups,
    })
}

fn lookup_bin_hash_name(
    provider: &flint_core::types::HashMapper,
    hash: u32,
) -> Option<String> {
    provider.get(hash as u64).map(|s| s.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinSplitResult {
    pub moved: usize,
    pub link_added: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinSplitSourceInfo {
    pub path: String,
    pub rel_path: String,
    pub object_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinSplitFolderAnalysis {
    pub sources: Vec<BinSplitSourceInfo>,
    pub total_objects: usize,
    pub groups: Vec<BinSplitClassGroup>,
    pub suggested_owner: String,
}

#[tauri::command]
pub async fn analyze_folder_for_split(
    folder_path: String,
) -> Result<BinSplitFolderAnalysis, String> {
    tracing::info!("analyze_folder_for_split: scanning {}", folder_path);
    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("Not a folder: {}", folder_path));
    }

    let bins = collect_folder_bins(&folder);
    if bins.is_empty() {
        return Err(format!("No .bin files found under {}", folder_path));
    }

    let multi = tokio::task::spawn_blocking(move || analyze_multi(&bins))
        .await
        .map_err(|e| format!("Task panicked: {}", e))?;

    let class_cache = flint_core::bin::get_cached_bin_hashes();
    let cache = class_cache.read();

    let groups: Vec<BinSplitClassGroup> = multi
        .groups
        .into_iter()
        .map(|(class_hash, hashes)| {
            let class_name = lookup_bin_hash_name(&cache, class_hash);
            let is_vfx_default = multi.vfx_class_hashes.contains(&class_hash);
            BinSplitClassGroup {
                class_hash: format!("{:08x}", class_hash),
                class_name,
                path_hashes: hashes.iter().map(|h| format!("{:08x}", h)).collect(),
                is_vfx_default,
            }
        })
        .collect();

    let folder_for_strip = folder.clone();
    let sources_for_pick: Vec<(PathBuf, usize)> = multi
        .sources
        .iter()
        .map(|s| (s.bin_path.clone(), s.object_count))
        .collect();
    let owner = pick_owner_bin(&sources_for_pick)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let sources: Vec<BinSplitSourceInfo> = multi
        .sources
        .into_iter()
        .map(|s| {
            let rel = s
                .bin_path
                .strip_prefix(&folder_for_strip)
                .unwrap_or(&s.bin_path)
                .to_string_lossy()
                .replace('\\', "/");
            BinSplitSourceInfo {
                path: s.bin_path.to_string_lossy().into_owned(),
                rel_path: rel,
                object_count: s.object_count,
            }
        })
        .collect();

    Ok(BinSplitFolderAnalysis {
        sources,
        total_objects: multi.total_objects,
        groups,
        suggested_owner: owner,
    })
}

#[tauri::command]
pub async fn split_folder_entries(
    folder_path: String,
    source_paths: Vec<String>,
    owner_path: String,
    output_filename: String,
    path_hashes: Vec<String>,
) -> Result<BinSplitResult, String> {
    tracing::info!(
        "split_folder_entries: folder={}, sources={}, owner={}, output={}, moving {} hashes",
        folder_path, source_paths.len(), owner_path, output_filename, path_hashes.len()
    );
    if output_filename.contains('/') || output_filename.contains('\\') {
        return Err("output_filename must be a bare filename, no slashes".to_string());
    }
    let parsed: Result<HashSet<u32>, _> = path_hashes
        .iter()
        .map(|s| u32::from_str_radix(s.trim_start_matches("0x"), 16))
        .collect();
    let move_hashes = parsed.map_err(|e| format!("Invalid hex hash: {}", e))?;

    let sources: Vec<PathBuf> = source_paths.into_iter().map(PathBuf::from).collect();
    let owner = PathBuf::from(&owner_path);
    let project_root = find_wad_root(&PathBuf::from(&folder_path));

    let result = tokio::task::spawn_blocking(move || {
        split_bin_multi(&sources, &owner, &project_root, &output_filename, &move_hashes)
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
    .map_err(|e| e.to_string())?;

    Ok(BinSplitResult {
        moved: result.moved,
        link_added: result.link_added,
    })
}

#[tauri::command]
pub async fn split_bin_entries(
    bin_path: String,
    output_filename: String,
    path_hashes: Vec<String>,
) -> Result<BinSplitResult, String> {
    tracing::info!(
        "split_bin_entries: parent={}, output={}, moving {} hashes",
        bin_path, output_filename, path_hashes.len()
    );
    if output_filename.contains('/') || output_filename.contains('\\') {
        return Err("output_filename must be a bare filename, no slashes".to_string());
    }
    let parsed: Result<HashSet<u32>, _> = path_hashes
        .iter()
        .map(|s| u32::from_str_radix(s.trim_start_matches("0x"), 16))
        .collect();
    let move_hashes = parsed.map_err(|e| format!("Invalid hex hash: {}", e))?;

    let parent = PathBuf::from(&bin_path);
    let project_root = find_wad_root(&parent);

    let result = tokio::task::spawn_blocking(move || {
        split_bin(&parent, &project_root, &output_filename, &move_hashes)
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
    .map_err(|e| e.to_string())?;

    Ok(BinSplitResult {
        moved: result.moved,
        link_added: result.link_added,
    })
}

// =============================================================================
// BIN organizer — auto-consolidate VFX vs main
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinOrganizePreview {
    pub sources: Vec<BinSplitSourceInfo>,
    pub vfx_objects_estimate: usize,
    pub main_objects_estimate: usize,
    pub suggested_owner: String,
    pub vfx_filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinOrganizeResult {
    pub vfx_objects_moved: usize,
    pub main_objects_merged: usize,
    pub sources_deleted: Vec<String>,
    pub links_pruned: usize,
    pub vfx_link_added: String,
}

#[tauri::command]
pub async fn preview_organize_vfx(folder_path: String) -> Result<BinOrganizePreview, String> {
    tracing::info!("preview_organize_vfx: scanning {}", folder_path);
    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("Not a folder: {}", folder_path));
    }
    let bins = collect_folder_bins(&folder);
    if bins.is_empty() {
        return Err(format!("No .bin files found under {}", folder_path));
    }

    let folder_for_strip = folder.clone();
    let multi = tokio::task::spawn_blocking(move || analyze_multi(&bins))
        .await
        .map_err(|e| format!("Task panicked: {}", e))?;

    let owner = pick_owner_bin(
        &multi
            .sources
            .iter()
            .map(|s| (s.bin_path.clone(), s.object_count))
            .collect::<Vec<_>>(),
    )
    .map(|p| p.to_string_lossy().into_owned())
    .unwrap_or_default();

    let vfx_set = &multi.vfx_class_hashes;
    let mut vfx_estimate = 0usize;
    let mut main_estimate = 0usize;
    for (class_hash, hashes) in &multi.groups {
        if vfx_set.contains(class_hash) {
            vfx_estimate += hashes.len();
        } else {
            main_estimate += hashes.len();
        }
    }

    let sources: Vec<BinSplitSourceInfo> = multi
        .sources
        .iter()
        .map(|s| BinSplitSourceInfo {
            path: s.bin_path.to_string_lossy().into_owned(),
            rel_path: s
                .bin_path
                .strip_prefix(&folder_for_strip)
                .unwrap_or(&s.bin_path)
                .to_string_lossy()
                .replace('\\', "/"),
            object_count: s.object_count,
        })
        .collect();

    Ok(BinOrganizePreview {
        sources,
        vfx_objects_estimate: vfx_estimate,
        main_objects_estimate: main_estimate,
        suggested_owner: owner,
        vfx_filename: get_vfx_filename(&folder),
    })
}

fn get_vfx_filename(folder: &Path) -> String {
    let mut current = folder.to_path_buf();
    while let Some(parent) = current.parent() {
        if parent.join("mod.config.json").exists() {
            if let Ok(project) = flint_core::project::project::open_project(parent) {
                let creator = project.authors.first().map(|a| a.to_string()).unwrap_or_else(|| "Unknown".to_string());
                let proj = project.name;
                let creator_sanitized = creator.replace(' ', "-");
                let project_sanitized = proj.replace(' ', "-");
                return format!("{}_{}_VFX.bin", creator_sanitized, project_sanitized);
            }
        }
        current = parent.to_path_buf();
    }
    "VFX.bin".to_string()
}

#[tauri::command]
pub async fn get_vfx_filename_command(folder_path: String) -> Result<String, String> {
    let folder = PathBuf::from(&folder_path);
    Ok(get_vfx_filename(if folder.is_file() {
        folder.parent().unwrap_or(Path::new("."))
    } else {
        &folder
    }))
}

#[tauri::command]
pub async fn organize_bins_vfx(
    folder_path: String,
    owner_path: String,
    vfx_filename: String,
) -> Result<BinOrganizeResult, String> {
    tracing::info!(
        "organize_bins_vfx: folder={}, owner={}, output={}",
        folder_path, owner_path, vfx_filename
    );
    if vfx_filename.contains('/') || vfx_filename.contains('\\') {
        return Err("vfx_filename must be a bare filename, no slashes".to_string());
    }
    if !vfx_filename.to_lowercase().ends_with(".bin") {
        return Err("vfx_filename must end with .bin".to_string());
    }

    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("Not a folder: {}", folder_path));
    }
    let bins = collect_folder_bins(&folder);
    if bins.is_empty() {
        return Err(format!("No .bin files found under {}", folder_path));
    }
    let owner = PathBuf::from(&owner_path);
    let project_root = find_wad_root(&folder);

    let result = tokio::task::spawn_blocking(move || {
        organize_vfx_in_folder(&bins, &owner, &project_root, &vfx_filename)
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
    .map_err(|e| e.to_string())?;

    Ok(BinOrganizeResult {
        vfx_objects_moved: result.vfx_objects_moved,
        main_objects_merged: result.main_objects_merged,
        sources_deleted: result
            .sources_deleted
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        links_pruned: result.links_pruned,
        vfx_link_added: result.vfx_link_added,
    })
}
