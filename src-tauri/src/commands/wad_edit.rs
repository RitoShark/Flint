//! In-memory WAD edit session commands.
//!
//! Open a WAD, mutate chunks in memory, save when ready. The on-disk
//! file is not touched until `save_session_to_path` fires — which means
//! you can iterate on edits without thrashing the WAD on the filesystem
//! (which would invalidate every cache that points at it, fire the
//! project watcher, and on Windows can take real time for multi-hundred-
//! MB champion WADs).
//!
//! Session lifecycle:
//!   1. `open_wad_edit_session(wad_path)` — parses TOC, returns a session_id.
//!   2. zero-or-more `read_session_chunk` / `write_session_chunk` /
//!      `remove_session_chunk` calls.
//!   3. either `save_session_to_path(session_id, output)` (commit) or
//!      `discard_session_changes(session_id)` (drop the deltas, keep the
//!      session open).
//!   4. `close_wad_edit_session(session_id)` — frees memory.
//!
//! Memory profile: only edited chunks live in RAM (as decompressed
//! bytes). Untouched chunks are streamed from the source WAD on read,
//! same as the read-only pipeline already does. So a session that
//! modifies ten chunks of a 5000-chunk WAD costs ~10× the decompressed
//! chunk size — no extra resident overhead.

use crate::core::ipc_trace;
use crate::state::{WadEditDelta, WadEditSession, WadEditState};
use flint_ltk::wad_jade::read_chunk_decompressed_bytes;
use flint_ltk::wad_jade::reader::read_wad_toc;
use flint_ltk::wad_jade::writer::{write_wad, EntryToWrite};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request, Response};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WadEditSessionInfo {
    pub session_id: String,
    pub source_path: String,
    pub initial_chunk_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WadDirtyChunk {
    /// Hex-formatted 16-char hash so JSON callers don't lose precision.
    pub path_hash: String,
    pub size: u64,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveResult {
    pub wrote_bytes: u64,
    pub chunk_count: usize,
}

fn parse_hex_hash(s: &str) -> Result<u64, String> {
    u64::from_str_radix(s.trim_start_matches("0x").trim_start_matches("0X"), 16)
        .map_err(|e| format!("Invalid path_hash '{}': {}", s, e))
}

/// Open a WAD into a fresh in-memory edit session. Parses the TOC
/// immediately (so subsequent reads can locate chunks on disk) but does
/// not decompress anything — uncommitted edits live in RAM, original
/// chunks stay on disk until they're read or saved.
#[tauri::command]
pub async fn open_wad_edit_session(
    wad_path: String,
    state: tauri::State<'_, WadEditState>,
) -> Result<WadEditSessionInfo, String> {
    let _t = ipc_trace::enter("open_wad_edit_session");
    let path = PathBuf::from(&wad_path);
    if !path.exists() {
        return Err(format!("WAD not found: {}", wad_path));
    }

    let toc = read_wad_toc(&path).map_err(|e| format!("Failed to parse WAD: {}", e))?;
    let session = WadEditSession {
        session_id: Uuid::new_v4().to_string(),
        source_path: path.clone(),
        original_chunks: toc.chunks,
        deltas: Default::default(),
    };
    let chunk_count = session.original_chunks.len();
    let id = state.insert(session);

    tracing::info!(
        "WAD edit session opened: {} ({} chunks) id={}",
        path.display(), chunk_count, id
    );
    Ok(WadEditSessionInfo {
        session_id: id,
        source_path: wad_path,
        initial_chunk_count: chunk_count,
    })
}

#[tauri::command]
pub async fn close_wad_edit_session(
    session_id: String,
    state: tauri::State<'_, WadEditState>,
) -> Result<(), String> {
    let _t = ipc_trace::enter("close_wad_edit_session");
    if !state.remove(&session_id) {
        return Err(format!("No such session: {}", session_id));
    }
    tracing::info!("WAD edit session closed: id={}", session_id);
    Ok(())
}

#[tauri::command]
pub async fn list_wad_edit_sessions(
    state: tauri::State<'_, WadEditState>,
) -> Result<Vec<WadEditSessionInfo>, String> {
    let _t = ipc_trace::enter("list_wad_edit_sessions");
    let snap = state.snapshot();
    Ok(snap
        .into_iter()
        .map(|(id, path, count)| WadEditSessionInfo {
            session_id: id,
            source_path: path.to_string_lossy().into_owned(),
            initial_chunk_count: count,
        })
        .collect())
}

/// Read a chunk from the session. Honors pending writes (returns the
/// staged bytes) and pending deletes (returns an error). For untouched
/// chunks we go to disk via the existing decompression path.
///
/// Response body is raw bytes — caller uses `invokeCommand` with the
/// returned ArrayBuffer.
#[tauri::command]
pub async fn read_session_chunk(
    session_id: String,
    path_hash: String,
    state: tauri::State<'_, WadEditState>,
) -> Result<Response, String> {
    let _t = ipc_trace::enter("read_session_chunk");
    let hash = parse_hex_hash(&path_hash)?;
    let session = state.get(&session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;

    // Take what we need under the lock then drop it before doing I/O.
    let (delta, original_chunk, source_path) = {
        let guard = session.read();
        let delta = guard.deltas.get(&hash).cloned();
        let chunk = guard.original_chunks.iter().find(|c| c.path_hash == hash).copied();
        (delta, chunk, guard.source_path.clone())
    };

    match delta {
        Some(WadEditDelta::Write(bytes)) => Ok(Response::new(bytes)),
        Some(WadEditDelta::Delete) => Err(format!(
            "Chunk {:016x} was deleted in this session", hash
        )),
        None => {
            let chunk = original_chunk.ok_or_else(|| format!(
                "Chunk {:016x} not found in WAD or session deltas", hash
            ))?;
            // Heavy: file read + decompress. Spawn on the blocking pool so
            // the async runtime stays responsive.
            let bytes = tokio::task::spawn_blocking(move || {
                read_chunk_decompressed_bytes(&source_path, &chunk)
            })
            .await
            .map_err(|e| format!("Read task panicked: {}", e))?
            .map_err(|e| format!("Failed to decompress chunk {:016x}: {}", hash, e))?;
            Ok(Response::new(bytes))
        }
    }
}

/// Stage new bytes for a chunk. Replaces if the hash already exists in
/// the WAD or in a prior staged write, adds if it's new.
///
/// Wire format: raw body bytes; `session-id` and `path-hash` go via
/// headers so the body is a clean memcpy on both sides.
#[tauri::command]
pub async fn write_session_chunk(
    request: Request<'_>,
    state: tauri::State<'_, WadEditState>,
) -> Result<(), String> {
    let _t = ipc_trace::enter("write_session_chunk");

    let session_id = request.headers().get("session-id")
        .ok_or("Missing 'session-id' header")?
        .to_str().map_err(|e| format!("Bad session-id: {}", e))?
        .to_string();
    let hash_str = request.headers().get("path-hash")
        .ok_or("Missing 'path-hash' header")?
        .to_str().map_err(|e| format!("Bad path-hash: {}", e))?;
    let hash = parse_hex_hash(hash_str)?;

    let body: Vec<u8> = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(_) => return Err("write_session_chunk expects raw bytes".into()),
    };

    let session = state.get(&session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;
    session.write().deltas.insert(hash, WadEditDelta::Write(body));
    Ok(())
}

/// Stage a chunk deletion. The deletion is visible to reads on this
/// session immediately but isn't persisted to disk until save.
#[tauri::command]
pub async fn remove_session_chunk(
    session_id: String,
    path_hash: String,
    state: tauri::State<'_, WadEditState>,
) -> Result<(), String> {
    let _t = ipc_trace::enter("remove_session_chunk");
    let hash = parse_hex_hash(&path_hash)?;
    let session = state.get(&session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;
    session.write().deltas.insert(hash, WadEditDelta::Delete);
    Ok(())
}

#[tauri::command]
pub async fn session_dirty_chunks(
    session_id: String,
    state: tauri::State<'_, WadEditState>,
) -> Result<Vec<WadDirtyChunk>, String> {
    let _t = ipc_trace::enter("session_dirty_chunks");
    let session = state.get(&session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;
    let guard = session.read();
    let out = guard.deltas.iter().map(|(hash, delta)| match delta {
        WadEditDelta::Write(bytes) => WadDirtyChunk {
            path_hash: format!("{:016x}", hash),
            size: bytes.len() as u64,
            deleted: false,
        },
        WadEditDelta::Delete => WadDirtyChunk {
            path_hash: format!("{:016x}", hash),
            size: 0,
            deleted: true,
        },
    }).collect();
    Ok(out)
}

#[tauri::command]
pub async fn discard_session_changes(
    session_id: String,
    state: tauri::State<'_, WadEditState>,
) -> Result<(), String> {
    let _t = ipc_trace::enter("discard_session_changes");
    let session = state.get(&session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;
    session.write().deltas.clear();
    Ok(())
}

/// Save the session as a fresh WAD at `output_path`. The session stays
/// open afterward — you can keep editing and re-save. To overwrite the
/// source, pass `output_path == source_path`; we use a write-then-rename
/// dance so a crashed save can't leave a half-written WAD where the
/// original used to be.
#[tauri::command]
pub async fn save_session_to_path(
    session_id: String,
    output_path: String,
    state: tauri::State<'_, WadEditState>,
) -> Result<SaveResult, String> {
    let _t = ipc_trace::enter("save_session_to_path");
    let session = state.get(&session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;

    // Collect everything we need under the lock, then drop the guard so
    // the (potentially long) write doesn't block other session calls.
    let (source_path, original_chunks, deltas) = {
        let g = session.read();
        (g.source_path.clone(), g.original_chunks.clone(), g.deltas.clone())
    };

    // Heavy: decompress every untouched chunk + run zstd over the edited
    // ones. Pin to the blocking pool.
    let result: Result<(Vec<u8>, usize), String> = tokio::task::spawn_blocking(move || {
        let mut entries: Vec<EntryToWrite> = Vec::with_capacity(original_chunks.len());

        // Originals — except those shadowed by a Delete.
        for chunk in &original_chunks {
            match deltas.get(&chunk.path_hash) {
                Some(WadEditDelta::Delete) => continue,
                Some(WadEditDelta::Write(_)) => continue, // overwritten below
                None => {
                    let bytes = read_chunk_decompressed_bytes(&source_path, chunk)
                        .map_err(|e| format!(
                            "Failed to decompress original chunk {:016x}: {}",
                            chunk.path_hash, e
                        ))?;
                    entries.push(EntryToWrite::new(chunk.path_hash, bytes));
                }
            }
        }

        // Edits (Write deltas). Includes both replacements of existing
        // hashes and brand-new ones.
        for (hash, delta) in deltas.iter() {
            if let WadEditDelta::Write(bytes) = delta {
                entries.push(EntryToWrite::new(*hash, bytes.clone()));
            }
        }

        let chunk_count = entries.len();
        let (wad_bytes, _stats) = write_wad(entries)
            .map_err(|e| format!("Failed to serialize WAD: {}", e))?;
        Ok::<_, String>((wad_bytes, chunk_count))
    })
    .await
    .map_err(|e| format!("Save task panicked: {}", e))?;

    let (wad_bytes, chunk_count) = result?;
    let total_bytes = wad_bytes.len() as u64;

    // Write-then-rename so the source WAD (if `output_path == source_path`)
    // can't get half-overwritten on a crash. Same pattern the extractor
    // uses for individual chunk writes.
    let out = PathBuf::from(&output_path);
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output parent: {}", e))?;
    }
    let mut tmp = out.clone();
    let fname = out.file_name().and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid output filename".to_string())?;
    tmp.set_file_name(format!(".{}.wadtmp", fname));

    std::fs::write(&tmp, &wad_bytes)
        .map_err(|e| format!("Failed to write tmp WAD {}: {}", tmp.display(), e))?;
    std::fs::rename(&tmp, &out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to rename tmp WAD into place: {}", e)
    })?;

    tracing::info!(
        "WAD session saved: id={} chunks={} bytes={} → {}",
        session_id, chunk_count, total_bytes, out.display()
    );

    Ok(SaveResult { wrote_bytes: total_bytes, chunk_count })
}
