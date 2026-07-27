use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Mod-package container types, re-exported so callers build archives through
/// this module rather than depending on the packaging crate directly.
pub use ltk_modpkg::builder::{ModpkgBuilder, ModpkgChunkBuilder, ModpkgLayerBuilder};
pub use ltk_modpkg::{Modpkg, ModpkgAuthor, ModpkgMetadata};

fn is_unresolved_hash(path: &str) -> bool {
    let p = path.to_lowercase();
    let name = Path::new(&p).file_stem().unwrap_or_default().to_string_lossy();
    name.len() == 16 && name.chars().all(|c| c.is_ascii_hexdigit())
}

/// Canonical WAD path-hash: xxh64 of the **lowercased** forward-slash path.
///
/// This MUST lowercase before hashing — the game, the LMDB hash tables, and
/// every unhash tool key on `xxh64(lowercase)` (see `hash_scanner::xxhash_path`
/// and Quartz's `WadChunkBuilder::with_path`). Hashing a mixed-case path yields
/// a chunk the game can't find and no tool can reverse from the (lowercase)
/// string stored in the BIN.
pub(crate) fn wad_chunk_hash(wad_path: &str) -> u64 {
    xxhash_rust::xxh64::xxh64(wad_path.to_lowercase().as_bytes(), 0)
}

/// Builds a valid WAD v3.4 binary (zstd-compressed, deduplicated chunks) from a
/// `.wad.client` directory.
pub fn build_wad_from_directory(wad_dir: &Path) -> Result<Vec<u8>, String> {
    use crate::wad_jade::writer::{write_wad, EntryToWrite};

    let mut wad_files: HashMap<String, PathBuf> = HashMap::new();
    for entry in walkdir::WalkDir::new(wad_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let p = e.path().to_string_lossy().to_lowercase();
            !p.contains("testcuberenderer")
                && !p.ends_with(".ritobin")
                && e.path().is_file()
        })
    {
        let relative = entry
            .path()
            .strip_prefix(wad_dir)
            .map_err(|e| format!("Failed to strip prefix: {}", e))?;
        let wad_path = relative.to_string_lossy().replace('\\', "/");
        wad_files.insert(wad_path, entry.path().to_path_buf());
    }

    if wad_files.is_empty() {
        return Err(format!("No files found in WAD directory: {}", wad_dir.display()));
    }

    tracing::info!("Building WAD from {} files in {}", wad_files.len(), wad_dir.display());

    let mut entries = Vec::with_capacity(wad_files.len());

    for (wad_path, file_path) in &wad_files {
        let hash = if is_unresolved_hash(wad_path) {
            let name = Path::new(wad_path).file_stem().unwrap_or_default().to_string_lossy();
            u64::from_str_radix(&name, 16).unwrap_or(0)
        } else {
            wad_chunk_hash(wad_path)
        };
        
        let data = std::fs::read(file_path)
            .map_err(|e| format!("Failed to read {}: {}", file_path.display(), e))?;
            
        entries.push(EntryToWrite::new(hash, data));
    }

    let (wad_bytes, stats) = write_wad(entries)
        .map_err(|e| format!("Failed to build WAD: {}", e))?;

    tracing::info!("WAD built: {} bytes from {} chunks ({} files read)", wad_bytes.len(), stats.chunk_count, wad_files.len());
    Ok(wad_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wad_chunk_hash_is_case_insensitive() {
        // A mixed-case path must hash identically to its lowercase form — the
        // game and every unhash tool look chunks up by xxh64(lowercase).
        let mixed = "DATA/Characters/Aatrox/Skins/Skin0.bin";
        let lower = "data/characters/aatrox/skins/skin0.bin";
        assert_eq!(wad_chunk_hash(mixed), wad_chunk_hash(lower));
    }

    #[test]
    fn wad_chunk_hash_matches_canonical_xxh64_lowercase() {
        // Explicitly pin the convention: xxh64 of the LOWERCASED bytes, seed 0.
        let path = "ASSETS/Characters/Foo/Bar.tex";
        let expected = xxhash_rust::xxh64::xxh64(path.to_lowercase().as_bytes(), 0);
        assert_eq!(wad_chunk_hash(path), expected);
    }

    #[test]
    fn wad_chunk_hash_would_differ_without_lowercasing() {
        // Guards against a regression to the old bug: a mixed-case path hashed
        // verbatim produces a DIFFERENT (unresolvable) hash.
        let path = "DATA/Characters/Aatrox.bin";
        let buggy = xxhash_rust::xxh64::xxh64(path.as_bytes(), 0);
        assert_ne!(wad_chunk_hash(path), buggy);
    }
}
