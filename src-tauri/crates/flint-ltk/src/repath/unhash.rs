//! Resolve and rename leftover hashed project files (`<16hex>.ext`) to their
//! real asset paths, comparing against a caller-supplied resolver (LMDB / live
//! WAD). If a string-named twin already exists at the destination, the hashed
//! duplicate is removed instead of overwriting.
//! Hashed files that cannot be resolved AND are not referenced by any surviving
//! BIN under `wad_root` are deleted as dead-weight orphans.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use walkdir::WalkDir;

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

/// Known asset path extensions used when scanning BIN bytes for path strings.
const ASSET_EXTS: &[&str] = &[
    "dds", "tex", "scb", "skn", "sco", "bnk", "wpk", "wem", "anm", "png",
    "tga", "bin", "troybin", "luabin", "stringtable", "json",
];

/// Scan all `.bin` files under `wad_root` and return the set of u64 hashes that
/// are referenced — either as bare 16-hex tokens or via `xxh64(lowercased path
/// string)` for any asset-path-looking ASCII substring.
fn collect_referenced_hashes(wad_root: &Path) -> HashSet<u64> {
    let mut referenced: HashSet<u64> = HashSet::new();

    for entry in WalkDir::new(wad_root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("bin") {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else { continue };

        // Walk bytes collecting printable ASCII runs.
        let mut i = 0usize;
        while i < bytes.len() {
            // Collect an ASCII run.
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_graphic() {
                i += 1;
            }
            let run_len = i - start;
            if run_len < 4 {
                i += 1;
                continue;
            }
            let Ok(s) = std::str::from_utf8(&bytes[start..i]) else {
                i += 1;
                continue;
            };

            // Check if this run looks like a 16-hex hash stem (bare token).
            if run_len == 16 && s.chars().all(|c| c.is_ascii_hexdigit()) {
                if let Ok(h) = u64::from_str_radix(s, 16) {
                    referenced.insert(h);
                }
            }

            // Check if this run looks like an asset path (contains '/' and ends
            // with a known extension), then hash it.
            if s.contains('/') {
                let lower = s.to_lowercase();
                if ASSET_EXTS.iter().any(|ext| lower.ends_with(&format!(".{}", ext))) {
                    let h = xxhash_rust::xxh64::xxh64(lower.as_bytes(), 0);
                    referenced.insert(h);
                }
            }

            i += 1;
        }
    }

    referenced
}

/// Rename every `<16hex>.ext` file under `wad_root` to the path `resolve`
/// returns for its hash. `resolve` takes the parsed u64 hashes and returns
/// resolved paths in the same order (an unresolved entry comes back as the
/// 16-hex string, which we skip).
///
/// Unresolvable files that are not referenced by any surviving BIN are deleted
/// as dead-weight orphans.
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

    // 4) Build the referenced-hash set from surviving BINs (only if needed).
    let referenced = if unresolved_hashes.is_empty() {
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
            // Unresolved — check BIN references.
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
}
