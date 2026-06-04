//! Format conversion commands for luabin and troybin files

use flint_ltk::wad_jade::adapter::WadHandle as WadReader;

/// Convert a luabin (Lua 5.1 bytecode) buffer to readable Lua source text
#[tauri::command]
pub async fn convert_luabin_to_text(data: Vec<u8>) -> Result<String, String> {
    flint_ltk::luabin::convert_luabin(&data)
}

/// Read a `.luabin64` file and return decompiled Lua source as raw UTF-8 bytes.
#[tauri::command]
pub async fn read_luabin_text(path: String) -> Result<tauri::ipc::Response, String> {
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let text = flint_ltk::luabin::convert_luabin(&data)?;
    Ok(tauri::ipc::Response::new(text.into_bytes()))
}

/// Convert a troybin binary buffer to INI-like text
#[tauri::command]
pub async fn convert_troybin_to_text(data: Vec<u8>) -> Result<String, String> {
    flint_ltk::troybin::convert_troybin(&data)
}

/// Read a `.troybin` file and return INI-like text as raw UTF-8 bytes.
#[tauri::command]
pub async fn read_troybin_text(path: String) -> Result<tauri::ipc::Response, String> {
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let text = flint_ltk::troybin::convert_troybin(&data)?;
    Ok(tauri::ipc::Response::new(text.into_bytes()))
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

/// Read and convert an inibin chunk from a WAD file to JSON
#[tauri::command]
pub async fn read_wad_inibin(
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

    // Parse with ltk_inibin and convert to JSON
    let file = ltk_inibin::from_slice(&data)
        .map_err(|e| format!("Failed to parse inibin: {}", e))?;
    
    serde_json::to_string_pretty(&file)
        .map_err(|e| format!("Failed to serialize inibin to JSON: {}", e))
}

/// Read a `.inibin`/`.cfgbin` and return INI-style editable text as raw UTF-8 bytes.
#[tauri::command]
pub async fn read_inibin_text(path: String) -> Result<tauri::ipc::Response, String> {
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let file = ltk_inibin::from_slice(&data).map_err(|e| format!("Failed to parse inibin: {e}"))?;
    let text = flint_ltk::inibin_text::inibin_to_text(&file);
    Ok(tauri::ipc::Response::new(text.into_bytes()))
}

/// Parse INI-style text and write it back to a `.inibin` (v2 binary).
#[tauri::command]
pub async fn save_inibin_text(path: String, content: String) -> Result<(), String> {
    let file = flint_ltk::inibin_text::text_to_inibin(&content)?;
    if file.version() == 1 {
        return Err("Legacy v1 inibin files are read-only".into());
    }
    let mut out = Vec::new();
    ltk_inibin::write(&mut out, &file).map_err(|e| format!("Failed to write inibin: {e}"))?;
    std::fs::write(&path, &out).map_err(|e| format!("Failed to write {path}: {e}"))?;
    Ok(())
}

/// Read and convert an rst chunk from a WAD file to JSON
#[tauri::command]
pub async fn read_wad_rst(
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

    // Parse with RitoShark's rs_rst and convert to JSON.
    rst_bytes_to_json(&data)
}

/// Read a `.stringtable` (RST) and return editor JSON as raw UTF-8 bytes.
#[tauri::command]
pub async fn read_stringtable_json(path: String) -> Result<tauri::ipc::Response, String> {
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let json = flint_ltk::stringtable::rst_to_json(&data)?;
    Ok(tauri::ipc::Response::new(json.into_bytes()))
}

/// Write editor JSON back to a `.stringtable` (RST) file.
#[tauri::command]
pub async fn save_stringtable_json(path: String, content: String) -> Result<(), String> {
    let bytes = flint_ltk::stringtable::json_to_rst(&content)?;
    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write {path}: {e}"))?;
    Ok(())
}

/// Read a `.manifest` (RMAN) and return viewer JSON as raw UTF-8 bytes.
#[tauri::command]
pub async fn read_manifest_json(path: String) -> Result<tauri::ipc::Response, String> {
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let json = flint_ltk::manifest::rman_to_json(&data)?;
    Ok(tauri::ipc::Response::new(json.into_bytes()))
}

/// Parse RST bytes with `ritoshark::rst` and emit the same JSON shape the old
/// `ltk_rst::Stringtable` serde output produced: `{ "entries": { "<hash_u64>": "<text>" } }`.
///
/// `ltk_rst::Stringtable` derived `Serialize` over a `HashMap<u64, String>` (keys rendered
/// as decimal strings, arbitrary order). `ritoshark::rst::Rst` instead exposes
/// `entries: Vec<(u64, RstValue)>`, so we collect into a `BTreeMap<u64, String>` — identical
/// JSON shape and key encoding, but with a stable (numeric) key order instead of the old
/// nondeterministic `HashMap` order. Encrypted pre-v5 payloads (which `ltk_rst` never
/// surfaced) degrade to an empty string, matching the "string value" contract.
fn rst_bytes_to_json(data: &[u8]) -> Result<String, String> {
    use ritoshark::prelude::Parse;
    use serde::Serialize;
    use std::collections::BTreeMap;

    let mut reader = std::io::Cursor::new(data);
    let table = ritoshark::rst::Rst::from_reader(&mut reader)
        .map_err(|e| format!("Failed to parse rst: {:?}", e))?;

    let entries: BTreeMap<u64, String> = table
        .entries
        .iter()
        .map(|(hash, value)| (*hash, value.as_str().unwrap_or("").to_string()))
        .collect();

    #[derive(Serialize)]
    struct StringtableJson {
        entries: BTreeMap<u64, String>,
    }

    serde_json::to_string_pretty(&StringtableJson { entries })
        .map_err(|e| format!("Failed to serialize rst to JSON: {}", e))
}
