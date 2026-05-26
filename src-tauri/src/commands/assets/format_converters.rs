//! Format conversion commands for luabin and troybin files

use flint_ltk::wad_jade::adapter::WadHandle as WadReader;

/// Convert a luabin (Lua 5.1 bytecode) buffer to readable Lua source text
#[tauri::command]
pub async fn convert_luabin_to_text(data: Vec<u8>) -> Result<String, String> {
    flint_ltk::luabin::convert_luabin(&data)
}

/// Convert a troybin binary buffer to INI-like text
#[tauri::command]
pub async fn convert_troybin_to_text(data: Vec<u8>) -> Result<String, String> {
    flint_ltk::troybin::convert_troybin(&data)
}

/// Read and convert a luabin chunk from a WAD file
#[tauri::command]
pub async fn read_wad_luabin(
    wad_path: String,
    hash: String,
) -> Result<String, String> {
    // Parse hash
    let path_hash = u64::from_str_radix(&hash, 16)
        .map_err(|e| format!("Invalid hash '{}': {}", hash, e))?;

    // Read WAD chunk
    let mut reader = WadReader::open(&wad_path)?;
    let chunk = *reader
        .get_chunk(path_hash)
        .ok_or_else(|| format!("Chunk {:016x} not found in WAD", path_hash))?;

    let data = reader
        .wad_mut()
        .load_chunk_decompressed(&chunk)
        .map_err(|e| format!("Failed to decompress chunk {:016x}: {}", path_hash, e))?;

    // Convert to Lua source
    flint_ltk::luabin::convert_luabin(&data)
}

/// Read and convert a troybin chunk from a WAD file
#[tauri::command]
pub async fn read_wad_troybin(
    wad_path: String,
    hash: String,
) -> Result<String, String> {
    // Parse hash
    let path_hash = u64::from_str_radix(&hash, 16)
        .map_err(|e| format!("Invalid hash '{}': {}", hash, e))?;

    // Read WAD chunk
    let mut reader = WadReader::open(&wad_path)?;
    let chunk = *reader
        .get_chunk(path_hash)
        .ok_or_else(|| format!("Chunk {:016x} not found in WAD", path_hash))?;

    let data = reader
        .wad_mut()
        .load_chunk_decompressed(&chunk)
        .map_err(|e| format!("Failed to decompress chunk {:016x}: {}", path_hash, e))?;

    // Convert to INI-like text
    flint_ltk::troybin::convert_troybin(&data)
}
