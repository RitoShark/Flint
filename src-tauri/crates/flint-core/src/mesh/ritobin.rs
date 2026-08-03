//! Locating a mesh's ritobin text, and caching a BIN's text form beside it.
//!
//! A mesh's material data lives in a companion BIN. The text form may already
//! sit next to the mesh, in a concatenated bin, or behind a link from the skin
//! bin — each is tried in turn.

use std::path::Path;

use ritoshark::bin::Bin;

use crate::mesh::discovery::{extract_character_folder, find_project_root, find_scb_bin};
use crate::mesh::texture::find_skin_bin;

pub fn find_ritobin_text(mesh_path: &Path) -> Option<String> {
    // Strategy 1: Find .bin via standard lookups, then check .ritobin cache
    let bin_finders: [fn(&Path) -> Option<std::path::PathBuf>; 2] = [
        |p| find_skin_bin(p),
        |p| find_scb_bin(p),
    ];

    for finder in &bin_finders {
        if let Some(bin_path) = finder(mesh_path) {
            let ritobin_path = std::path::PathBuf::from(format!("{}.ritobin", bin_path.display()));

            if ritobin_path.exists() {
                if let Ok(text) = std::fs::read_to_string(&ritobin_path) {
                    tracing::debug!("✓ Found .ritobin cache next to BIN: {}", ritobin_path.display());
                    return Some(text);
                }
            }

            tracing::debug!("Creating .ritobin cache from BIN: {}", bin_path.display());
            match create_ritobin_cache(&bin_path, &ritobin_path) {
                Ok(text) => {
                    tracing::debug!("Created .ritobin cache: {}", ritobin_path.display());
                    return Some(text);
                }
                Err(e) => {
                    tracing::warn!("Failed to create .ritobin cache: {}", e);
                }
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

                    let ritobin_path = std::path::PathBuf::from(format!("{}.ritobin", path.display()));
                    if ritobin_path.exists() {
                        if let Ok(text) = std::fs::read_to_string(&ritobin_path) {
                            tracing::debug!("  ✓ Loaded concat ritobin cache: {}", ritobin_path.display());
                            return Some(text);
                        }
                    }

                    tracing::debug!("  Creating ritobin cache for concat BIN...");
                    if let Ok(text) = create_ritobin_cache(&path, &ritobin_path) {
                        tracing::debug!("  ✓ Created concat ritobin cache: {}", ritobin_path.display());
                        return Some(text);
                    } else {
                        tracing::debug!("  ✗ Failed to create concat ritobin cache");
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

        let ritobin_path = std::path::PathBuf::from(format!("{}.ritobin", bin_path.display()));
        let text = if ritobin_path.exists() {
            std::fs::read_to_string(&ritobin_path).ok()
        } else {
            create_ritobin_cache(&bin_path, &ritobin_path).ok()
        };

        if let Some(text) = text {
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
pub fn create_ritobin_cache(bin_path: &Path, ritobin_path: &Path) -> anyhow::Result<String> {
    use crate::bin::codec;

    tracing::debug!("Reading BIN file: {}", bin_path.display());

    let data = std::fs::read(bin_path)
        .map_err(|e| anyhow::anyhow!("Failed to read BIN file: {}", e))?;

    let tree = codec::read_bin(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse BIN file: {}", e))?;

    let text = codec::tree_to_text_cached(&tree)
        .map_err(|e| anyhow::anyhow!("Failed to convert BIN to text: {}", e))?;

    std::fs::write(ritobin_path, &text)
        .map_err(|e| anyhow::anyhow!("Failed to write .ritobin cache: {}", e))?;

    tracing::debug!("Wrote {} bytes to {}", text.len(), ritobin_path.display());

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

