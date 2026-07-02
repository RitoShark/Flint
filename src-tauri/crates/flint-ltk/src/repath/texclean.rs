//! Remove `2x_`/`4x_` HD-texture twins. We standardize on `.tex`, so the HD
//! DDS twins Riot ships are redundant — but only delete a twin when its
//! base-resolution counterpart exists (as .dds OR .tex); never delete the only
//! copy of an asset.

use std::collections::HashSet;
use std::path::Path;
use walkdir::WalkDir;

/// Delete every `2x_`/`4x_`-prefixed file that has a base-res sibling in the
/// same directory (same name without the prefix, with either `.dds` or `.tex`).
/// Returns the number removed.
pub fn strip_hd_twins(wad_root: &Path) -> usize {
    // Index every file by lowercased relative path so we can check siblings.
    let mut present: HashSet<String> = HashSet::new();
    let mut twins: Vec<std::path::PathBuf> = Vec::new();
    for e in WalkDir::new(wad_root).into_iter().filter_map(|e| e.ok()) {
        if !e.path().is_file() {
            continue;
        }
        if let Ok(rel) = e.path().strip_prefix(wad_root) {
            present.insert(rel.to_string_lossy().replace('\\', "/").to_lowercase());
        }
        let fname = e.path().file_name().and_then(|s| s.to_str()).unwrap_or("");
        let lower = fname.to_lowercase();
        if lower.starts_with("2x_") || lower.starts_with("4x_") {
            twins.push(e.path().to_path_buf());
        }
    }

    let mut removed = 0usize;
    for twin in twins {
        let Ok(rel) = twin.strip_prefix(wad_root) else {
            continue;
        };
        let rel_lower = rel.to_string_lossy().replace('\\', "/").to_lowercase();
        // Strip the leading "2x_"/"4x_" from the filename segment.
        let (dir, file) = match rel_lower.rsplit_once('/') {
            Some((d, f)) => (format!("{}/", d), f.to_string()),
            None => (String::new(), rel_lower.clone()),
        };
        let base_name = file
            .strip_prefix("2x_")
            .or_else(|| file.strip_prefix("4x_"))
            .unwrap_or(&file);
        let stem = base_name.rsplit_once('.').map(|(s, _)| s).unwrap_or(base_name);
        let base_dds = format!("{}{}.dds", dir, stem);
        let base_tex = format!("{}{}.tex", dir, stem);
        if (present.contains(&base_dds) || present.contains(&base_tex))
            && std::fs::remove_file(&twin).is_ok()
        {
            removed += 1;
        }
        // else: this twin is the only copy — keep it.
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_twin_when_base_exists() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let base = root.join("assets/x/skins/base");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("body.dds"), b"BASE").unwrap();
        std::fs::write(base.join("2x_body.dds"), b"HD2").unwrap();
        std::fs::write(base.join("4x_body.dds"), b"HD4").unwrap();
        let n = strip_hd_twins(root);
        assert_eq!(n, 2);
        assert!(base.join("body.dds").exists());
        assert!(!base.join("2x_body.dds").exists());
        assert!(!base.join("4x_body.dds").exists());
    }

    #[test]
    fn keeps_twin_when_only_copy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let base = root.join("assets/x");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("2x_lonely.dds"), b"ONLY").unwrap();
        assert_eq!(strip_hd_twins(root), 0);
        assert!(base.join("2x_lonely.dds").exists());
    }

    #[test]
    fn base_as_tex_counts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let base = root.join("a");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("cape.tex"), b"TEX").unwrap();
        std::fs::write(base.join("2x_cape.dds"), b"HD").unwrap();
        assert_eq!(strip_hd_twins(root), 1);
        assert!(!base.join("2x_cape.dds").exists());
    }
}
