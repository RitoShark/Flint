//! Resolve and rename leftover hashed project files (`<16hex>.ext`) to their
//! real asset paths, comparing against a caller-supplied resolver (LMDB / live
//! WAD). If a string-named twin already exists at the destination, the hashed
//! duplicate is removed instead of overwriting.
//! Hashed files that cannot be resolved AND are not referenced by any surviving
//! BIN under `wad_root` are deleted as dead-weight orphans.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use walkdir::WalkDir;
use crate::hash::bin_refs::collect_referenced_assets;

/// Result of the unhash pass.
#[derive(Debug, Default, Clone)]
pub struct UnhashResult {
    pub renamed: usize,
    pub deleted_orphans: usize,
}

/// True when `stem` is exactly 16 ASCII-hex chars (an unresolved hash name).
fn is_hash_stem(stem: &str) -> bool {
    stem.len() == 16 && stem.chars().all(|c| c.is_ascii_hexdigit())
}


/// Set of u64 hashes referenced by BINs under `wad_root`.
fn collect_referenced_hashes(wad_root: &Path) -> HashSet<u64> {
    collect_referenced_assets(wad_root)
        .into_iter()
        .map(|r| r.hash)
        .collect()
}

/// Rename every `<16hex>.ext` file under `wad_root` to the path `resolve`
/// returns for its hash. `resolve` takes the parsed u64 hashes and returns
/// resolved paths in the same order (an unresolved entry comes back as the
/// 16-hex string, which we skip).
///
/// Unresolvable files that are not referenced by any surviving BIN are deleted
/// as dead-weight orphans.
///
/// **Degraded-resolver guard**: if the resolver fails to resolve ANY of the
/// hashed files (i.e. every hash in the batch comes back as its own hex stem),
/// and there are at least 2 hashed files, this strongly indicates a corrupt or
/// empty LMDB rather than a genuinely all-orphan project. In that case orphan
/// deletion is skipped entirely (files are kept) and a warning is emitted.
pub fn unhash_project_files(wad_root: &Path, resolve: &dyn Fn(&[u64]) -> Vec<String>) -> UnhashResult {
    // 1) Collect (hash, ext, disk_path) for every hashed file.
    let mut hashes: Vec<u64> = Vec::new();
    let mut entries: Vec<(String, std::path::PathBuf)> = Vec::new(); // (ext, path)
    for e in WalkDir::new(wad_root).into_iter().filter_map(|e| e.ok()) {
        if !e.path().is_file() {
            continue;
        }
        let stem = e.path().file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if !is_hash_stem(stem) {
            continue;
        }
        let Ok(h) = u64::from_str_radix(stem, 16) else { continue };
        let ext = e.path().extension().and_then(|s| s.to_str()).unwrap_or("").to_string();
        hashes.push(h);
        entries.push((ext, e.path().to_path_buf()));
    }
    if hashes.is_empty() {
        return UnhashResult::default();
    }

    // 2) Resolve all at once.
    let resolved = resolve(&hashes);

    // 3) Separate resolved from unresolved.
    let mut unresolved_hashes: Vec<(usize, u64)> = Vec::new(); // (index, hash)
    for (idx, (path, &hash)) in resolved.iter().zip(hashes.iter()).enumerate() {
        let stem = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if is_hash_stem(stem) {
            unresolved_hashes.push((idx, hash));
        }
    }

    // 3b) Degraded-resolver guard: if EVERY hashed file is unresolved and there
    // are at least 2 of them, skip orphan deletion. A working resolver will
    // resolve at least some files when a project has genuine assets; resolving
    // nothing for a multi-file project almost certainly means the LMDB is empty
    // or corrupt rather than every file being a genuine orphan.
    let skip_orphan_delete = !hashes.is_empty()
        && unresolved_hashes.len() == hashes.len()
        && hashes.len() >= 2;
    if skip_orphan_delete {
        tracing::warn!(
            "unhash: resolver returned unresolved hex stems for all {} hashed file(s) — \
             likely a degraded/empty LMDB; skipping orphan deletion to avoid mass-deletion",
            hashes.len()
        );
    }

    // 4) Build the referenced-hash set from surviving BINs (only if needed).
    let referenced = if unresolved_hashes.is_empty() || skip_orphan_delete {
        HashSet::new()
    } else {
        collect_referenced_hashes(wad_root)
    };

    // 5) Rename resolved (or drop the dup if a string-named twin already exists);
    //    delete unresolved orphans that no BIN references.
    let mut result = UnhashResult::default();
    let mut taken: HashMap<String, ()> = HashMap::new();

    for ((ext, disk_path), (path, &hash)) in entries.iter().zip(resolved.iter().zip(hashes.iter())) {
        let stem = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if is_hash_stem(stem) {
            // Unresolved — check degraded-resolver guard first.
            if skip_orphan_delete {
                // Guard active: leave ALL unresolved files; don't delete anything.
                continue;
            }
            // Guard not active: check BIN references.
            if !referenced.contains(&hash) {
                // Truly orphaned; delete it.
                let _ = std::fs::remove_file(disk_path);
                result.deleted_orphans += 1;
            }
            // else: referenced by a BIN → keep.
            continue;
        }

        // Resolved path — ensure it carries an extension; fall back to the file's.
        let lower = path.to_lowercase();
        let mut rel = path.replace('\\', "/");
        if Path::new(&rel).extension().is_none() && !ext.is_empty() {
            rel = format!("{}.{}", rel, ext);
        }
        let dest = wad_root.join(rel.trim_start_matches('/'));
        if dest.exists() || taken.contains_key(&lower) {
            // String twin already present → drop the hashed duplicate.
            let _ = std::fs::remove_file(disk_path);
            continue;
        }
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::rename(disk_path, &dest).is_ok() {
            result.renamed += 1;
            taken.insert(lower, ());
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_resolved_and_drops_twin() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // hashed file that resolves to data/x/a.dds
        let h1 = 0x0123456789abcdefu64;
        std::fs::write(root.join(format!("{:016x}.dds", h1)), b"AAAA").unwrap();
        // hashed file that resolves to data/x/b.dds, but a string twin exists
        let h2 = 0x1111222233334444u64;
        std::fs::write(root.join(format!("{:016x}.dds", h2)), b"BBBB").unwrap();
        std::fs::create_dir_all(root.join("data/x")).unwrap();
        std::fs::write(root.join("data/x/b.dds"), b"TWIN").unwrap();

        let resolve = |hs: &[u64]| -> Vec<String> {
            hs.iter()
                .map(|h| match *h {
                    x if x == h1 => "data/x/a.dds".to_string(),
                    x if x == h2 => "data/x/b.dds".to_string(),
                    other => format!("{:016x}", other),
                })
                .collect()
        };
        let res = unhash_project_files(root, &resolve);
        assert_eq!(res.renamed, 1, "only a.dds renamed; b.dds dropped as dup");
        assert!(root.join("data/x/a.dds").exists());
        assert!(!root.join(format!("{:016x}.dds", h1)).exists());
        // twin untouched, hashed dup removed
        assert_eq!(std::fs::read(root.join("data/x/b.dds")).unwrap(), b"TWIN");
        assert!(!root.join(format!("{:016x}.dds", h2)).exists());
    }

    #[test]
    fn leaves_unresolved_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let h = 0xdeadbeefdeadbeefu64;
        let name = format!("{:016x}.dds", h);
        std::fs::write(root.join(&name), b"X").unwrap();
        let resolve = |hs: &[u64]| hs.iter().map(|h| format!("{:016x}", h)).collect();
        // No BINs reference this hash → it must be deleted as an orphan.
        // Note: only 1 hashed file, so the degraded-resolver guard (>=2) does NOT fire.
        let res = unhash_project_files(root, &resolve);
        assert_eq!(res.deleted_orphans, 1, "unreferenced unresolved hash deleted");
        assert!(!root.join(&name).exists(), "orphan file should be gone");
    }

    #[test]
    fn keeps_unresolved_orphan_referenced_by_bin() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let h = 0xdeadbeefdeadbeefu64;
        let stem = format!("{:016x}", h);
        let name = format!("{}.dds", stem);
        std::fs::write(root.join(&name), b"DATA").unwrap();

        // Write a .bin file that contains the 16-hex stem as bytes (simulating a
        // BIN that references this hashed asset by its bare hex token).
        std::fs::write(root.join("skin0.bin"), stem.as_bytes()).unwrap();

        let resolve = |hs: &[u64]| hs.iter().map(|h| format!("{:016x}", h)).collect();
        let res = unhash_project_files(root, &resolve);
        assert_eq!(res.deleted_orphans, 0, "referenced unresolved hash must be kept");
        assert!(root.join(&name).exists(), "file referenced by a bin must survive");
    }

    /// FIX 1: When the resolver returns hex stems for ALL hashed files AND there
    /// are >= 2 of them, skip orphan deletion (degraded-resolver guard).
    #[test]
    fn skips_orphan_delete_when_all_unresolved() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Three hashed files; resolver returns hex for all (simulates empty LMDB).
        let h1 = 0x0000000000000001u64;
        let h2 = 0x0000000000000002u64;
        let h3 = 0x0000000000000003u64;
        std::fs::write(root.join(format!("{:016x}.dds", h1)), b"A").unwrap();
        std::fs::write(root.join(format!("{:016x}.dds", h2)), b"B").unwrap();
        std::fs::write(root.join(format!("{:016x}.dds", h3)), b"C").unwrap();

        // No BINs anywhere — all three would be "orphans" under a naive check.
        let resolve = |hs: &[u64]| hs.iter().map(|h| format!("{:016x}", h)).collect();
        let res = unhash_project_files(root, &resolve);

        assert_eq!(res.deleted_orphans, 0, "degraded-resolver guard must prevent deletion");
        // All three files must still exist on disk.
        assert!(root.join(format!("{:016x}.dds", h1)).exists(), "file 1 must survive");
        assert!(root.join(format!("{:016x}.dds", h2)).exists(), "file 2 must survive");
        assert!(root.join(format!("{:016x}.dds", h3)).exists(), "file 3 must survive");
    }

    /// FIX 2: An orphan whose hash appears as a `BinValue::File(h)` in a real
    /// binary-format BIN must be kept (structured-parse pass).
    #[test]
    fn keeps_orphan_referenced_by_binary_filehash() {
        use crate::bin::{Bin, BinEntry, BinValue};
        use indexmap::IndexMap;

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // The file hash we want to protect.
        let h = 0xc0ffee00deadbeefu64;
        let name = format!("{:016x}.dds", h);
        std::fs::write(root.join(&name), b"ASSET").unwrap();

        // Build a real PROP BIN that contains a BinValue::File(h) field.
        let mut fields = IndexMap::new();
        fields.insert(0x12345678u32, BinValue::File(h));
        let mut bin = Bin::new();
        bin.entries.push(BinEntry {
            path_hash: 0xaabbccddu32,
            class_hash: 0x11223344u32,
            fields,
        });
        let bin_bytes = crate::bin::write_bin(&bin).expect("write_bin must succeed");
        std::fs::write(root.join("skin0.bin"), &bin_bytes).unwrap();

        // Resolver returns hex for the hashed file (simulates a miss in LMDB).
        // Only 1 hashed file → degraded-resolver guard (>=2) does NOT fire.
        let resolve = |hs: &[u64]| hs.iter().map(|h| format!("{:016x}", h)).collect();
        let res = unhash_project_files(root, &resolve);

        assert_eq!(
            res.deleted_orphans, 0,
            "file referenced by BinValue::File must not be deleted"
        );
        assert!(root.join(&name).exists(), "asset protected by binary File ref must survive");
    }

    #[test]
    fn collect_referenced_assets_returns_path_with_its_hash() {
        let dir = tempfile::tempdir().unwrap();
        // Not a valid BIN — the structured parse fails and the byte-scan
        // fallback is what must produce the hit.
        std::fs::write(
            dir.path().join("a.bin"),
            b"\x00\x00assets/characters/test/x.dds\x00",
        )
        .unwrap();

        let found = collect_referenced_assets(dir.path());

        let expected_hash =
            xxhash_rust::xxh64::xxh64(b"assets/characters/test/x.dds", 0);
        let hit = found
            .iter()
            .find(|r| r.hash == expected_hash)
            .expect("path hash not collected");
        assert_eq!(hit.path.as_deref(), Some("assets/characters/test/x.dds"));
    }

    #[test]
    fn collect_referenced_hashes_still_returns_bare_hashes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.bin"),
            b"\x00\x00assets/characters/test/x.dds\x00",
        )
        .unwrap();

        let hashes = collect_referenced_hashes(dir.path());

        let expected_hash =
            xxhash_rust::xxh64::xxh64(b"assets/characters/test/x.dds", 0);
        assert!(hashes.contains(&expected_hash));
    }
}
