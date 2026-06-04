//! Tauri commands for the "split BIN" right-click action.
//!
//! Two endpoints:
//! - `analyze_bin_for_split` — read a BIN and return its objects grouped by
//!   class, plus the default VFX selection. Drives the modal preview.
//! - `split_bin_entries` — perform the split (writes new sibling BIN, updates
//!   parent dependencies, removes moved objects from parent).

use flint_ltk::bin::{
    analyze_multi, classify_vfx_objects, group_by_class, organize_vfx_in_folder, read_bin,
    split_bin, split_bin_multi,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// One class group surfaced to the modal: a class hash, an optional
/// resolved class name (looked up via the BIN hash table when available),
/// the per-object path hashes in this group, and whether the class is in
/// the default VFX set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinSplitClassGroup {
    pub class_hash: String,
    pub class_name: Option<String>,
    pub path_hashes: Vec<String>,
    pub is_vfx_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinSplitAnalysis {
    /// Total objects in the parent BIN.
    pub total_objects: usize,
    /// Class groups for the modal table. Sorted by class hash so the order
    /// is deterministic between calls.
    pub groups: Vec<BinSplitClassGroup>,
}

/// Resolve the WAD-folder root for a given BIN path. Convention is
/// `<project>/content/base/<champion>.wad.client/data/...`. Walk parents
/// until we find a directory whose name ends in `.wad.client`; if none
/// exists fall back to the immediate parent (best-effort).
fn find_wad_root(bin_path: &Path) -> PathBuf {
    let mut cur = bin_path.parent();
    while let Some(p) = cur {
        if p.file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_lowercase().ends_with(".wad.client"))
            .unwrap_or(false)
        {
            return p.to_path_buf();
        }
        cur = p.parent();
    }
    bin_path.parent().unwrap_or(Path::new(".")).to_path_buf()
}

/// Read a BIN and return its class breakdown for the split modal.
#[tauri::command]
pub async fn analyze_bin_for_split(bin_path: String) -> Result<BinSplitAnalysis, String> {
    tracing::info!("analyze_bin_for_split: reading {}", bin_path);
    let path = PathBuf::from(&bin_path);
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read BIN: {}", e))?;
    let bin = read_bin(&data).map_err(|e| format!("Failed to parse BIN: {}", e))?;

    let total = bin.entries.len();
    let vfx_set: HashSet<u32> = classify_vfx_objects(&bin).into_iter().collect();

    let class_cache = flint_ltk::bin::get_cached_bin_hashes();
    let cache = class_cache.read();

    let groups: Vec<BinSplitClassGroup> = group_by_class(&bin)
        .into_iter()
        .map(|(class_hash, hashes)| {
            // Resolve class name via BIN hash table (HashMapProvider). The
            // provider exposes `get_type` for class-name lookups in v0.4.
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

/// Look up a BIN class hash in the cached HashMapProvider. Returns the
/// resolved name when present; falls back to `None` so the frontend renders
/// the raw hex.
fn lookup_bin_hash_name(
    provider: &flint_ltk::ltk_types::HashMapper,
    hash: u32,
) -> Option<String> {
    // BIN hashes are FNV1a-32; the HashMapper is u64-keyed, so widen at lookup.
    provider.get(hash as u64).map(|s| s.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinSplitResult {
    pub moved: usize,
    pub link_added: String,
}

/// One source BIN listed in a folder-mode analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinSplitSourceInfo {
    /// Absolute path of the source BIN.
    pub path: String,
    /// Engine-relative form (e.g. `data/characters/.../skin19.bin`) shown in
    /// the modal so the user can tell which BIN they're operating on.
    pub rel_path: String,
    pub object_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinSplitFolderAnalysis {
    pub sources: Vec<BinSplitSourceInfo>,
    pub total_objects: usize,
    pub groups: Vec<BinSplitClassGroup>,
    /// Suggested owner BIN (the main skin BIN — biggest object count among
    /// matches in `data/characters/.../skins/skin*.bin`). Empty string if
    /// nothing in the folder looks like a main skin BIN.
    pub suggested_owner: String,
}

/// Walk the given folder for `.bin` files. Skips animation BINs (anim files
/// are bone curves; we never want to split or merge those), and skips empty
/// concat byproducts.
fn collect_folder_bins(folder: &Path) -> Vec<PathBuf> {
    WalkDir::new(folder)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.to_lowercase();
            if !name.ends_with(".bin") {
                return None;
            }
            // Skip animation BINs — different content, never relevant here.
            let path_lower = path.to_string_lossy().to_lowercase().replace('\\', "/");
            if path_lower.contains("/animations/") {
                return None;
            }
            Some(path.to_path_buf())
        })
        .collect()
}

/// Pick the most plausible "owner" BIN — the one whose `dependencies` list
/// should get the new link added. Heuristic: the largest BIN whose path
/// looks like a skin definition (`/data/characters/<name>/skins/skinNN.bin`).
fn pick_owner_bin(sources: &[(PathBuf, usize)]) -> Option<PathBuf> {
    let mut best: Option<(usize, PathBuf)> = None;
    for (path, count) in sources {
        let lower = path.to_string_lossy().to_lowercase().replace('\\', "/");
        let looks_like_skin = lower.contains("/data/characters/")
            && lower.contains("/skins/skin")
            && lower.ends_with(".bin");
        if !looks_like_skin {
            continue;
        }
        match best {
            Some((c, _)) if c >= *count => {}
            _ => best = Some((*count, path.clone())),
        }
    }
    best.map(|(_, p)| p)
}

/// Folder-mode analysis: walk every BIN in `folder_path`, union their class
/// groups, and return the suggested owner.
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

    let class_cache = flint_ltk::bin::get_cached_bin_hashes();
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

/// Folder-mode split: move objects out of every listed source BIN into a
/// single shared output file under `<wad_root>/data/<output_filename>`. The
/// `owner_path` BIN's `dependencies` list gets the new link.
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

/// Move the listed objects out of `bin_path` into a new sibling BIN at
/// `output_filename` (just the filename — written next to the parent). The
/// parent's dependency list is updated to reference the new file.
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

/// Walk a folder, classify every object across every BIN, and report what an
/// organize pass would do. The frontend can show this preview in a confirm
/// dialog before running the actual write.
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
            if let Ok(project) = flint_ltk::project::project::open_project(parent) {
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

/// Run the organize pass. Pulls every VFX-class object from every source
/// (incl. owner) into a consolidated `<wad_root>/data/<vfx_filename>`,
/// merges every non-owner non-VFX object into the owner BIN, deletes any
/// source BIN that ends up empty, and prunes dead dependency links.
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
