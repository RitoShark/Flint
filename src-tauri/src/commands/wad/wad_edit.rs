//! In-memory WAD edit session commands. The on-disk file is not touched until
//! `save_session_to_path` fires; only edited chunks live in RAM (as
//! decompressed bytes), untouched chunks are streamed from the source WAD.
//!
//! Session lifecycle:
//!   1. `open_wad_edit_session(wad_path)` — parses TOC, returns a session_id.
//!   2. zero-or-more `read_session_chunk` / `write_session_chunk` /
//!      `remove_session_chunk` calls.
//!   3. either `save_session_to_path(session_id, output)` (commit) or
//!      `discard_session_changes(session_id)` (drop the deltas, keep the
//!      session open).
//!   4. `close_wad_edit_session(session_id)` — frees memory.

use crate::core::ipc_trace;
use crate::state::{WadEditBacking, WadEditDelta, WadEditSession, WadEditState};
use flint_core::wad::format::{WadChunk, WadCompression};
use flint_core::wad::read_chunk_decompressed_bytes;
use flint_core::wad::reader::read_wad_toc;
use flint_core::wad::writer::{write_wad, EntryToWrite};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

/// Open a WAD at `wad_path` into a fresh in-memory edit session against the
/// given `WadEditState`. Parses the TOC immediately but does not decompress
/// anything. Shared by the `open_wad_edit_session` command and the archive
/// editor's `open_inner_wad` (both need an identical open path).
pub fn open_wad_session_for_path(
    wad_path: &str,
    state: &WadEditState,
) -> Result<WadEditSessionInfo, String> {
    let path = PathBuf::from(wad_path);
    if !path.exists() {
        return Err(format!("WAD not found: {}", wad_path));
    }

    if let Ok(settings) = crate::commands::settings::get_settings() {
        let normalized_wad = wad_path.to_lowercase().replace('\\', "/");
        if let Some(ref lp) = settings.league_path {
            let normalized_lp = lp.to_lowercase().replace('\\', "/");
            if !normalized_lp.is_empty() && normalized_wad.starts_with(&normalized_lp) {
                return Err("WAD files inside the League of Legends game directory are read-only.".to_string());
            }
        }
        if let Some(ref lp_pbe) = settings.league_path_pbe {
            let normalized_lp_pbe = lp_pbe.to_lowercase().replace('\\', "/");
            if !normalized_lp_pbe.is_empty() && normalized_wad.starts_with(&normalized_lp_pbe) {
                return Err("WAD files inside the League of Legends game directory are read-only.".to_string());
            }
        }
    }

    let toc = read_wad_toc(&path).map_err(|e| format!("Failed to parse WAD: {}", e))?;
    let session = WadEditSession {
        session_id: Uuid::new_v4().to_string(),
        source_path: path.clone(),
        original_chunks: toc.chunks,
        deltas: Default::default(),
        backing: WadEditBacking::Wad,
    };
    let chunk_count = session.original_chunks.len();
    let id = state.insert(session);

    tracing::info!(
        "WAD edit session opened: {} ({} chunks) id={}",
        path.display(), chunk_count, id
    );
    Ok(WadEditSessionInfo {
        session_id: id,
        source_path: wad_path.to_string(),
        initial_chunk_count: chunk_count,
    })
}

/// One chunk of a folder-backed WAD session, with its real (known) path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderWadChunk {
    /// Hex-formatted 16-char hash (`xxhash64` of the lowercased WAD-relative path).
    pub hash: String,
    /// Real WAD-relative path (forward slashes) — no LMDB lookup needed.
    pub path: String,
    pub size: u64,
}

/// Open a WAD stored as a FOLDER tree of loose files into an edit session
/// WITHOUT packing it into a `.wad.client`. Chunks map 1:1 to the loose files;
/// their real paths are kept so the browser shows real paths (never hashed) and
/// save writes the files straight back to the folder. Returns the session info
/// plus the chunk list (so the caller need not re-derive paths via LMDB).
pub fn open_folder_wad_session(
    folder_root: &std::path::Path,
    display_source: &str,
    state: &WadEditState,
) -> Result<(WadEditSessionInfo, Vec<FolderWadChunk>), String> {
    if !folder_root.is_dir() {
        return Err(format!("Not a folder: {}", folder_root.display()));
    }

    let mut original_chunks: Vec<WadChunk> = Vec::new();
    let mut paths: HashMap<u64, String> = HashMap::new();
    let mut chunk_list: Vec<FolderWadChunk> = Vec::new();

    for entry in walkdir::WalkDir::new(folder_root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
    {
        let rel = entry
            .path()
            .strip_prefix(folder_root)
            .map_err(|e| format!("strip prefix: {}", e))?
            .to_string_lossy()
            .replace('\\', "/");
        if rel.is_empty() {
            continue;
        }
        // WAD path hashing is xxhash64 of the LOWERCASED path (seed 0).
        let hash = xxhash_rust::xxh64::xxh64(rel.to_lowercase().as_bytes(), 0);
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        original_chunks.push(WadChunk {
            path_hash: hash,
            data_offset: 0,
            compressed_size: size,
            uncompressed_size: size,
            compression: WadCompression::None,
        });
        paths.insert(hash, rel.clone());
        chunk_list.push(FolderWadChunk {
            hash: format!("{:016x}", hash),
            path: rel,
            size,
        });
    }

    if original_chunks.is_empty() {
        return Err(format!("Folder WAD is empty: {}", folder_root.display()));
    }

    let chunk_count = original_chunks.len();
    let session = WadEditSession {
        session_id: Uuid::new_v4().to_string(),
        source_path: PathBuf::from(display_source),
        original_chunks,
        deltas: Default::default(),
        backing: WadEditBacking::Folder {
            root: folder_root.to_path_buf(),
            paths,
        },
    };
    let id = state.insert(session);
    tracing::info!(
        "Folder WAD edit session opened: {} ({} files) id={}",
        folder_root.display(), chunk_count, id
    );
    Ok((
        WadEditSessionInfo {
            session_id: id,
            source_path: display_source.to_string(),
            initial_chunk_count: chunk_count,
        },
        chunk_list,
    ))
}

/// Return the real path list for a folder-backed session (reflecting pending
/// renames/deletes/adds), so the browser shows real paths with no LMDB lookup.
#[tauri::command]
pub async fn folder_wad_chunks(
    session_id: String,
    state: tauri::State<'_, WadEditState>,
) -> Result<Vec<FolderWadChunk>, String> {
    let _t = ipc_trace::enter("folder_wad_chunks");
    let session = state
        .get(&session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;
    let g = session.read();
    let paths = match &g.backing {
        WadEditBacking::Folder { paths, .. } => paths.clone(),
        WadEditBacking::Wad => {
            return Err("Session is not folder-backed".into());
        }
    };

    // Start from originals not deleted, then layer in Write deltas (adds/edits).
    let mut out: HashMap<u64, FolderWadChunk> = HashMap::new();
    for chunk in &g.original_chunks {
        if matches!(g.deltas.get(&chunk.path_hash), Some(WadEditDelta::Delete)) {
            continue;
        }
        if let Some(p) = paths.get(&chunk.path_hash) {
            out.insert(
                chunk.path_hash,
                FolderWadChunk {
                    hash: format!("{:016x}", chunk.path_hash),
                    path: p.clone(),
                    size: chunk.uncompressed_size,
                },
            );
        }
    }
    for (hash, delta) in g.deltas.iter() {
        if let WadEditDelta::Write(bytes) = delta {
            let path = paths
                .get(hash)
                .cloned()
                .unwrap_or_else(|| format!("{:016x}", hash));
            out.insert(
                *hash,
                FolderWadChunk {
                    hash: format!("{:016x}", hash),
                    path,
                    size: bytes.len() as u64,
                },
            );
        }
    }
    Ok(out.into_values().collect())
}

/// Open a WAD into a fresh in-memory edit session. Parses the TOC immediately
/// but does not decompress anything.
#[tauri::command]
pub async fn open_wad_edit_session(
    wad_path: String,
    state: tauri::State<'_, WadEditState>,
) -> Result<WadEditSessionInfo, String> {
    let _t = ipc_trace::enter("open_wad_edit_session");
    open_wad_session_for_path(&wad_path, &state)
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

/// Read a chunk from the session. Honors pending writes (returns staged bytes)
/// and pending deletes (returns an error); untouched chunks come from disk.
/// Response body is raw bytes.
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
    let (delta, original_chunk, source_path, folder_file) = {
        let guard = session.read();
        let delta = guard.deltas.get(&hash).cloned();
        let chunk = guard.original_chunks.iter().find(|c| c.path_hash == hash).copied();
        // For a folder-backed session, resolve the loose file to read from disk.
        let folder_file = match &guard.backing {
            WadEditBacking::Folder { root, paths } => {
                paths.get(&hash).map(|rel| root.join(rel))
            }
            WadEditBacking::Wad => None,
        };
        (delta, chunk, guard.source_path.clone(), folder_file)
    };

    match delta {
        Some(WadEditDelta::Write(bytes)) => Ok(Response::new(bytes)),
        Some(WadEditDelta::Delete) => Err(format!(
            "Chunk {:016x} was deleted in this session", hash
        )),
        None => {
            // Folder-backed: read the loose file directly (no WAD decompression).
            if let Some(file_path) = folder_file {
                let bytes = tokio::task::spawn_blocking(move || std::fs::read(&file_path))
                    .await
                    .map_err(|e| format!("Read task panicked: {}", e))?
                    .map_err(|e| format!("Failed to read folder chunk {:016x}: {}", hash, e))?;
                return Ok(Response::new(bytes));
            }
            let chunk = original_chunk.ok_or_else(|| format!(
                "Chunk {:016x} not found in WAD or session deltas", hash
            ))?;
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

/// Stage new bytes for a chunk (replaces an existing hash or adds a new one).
/// Wire format: raw body bytes; `session-id` and `path-hash` go via headers.
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

/// Rename (move) a chunk to a new project-relative path. Re-keys the chunk
/// under the new path-hash (`xxhash64` of the lowercased path), carrying any
/// pending `Write` bytes or — for an untouched original — staging a `Write`
/// with the original's decompressed bytes under the new hash, plus a `Delete`
/// of the old hash. Returns the new hash as `0x{:016x}`.
#[tauri::command]
pub async fn rename_session_chunk(
    session_id: String,
    old_path_hash: String,
    new_path: String,
    state: tauri::State<'_, WadEditState>,
) -> Result<String, String> {
    let _t = ipc_trace::enter("rename_session_chunk");
    let old_hash = parse_hex_hash(&old_path_hash)?;
    let new_key = new_path.replace('\\', "/").trim_start_matches('/').to_lowercase();
    if new_key.is_empty() {
        return Err("New path is empty".into());
    }
    let new_hash = xxhash_rust::xxh64::xxh64(new_key.as_bytes(), 0);

    if new_hash == old_hash {
        return Ok(format!("0x{:016x}", new_hash));
    }

    let session = state
        .get(&session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;

    // Resolve the bytes to carry to the new hash: a pending Write wins; an
    // untouched original is read from its backing (folder file or WAD chunk); a
    // pending Delete means there's nothing to rename.
    let (source_path, original, folder_file) = {
        let g = session.read();
        let original = g.original_chunks.iter().find(|c| c.path_hash == old_hash).cloned();
        let folder_file = match &g.backing {
            WadEditBacking::Folder { root, paths } => paths.get(&old_hash).map(|rel| root.join(rel)),
            WadEditBacking::Wad => None,
        };
        (g.source_path.clone(), original, folder_file)
    };

    let bytes: Vec<u8> = {
        let g = session.read();
        match g.deltas.get(&old_hash) {
            Some(WadEditDelta::Write(b)) => b.clone(),
            Some(WadEditDelta::Delete) => return Err("Cannot rename a deleted chunk".into()),
            None => {
                if let Some(file_path) = folder_file {
                    std::fs::read(&file_path)
                        .map_err(|e| format!("Failed to read folder chunk to rename: {}", e))?
                } else {
                    let chunk = original.ok_or_else(|| format!("Chunk not found: {}", old_path_hash))?;
                    read_chunk_decompressed_bytes(&source_path, &chunk)
                        .map_err(|e| format!("Failed to read chunk to rename: {}", e))?
                }
            }
        }
    };

    {
        let mut g = session.write();
        g.deltas.insert(new_hash, WadEditDelta::Write(bytes));
        // Only stage a Delete of the old hash if it exists as an original;
        // a brand-new (added) chunk being renamed just drops its old Write.
        if g.original_chunks.iter().any(|c| c.path_hash == old_hash) {
            g.deltas.insert(old_hash, WadEditDelta::Delete);
        } else {
            g.deltas.remove(&old_hash);
        }
        // Record the new hash's real path for a folder-backed session so the
        // browser shows the moved path and save writes it to the right place.
        if let WadEditBacking::Folder { paths, .. } = &mut g.backing {
            paths.insert(new_hash, new_key.clone());
        }
    }

    Ok(format!("0x{:016x}", new_hash))
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

/// Serialize a session's current state (untouched originals + pending Writes,
/// minus pending Deletes) into a fresh WAD byte buffer WITHOUT touching disk.
/// Shared by `save_session_to_path` (which then write-then-renames) and the
/// archive editor's `save_archive_session` (which embeds the bytes into the
/// archive). Returns `(wad_bytes, chunk_count)`.
pub async fn serialize_session_to_bytes(
    session_id: &str,
    state: &WadEditState,
) -> Result<(Vec<u8>, usize), String> {
    let session = state.get(session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;

    // Collect everything we need under the lock, then drop the guard so
    // the (potentially long) write doesn't block other session calls.
    let (source_path, original_chunks, deltas) = {
        let g = session.read();
        (g.source_path.clone(), g.original_chunks.clone(), g.deltas.clone())
    };

    tokio::task::spawn_blocking(move || {
        use rayon::prelude::*;

        // Decompress untouched originals (not shadowed by a delta) across rayon;
        // each opens its own file handle. write_wad dedups + sorts by hash.
        let originals: Vec<EntryToWrite> = original_chunks
            .par_iter()
            .filter(|chunk| !deltas.contains_key(&chunk.path_hash))
            .map(|chunk| {
                read_chunk_decompressed_bytes(&source_path, chunk)
                    .map(|bytes| EntryToWrite::new(chunk.path_hash, bytes))
                    .map_err(|e| format!(
                        "Failed to decompress original chunk {:016x}: {}",
                        chunk.path_hash, e
                    ))
            })
            .collect::<Result<Vec<_>, String>>()?;

        let mut entries = originals;
        entries.reserve(deltas.len());

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
    .map_err(|e| format!("Save task panicked: {}", e))?
}

/// Serialize a FOLDER-backed session's current state into `(relative_path,
/// bytes)` pairs — untouched loose files (read from disk) + pending Writes,
/// minus pending Deletes. The caller writes these back as loose files (the
/// archive editor re-zips them under `WAD/<name>.wad.client/`). Errors if the
/// session isn't folder-backed.
pub async fn serialize_folder_session_to_files(
    session_id: &str,
    state: &WadEditState,
) -> Result<Vec<(String, Vec<u8>)>, String> {
    let session = state
        .get(session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;

    let (root, paths, original_chunks, deltas) = {
        let g = session.read();
        match &g.backing {
            WadEditBacking::Folder { root, paths } => (
                root.clone(),
                paths.clone(),
                g.original_chunks.clone(),
                g.deltas.clone(),
            ),
            WadEditBacking::Wad => return Err("Session is not folder-backed".into()),
        }
    };

    tokio::task::spawn_blocking(move || {
        let mut out: HashMap<u64, (String, Vec<u8>)> = HashMap::new();
        // Untouched originals: read the loose file straight off disk.
        for chunk in &original_chunks {
            if deltas.contains_key(&chunk.path_hash) {
                continue;
            }
            let Some(rel) = paths.get(&chunk.path_hash) else { continue };
            let bytes = std::fs::read(root.join(rel))
                .map_err(|e| format!("Failed to read folder chunk {}: {}", rel, e))?;
            out.insert(chunk.path_hash, (rel.clone(), bytes));
        }
        // Pending Writes (edits + adds + rename targets).
        for (hash, delta) in deltas.iter() {
            if let WadEditDelta::Write(bytes) = delta {
                let rel = paths
                    .get(hash)
                    .cloned()
                    .unwrap_or_else(|| format!("{:016x}", hash));
                out.insert(*hash, (rel, bytes.clone()));
            }
        }
        Ok::<_, String>(out.into_values().collect())
    })
    .await
    .map_err(|e| format!("Folder serialize task panicked: {}", e))?
}

/// Save the session as a fresh WAD at `output_path`, via write-then-rename so a
/// crashed save can't leave a half-written file. The session stays open and is
/// re-baselined to the output. Pass `output_path == source_path` to overwrite.
#[tauri::command]
pub async fn save_session_to_path(
    session_id: String,
    output_path: String,
    state: tauri::State<'_, WadEditState>,
) -> Result<SaveResult, String> {
    let _t = ipc_trace::enter("save_session_to_path");

    if let Ok(settings) = crate::commands::settings::get_settings() {
        let normalized_out = output_path.to_lowercase().replace('\\', "/");
        if let Some(ref lp) = settings.league_path {
            let normalized_lp = lp.to_lowercase().replace('\\', "/");
            if !normalized_lp.is_empty() && normalized_out.starts_with(&normalized_lp) {
                return Err("Cannot write or save WAD files inside the League of Legends game directory.".to_string());
            }
        }
        if let Some(ref lp_pbe) = settings.league_path_pbe {
            let normalized_lp_pbe = lp_pbe.to_lowercase().replace('\\', "/");
            if !normalized_lp_pbe.is_empty() && normalized_out.starts_with(&normalized_lp_pbe) {
                return Err("Cannot write or save WAD files inside the League of Legends game directory.".to_string());
            }
        }
    }

    let (wad_bytes, chunk_count) = serialize_session_to_bytes(&session_id, &state).await?;
    let total_bytes = wad_bytes.len() as u64;

    let session = state.get(&session_id)
        .ok_or_else(|| format!("No such session: {}", session_id))?;

    // Write-then-rename so the source WAD (if `output_path == source_path`)
    // can't get half-overwritten on a crash.
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

    // Re-baseline the session to the saved file: re-parse its TOC (offsets +
    // sizes changed on rewrite) and clear the committed deltas.
    match read_wad_toc(&out) {
        Ok(toc) => {
            let mut s = session.write();
            s.original_chunks = toc.chunks;
            s.deltas.clear();
            s.source_path = out.clone();
        }
        Err(e) => {
            tracing::warn!(
                "Saved WAD but failed to refresh session TOC ({}); clearing deltas to avoid stale reads",
                e
            );
            let mut s = session.write();
            s.deltas.clear();
            s.source_path = out.clone();
        }
    }

    tracing::info!(
        "WAD session saved: id={} chunks={} bytes={} → {}",
        session_id, chunk_count, total_bytes, out.display()
    );

    Ok(SaveResult { wrote_bytes: total_bytes, chunk_count })
}
