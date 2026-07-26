//! Project-local hash overlay: resolves a modder's own asset paths and BIN
//! identifiers, which appear in no global hash database.

use crate::hash::lmdb_cache::ResolvedHashes;
use rustc_hash::FxHashMap;
use std::path::Path;
use walkdir::WalkDir;

/// A project's own hashes, in both keyspaces Flint resolves.
#[derive(Default)]
pub struct ProjectHashOverlay {
    /// xxh64 WAD path hash → path.
    wad: ResolvedHashes,
    /// FNV-1a BIN identifier hash → name.
    bin: FxHashMap<u32, String>,
}

impl ProjectHashOverlay {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert_wad(&mut self, hash: u64, path: &str) {
        self.wad.insert(hash, path);
    }

    pub fn insert_bin(&mut self, hash: u32, name: &str) {
        self.bin.insert(hash, name.to_string());
    }

    pub fn wad_get(&self, hash: u64) -> Option<&str> {
        self.wad.get(&hash)
    }

    pub fn bin_get(&self, hash: u32) -> Option<&str> {
        self.bin.get(&hash).map(String::as_str)
    }

    pub fn wad_len(&self) -> usize {
        self.wad.len()
    }

    pub fn bin_len(&self) -> usize {
        self.bin.len()
    }

    pub fn is_empty(&self) -> bool {
        self.wad.is_empty() && self.bin.is_empty()
    }

    /// Iterate the WAD keyspace, for serialization.
    pub fn wad_iter(&self) -> impl Iterator<Item = (u64, &str)> + '_ {
        self.wad.iter()
    }

    /// Iterate the BIN keyspace, for serialization.
    pub fn bin_iter(&self) -> impl Iterator<Item = (u32, &str)> + '_ {
        self.bin.iter().map(|(h, s)| (*h, s.as_str()))
    }
}

/// Canonical WAD path hash: xxh64 of the lowercased forward-slash path, seed 0.
///
/// Mirrors `crate::export::wad_chunk_hash`. Hashing mixed case yields a hash no
/// tool can reverse from the lowercase string stored in a BIN.
fn wad_path_hash(wad_relative_path: &str) -> u64 {
    xxhash_rust::xxh64::xxh64(wad_relative_path.to_lowercase().as_bytes(), 0)
}

/// Given a path under a project, return its WAD-relative portion — everything
/// after the first `*.wad.client` directory component — lowercased with forward
/// slashes. Returns `None` when the path is not inside a WAD folder.
fn wad_relative(path: &Path, project_path: &Path) -> Option<String> {
    let rel = path.strip_prefix(project_path).ok()?;
    let mut components = Vec::new();
    let mut seen_wad = false;

    for part in rel.components() {
        let part = part.as_os_str().to_string_lossy();
        if seen_wad {
            components.push(part.to_string());
        } else if part.to_lowercase().ends_with(".wad.client") {
            seen_wad = true;
        }
    }

    if !seen_wad || components.is_empty() {
        return None;
    }
    Some(components.join("/").to_lowercase())
}

/// Walk `content/**` and record every real file's WAD-relative path.
pub fn collect_disk_paths(project_path: &Path, overlay: &mut ProjectHashOverlay) {
    let content = project_path.join("content");
    if !content.is_dir() {
        return;
    }

    for entry in WalkDir::new(&content).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(rel) = wad_relative(path, project_path) else { continue };
        overlay.insert_wad(wad_path_hash(&rel), &rel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_round_trips_both_keyspaces() {
        let mut o = ProjectHashOverlay::new();
        o.insert_wad(42, "assets/characters/test/x.dds");
        o.insert_bin(7, "MyCustomVfxDefinition");

        assert_eq!(o.wad_get(42), Some("assets/characters/test/x.dds"));
        assert_eq!(o.bin_get(7), Some("MyCustomVfxDefinition"));
        assert_eq!(o.wad_get(43), None);
        assert_eq!(o.wad_len(), 1);
        assert_eq!(o.bin_len(), 1);
    }

    #[test]
    fn disk_walk_hashes_wad_relative_paths_lowercased() {
        let dir = tempfile::tempdir().unwrap();
        let deep = dir
            .path()
            .join("content/base/Aatrox.wad.client/ASSETS/Characters/Test");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("X.dds"), b"x").unwrap();

        let mut o = ProjectHashOverlay::new();
        collect_disk_paths(dir.path(), &mut o);

        // Canonical hash is over the lowercased, WAD-relative, forward-slash path.
        let expected =
            xxhash_rust::xxh64::xxh64(b"assets/characters/test/x.dds", 0);
        assert_eq!(o.wad_get(expected), Some("assets/characters/test/x.dds"));
    }

    #[test]
    fn disk_walk_ignores_files_outside_a_wad_folder() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("content/base")).unwrap();
        std::fs::write(dir.path().join("content/base/loose.dds"), b"x").unwrap();

        let mut o = ProjectHashOverlay::new();
        collect_disk_paths(dir.path(), &mut o);

        assert_eq!(o.wad_len(), 0);
    }
}
