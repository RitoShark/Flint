use flint_core::audio::bank::{self, AudioBankInfo, DecodedAudio};
use flint_core::audio::event_mapper::{self, BinEventString, EventMapping};
use flint_core::audio::hirc::{self, HircData};
use serde::{Deserialize, Serialize};

// ============================================================
// READ-ONLY COMMANDS (WAD Explorer + Project)
// ============================================================

/// Parse a BNK/WPK file from disk, return entry list (no audio data).
#[tauri::command]
pub async fn parse_audio_bank(path: String) -> Result<AudioBankInfo, String> {
    let data = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
    bank::info(&data)
}

/// Parse BNK/WPK from a raw-byte request body (for WAD Explorer in-memory chunks).
#[tauri::command]
pub async fn parse_audio_bank_bytes(
    request: tauri::ipc::Request<'_>,
) -> Result<AudioBankInfo, String> {
    bank::info(raw_body(&request, "parse_audio_bank_bytes")?)
}

/// Extract the raw byte slice from a raw-body IPC request.
fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>, cmd: &str) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.as_slice()),
        tauri::ipc::InvokeBody::Json(_) => Err(format!("{cmd} expects raw bytes; got JSON body")),
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
    Ok(tauri::ipc::Response::new(bank::read_entry(&data, file_id)?))
}

/// Read a single WEM entry from in-memory BNK/WPK bytes. Bank is the raw
/// request body; `file_id` rides in a header.
#[tauri::command]
pub async fn read_audio_entry_bytes(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let data = raw_body(&request, "read_audio_entry_bytes")?;
    let file_id = header_u32(&request, "file-id")?;
    Ok(tauri::ipc::Response::new(bank::read_entry(data, file_id)?))
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

/// Decode WEM bytes to playable audio (OGG or WAV).
#[tauri::command]
pub async fn decode_wem(request: tauri::ipc::Request<'_>) -> Result<DecodedAudio, String> {
    let wem_data = raw_body(&request, "decode_wem")?.to_vec();
    tokio::task::spawn_blocking(move || bank::decode_wem(&wem_data))
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

/// Replace a single WEM entry in a BNK/WPK, return modified file bytes.
#[tauri::command]
pub async fn replace_audio_entry(
    bank_data: Vec<u8>,
    file_id: u32,
    new_wem_data: Vec<u8>,
) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || {
        bank::replace_entry(&bank_data, file_id, &new_wem_data)
    })
    .await
    .map_err(|e| format!("Audio replace task failed: {e}"))?
}

/// Replace multiple WEM entries at once.
#[tauri::command]
pub async fn replace_audio_entries(
    bank_data: Vec<u8>,
    replacements: Vec<AudioReplacement>,
) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || {
        let mut current = bank_data;
        for rep in &replacements {
            current = bank::replace_entry(&current, rep.file_id, &rep.new_data)?;
        }
        Ok(current)
    })
    .await
    .map_err(|e| format!("Audio replace task failed: {e}"))?
}

/// Replace an entry with silence at its own sample rate and channel count.
#[tauri::command]
pub async fn silence_audio_entry(bank_data: Vec<u8>, file_id: u32) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || bank::silence_entry(&bank_data, file_id))
        .await
        .map_err(|e| format!("Audio silence task failed: {e}"))?
}

/// Remove an entry from the bank.
#[tauri::command]
pub async fn remove_audio_entry(bank_data: Vec<u8>, file_id: u32) -> Result<Vec<u8>, String> {
    bank::remove_entry(&bank_data, file_id)
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
