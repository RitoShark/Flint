use flint_ltk::audio::bnk::{self, AudioEntry, AudioEntryInfo, BnkInfo};
use flint_ltk::audio::event_mapper::{self, BinEventString, EventMapping};
use flint_ltk::audio::hirc::{self, HircData};
use flint_ltk::audio::wem::{self, DecodedAudio};
use flint_ltk::audio::wpk::{self, WpkInfo};
use serde::{Deserialize, Serialize};

/// Unified audio bank info returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioBankInfo {
    pub format: String,
    pub version: u32,
    pub entry_count: usize,
    pub entries: Vec<AudioEntryInfo>,
    pub has_hirc: bool,
}

impl From<BnkInfo> for AudioBankInfo {
    fn from(info: BnkInfo) -> Self {
        Self {
            format: info.format,
            version: info.version,
            entry_count: info.entry_count,
            entries: info.entries,
            has_hirc: info.has_hirc,
        }
    }
}

impl From<WpkInfo> for AudioBankInfo {
    fn from(info: WpkInfo) -> Self {
        Self {
            format: info.format,
            version: info.version,
            entry_count: info.entry_count,
            entries: info.entries,
            has_hirc: false,
        }
    }
}

/// Detect format from magic bytes
fn detect_format(data: &[u8]) -> Result<&str, String> {
    if data.len() < 4 {
        return Err("File too small to detect format".into());
    }
    match &data[0..4] {
        b"BKHD" => Ok("bnk"),
        b"r3d2" => Ok("wpk"),
        _ => Err(format!(
            "Unknown audio format (magic: {:02X}{:02X}{:02X}{:02X})",
            data[0], data[1], data[2], data[3]
        )),
    }
}

// ============================================================
// READ-ONLY COMMANDS (WAD Explorer + Project)
// ============================================================

/// Parse a BNK/WPK file from disk, return entry list (no audio data).
#[tauri::command]
pub async fn parse_audio_bank(path: String) -> Result<AudioBankInfo, String> {
    let data = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
    parse_audio_bank_inner(&data)
}

/// Parse BNK/WPK from a raw-byte request body (for WAD Explorer in-memory chunks).
#[tauri::command]
pub async fn parse_audio_bank_bytes(request: tauri::ipc::Request<'_>) -> Result<AudioBankInfo, String> {
    let data = raw_body(&request, "parse_audio_bank_bytes")?;
    parse_audio_bank_inner(data)
}

/// Extract the raw byte slice from a raw-body IPC request.
fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>, cmd: &str) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.as_slice()),
        tauri::ipc::InvokeBody::Json(_) => {
            Err(format!("{cmd} expects raw bytes; got JSON body"))
        }
    }
}

fn parse_audio_bank_inner(data: &[u8]) -> Result<AudioBankInfo, String> {
    match detect_format(data)? {
        "bnk" => Ok(bnk::parse_bnk_metadata(data)?.into()),
        "wpk" => Ok(wpk::parse_wpk_metadata(data)?.into()),
        f => Err(format!("Unsupported format: {f}")),
    }
}

/// Read a single WEM entry from a BNK/WPK file on disk. Returns raw bytes.
#[tauri::command]
pub async fn read_audio_entry(
    path: String,
    file_id: u32,
) -> Result<tauri::ipc::Response, String> {
    let data = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
    let bytes = read_audio_entry_inner(&data, file_id)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Read a single WEM entry from in-memory BNK/WPK bytes. Bank is the raw
/// request body; `file_id` rides in a header.
#[tauri::command]
pub async fn read_audio_entry_bytes(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let data = raw_body(&request, "read_audio_entry_bytes")?;
    let file_id = header_u32(&request, "file-id")?;
    let bytes = read_audio_entry_inner(data, file_id)?;
    Ok(tauri::ipc::Response::new(bytes))
}

fn header_u32(request: &tauri::ipc::Request<'_>, name: &str) -> Result<u32, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("Missing '{name}' header"))?
        .to_str()
        .map_err(|e| format!("Invalid '{name}' header: {e}"))?;
    raw.parse::<u32>()
        .map_err(|e| format!("Invalid u32 in '{name}': {e}"))
}

fn read_audio_entry_inner(data: &[u8], file_id: u32) -> Result<Vec<u8>, String> {
    match detect_format(data)? {
        "bnk" => bnk::read_bnk_entry(data, file_id),
        "wpk" => wpk::read_wpk_entry(data, file_id),
        f => Err(format!("Unsupported format: {f}")),
    }
}

/// Decode WEM bytes to playable audio (OGG or WAV).
#[tauri::command]
pub async fn decode_wem(request: tauri::ipc::Request<'_>) -> Result<DecodedAudio, String> {
    let wem_data = raw_body(&request, "decode_wem")?.to_vec();
    tokio::task::spawn_blocking(move || wem::decode_wem(&wem_data))
        .await
        .map_err(|e| format!("WEM decode task failed: {e}"))?
}

/// Parse HIRC section from a BNK file on disk.
#[tauri::command]
pub async fn parse_bnk_hirc(path: String) -> Result<Option<HircData>, String> {
    let data = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
    hirc::parse_hirc_from_bnk(&data)
}

/// Parse HIRC section from in-memory BNK bytes.
#[tauri::command]
pub async fn parse_bnk_hirc_bytes(
    request: tauri::ipc::Request<'_>,
) -> Result<Option<HircData>, String> {
    let data = raw_body(&request, "parse_bnk_hirc_bytes")?;
    hirc::parse_hirc_from_bnk(data)
}

/// Extract event names from a BIN file (raw bytes).
#[tauri::command]
pub async fn extract_bin_audio_events(
    request: tauri::ipc::Request<'_>,
) -> Result<Vec<BinEventString>, String> {
    let data = raw_body(&request, "extract_bin_audio_events")?;
    Ok(event_mapper::extract_bin_events(data))
}

/// Map BIN events to WEM IDs via HIRC hierarchy.
#[tauri::command]
pub async fn map_audio_events(
    bin_data: Vec<u8>,
    events_bnk_data: Vec<u8>,
) -> Result<Vec<EventMapping>, String> {
    let events = event_mapper::extract_bin_events(&bin_data);
    let hirc = hirc::parse_hirc_from_bnk(&events_bnk_data)?
        .ok_or("No HIRC section found in events BNK")?;
    Ok(event_mapper::map_events_to_wem(&events, &hirc))
}

// ============================================================
// EDIT COMMANDS (Project mode only)
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioReplacement {
    pub file_id: u32,
    pub new_data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioEntryData {
    pub id: u32,
    pub data: Vec<u8>,
}

/// Replace a single WEM entry in a BNK/WPK, return modified file bytes.
#[tauri::command]
pub async fn replace_audio_entry(
    bank_data: Vec<u8>,
    file_id: u32,
    new_wem_data: Vec<u8>,
) -> Result<Vec<u8>, String> {
    match detect_format(&bank_data)? {
        "bnk" => bnk::replace_bnk_entry(&bank_data, file_id, &new_wem_data),
        "wpk" => wpk::replace_wpk_entry(&bank_data, file_id, &new_wem_data),
        f => Err(format!("Unsupported format: {f}")),
    }
}

/// Replace multiple WEM entries at once.
#[tauri::command]
pub async fn replace_audio_entries(
    bank_data: Vec<u8>,
    replacements: Vec<AudioReplacement>,
) -> Result<Vec<u8>, String> {
    let format = detect_format(&bank_data)?.to_string();
    let mut current = bank_data;
    for rep in &replacements {
        current = match format.as_str() {
            "bnk" => bnk::replace_bnk_entry(&current, rep.file_id, &rep.new_data)?,
            "wpk" => wpk::replace_wpk_entry(&current, rep.file_id, &rep.new_data)?,
            f => return Err(format!("Unsupported format: {f}")),
        };
    }
    Ok(current)
}

/// Replace an entry with silence.
#[tauri::command]
pub async fn silence_audio_entry(
    bank_data: Vec<u8>,
    file_id: u32,
) -> Result<Vec<u8>, String> {
    match detect_format(&bank_data)? {
        "bnk" => bnk::silence_bnk_entry(&bank_data, file_id),
        "wpk" => {
            // WPK has no dedicated silence function; reuse the BNK silence WEM.
            wpk::replace_wpk_entry(&bank_data, file_id, bnk::SILENCE_WEM)
        }
        f => Err(format!("Unsupported format: {f}")),
    }
}

/// Remove an entry from the bank.
#[tauri::command]
pub async fn remove_audio_entry(
    bank_data: Vec<u8>,
    file_id: u32,
) -> Result<Vec<u8>, String> {
    match detect_format(&bank_data)? {
        "bnk" => bnk::remove_bnk_entry(&bank_data, file_id),
        "wpk" => wpk::remove_wpk_entry(&bank_data, file_id),
        f => Err(format!("Unsupported format: {f}")),
    }
}

/// Rebuild a full BNK from a list of audio entries.
#[tauri::command]
pub async fn write_bnk(entries: Vec<AudioEntryData>) -> Result<Vec<u8>, String> {
    let audio_entries: Vec<AudioEntry> = entries
        .into_iter()
        .map(|e| AudioEntry { id: e.id, data: e.data })
        .collect();
    Ok(bnk::write_bnk(&audio_entries))
}

/// Rebuild a full WPK from a list of audio entries.
#[tauri::command]
pub async fn write_wpk(entries: Vec<AudioEntryData>) -> Result<Vec<u8>, String> {
    let audio_entries: Vec<AudioEntry> = entries
        .into_iter()
        .map(|e| AudioEntry { id: e.id, data: e.data })
        .collect();
    Ok(wpk::write_wpk(&audio_entries))
}

/// Save audio bytes to disk. Path rides in a header so the body can stay raw.
#[tauri::command]
pub async fn save_audio_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("path")
        .ok_or("Missing 'path' header on save_audio_file")?
        .to_str()
        .map_err(|e| format!("Invalid 'path' header: {}", e))?
        .to_string();
    let data = raw_body(&request, "save_audio_file")?;
    tokio::fs::write(&path, data)
        .await
        .map_err(|e| format!("Failed to write '{}': {}", path, e))
}
