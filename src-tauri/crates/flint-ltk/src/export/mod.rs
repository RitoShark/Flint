use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Builds a valid WAD v3.4 binary (zstd-compressed, deduplicated chunks) from a
/// `.wad.client` directory.
pub fn build_wad_from_directory(wad_dir: &Path) -> Result<Vec<u8>, String> {
    use ritoshark::wad::{Error as WadError, WadBuilder};

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

    let mut hash_to_path: HashMap<u64, PathBuf> = HashMap::with_capacity(wad_files.len());
    let mut builder = WadBuilder::new();

    for (wad_path, file_path) in &wad_files {
        let hash = ritoshark::hash::xxh64(wad_path);
        hash_to_path.insert(hash, file_path.clone());
        builder = builder.with_chunk(wad_path);
    }

    let wad_bytes = builder
        .build_to_bytes(|path_hash, w| {
            if let Some(file_path) = hash_to_path.get(&path_hash) {
                let data = std::fs::read(file_path).map_err(|e| {
                    WadError::Build(format!("Failed to read {}: {}", file_path.display(), e))
                })?;
                w.write_all(&data).map_err(|e| {
                    WadError::Build(format!("Failed to write chunk bytes: {}", e))
                })?;
            }
            Ok(())
        })
        .map_err(|e| format!("Failed to build WAD: {}", e))?;

    tracing::info!("WAD built: {} bytes from {} chunks", wad_bytes.len(), wad_files.len());
    Ok(wad_bytes)
}
