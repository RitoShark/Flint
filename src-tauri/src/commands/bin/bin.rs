use flint_ltk::bin::{bin_to_json, json_to_bin, read_bin, text_to_bin, write_bin};
use flint_ltk::bin::tree_to_text_cached;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use crate::core::ipc_trace;

// Per-path mutex so concurrent read_or_convert_bin calls for the same file
// don't both race past the cache check and convert the BIN twice.
static BIN_INFLIGHT: std::sync::OnceLock<dashmap::DashMap<String, Arc<tokio::sync::Mutex<()>>>> =
    std::sync::OnceLock::new();

fn bin_inflight() -> &'static dashmap::DashMap<String, Arc<tokio::sync::Mutex<()>>> {
    BIN_INFLIGHT.get_or_init(dashmap::DashMap::new)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinInfo {
    pub entry_count: usize,
    pub version: u32,
}

/// Convert a binary .bin file to Python-like text format (.py).
#[tauri::command]
pub async fn convert_bin_to_text(
    input_path: String,
    output_path: String,
) -> Result<(), String> {
    let _t = ipc_trace::enter("convert_bin_to_text");
    tracing::info!("Converting bin to text: {} -> {}", input_path, output_path);

    if input_path.is_empty() {
        tracing::error!("Input path cannot be empty");
        return Err("Input path cannot be empty".to_string());
    }
    if output_path.is_empty() {
        tracing::error!("Output path cannot be empty");
        return Err("Output path cannot be empty".to_string());
    }

    let input = Path::new(&input_path);
    if !input.exists() {
        tracing::error!("Input file does not exist: {}", input_path);
        return Err(format!("Input file does not exist: {}", input_path));
    }

    let data = fs::read(input)
        .map_err(|e| {
            tracing::error!("Failed to read input file '{}': {}", input_path, e);
            format!("Failed to read input file '{}': {}", input_path, e)
        })?;

    tracing::debug!("Read {} bytes from {}", data.len(), input_path);

    let bin = flint_ltk::bin::read_bin_ltk(&data)
        .map_err(|e| {
            tracing::error!("Failed to parse bin file '{}': {}", input_path, e);
            format!("Failed to parse bin file '{}': {}", input_path, e)
        })?;

    tracing::debug!("Parsed bin file with {} objects", bin.entries.len());

    let text = tree_to_text_cached(&bin)
        .map_err(|e| {
            tracing::error!("Failed to convert to text: {}", e);
            format!("Failed to convert to text: {}", e)
        })?;

    fs::write(&output_path, text)
        .map_err(|e| {
            tracing::error!("Failed to write output file '{}': {}", output_path, e);
            format!("Failed to write output file '{}': {}", output_path, e)
        })?;

    tracing::info!("Successfully converted bin to text: {}", output_path);

    Ok(())
}

/// Convert a binary .bin file to JSON format (.json).
#[tauri::command]
pub async fn convert_bin_to_json(
    input_path: String,
    output_path: String,
) -> Result<(), String> {
    if input_path.is_empty() {
        return Err("Input path cannot be empty".to_string());
    }
    if output_path.is_empty() {
        return Err("Output path cannot be empty".to_string());
    }

    let input = Path::new(&input_path);
    if !input.exists() {
        return Err(format!("Input file does not exist: {}", input_path));
    }

    let data = fs::read(input)
        .map_err(|e| format!("Failed to read input file: {}", e))?;

    let bin = read_bin(&data)
        .map_err(|e| format!("Failed to parse bin file: {}", e))?;

    let json = bin_to_json(&bin)
        .map_err(|e| format!("Failed to convert to JSON: {}", e))?;

    fs::write(&output_path, json)
        .map_err(|e| format!("Failed to write output file: {}", e))?;

    Ok(())
}

/// Convert a Python-like text format (.py) to a binary .bin file.
#[tauri::command]
pub async fn convert_text_to_bin(
    input_path: String,
    output_path: String,
) -> Result<(), String> {
    tracing::info!("Converting text to bin: {} -> {}", input_path, output_path);

    if input_path.is_empty() {
        tracing::error!("Input path cannot be empty");
        return Err("Input path cannot be empty".to_string());
    }
    if output_path.is_empty() {
        tracing::error!("Output path cannot be empty");
        return Err("Output path cannot be empty".to_string());
    }

    let input = Path::new(&input_path);
    if !input.exists() {
        tracing::error!("Input file does not exist: {}", input_path);
        return Err(format!("Input file does not exist: {}", input_path));
    }

    let text = fs::read_to_string(input)
        .map_err(|e| {
            tracing::error!("Failed to read input file '{}': {}", input_path, e);
            format!("Failed to read input file '{}': {}", input_path, e)
        })?;

    tracing::debug!("Read {} characters from {}", text.len(), input_path);

    let bin = text_to_bin(&text)
        .map_err(|e| {
            tracing::error!("Failed to parse text from '{}': {}", input_path, e);
            format!("Failed to parse text from '{}': {}", input_path, e)
        })?;

    tracing::debug!("Parsed text to bin with {} objects", bin.entries.len());

    let data = write_bin(&bin)
        .map_err(|e| {
            tracing::error!("Failed to write bin: {}", e);
            format!("Failed to write bin: {}", e)
        })?;

    fs::write(&output_path, data)
        .map_err(|e| {
            tracing::error!("Failed to write output file '{}': {}", output_path, e);
            format!("Failed to write output file '{}': {}", output_path, e)
        })?;

    tracing::info!("Successfully converted text to bin: {}", output_path);

    Ok(())
}

/// Convert a JSON format (.json) to a binary .bin file.
#[tauri::command]
pub async fn convert_json_to_bin(
    input_path: String,
    output_path: String,
) -> Result<(), String> {
    if input_path.is_empty() {
        return Err("Input path cannot be empty".to_string());
    }
    if output_path.is_empty() {
        return Err("Output path cannot be empty".to_string());
    }

    let input = Path::new(&input_path);
    if !input.exists() {
        return Err(format!("Input file does not exist: {}", input_path));
    }

    let json = fs::read_to_string(input)
        .map_err(|e| format!("Failed to read input file: {}", e))?;

    let bin = json_to_bin(&json)
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;

    let data = write_bin(&bin)
        .map_err(|e| format!("Failed to write bin: {}", e))?;

    fs::write(&output_path, data)
        .map_err(|e| format!("Failed to write output file: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn read_bin_info(input_path: String) -> Result<BinInfo, String> {
    let _t = ipc_trace::enter("read_bin_info");
    if input_path.is_empty() {
        return Err("Input path cannot be empty".to_string());
    }

    let input = Path::new(&input_path);
    if !input.exists() {
        return Err(format!("Input file does not exist: {}", input_path));
    }

    let data = fs::read(input)
        .map_err(|e| format!("Failed to read input file: {}", e))?;

    let bin = read_bin(&data)
        .map_err(|e| format!("Failed to parse bin file: {}", e))?;

    Ok(BinInfo {
        entry_count: bin.entries.len(),
        version: 1, // TODO: Extract actual version from bin file if available
    })
}

/// Convert in-memory BIN bytes to Python-like text format.
#[tauri::command]
pub async fn convert_bin_bytes_to_text(
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let bin_data: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("convert_bin_bytes_to_text expects raw bytes; got JSON body".into());
        }
    };
    tracing::debug!("Converting {} bytes of BIN data to text", bin_data.len());

    let bin = flint_ltk::bin::read_bin_ltk(bin_data)
        .map_err(|e| {
            tracing::error!("Failed to parse bin data: {}", e);
            format!("Failed to parse bin data: {}", e)
        })?;

    tracing::debug!("Parsed bin data with {} objects", bin.entries.len());

    let text = tree_to_text_cached(&bin)
        .map_err(|e| {
            tracing::error!("Failed to convert to text: {}", e);
            format!("Failed to convert to text: {}", e)
        })?;

    tracing::debug!("Successfully converted bin data to text ({} chars)", text.len());

    Ok(text)
}

/// Re-resolve any `0x…` hash tokens in ritobin editor text against the cached
/// BIN hash dictionary, returning the unhashed text and how many tokens changed.
///
/// Purely lexical (no tree parse) so it works on partially-edited text and only
/// touches hash tokens. Used by the BIN editor's "Unhash" button — after a hash
/// download the cache has more names than when the text was first converted.
#[tauri::command]
pub async fn unhash_bin_text(text: String) -> Result<UnhashResult, String> {
    let _t = ipc_trace::enter("unhash_bin_text");
    let (unhashed, replaced) = flint_ltk::bin::unhash_text_cached(&text);
    tracing::debug!("unhash_bin_text: resolved {} hash token(s)", replaced);
    Ok(UnhashResult { text: unhashed, replaced })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnhashResult {
    pub text: String,
    pub replaced: usize,
}

/// Convert in-memory BIN bytes to JSON format.
#[tauri::command]
pub async fn convert_bin_bytes_to_json(
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let bin_data: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("convert_bin_bytes_to_json expects raw bytes; got JSON body".into());
        }
    };
    tracing::debug!("Converting {} bytes of BIN data to JSON", bin_data.len());

    let bin = read_bin(bin_data)
        .map_err(|e| {
            tracing::error!("Failed to parse bin data: {}", e);
            format!("Failed to parse bin data: {}", e)
        })?;

    tracing::debug!("Parsed bin data with {} objects", bin.entries.len());

    let json = bin_to_json(&bin)
        .map_err(|e| {
            tracing::error!("Failed to convert to JSON: {}", e);
            format!("Failed to convert to JSON: {}", e)
        })?;

    tracing::debug!("Successfully converted bin data to JSON");

    Ok(json)
}

/// Parse a BIN file and return Python-like text format for the editor.
#[tauri::command]
pub async fn parse_bin_file_to_text(
    path: String,
) -> Result<tauri::ipc::Response, String> {
    tracing::info!("Parsing BIN file for editor: {}", path);

    if path.is_empty() {
        return Err("Path cannot be empty".to_string());
    }

    let input = Path::new(&path);
    if !input.exists() {
        return Err(format!("File does not exist: {}", path));
    }

    let data = fs::read(input)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    tracing::debug!("Read {} bytes from {}", data.len(), path);

    let bin = flint_ltk::bin::read_bin_ltk(&data)
        .map_err(|e| format!("Failed to parse bin file: {}", e))?;

    tracing::debug!("Parsed bin file with {} objects", bin.entries.len());

    let text = flint_ltk::bin::tree_to_text_cached(&bin)
        .map_err(|e| format!("Failed to convert to text: {}", e))?;

    tracing::info!("Successfully parsed BIN file to text ({} chars)", text.len());

    Ok(tauri::ipc::Response::new(text.into_bytes()))
}

/// Read a BIN file as ritobin text. Converts in-memory every time — the editor
/// path never drops a `.ritobin` sidecar next to the file (claiming/editing a
/// bin must not pollute the project folder). The mesh/texture-preview path
/// generates its own sidecar independently when it needs one.
#[tauri::command]
pub async fn read_or_convert_bin(
    bin_path: String,
) -> Result<tauri::ipc::Response, String> {
    let text = read_or_convert_bin_inner(bin_path).await?;
    Ok(tauri::ipc::Response::new(text.into_bytes()))
}

async fn read_or_convert_bin_inner(
    bin_path: String,
) -> Result<String, String> {
    let _t = ipc_trace::enter("read_or_convert_bin");

    tracing::info!("[BIN_READ] Starting read_or_convert_bin (RitoShark) for {}", bin_path);

    if bin_path.is_empty() {
        return Err("Path cannot be empty".to_string());
    }

    let bin_file = Path::new(&bin_path);
    if !bin_file.exists() {
        return Err(format!("File does not exist: {}", bin_path));
    }

    // Serialize concurrent calls for the same path so we don't convert twice.
    let lock = {
        let map = bin_inflight();
        let entry = map.entry(bin_path.clone()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())));        Arc::clone(&*entry)
    };
    let _guard = lock.lock().await;

    // Reject non-BIN files (wrong file type routed here via stale UI state).
    {
        let mut f = fs::File::open(bin_file)
            .map_err(|e| format!("Failed to open file: {}", e))?;
        let mut magic = [0u8; 4];
        use std::io::Read;
        if f.read_exact(&mut magic).is_ok() {
            let is_prop = &magic == b"PROP";
            let is_ptch = &magic == b"PTCH";
            if !is_prop && !is_ptch {
                let ext = bin_file.extension().and_then(|e| e.to_str()).unwrap_or("?");
                return Err(format!(
                    "Not a BIN file (magic: {:02X} {:02X} {:02X} {:02X}, ext: .{}). \
                     Expected PROP or PTCH header.",
                    magic[0], magic[1], magic[2], magic[3], ext
                ));
            }
        }
    }

    tracing::info!("[BIN_READ] Converting BIN with RitoShark engine (in-memory, no sidecar)");

    let data = fs::read(bin_file)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let text = {
        let bin = flint_ltk::bin::read_bin_ltk(&data)
            .map_err(|e| format!("Failed to parse bin file: {}", e))?;
        flint_ltk::bin::tree_to_text_cached(&bin)
            .map_err(|e| format!("Failed to convert to text: {}", e))?
    };

    tracing::info!("[BIN_READ] Converted {} to {} chars of text", bin_path, text.len());
    Ok(text)
}

/// Save edited ritobin content back to the .bin file. Does NOT write a
/// `.ritobin` sidecar — editing a bin must not leave one in the project folder.
#[tauri::command]
pub async fn save_ritobin_to_bin(
    bin_path: String,
    content: String,
) -> Result<(), String> {
    let _t = ipc_trace::enter("save_ritobin_to_bin");

    tracing::info!("Saving ritobin content to: {} (using RitoShark engine)", bin_path);

    if bin_path.is_empty() {
        return Err("Path cannot be empty".to_string());
    }

    // Parse + encode is CPU-bound (ritobin text → tree → bytes). Run it on the
    // blocking pool so a large BIN save doesn't stall the async runtime / UI.
    let content_for_encode = content.clone();
    let binary_data = tokio::task::spawn_blocking(move || {
        let bin = flint_ltk::bin::text_to_tree(&content_for_encode)
            .map_err(|e| format!("Failed to parse text content: {}", e))?;
        flint_ltk::bin::write_bin_ltk(&bin)
            .map_err(|e| format!("Failed to convert to binary: {}", e))
    })
    .await
    .map_err(|e| format!("encode task join error: {}", e))??;

    // Mark the path as an expected self-write so the watcher doesn't bounce it
    // back into the editor as an external modification.
    crate::core::write_echo::mark(&bin_path);

    fs::write(&bin_path, &binary_data)
        .map_err(|e| format!("Failed to write .bin file: {}", e))?;

    tracing::info!("Saved .bin file: {} ({} bytes)", bin_path, binary_data.len());

    // No `.ritobin` sidecar is written — see the fn doc. A stale sidecar left
    // over from an older build would now be OLDER than the just-saved .bin, so
    // nothing reads it as authoritative; leave it alone rather than touch disk.
    Ok(())
}

/// Compiles ritobin text content back to binary bytes in-memory.
#[tauri::command]
pub async fn compile_ritobin_text_to_bytes(
    content: String,
) -> Result<tauri::ipc::Response, String> {
    let _t = ipc_trace::enter("compile_ritobin_text_to_bytes");
    // CPU-bound parse + encode — off the async runtime (see save_ritobin_to_bin).
    let binary_data = tokio::task::spawn_blocking(move || {
        let bin = flint_ltk::bin::text_to_tree(&content)
            .map_err(|e| format!("Failed to parse text content: {}", e))?;
        flint_ltk::bin::write_bin_ltk(&bin)
            .map_err(|e| format!("Failed to convert to binary: {}", e))
    })
    .await
    .map_err(|e| format!("encode task join error: {}", e))??;
    Ok(tauri::ipc::Response::new(binary_data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_bin_info_serialization() {
        let info = BinInfo {
            entry_count: 10,
            version: 1,
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("entry_count"));
        assert!(json.contains("10"));
        assert!(json.contains("version"));
        assert!(json.contains("1"));
    }

    #[tokio::test]
    async fn test_read_bin_info_empty_path() {
        let result = read_bin_info("".to_string()).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Input path cannot be empty"));
    }

    #[tokio::test]
    async fn test_read_bin_info_nonexistent_file() {
        let result = read_bin_info("nonexistent.bin".to_string()).await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }
}
