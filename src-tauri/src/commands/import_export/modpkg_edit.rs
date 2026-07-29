//! ModPkg editing — open a `.modpkg`, edit its metadata and its chunks, re-save.
//!
//! This mirrors the WAD edit-session pattern (`wad_edit.rs`): callers open a
//! session against a file on disk, receive its metadata + file list, stage edits
//! against the session, then save back (in place or to a new path). Edits are
//! staged as deltas and only touch disk on save, so nothing is lost if the user
//! backs out.
//!
//! **Single-layer only.** The rebuild writes every chunk to the `base` layer, so
//! a package that genuinely uses several layers would be silently flattened.
//! Rather than corrupt one, `open_modpkg_session` reports `multi_layer` and the
//! chunk-editing commands refuse. Authoring layered packages is future work.

use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use flint_core::export::{
    Modpkg, ModpkgAuthor, ModpkgBuilder, ModpkgChunkBuilder, ModpkgLayerBuilder, ModpkgMetadata,
};

/// One staged change to a chunk. Held until save, mirroring `WadEditDelta`.
#[derive(Debug, Clone)]
enum ChunkDelta {
    /// Replacement bytes (also covers adding a chunk that was not there).
    Write(Vec<u8>),
    Delete,
}

/// A live session: where it came from, plus whatever the user has staged.
#[derive(Debug, Default)]
struct SessionState {
    source: PathBuf,
    /// Keyed by chunk path. A rename is a Write of the new path plus a Delete of
    /// the old one, so the delta set stays a flat path→change map.
    deltas: HashMap<String, ChunkDelta>,
    /// Set when the package uses more than the base layer. Chunk edits are
    /// refused, because the rebuild would flatten the layers.
    multi_layer: bool,
}

/// Live sessions: session id → state. Self-contained global so we don't have to
/// thread a managed Tauri state through `main.rs`.
fn sessions() -> &'static Mutex<HashMap<String, SessionState>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, SessionState>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Run `f` against one session's state.
fn with_session<T>(
    session_id: &str,
    f: impl FnOnce(&mut SessionState) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = sessions()
        .lock()
        .map_err(|_| "Session store poisoned".to_string())?;
    let state = guard
        .get_mut(session_id)
        .ok_or_else(|| format!("Unknown modpkg session: {}", session_id))?;
    f(state)
}

/// Chunk edits are refused on a layered package rather than silently flattening it.
fn ensure_editable(state: &SessionState) -> Result<(), String> {
    if state.multi_layer {
        return Err(
            "This package uses multiple layers, which Flint cannot rewrite without flattening them. \
             Chunk editing is disabled for it."
                .to_string(),
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct ModpkgSession {
    pub session_id: String,
    pub source_path: String,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub version: String,
    pub authors: Vec<String>,
    pub file_paths: Vec<String>,
    /// Base64 data URL (WebP) for the thumbnail, or null if there is none.
    pub thumbnail: Option<String>,
    /// True when the package uses more than the base layer. The UI must present
    /// it read-only: rewriting would collapse the layers.
    pub multi_layer: bool,
}

/// One chunk as the browser sees it.
#[derive(Debug, Clone, Serialize)]
pub struct ModpkgChunkInfo {
    pub path: String,
    /// Decompressed size in bytes.
    pub size: u64,
    /// True when this path has an unsaved edit staged against it.
    pub dirty: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModpkgMetadataInput {
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub version: String,
    pub authors: Vec<String>,
}

fn mount(path: &str) -> Result<Modpkg<BufReader<std::fs::File>>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open modpkg: {}", e))?;
    Modpkg::mount_from_reader(BufReader::new(file))
        .map_err(|e| format!("Failed to read modpkg: {}", e))
}

/// Content chunk paths (excluding internal `_meta_/` entries), sorted for a stable list.
fn content_paths(modpkg: &Modpkg<BufReader<std::fs::File>>) -> Vec<String> {
    let mut paths: Vec<String> = modpkg
        .chunk_paths
        .values()
        .filter(|p| !p.starts_with("_meta_/"))
        .cloned()
        .collect();
    paths.sort();
    paths
}

#[tauri::command]
pub async fn open_modpkg_session(path: String) -> Result<ModpkgSession, String> {
    tokio::task::spawn_blocking(move || {
        let mut modpkg = mount(&path)?;

        let metadata = modpkg.load_metadata().ok();
        let thumbnail = modpkg.load_thumbnail().ok().map(|bytes| {
            format!("data:image/webp;base64,{}", STANDARD.encode(&bytes))
        });
        let file_paths = content_paths(&modpkg);

        let (name, display_name, description, version, authors) = match &metadata {
            Some(m) => (
                m.name.clone(),
                m.display_name.clone(),
                m.description.clone(),
                m.version.to_string(),
                m.authors.iter().map(|a| a.name.clone()).collect(),
            ),
            None => (String::new(), String::new(), None, "0.1.0".to_string(), vec![]),
        };

        // More than one distinct layer means a rewrite would flatten the package.
        let layers: std::collections::HashSet<u64> =
            modpkg.chunks.keys().map(|(_, layer)| *layer).collect();
        let multi_layer = layers.len() > 1;
        if multi_layer {
            tracing::warn!(
                "modpkg {} uses {} layers; chunk editing disabled to avoid flattening it",
                path,
                layers.len()
            );
        }

        let session_id = Uuid::new_v4().to_string();
        sessions()
            .lock()
            .map_err(|_| "Session store poisoned".to_string())?
            .insert(
                session_id.clone(),
                SessionState {
                    source: PathBuf::from(&path),
                    deltas: HashMap::new(),
                    multi_layer,
                },
            );

        Ok(ModpkgSession {
            session_id,
            source_path: path,
            name,
            display_name,
            description,
            version,
            authors,
            file_paths,
            thumbnail,
            multi_layer,
        })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn save_modpkg_session(
    session_id: String,
    metadata: ModpkgMetadataInput,
    output_path: String,
) -> Result<(), String> {
    let (source, deltas) = with_session(&session_id, |s| {
        Ok((s.source.clone(), s.deltas.clone()))
    })?;

    let saved = tokio::task::spawn_blocking(move || {
        save_modpkg(&source, &metadata, &output_path, &deltas)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    // The staged edits are now on disk; a later save must not replay them
    // against the already-updated file.
    if saved.is_ok() {
        let _ = with_session(&session_id, |s| {
            s.deltas.clear();
            Ok(())
        });
    }
    saved
}

/// Content chunks with their sizes, honouring staged edits, for the browser tree.
#[tauri::command]
pub async fn list_modpkg_chunks(session_id: String) -> Result<Vec<ModpkgChunkInfo>, String> {
    let (source, deltas) = with_session(&session_id, |s| {
        Ok((s.source.clone(), s.deltas.clone()))
    })?;

    tokio::task::spawn_blocking(move || {
        let mut modpkg = mount(&source.to_string_lossy())?;

        let mut out: Vec<ModpkgChunkInfo> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        for (path_hash, layer_hash) in modpkg.chunks.keys().copied().collect::<Vec<_>>() {
            let Some(path) = modpkg.chunk_paths.get(&path_hash).cloned() else {
                continue;
            };
            if path.starts_with("_meta_/") || !seen.insert(path.clone()) {
                continue;
            }
            match deltas.get(&path) {
                Some(ChunkDelta::Delete) => continue,
                Some(ChunkDelta::Write(bytes)) => out.push(ModpkgChunkInfo {
                    path,
                    size: bytes.len() as u64,
                    dirty: true,
                }),
                None => {
                    let size = modpkg
                        .load_chunk_decompressed_by_hash(path_hash, layer_hash)
                        .map(|d| d.len() as u64)
                        .unwrap_or(0);
                    out.push(ModpkgChunkInfo { path, size, dirty: false });
                }
            }
        }

        // Chunks added by an edit have no counterpart in the file on disk.
        for (path, delta) in &deltas {
            if let ChunkDelta::Write(bytes) = delta {
                if !seen.contains(path) {
                    out.push(ModpkgChunkInfo {
                        path: path.clone(),
                        size: bytes.len() as u64,
                        dirty: true,
                    });
                }
            }
        }

        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Decompressed bytes for one chunk, taking a staged edit over what is on disk.
async fn chunk_bytes(session_id: &str, path: &str) -> Result<Vec<u8>, String> {
    let (source, staged) = with_session(session_id, |s| {
        Ok((s.source.clone(), s.deltas.get(path).cloned()))
    })?;

    match staged {
        Some(ChunkDelta::Write(bytes)) => Ok(bytes),
        Some(ChunkDelta::Delete) => Err(format!("Chunk was removed: {}", path)),
        None => {
            let path = path.to_string();
            tokio::task::spawn_blocking(move || {
                let mut modpkg = mount(&source.to_string_lossy())?;
                let (path_hash, layer_hash) = modpkg
                    .chunks
                    .keys()
                    .find(|(ph, _)| modpkg.chunk_paths.get(ph).is_some_and(|p| *p == path))
                    .copied()
                    .ok_or_else(|| format!("Chunk not found: {}", path))?;
                let data = modpkg
                    .load_chunk_decompressed_by_hash(path_hash, layer_hash)
                    .map_err(|e| format!("Failed to decompress '{}': {}", path, e))?;
                Ok(data.to_vec())
            })
            .await
            .map_err(|e| format!("Task failed: {}", e))?
        }
    }
}

/// Decompressed bytes for one chunk, honouring a staged edit.
#[tauri::command]
pub async fn read_modpkg_chunk(
    session_id: String,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let bytes = chunk_bytes(&session_id, &path).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Stage replacement bytes for a chunk (adds it when the path is new).
#[tauri::command]
pub async fn write_modpkg_chunk(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let session_id = header_string(&request, "session-id")?;
    let path = header_string(&request, "chunk-path")?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("write_modpkg_chunk expects a raw body".to_string()),
    };

    with_session(&session_id, |s| {
        ensure_editable(s)?;
        s.deltas.insert(path, ChunkDelta::Write(bytes));
        Ok(())
    })
}

/// Stage removal of a chunk.
#[tauri::command]
pub async fn remove_modpkg_chunk(session_id: String, path: String) -> Result<(), String> {
    with_session(&session_id, |s| {
        ensure_editable(s)?;
        s.deltas.insert(path, ChunkDelta::Delete);
        Ok(())
    })
}

/// Stage a move: the bytes reappear under `new_path` and the old path is dropped.
#[tauri::command]
pub async fn rename_modpkg_chunk(
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    if new_path.trim().is_empty() {
        return Err("New path cannot be empty".to_string());
    }
    if new_path.starts_with("_meta_/") {
        return Err("'_meta_/' is reserved for package metadata".to_string());
    }

    // Carry the current bytes over to the new path, taking a staged edit when
    // there is one so a rename after an edit moves the edited bytes.
    let bytes = chunk_bytes(&session_id, &old_path).await?;

    with_session(&session_id, |s| {
        ensure_editable(s)?;
        s.deltas.insert(new_path.clone(), ChunkDelta::Write(bytes));
        if old_path != new_path {
            s.deltas.insert(old_path.clone(), ChunkDelta::Delete);
        }
        Ok(())
    })
}

/// Paths with unsaved edits staged against them.
#[tauri::command]
pub async fn modpkg_dirty_chunks(session_id: String) -> Result<Vec<String>, String> {
    with_session(&session_id, |s| {
        let mut paths: Vec<String> = s.deltas.keys().cloned().collect();
        paths.sort();
        Ok(paths)
    })
}

/// Drop every staged edit, returning the session to what is on disk.
#[tauri::command]
pub async fn discard_modpkg_changes(session_id: String) -> Result<(), String> {
    with_session(&session_id, |s| {
        s.deltas.clear();
        Ok(())
    })
}

/// Read a required string header off a raw-body request.
fn header_string(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Missing '{}' header", name))
}

#[tauri::command]
pub async fn close_modpkg_session(session_id: String) -> Result<(), String> {
    sessions()
        .lock()
        .map_err(|_| "Session store poisoned".to_string())?
        .remove(&session_id);
    Ok(())
}

/// Re-mount the source modpkg and rewrite it with new metadata, preserving every
/// content chunk and the thumbnail. Writes to a temp file then atomically renames,
/// so an in-place save (`output_path == source`) never corrupts the original on a
/// mid-write failure.
fn save_modpkg(
    source: &std::path::Path,
    metadata: &ModpkgMetadataInput,
    output_path: &str,
    deltas: &HashMap<String, ChunkDelta>,
) -> Result<(), String> {
    let mut modpkg = mount(&source.to_string_lossy())?;

    // Collect content chunk bytes keyed by path. Multi-layer packages are collapsed
    // onto the base layer (first occurrence wins) — acceptable for the minimal
    // metadata editor; the common skin modpkg is single-layer.
    let entries: Vec<(u64, u64, String)> = modpkg
        .chunks
        .keys()
        .filter_map(|(path_hash, layer_hash)| {
            let path = modpkg.chunk_paths.get(path_hash)?;
            if path.starts_with("_meta_/") {
                return None;
            }
            Some((*path_hash, *layer_hash, path.clone()))
        })
        .collect();

    let mut chunk_bytes: HashMap<String, Vec<u8>> = HashMap::new();
    for (path_hash, layer_hash, path) in &entries {
        if chunk_bytes.contains_key(path) {
            continue;
        }
        let data = modpkg
            .load_chunk_decompressed_by_hash(*path_hash, *layer_hash)
            .map_err(|e| format!("Failed to decompress '{}': {}", path, e))?;
        chunk_bytes.insert(path.clone(), data.to_vec());
    }

    // Apply staged edits over the chunks read from disk: a Write replaces or adds,
    // a Delete drops the path entirely (a rename arrives as both).
    for (path, delta) in deltas {
        match delta {
            ChunkDelta::Write(bytes) => {
                chunk_bytes.insert(path.clone(), bytes.clone());
            }
            ChunkDelta::Delete => {
                chunk_bytes.remove(path);
            }
        }
    }

    let thumbnail = modpkg.load_thumbnail().ok();

    let version = semver::Version::parse(&metadata.version)
        .unwrap_or_else(|_| semver::Version::new(0, 1, 0));

    let new_metadata = ModpkgMetadata {
        name: metadata.name.clone(),
        display_name: metadata.display_name.clone(),
        version,
        description: metadata
            .description
            .as_ref()
            .filter(|d| !d.is_empty())
            .cloned(),
        authors: metadata
            .authors
            .iter()
            .filter(|a| !a.trim().is_empty())
            .map(|a| ModpkgAuthor::new(a.clone(), None))
            .collect(),
        ..Default::default()
    };

    let mut builder = ModpkgBuilder::default()
        .with_metadata(new_metadata)
        .map_err(|e| format!("Failed to set metadata: {}", e))?
        .with_layer(ModpkgLayerBuilder::base());

    if let Some(thumb) = thumbnail {
        builder = builder
            .with_thumbnail(thumb)
            .map_err(|e| format!("Failed to set thumbnail: {}", e))?;
    }

    for path in chunk_bytes.keys() {
        let chunk = ModpkgChunkBuilder::new()
            .with_path(path)
            .map_err(|e| format!("Failed to set chunk path '{}': {}", path, e))?
            .with_layer("base");
        builder = builder.with_chunk(chunk);
    }

    // Write to a sibling temp file, then atomically swap into place.
    let out = PathBuf::from(output_path);
    let tmp = out.with_extension("modpkg.tmp");
    {
        let mut tmp_file =
            std::fs::File::create(&tmp).map_err(|e| format!("Failed to create temp file: {}", e))?;
        builder
            .build_to_writer(&mut tmp_file, |chunk_builder, cursor| {
                if let Some(data) = chunk_bytes.get(&chunk_builder.path) {
                    cursor.write_all(data)?;
                }
                Ok(())
            })
            .map_err(|e| format!("Failed to build modpkg: {}", e))?;
        tmp_file
            .flush()
            .map_err(|e| format!("Failed to flush temp file: {}", e))?;
    }

    std::fs::rename(&tmp, &out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to finalize modpkg: {}", e)
    })?;

    tracing::info!("Saved modpkg to {} ({} chunks)", out.display(), chunk_bytes.len());
    Ok(())
}
