use flint_core::bin::{
    bin_to_json, json_to_bin, read_bin, remember_custom_hash_names, text_to_bin, write_bin, Bin,
};
use flint_core::bin::tree_to_text_cached;
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

fn remember_hash_names(text: &str, bin: &Bin) {
    match remember_custom_hash_names(text, bin) {
        Ok(count) if count > 0 => tracing::info!("Saved {} custom BIN hash name(s)", count),
        Ok(_) => {}
        Err(e) => tracing::warn!("Could not save custom BIN hash names: {}", e),
    }
}

/// Resolve the `0x…` tokens only this bin's own trailer can name.
fn apply_own_trailer(text: String, bin: &Bin) -> String {
    let trailer = flint_core::bin::read_trailer(&bin.trailing);
    if trailer.is_empty() {
        return text;
    }
    tracing::info!("BIN carries {} embedded hash name(s)", trailer.len());
    flint_core::bin::apply_trailer(text, &trailer)
}

/// Name the `0x…` tokens the bin's own trailer could not, from the mod folder.
///
/// Two fallbacks for a bin whose trailer is missing — one written by a tool that
/// emits none, or one whose trailer a reserialize dropped:
///
/// 1. `files.txt` at the mod root, the deliberate record. Names a path whether or
///    not the file is still on disk.
/// 2. Hashing the assets actually present. Needs no sidecar at all, but can only
///    find what exists.
///
/// Both only fill gaps — `apply_trailer` runs first, so a recorded name always
/// beats an inferred one. Cheap to skip: with nothing left unresolved in the
/// text there is no reason to touch the disk.
fn apply_mod_root_names(text: String, bin_path: &Path) -> String {
    // Only pay for this when the text still has unnamed hashes in it.
    if !text.contains("0x") {
        return text;
    }
    let Some(root) = mod_root(bin_path) else {
        return text;
    };

    let mut trailer = flint_core::bin::Trailer::new();

    // 1. files.txt — `<hex> <name>`, or a bare path from the older format.
    if let Ok(list) = fs::read_to_string(root.join("files.txt")) {
        for line in list.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match line.split_once(char::is_whitespace) {
                Some((hex, name)) if is_hash_hex(hex) => {
                    let name = name.trim().to_string();
                    if hex.len() == 8 {
                        if let Ok(h) = u32::from_str_radix(hex, 16) {
                            trailer.names.entry(h).or_insert(name);
                        }
                    } else if let Ok(h) = u64::from_str_radix(hex, 16) {
                        trailer.files.entry(h).or_insert(name);
                    }
                }
                _ => {
                    trailer
                        .files
                        .entry(ritoshark::hash::xxh64(line))
                        .or_insert_with(|| line.to_string());
                }
            }
        }
    }

    // 2. Whatever is on disk. The WAD-relative path IS what was hashed, so a
    //    file still present names itself with no table involved.
    const ASSET_EXTS: [&str; 12] = [
        "tex", "dds", "png", "jpg", "jpeg", "skn", "skl", "scb", "sco", "anm", "bnk", "wpk",
    ];
    const MAX_FILES: usize = 100_000;
    let mut stack = vec![root.clone()];
    let mut scanned = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if scanned >= MAX_FILES {
                tracing::warn!("mod-root scan hit the {MAX_FILES}-file cap; some hashes may stay unnamed");
                stack.clear();
                break;
            }
            let path = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push(path),
                Ok(t) if t.is_file() => {
                    let ext = path
                        .extension()
                        .map(|e| e.to_string_lossy().to_ascii_lowercase())
                        .unwrap_or_default();
                    if !ASSET_EXTS.contains(&ext.as_str()) {
                        continue;
                    }
                    scanned += 1;
                    let Ok(rel) = path.strip_prefix(&root) else { continue };
                    let rel = rel.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
                    trailer
                        .files
                        .entry(ritoshark::hash::xxh64(&rel))
                        .or_insert(rel);
                }
                _ => {}
            }
        }
    }

    if trailer.is_empty() {
        return text;
    }
    tracing::info!(
        "Mod folder names {} more hash(es) the trailer did not",
        trailer.names.len() + trailer.files.len()
    );
    flint_core::bin::apply_trailer(text, &trailer)
}

/// Compile edited ritobin text, embedding the names the text is the only record
/// of. A repathed asset exists in no dictionary, so once the editor writes the
/// hash the path is unrecoverable unless it travels inside the bin.
fn encode_with_trailer(text: &str) -> Result<Vec<u8>, String> {
    encode_capturing_trailer(text).map(|(bytes, _)| bytes)
}

/// As [`encode_with_trailer`], but hands the captured names back to the caller.
///
/// A caller that knows where the bin lives mirrors them into `files.txt` at the
/// mod root. The trailer alone is enough right up until a tool reserializes the
/// bin from its parsed tree — that writes a fresh body with no trailing bytes,
/// and the names are then gone with nothing on disk to recover them from.
fn encode_capturing_trailer(
    text: &str,
) -> Result<(Vec<u8>, flint_core::bin::Trailer), String> {
    let mut bin = flint_core::bin::text_to_tree(text)
        .map_err(|e| format!("Failed to parse text content: {}", e))?;
    remember_hash_names(text, &bin);
    let trailer = flint_core::bin::capture_trailer(text, &bin);
    if !trailer.is_empty() {
        tracing::info!("Embedding {} hash name(s) in the BIN", trailer.len());
        bin.trailing = flint_core::bin::append_trailer(&bin.trailing, &trailer);
    }
    let bytes = flint_core::bin::write_bin(&bin)
        .map_err(|e| format!("Failed to convert to binary: {}", e))?;
    Ok((bytes, trailer))
}

/// The mod folder a bin sits in: the directory holding `data/` or `assets/`.
fn mod_root(bin_path: &Path) -> Option<std::path::PathBuf> {
    let mut dir = bin_path.parent();
    while let Some(d) = dir {
        if d.join("data").is_dir() || d.join("assets").is_dir() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// 8 hex digits (fnv1a32) or 16 (xxh64) — the two hash widths a bin uses.
fn is_hash_hex(s: &str) -> bool {
    (s.len() == 8 || s.len() == 16) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Mirror the trailer into `files.txt` at the mod root, keeping what is there.
///
/// The second of the two records described in
/// `BIN-TRAILER-hashpath-preservation.md`. The trailer lives inside the bin and
/// dies with any reserialize; this sits beside the mod and survives that, and it
/// is what travels in `META/files.txt` when the mod is packed.
///
/// `<hex> <name>` per line, because a name alone cannot say which keyspace it
/// belongs to — an object name and an asset path are both just text. Merged by
/// NAME (never overwritten) so saving one bin cannot drop another's entries, and
/// sorted so re-saving produces no diff.
fn merge_into_files_txt(bin_path: &Path, trailer: &flint_core::bin::Trailer) {
    if trailer.is_empty() {
        return;
    }
    let Some(root) = mod_root(bin_path) else {
        return;
    };
    let list = root.join("files.txt");

    let mut entries: std::collections::BTreeMap<String, String> = Default::default();
    for line in fs::read_to_string(&list).unwrap_or_default().lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match line.split_once(char::is_whitespace) {
            Some((hex, name)) if is_hash_hex(hex) => {
                entries.insert(name.trim().to_string(), hex.to_ascii_lowercase());
            }
            // A bare path: the older format, or a hand-written line. It can only
            // be an asset path, so hash it as one.
            _ => {
                entries.insert(line.to_string(), format!("{:016x}", ritoshark::hash::xxh64(line)));
            }
        }
    }

    let before = entries.len();
    for (hash, name) in &trailer.names {
        entries.insert(name.clone(), format!("{hash:08x}"));
    }
    for (hash, name) in &trailer.files {
        entries.insert(name.clone(), format!("{hash:016x}"));
    }
    if entries.len() == before {
        return;
    }

    let contents = entries
        .iter()
        .map(|(name, hex)| format!("{hex} {name}"))
        .collect::<Vec<_>>()
        .join("\n");
    match fs::write(&list, contents) {
        Ok(()) => tracing::info!("Recorded {} name(s) in {}", entries.len(), list.display()),
        Err(e) => tracing::warn!("Could not write {}: {e}", list.display()),
    }
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

    let bin = flint_core::bin::read_bin(&data)
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

    remember_hash_names(&text, &bin);

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

    let bin = flint_core::bin::read_bin(bin_data)
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
    let (unhashed, replaced) = flint_core::bin::unhash_text_cached(&text);
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

    let bin = flint_core::bin::read_bin(&data)
        .map_err(|e| format!("Failed to parse bin file: {}", e))?;

    tracing::debug!("Parsed bin file with {} objects", bin.entries.len());

    let text = flint_core::bin::tree_to_text_cached(&bin)
        .map_err(|e| format!("Failed to convert to text: {}", e))?;
    let text = apply_own_trailer(text, &bin);
    // Then the mod folder, for anything the bin's own trailer could not name.
    let text = apply_mod_root_names(text, input);

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

/// Whether this path is ritobin TEXT (`.ritobin` / `.py`) rather than a binary
/// `.bin`. Text files skip the PROP/PTCH magic gate on read and are saved back
/// as text (validated, but never overwritten with binary bytes).
fn is_ritobin_text_path(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some(ext) if ext.eq_ignore_ascii_case("ritobin") || ext.eq_ignore_ascii_case("py")
    )
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

    // Ritobin TEXT files (.ritobin / .py) are already the editor's format —
    // return their content directly instead of demanding PROP/PTCH magic.
    if is_ritobin_text_path(bin_file) {
        let text = fs::read_to_string(bin_file)
            .map_err(|e| format!("Failed to read ritobin text file: {}", e))?;
        tracing::info!("[BIN_READ] {} is ritobin text — returned as-is ({} chars)", bin_path, text.len());
        return Ok(text);
    }

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
        let bin = flint_core::bin::read_bin(&data)
            .map_err(|e| format!("Failed to parse bin file: {}", e))?;
        let text = flint_core::bin::tree_to_text_cached(&bin)
            .map_err(|e| format!("Failed to convert to text: {}", e))?;
        let text = apply_own_trailer(text, &bin);
        // Then the mod folder, for anything the bin's own trailer could not name.
        apply_mod_root_names(text, bin_file)
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

    // A .ritobin/.py target IS the text form: parse only to validate the edit,
    // then persist the text itself — writing binary bytes under a .ritobin name
    // would corrupt the file for every other reader.
    let text_target = is_ritobin_text_path(Path::new(&bin_path));

    // Parse + encode is CPU-bound (ritobin text → tree → bytes). Run it on the
    // blocking pool so a large BIN save doesn't stall the async runtime / UI.
    let content_for_encode = content.clone();
    let (binary_data, trailer) =
        tokio::task::spawn_blocking(move || encode_capturing_trailer(&content_for_encode))
            .await
            .map_err(|e| format!("encode task join error: {}", e))??;

    // Mark the path as an expected self-write so the watcher doesn't bounce it
    // back into the editor as an external modification.
    crate::core::write_echo::mark(&bin_path);

    if text_target {
        fs::write(&bin_path, content.as_bytes())
            .map_err(|e| format!("Failed to write ritobin text file: {}", e))?;
        tracing::info!("Saved ritobin text file: {} ({} chars)", bin_path, content.len());
        return Ok(());
    }

    fs::write(&bin_path, &binary_data)
        .map_err(|e| format!("Failed to write .bin file: {}", e))?;

    tracing::info!("Saved .bin file: {} ({} bytes)", bin_path, binary_data.len());

    // Mirror the same names beside the mod. The trailer above is lost the moment
    // any tool reserializes this bin; this copy is not, and it is what gets
    // packed into `META/files.txt`.
    merge_into_files_txt(Path::new(&bin_path), &trailer);

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
    let binary_data = tokio::task::spawn_blocking(move || encode_with_trailer(&content))
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
