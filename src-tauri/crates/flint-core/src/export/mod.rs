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

use crate::hash::wad_chunk_hash;

/** The shippable files inside a `.wad.client` directory, as (WAD-internal path, disk
path) pairs. Excludes `testcuberenderer` scratch content and `.ritobin` editor sidecars,
neither of which belongs in a distributed mod.

Both export shapes go through this: packing into a WAD binary and emitting the folder
verbatim into a `.fantome`. Keeping one walk means the two can never ship different
content. */
pub fn wad_directory_files(wad_dir: &Path) -> Result<HashMap<String, PathBuf>, String> {
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
    Ok(wad_files)
}

/** The `.wad.client` directories a project ships. `content/base` is the only layer an
exporter reads, so a pre-export check that looked anywhere else would report on files no
player ever receives. */
pub fn project_wad_folders(project_path: &Path) -> Result<Vec<PathBuf>, String> {
    let content_base = project_path.join("content").join("base");
    let entries = std::fs::read_dir(&content_base)
        .map_err(|e| format!("Failed to read content/base: {}", e))?;

    let mut folders: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|e| format!("Failed to read directory entry: {}", e))?
            .path();
        let is_wad = path
            .file_name()
            .map(|n| n.to_string_lossy().ends_with(".wad.client"))
            .unwrap_or(false);
        if path.is_dir() && is_wad {
            folders.push(path);
        }
    }
    folders.sort();
    Ok(folders)
}

/// Builds a valid WAD v3.4 binary (zstd-compressed, deduplicated chunks) from a
/// `.wad.client` directory.
pub fn build_wad_from_directory(wad_dir: &Path) -> Result<Vec<u8>, String> {
    use crate::wad::writer::{write_wad, EntryToWrite};

    let wad_files = wad_directory_files(wad_dir)?;

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

    #[test]
    fn only_wad_client_dirs_under_content_base_are_shipped() {
        let root = std::env::temp_dir().join(format!("flint-wadfolders-{}", std::process::id()));
        let base = root.join("content").join("base");
        std::fs::create_dir_all(base.join("Aatrox.wad.client")).unwrap();
        std::fs::create_dir_all(base.join("Map11.wad.client")).unwrap();
        std::fs::create_dir_all(base.join("scratch")).unwrap();
        std::fs::create_dir_all(root.join("content").join("other.wad.client")).unwrap();
        std::fs::write(base.join("packed.wad.client"), b"x").unwrap();

        let names: Vec<String> = project_wad_folders(&root)
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["Aatrox.wad.client", "Map11.wad.client"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_project_without_content_base_is_an_error() {
        let root = std::env::temp_dir().join(format!("flint-nowads-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(project_wad_folders(&root).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
