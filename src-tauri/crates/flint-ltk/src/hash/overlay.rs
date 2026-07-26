//! Project-local hash overlay: resolves a modder's own asset paths and BIN
//! identifiers, which appear in no global hash database.

use crate::hash::lmdb_cache::ResolvedHashes;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
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

/// The project's `content/` directory, or `None` when it does not exist.
fn content_dir(project_path: &Path) -> Option<std::path::PathBuf> {
    let content = project_path.join("content");
    if content.is_dir() {
        Some(content)
    } else {
        None
    }
}

/// Walk `content/**` and record every real file's WAD-relative path.
pub fn collect_disk_paths(project_path: &Path, overlay: &mut ProjectHashOverlay) {
    let Some(content) = content_dir(project_path) else {
        return;
    };

    for entry in WalkDir::new(&content).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(rel) = wad_relative(path, project_path) else { continue };
        overlay.insert_wad(wad_path_hash(&rel), &rel);
    }
}

/// Scan the project's BINs for referenced asset paths, catching files a BIN
/// points at that have not been extracted to disk yet.
///
/// Only references that carry a recoverable path string are inserted. A bare
/// hash with no string behind it adds nothing an overlay could display.
pub fn collect_bin_asset_refs(project_path: &Path, overlay: &mut ProjectHashOverlay) {
    let Some(content) = content_dir(project_path) else {
        return;
    };

    for asset in crate::repath::unhash::collect_referenced_assets(&content) {
        if let Some(path) = asset.path {
            overlay.insert_wad(asset.hash, &path);
        }
    }
}

/// Shortest token worth recording. Single letters are almost always loop
/// variables or type tags, not identifiers a user would want unhashed.
const MIN_IDENTIFIER_LEN: usize = 2;

/// FNV-1a 32-bit over the lowercased name — the BIN identifier hash.
///
/// Note this is FNV-1**a**. `crate::audio::event_mapper::fnv1_hash` is FNV-1
/// (multiply-then-XOR) for Wwise event names and is a different function.
pub fn bin_identifier_hash(name: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in name.to_lowercase().as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Scan `*.ritobin` sidecars for identifier tokens and record them.
///
/// Coverage is partial by nature: an identifier is only recoverable if the user
/// has written it as text, because that is the only place it ever exists as a
/// name rather than a hash.
pub fn collect_ritobin_identifiers(project_path: &Path, overlay: &mut ProjectHashOverlay) {
    let Some(content) = content_dir(project_path) else {
        return;
    };

    for entry in WalkDir::new(&content).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_ritobin = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.to_lowercase().ends_with(".ritobin"))
            .unwrap_or(false);
        if !is_ritobin {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path) else { continue };

        for token in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
            if token.len() < MIN_IDENTIFIER_LEN {
                continue;
            }
            // Identifiers start with a letter or underscore, never a digit.
            if !token
                .chars()
                .next()
                .map(|c| c.is_ascii_alphabetic() || c == '_')
                .unwrap_or(false)
            {
                continue;
            }
            overlay.insert_bin(bin_identifier_hash(token), token);
        }
    }
}

/// Cheap staleness check for the on-disk overlay cache.
///
/// `path_set_hash` is what catches renames: a rename leaves `file_count`
/// unchanged, and on NTFS and ext4 it bumps only the parent directory's mtime,
/// not the file's — so the first two fields alone would call a renamed tree
/// fresh and serve the old path forever. Folding every relative path in costs
/// nothing extra, since the walk already visits each one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverlayFingerprint {
    pub file_count: u64,
    pub max_mtime_secs: u64,
    pub path_set_hash: u64,
}

impl OverlayFingerprint {
    pub fn compute(project_path: &Path) -> Self {
        let content = project_path.join("content");
        let mut file_count = 0u64;
        let mut max_mtime_secs = 0u64;
        let mut path_set_hash = 0u64;

        for entry in WalkDir::new(&content).into_iter().filter_map(|e| e.ok()) {
            if !entry.path().is_file() {
                continue;
            }
            file_count += 1;

            // `wrapping_add` so the fold is order-independent — WalkDir's
            // traversal order must not change the fingerprint.
            if let Ok(rel) = entry.path().strip_prefix(&content) {
                let rel = rel.to_string_lossy().replace('\\', "/").to_lowercase();
                path_set_hash =
                    path_set_hash.wrapping_add(xxhash_rust::xxh64::xxh64(rel.as_bytes(), 0));
            }

            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    if let Ok(dur) = modified.duration_since(UNIX_EPOCH) {
                        max_mtime_secs = max_mtime_secs.max(dur.as_secs());
                    }
                }
            }
        }

        Self { file_count, max_mtime_secs, path_set_hash }
    }
}

/// Serialized form of the cache. Kept flat so the file stays readable.
#[derive(Serialize, Deserialize)]
struct CacheFile {
    fingerprint: OverlayFingerprint,
    wad: Vec<(u64, String)>,
    bin: Vec<(u32, String)>,
}

/// `<project>/.flint/hashes.json`. The `.flint` directory is already excluded
/// from checkpoints, so this derived cache never enters a snapshot.
pub fn cache_path(project_path: &Path) -> PathBuf {
    project_path.join(".flint").join("hashes.json")
}

pub fn load_cache(project_path: &Path) -> Option<(OverlayFingerprint, ProjectHashOverlay)> {
    let text = std::fs::read_to_string(cache_path(project_path)).ok()?;
    let parsed: CacheFile = serde_json::from_str(&text).ok()?;

    let mut overlay = ProjectHashOverlay::new();
    for (hash, path) in &parsed.wad {
        overlay.insert_wad(*hash, path);
    }
    for (hash, name) in &parsed.bin {
        overlay.insert_bin(*hash, name);
    }
    Some((parsed.fingerprint, overlay))
}

pub fn save_cache(
    project_path: &Path,
    fingerprint: &OverlayFingerprint,
    overlay: &ProjectHashOverlay,
) -> std::io::Result<()> {
    let path = cache_path(project_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let payload = CacheFile {
        fingerprint: *fingerprint,
        wad: overlay.wad_iter().map(|(h, s)| (h, s.to_string())).collect(),
        bin: overlay.bin_iter().map(|(h, s)| (h, s.to_string())).collect(),
    };

    let text = serde_json::to_string(&payload)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, text)
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

    #[test]
    fn bin_asset_refs_are_collected_with_their_paths() {
        let dir = tempfile::tempdir().unwrap();
        let wad = dir.path().join("content/base/Aatrox.wad.client/data");
        std::fs::create_dir_all(&wad).unwrap();
        std::fs::write(
            wad.join("skin99.bin"),
            b"\x00ASSETS/Perso/MyMod/particles/glow.dds\x00",
        )
        .unwrap();

        let mut o = ProjectHashOverlay::new();
        collect_bin_asset_refs(dir.path(), &mut o);

        let expected =
            xxhash_rust::xxh64::xxh64(b"assets/perso/mymod/particles/glow.dds", 0);
        assert_eq!(
            o.wad_get(expected),
            Some("assets/perso/mymod/particles/glow.dds")
        );
    }

    #[test]
    fn bin_asset_refs_skip_hashes_with_no_recoverable_path() {
        let dir = tempfile::tempdir().unwrap();
        let wad = dir.path().join("content/base/Aatrox.wad.client/data");
        std::fs::create_dir_all(&wad).unwrap();
        // A bare 16-hex token: a referenced hash with no path string behind it.
        std::fs::write(wad.join("skin99.bin"), b"\x00deadbeefcafe0001\x00").unwrap();

        let mut o = ProjectHashOverlay::new();
        collect_bin_asset_refs(dir.path(), &mut o);

        // Nothing to name it with, so it must not enter the overlay.
        assert_eq!(o.wad_len(), 0);
    }

    #[test]
    fn bin_identifier_hash_is_fnv1a_over_lowercase() {
        // Known-good FNV-1a 32-bit values, lowercased input.
        assert_eq!(bin_identifier_hash("mWeightList"), 0xa3c8_0380);
        assert_eq!(bin_identifier_hash("mMaskDataMap"), 0xde04_746e);
        // Case must not matter.
        assert_eq!(
            bin_identifier_hash("MWEIGHTLIST"),
            bin_identifier_hash("mWeightList")
        );
    }

    #[test]
    fn ritobin_identifiers_are_collected() {
        let dir = tempfile::tempdir().unwrap();
        let wad = dir.path().join("content/base/Aatrox.wad.client/data");
        std::fs::create_dir_all(&wad).unwrap();
        std::fs::write(
            wad.join("skin99.bin.ritobin"),
            b"MyCustomVfxDefinition = SkinCharacterDataProperties {\n  mFooBar: f32 = 1.0\n}\n",
        )
        .unwrap();

        let mut o = ProjectHashOverlay::new();
        collect_ritobin_identifiers(dir.path(), &mut o);

        assert_eq!(
            o.bin_get(bin_identifier_hash("MyCustomVfxDefinition")),
            Some("MyCustomVfxDefinition")
        );
        assert_eq!(o.bin_get(bin_identifier_hash("mFooBar")), Some("mFooBar"));
    }

    #[test]
    fn ritobin_collector_ignores_numbers_and_short_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let wad = dir.path().join("content/base/Aatrox.wad.client/data");
        std::fs::create_dir_all(&wad).unwrap();
        std::fs::write(wad.join("a.bin.ritobin"), b"x: f32 = 1.0\n").unwrap();

        let mut o = ProjectHashOverlay::new();
        collect_ritobin_identifiers(dir.path(), &mut o);

        // "x" is below the minimum length; "1.0" is not an identifier.
        assert_eq!(o.bin_get(bin_identifier_hash("x")), None);
    }

    #[test]
    fn cache_round_trips_both_keyspaces() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".flint")).unwrap();

        let mut o = ProjectHashOverlay::new();
        o.insert_wad(42, "assets/characters/test/x.dds");
        o.insert_bin(7, "MyCustomVfxDefinition");
        let fp = OverlayFingerprint { file_count: 3, max_mtime_secs: 99, path_set_hash: 7 };

        save_cache(dir.path(), &fp, &o).unwrap();
        let (loaded_fp, loaded) = load_cache(dir.path()).expect("cache did not load");

        assert_eq!(loaded_fp, fp);
        assert_eq!(loaded.wad_get(42), Some("assets/characters/test/x.dds"));
        assert_eq!(loaded.bin_get(7), Some("MyCustomVfxDefinition"));
    }

    #[test]
    fn missing_cache_loads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_cache(dir.path()).is_none());
    }

    #[test]
    fn fingerprint_changes_when_a_file_is_added() {
        let dir = tempfile::tempdir().unwrap();
        let wad = dir.path().join("content/base/Aatrox.wad.client");
        std::fs::create_dir_all(&wad).unwrap();
        std::fs::write(wad.join("a.dds"), b"a").unwrap();

        let before = OverlayFingerprint::compute(dir.path());
        std::fs::write(wad.join("b.dds"), b"b").unwrap();
        let after = OverlayFingerprint::compute(dir.path());

        assert_ne!(before, after);
        assert_eq!(after.file_count, before.file_count + 1);
    }

    #[test]
    fn corrupt_cache_loads_as_none_rather_than_panicking() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".flint")).unwrap();
        std::fs::write(cache_path(dir.path()), "{ not valid json").unwrap();

        // A corrupt cache must degrade to a rebuild, never break project open.
        assert!(load_cache(dir.path()).is_none());
    }

    #[test]
    fn save_cache_creates_the_flint_directory() {
        let dir = tempfile::tempdir().unwrap();
        // .flint deliberately absent — save_cache must create it.
        let fp = OverlayFingerprint { file_count: 0, max_mtime_secs: 0, path_set_hash: 0 };

        save_cache(dir.path(), &fp, &ProjectHashOverlay::new()).unwrap();

        assert!(cache_path(dir.path()).exists());
    }

    #[test]
    fn fingerprint_changes_when_a_file_is_renamed() {
        let dir = tempfile::tempdir().unwrap();
        let wad = dir.path().join("content/base/Aatrox.wad.client");
        std::fs::create_dir_all(&wad).unwrap();
        std::fs::write(wad.join("a.dds"), b"x").unwrap();

        let before = OverlayFingerprint::compute(dir.path());
        std::fs::rename(wad.join("a.dds"), wad.join("b.dds")).unwrap();
        let after = OverlayFingerprint::compute(dir.path());

        // file_count and mtime are both unchanged by a rename — only the
        // path-set hash catches it.
        assert_eq!(after.file_count, before.file_count);
        assert_ne!(after.path_set_hash, before.path_set_hash);
        assert_ne!(after, before);
    }

    #[test]
    fn fingerprint_is_zero_when_content_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let fp = OverlayFingerprint::compute(dir.path());

        assert_eq!(fp.file_count, 0);
        assert_eq!(fp.max_mtime_secs, 0);
        assert_eq!(fp.path_set_hash, 0);
    }
}
