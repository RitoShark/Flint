/*!
Naming the `0x…` tokens a rendered bin is left with.

A repath invents asset paths and object names that exist in no hash dictionary, so a bin
that stores only their hash cannot be read back without a record of what was hashed. Three
records are consulted, each filling only what the ones before it could not:

1. the bin's own `ritobinmap` record (`rs_bin::PathMap`), written at authoring time;
2. `files.txt` at the mod root, which survives a reserialize the trailer does not;
3. the assets actually on disk — the WAD-relative path IS what was hashed, so a file still
   present names itself with no table involved.

This lives here rather than in the command layer because the BIN editor is not the only
reader. The model preview parses the same rendered text to find its textures, and a
`texturePath: file = 0x…` it cannot name is a texture it cannot load.
*/

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use ritoshark::bin::Bin;

/// How long a mod root's name table is trusted before the folder is walked again.
///
/// The walk is the expensive half of naming — up to `MAX_FILES` stat calls — and loading one
/// mesh renders six or more bins, each of which would otherwise redo it. A few seconds is
/// long enough to collapse that into one walk and short enough that a file the user just
/// dropped in shows up without restarting.
const MOD_ROOT_TTL: Duration = Duration::from_secs(5);

type ModRootCache = DashMap<PathBuf, (Instant, crate::Trailer)>;

fn mod_root_cache() -> &'static ModRootCache {
    static CACHE: OnceLock<ModRootCache> = OnceLock::new();
    CACHE.get_or_init(DashMap::new)
}

/// Drop the cached name table for the mod root `path` belongs to.
///
/// Call after writing a bin or an asset into a project, so the next render sees it.
pub fn forget_mod_root(path: &Path) {
    if let Some(root) = mod_root(path) {
        mod_root_cache().remove(&root);
    }
}

/// Render a bin to ritobin text with every name source applied.
///
/// `bin_path` is where the bin lives on disk; the mod-root records are found relative to it.
pub fn render_bin_text(bin: &Bin, bin_path: &Path) -> crate::codec::Result<String> {
    let text = crate::codec::tree_to_text_cached(bin)?;
    let text = apply_own_names(text, bin);
    Ok(apply_mod_root_names(text, bin_path))
}

/// Resolve the `0x…` tokens only this bin's own record can name.
pub fn apply_own_names(text: String, bin: &Bin) -> String {
    let carried = crate::codec::embedded_names(bin);
    if carried.is_empty() {
        return text;
    }
    tracing::info!("BIN carries {} embedded hash name(s)", carried.len());
    crate::apply_names(text, &carried)
}

/// Name the `0x…` tokens the bin's own trailer could not, from the mod folder.
///
/// Two fallbacks for a bin whose record is missing — one written by a tool that
/// emits none, or one whose record a reserialize dropped:
///
/// 1. `files.txt` at the mod root, the deliberate record. Names a path whether or
///    not the file is still on disk.
/// 2. Hashing the assets actually present. Needs no sidecar at all, but can only
///    find what exists.
///
/// Both only fill gaps — `apply_own_names` runs first, so a recorded name always
/// beats an inferred one. Cheap to skip: with nothing left unresolved in the
/// text there is no reason to touch the disk.
pub fn apply_mod_root_names(text: String, bin_path: &Path) -> String {
    // Only pay for this when the text still has unnamed hashes in it.
    if !text.contains("0x") {
        return text;
    }
    let Some(root) = mod_root(bin_path) else {
        return text;
    };

    let trailer = mod_root_names(&root);
    if trailer.is_empty() {
        return text;
    }
    crate::apply_names(text, &trailer)
}

/// Every name source for one bin, merged into a single lookup table.
///
/// The same three records [`render_bin_text`] applies to text, for callers that walk the
/// parsed tree instead and only need to name the handful of hashes they actually reach.
pub fn name_table(bin: &Bin, bin_path: &Path) -> crate::Trailer {
    let mut table = crate::codec::embedded_names(bin);
    if let Some(root) = mod_root(bin_path) {
        let from_root = mod_root_names(&root);
        for (hash, name) in from_root.names {
            table.names.entry(hash).or_insert(name);
        }
        for (hash, name) in from_root.files {
            table.files.entry(hash).or_insert(name);
        }
    }
    table
}

/// The name table for one mod root, walked at most once per [`MOD_ROOT_TTL`].
fn mod_root_names(root: &Path) -> crate::Trailer {
    if let Some(hit) = mod_root_cache().get(root) {
        if hit.0.elapsed() < MOD_ROOT_TTL {
            return hit.1.clone();
        }
    }

    let trailer = build_mod_root_names(root);
    tracing::info!(
        "Mod folder {} names {} hash(es) the trailer did not",
        root.display(),
        trailer.len()
    );
    mod_root_cache().insert(root.to_path_buf(), (Instant::now(), trailer.clone()));
    trailer
}

fn build_mod_root_names(root: &Path) -> crate::Trailer {
    let root = root.to_path_buf();
    let mut trailer = crate::Trailer::new();

    // 1. files.txt — `<hex> <name>`, or a bare path from the older format.
    if let Ok(list) = fs::read_to_string(root.join("files.txt")) {
        for line in list.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match line.split_once(char::is_whitespace) {
                Some((hex, name)) if is_hash_hex(hex) => {
                    let name = name.trim().to_string();
                    if hex.len() == 8 {
                        if let Ok(h) = u32::from_str_radix(hex, 16) {
                            trailer.names.entry(h).or_insert(name);
                        }
                    } else if let Ok(h) = u64::from_str_radix(hex, 16) {
                        trailer.files.entry(h).or_insert(name);
                    }
                }
                _ => {
                    trailer
                        .files
                        .entry(ritoshark::hash::xxh64(line))
                        .or_insert_with(|| line.to_string());
                }
            }
        }
    }

    // 2. Whatever is on disk. The WAD-relative path IS what was hashed, so a
    //    file still present names itself with no table involved.
    const ASSET_EXTS: [&str; 13] = [
        "tex", "dds", "png", "jpg", "jpeg", "skn", "skl", "scb", "sco", "anm", "bnk", "wpk", "bin",
    ];
    const MAX_FILES: usize = 100_000;
    let mut stack = vec![root.clone()];
    let mut scanned = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if scanned >= MAX_FILES {
                tracing::warn!("mod-root scan hit the {MAX_FILES}-file cap; some hashes may stay unnamed");
                stack.clear();
                break;
            }
            let path = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(path),
                Ok(t) if t.is_file() => {
                    let ext = path
                        .extension()
                        .map(|e| e.to_string_lossy().to_ascii_lowercase())
                        .unwrap_or_default();
                    if !ASSET_EXTS.contains(&ext.as_str()) {
                        continue;
                    }
                    scanned += 1;
                    let Ok(rel) = path.strip_prefix(&root) else { continue };
                    let rel = rel.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
                    trailer
                        .files
                        .entry(ritoshark::hash::xxh64(&rel))
                        .or_insert(rel);
                }
                _ => {}
            }
        }
    }

    trailer
}

/// The mod folder a bin sits in: the directory holding `data/` or `assets/`.
pub fn mod_root(bin_path: &Path) -> Option<std::path::PathBuf> {
    let mut dir = bin_path.parent();
    while let Some(d) = dir {
        if d.join("data").is_dir() || d.join("assets").is_dir() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// 8 hex digits (fnv1a32) or 16 (xxh64) — the two hash widths a bin uses.
pub fn is_hash_hex(s: &str) -> bool {
    (s.len() == 8 || s.len() == 16) && s.chars().all(|c| c.is_ascii_hexdigit())
}

