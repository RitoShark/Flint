//! Resolve and rename leftover hashed project files (`<16hex>.ext`) to their
//! real asset paths, comparing against a caller-supplied resolver (LMDB / live
//! WAD). If a string-named twin already exists at the destination, the hashed
//! duplicate is removed instead of overwriting.

use std::collections::HashMap;
use std::path::Path;
use walkdir::WalkDir;

/// True when `stem` is exactly 16 ASCII-hex chars (an unresolved hash name).
fn is_hash_stem(stem: &str) -> bool {
    stem.len() == 16 && stem.chars().all(|c| c.is_ascii_hexdigit())
}

/// Rename every `<16hex>.ext` file under `wad_root` to the path `resolve`
/// returns for its hash. `resolve` takes the parsed u64 hashes and returns
/// resolved paths in the same order (an unresolved entry comes back as the
/// 16-hex string, which we skip). Returns the number of files renamed.
pub fn unhash_project_files(wad_root: &Path, resolve: &dyn Fn(&[u64]) -> Vec<String>) -> usize {
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
        return 0;
    }

    // 2) Resolve all at once.
    let resolved = resolve(&hashes);

    // 3) Rename (or drop the dup if a string-named twin already exists).
    let mut renamed = 0usize;
    let mut taken: HashMap<String, ()> = HashMap::new();
    for ((ext, disk_path), path) in entries.iter().zip(resolved.iter()) {
        let lower = path.to_lowercase();
        // Still unresolved (came back as the hex stem) → leave it.
        let stem = Path::new(path).file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if is_hash_stem(stem) {
            continue;
        }
        // Ensure the resolved path carries an extension; fall back to the file's.
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
            renamed += 1;
            taken.insert(lower, ());
        }
    }
    renamed
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
            hs.iter().map(|h| match *h {
                x if x == h1 => "data/x/a.dds".to_string(),
                x if x == h2 => "data/x/b.dds".to_string(),
                other => format!("{:016x}", other),
            }).collect()
        };
        let n = unhash_project_files(root, &resolve);
        assert_eq!(n, 1, "only a.dds renamed; b.dds dropped as dup");
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
        assert_eq!(unhash_project_files(root, &resolve), 0);
        assert!(root.join(&name).exists());
    }
}
