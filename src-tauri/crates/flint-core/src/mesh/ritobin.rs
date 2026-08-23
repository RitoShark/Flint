//! Locating a mesh's ritobin text.
//!
//! A mesh's material data lives in a companion BIN, which may sit next to the mesh, be a
//! concatenated bin, or hang off the skin bin's `linked` header — each is tried in turn.
//! The text is rendered in memory; nothing is written into the project.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use dashmap::DashMap;
use ritoshark::bin::Bin;

/// What makes a cached render stale: the bin's size and mtime.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

/// Rendered bin text, in memory for the life of the process.
///
/// This used to be a `<bin>.ritobin` file written into the project. That left a second copy
/// of every bin on disk with nothing to invalidate it, so editing the bin left the model
/// preview reading the old text forever. Keyed on size+mtime here, it cannot go stale, and
/// the project folder stays as the author left it.
fn rendered() -> &'static DashMap<PathBuf, (Stamp, String)> {
    static CACHE: OnceLock<DashMap<PathBuf, (Stamp, String)>> = OnceLock::new();
    CACHE.get_or_init(DashMap::new)
}

use crate::mesh::discovery::{extract_character_folder, find_project_root, find_scb_bin};
use crate::mesh::texture::find_skin_bin;

pub fn find_ritobin_text(mesh_path: &Path) -> Option<String> {
    // Strategy 1: find the companion .bin and render it.
    let bin_finders: [fn(&Path) -> Option<std::path::PathBuf>; 2] = [
        |p| find_skin_bin(p),
        |p| find_scb_bin(p),
    ];

    for finder in &bin_finders {
        if let Some(bin_path) = finder(mesh_path) {
            match render_bin(&bin_path) {
                Ok(text) => return Some(text),
                Err(e) => tracing::warn!("Failed to render {}: {}", bin_path.display(), e),
            }
        }
    }

    // Strategy 2: Search for .ritobin files directly in the data/ tree
    if let Some(character_folder) = extract_character_folder(mesh_path) {
        if let Some(root) = find_project_root(mesh_path) {
            let skins_dir = root
                .join("data")
                .join("characters")
                .join(&character_folder)
                .join("skins");

            if skins_dir.exists() {
                if let Some(text) = find_ritobin_in_dir(&skins_dir) {
                    return Some(text);
                }
            }
        }
    }

    None
}

/// Find concat BIN ritobin text — concat BINs hold merged material
/// definitions that may not be in the main skin BIN.
pub fn find_concat_ritobin_text(mesh_path: &Path) -> Option<String> {
    tracing::debug!("🔎 Looking for concat BIN for: {}", mesh_path.display());

    let root = find_project_root(mesh_path)?;
    tracing::debug!("  Project root: {}", root.display());

    let character_folder = extract_character_folder(mesh_path)?;
    tracing::debug!("  Character folder: {}", character_folder);

    let search_dirs = vec![
        root.join("data").join("characters").join(&character_folder).join("skins"),
        root.join("data"),
    ];

    for search_dir in search_dirs {
        tracing::debug!("  Searching in: {}", search_dir.display());

        if !search_dir.exists() {
            tracing::debug!("    Directory doesn't exist, skipping");
            continue;
        }

        if let Ok(entries) = std::fs::read_dir(&search_dir) {
            let files: Vec<_> = entries.filter_map(|e| e.ok()).collect();
            tracing::debug!("    Found {} files", files.len());

            for entry in &files {
                let path = entry.path();
                let name = path.file_name()?.to_string_lossy().to_lowercase();

                if name.contains("concat") && name.ends_with(".bin") {
                    tracing::debug!("  ✓ Found concat BIN: {}", path.display());

                    match render_bin(&path) {
                        Ok(text) => return Some(text),
                        Err(e) => tracing::debug!("  ✗ Failed to render concat BIN: {e}"),
                    }
                }
            }
        }
    }

    tracing::debug!("  ✗ No concat BIN found in any location");
    None
}

/// Follow the skin BIN's `linked` header and return the concatenated ritobin text of every
/// linked `.bin` that resolves to a file on disk. Material/`StaticMaterialDef` defs often live
/// in these shared/linked bins rather than in the skin BIN itself.
///
/// Only the skin BIN's *direct* linked list is followed (no recursion, no project-wide scan).
pub fn find_linked_bin_ritobin_text(mesh_path: &Path) -> Option<String> {
    let skin_bin = find_skin_bin(mesh_path)?;
    let data = std::fs::read(&skin_bin).ok()?;
    let tree = crate::bin::codec::read_bin(&data).ok()?;
    if tree.linked.is_empty() {
        return None;
    }

    let project_root = find_project_root(mesh_path);
    let mut merged = String::new();

    for linked in &tree.linked {
        let normalized = linked.replace('\\', "/");
        if !normalized.to_lowercase().ends_with(".bin") {
            continue;
        }

        let Some(bin_path) = resolve_linked_bin_path(mesh_path, project_root.as_deref(), &normalized)
        else {
            tracing::debug!("  Linked BIN not found on disk: {}", linked);
            continue;
        };

        // Skip the skin BIN itself if it links back to its own concat, etc. — already merged.
        if bin_path == skin_bin {
            continue;
        }

        if let Ok(text) = render_bin(&bin_path) {
            tracing::debug!("  ✓ Merged linked BIN: {} ({} bytes)", bin_path.display(), text.len());
            merged.push_str("\n\n");
            merged.push_str(&text);
        }
    }

    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

/// Read and parse every `.bin` in a skin BIN's direct `linked` header that resolves on disk.
///
/// Same resolution as [`find_linked_bin_ritobin_text`] (direct list only, no recursion, no
/// project-wide scan) but returns parsed trees instead of text — entries Riot's build hoisted
/// out of `skinN.bin` into a shared `<Champ>_Skins_*.bin` are reachable only this way.
/// Unreadable/unparseable links are skipped; the caller treats a short list as "not found".
pub fn read_linked_bin_trees(mesh_path: &Path, skin_bin: &Path, tree: &Bin) -> Vec<Bin> {
    let project_root = find_project_root(mesh_path);
    let mut trees = Vec::new();

    for linked in &tree.linked {
        let normalized = linked.replace('\\', "/");
        if !normalized.to_lowercase().ends_with(".bin") {
            continue;
        }

        let Some(bin_path) = resolve_linked_bin_path(mesh_path, project_root.as_deref(), &normalized)
        else {
            tracing::debug!("  Linked BIN not found on disk: {}", linked);
            continue;
        };

        // A BIN can link back to itself (via its own concat) — already covered by the caller.
        if bin_path == skin_bin {
            continue;
        }

        let Ok(data) = std::fs::read(&bin_path) else {
            tracing::debug!("  ✗ Failed to read linked BIN: {}", bin_path.display());
            continue;
        };
        match crate::bin::codec::read_bin(&data) {
            Ok(linked_tree) => {
                tracing::debug!("  ✓ Read linked BIN: {} ({} entries)", bin_path.display(), linked_tree.entries.len());
                trees.push(linked_tree);
            }
            Err(e) => tracing::debug!("  ✗ Failed to parse linked BIN {}: {}", bin_path.display(), e),
        }
    }

    trees
}

/// Resolve a BIN `linked` path (e.g. `data/characters/kayn/skins/skin20.bin`) to a real file.
/// Tries: relative to the project root, walking up from the mesh directory, and as-is.
pub fn resolve_linked_bin_path(
    mesh_path: &Path,
    project_root: Option<&Path>,
    linked: &str,
) -> Option<std::path::PathBuf> {
    let normalized = linked
        .trim_start_matches("ASSETS/")
        .trim_start_matches("assets/");

    if let Some(root) = project_root {
        let candidate = root.join(normalized);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    // Walk up from the mesh directory looking for a dir where the linked path resolves — this
    // handles `.wad.client` extraction roots that hold the `data/` tree.
    let mut search_dir = mesh_path.parent().map(|p| p.to_path_buf());
    for _ in 0..8 {
        let Some(dir) = search_dir else { break };
        let candidate = dir.join(normalized);
        if candidate.exists() {
            return Some(candidate);
        }
        search_dir = dir.parent().map(|p| p.to_path_buf());
    }

    let as_is = std::path::PathBuf::from(linked);
    if as_is.exists() {
        return Some(as_is);
    }

    None
}

/// Read a BIN file, convert it to text using cached hashes, and write a
/// `.ritobin` cache file.
pub fn render_bin(bin_path: &Path) -> anyhow::Result<String> {
    let meta = std::fs::metadata(bin_path)?;
    let stamp = Stamp {
        len: meta.len(),
        modified: meta.modified().ok(),
    };

    if let Some(hit) = rendered().get(bin_path) {
        if hit.0 == stamp {
            return Ok(hit.1.clone());
        }
    }

    let data = std::fs::read(bin_path)
        .map_err(|e| anyhow::anyhow!("Failed to read BIN file: {}", e))?;
    let tree = crate::bin::codec::read_bin(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse BIN file: {}", e))?;

    /* Through the shared renderer, not a bare `tree_to_text_cached`: after Riot's
    string->file migration a texture reference is an xxh64, and only the trailer /
    files.txt / on-disk records can turn it back into the path the mapper matches on. */
    let text = crate::bin::render_bin_text(&tree, bin_path)
        .map_err(|e| anyhow::anyhow!("Failed to convert BIN to text: {}", e))?;

    rendered().insert(bin_path.to_path_buf(), (stamp, text.clone()));
    Ok(text)
}

/// Recursively search a directory for .ritobin files, preferring Concat.bin.ritobin
pub fn find_ritobin_in_dir(dir: &Path) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut fallback: Option<std::path::PathBuf> = None;

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_lowercase();

        if path.is_dir() {
            if let Some(text) = find_ritobin_in_dir(&path) {
                return Some(text);
            }
        } else if name.ends_with(".bin.ritobin") {
            if name.contains("concat") {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    tracing::debug!("✓ Found concat .ritobin directly: {}", path.display());
                    return Some(text);
                }
            } else if fallback.is_none() {
                fallback = Some(path);
            }
        }
    }

    if let Some(fb_path) = fallback {
        if let Ok(text) = std::fs::read_to_string(&fb_path) {
            tracing::debug!("✓ Found .ritobin directly: {}", fb_path.display());
            return Some(text);
        }
    }

    None
}

