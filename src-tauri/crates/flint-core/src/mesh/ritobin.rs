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

/// Parsed bins, cached the same way [`rendered`] caches text.
type ParsedCache = DashMap<PathBuf, (Stamp, std::sync::Arc<(Bin, crate::bin::Trailer)>)>;

fn parsed() -> &'static ParsedCache {
    static CACHE: OnceLock<ParsedCache> = OnceLock::new();
    CACHE.get_or_init(DashMap::new)
}

fn stamp_of(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some(Stamp {
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

/// One bin, parsed, with the name table its own location supplies.
///
/// The AST counterpart of [`render_bin`]: the tree is what the caller wants, and the names are
/// looked up per value reached instead of substituted across the printed text.
pub fn load_bin(bin_path: &Path) -> Option<std::sync::Arc<(Bin, crate::bin::Trailer)>> {
    let stamp = stamp_of(bin_path)?;
    if let Some(hit) = parsed().get(bin_path) {
        if hit.0 == stamp {
            return Some(hit.1.clone());
        }
    }

    let data = std::fs::read(bin_path).ok()?;
    let tree = crate::bin::codec::read_bin(&data).ok()?;
    let names = crate::bin::name_table(&tree, bin_path);
    let entry = std::sync::Arc::new((tree, names));
    parsed().insert(bin_path.to_path_buf(), (stamp, entry.clone()));
    Some(entry)
}

/// Every bin a mesh's materials can live in: its companion skin/SCB bin, the project's concat
/// bin, and every bin in the skin bin's direct `linked` header that resolves on disk.
///
/// Riot's build hoists entries shared between skins out of `skinN.bin` into a
/// `<Champ>_Skins_*.bin`, so a material a mesh uses is frequently in none of the obvious files.
pub fn mesh_bins(mesh_path: &Path) -> Vec<std::sync::Arc<(Bin, crate::bin::Trailer)>> {
    let mut paths: Vec<PathBuf> = Vec::new();
    let push = |p: Option<PathBuf>, paths: &mut Vec<PathBuf>| {
        if let Some(p) = p {
            if !paths.contains(&p) {
                paths.push(p);
            }
        }
    };

    let companion = find_skin_bin(mesh_path).or_else(|| find_scb_bin(mesh_path));
    push(companion.clone(), &mut paths);
    push(find_concat_bin_path(mesh_path), &mut paths);

    if let Some(skin_bin) = companion {
        if let Some(entry) = load_bin(&skin_bin) {
            let project_root = find_project_root(mesh_path);
            for linked in &entry.0.linked {
                let normalized = linked.replace(char::from(92), "/");
                if !normalized.to_lowercase().ends_with(".bin") {
                    continue;
                }
                push(
                    resolve_linked_bin_path(mesh_path, project_root.as_deref(), &normalized),
                    &mut paths,
                );
            }
        }
    }

    paths.iter().filter_map(|p| load_bin(p)).collect()
}

/// The project's concat bin: the first `*concat*.bin` beside the skin bins, else under `data/`.
pub fn find_concat_bin_path(mesh_path: &Path) -> Option<PathBuf> {
    let root = find_project_root(mesh_path)?;
    let character_folder = extract_character_folder(mesh_path)?;

    for search_dir in [
        root.join("data").join("characters").join(&character_folder).join("skins"),
        root.join("data"),
    ] {
        let Ok(entries) = std::fs::read_dir(&search_dir) else { continue };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_lowercase()) else {
                continue;
            };
            if name.contains("concat") && name.ends_with(".bin") {
                return Some(path);
            }
        }
    }
    None
}

use crate::mesh::discovery::{extract_character_folder, find_project_root, find_scb_bin};
use crate::mesh::texture::find_skin_bin;

/// Read and parse every `.bin` in a skin BIN's direct `linked` header that resolves on disk.
///
/// Direct list only — no recursion, no project-wide scan — entries Riot's build hoisted
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
