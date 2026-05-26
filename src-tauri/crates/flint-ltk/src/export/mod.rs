//! Export module for creating distributable mod packages

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Build a proper WAD binary from a .wad.client directory
///
/// Uses league_toolkit's WadBuilder to create a valid WAD v3.4 binary
/// with compressed chunks that mod managers can read.
pub fn build_wad_from_directory(wad_dir: &Path) -> Result<Vec<u8>, String> {
    use league_toolkit::wad::{WadBuilder, WadChunkBuilder};
    use std::io::{Cursor, Write};

    // Collect all files with their WAD-relative paths
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

    // Build hash -> file path lookup (WadBuilder callback receives hash, not path)
    let mut hash_to_path: HashMap<u64, PathBuf> = HashMap::with_capacity(wad_files.len());
    let mut builder = WadBuilder::default();

    for (wad_path, file_path) in &wad_files {
        let hash = xxhash_rust::xxh64::xxh64(wad_path.to_lowercase().as_bytes(), 0);
        hash_to_path.insert(hash, file_path.clone());
        builder = builder.with_chunk(WadChunkBuilder::default().with_path(wad_path));
    }

    // Build WAD binary to memory
    let mut wad_buffer = Cursor::new(Vec::new());
    builder
        .build_to_writer(&mut wad_buffer, |path_hash, cursor| {
            if let Some(file_path) = hash_to_path.get(&path_hash) {
                let data = std::fs::read(file_path).map_err(|e| {
                    league_toolkit::wad::WadBuilderError::IoError(std::io::Error::other(
                        format!("Failed to read {}: {}", file_path.display(), e),
                    ))
                })?;
                cursor.write_all(&data)?;
            }
            Ok(())
        })
        .map_err(|e| format!("Failed to build WAD: {}", e))?;

    tracing::info!("WAD built: {} bytes from {} chunks", wad_buffer.get_ref().len(), wad_files.len());
    Ok(wad_buffer.into_inner())
}
