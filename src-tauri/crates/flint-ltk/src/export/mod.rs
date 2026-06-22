use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn is_unresolved_hash(path: &str) -> bool {
    let p = path.to_lowercase();
    let name = Path::new(&p).file_stem().unwrap_or_default().to_string_lossy();
    name.len() == 16 && name.chars().all(|c| c.is_ascii_hexdigit())
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
            xxhash_rust::xxh64::xxh64(wad_path.as_bytes(), 0)
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
