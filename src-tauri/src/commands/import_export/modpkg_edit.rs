//! ModPkg editing — open a `.modpkg`, edit its metadata and its chunks, re-save.
//!
//! This mirrors the WAD edit-session pattern (`wad_edit.rs`): callers open a
//! session against a file on disk, receive its metadata + file list, stage edits
//! against the session, then save back (in place or to a new path). Edits are
//! staged as deltas and only touch disk on save, so nothing is lost if the user
//! backs out.
//!
//! **Layers are preserved.** Each chunk remembers the layer it came from and is
//! rebuilt into that same layer with its original name and priority, so editing
//! a layered package no longer collapses it onto `base`. A chunk added by an
//! edit lands on `base` unless the caller names a layer.

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
    /// Replacement bytes (also covers adding a chunk that was not there), plus
    /// the layer they belong to so an edit never migrates a chunk off its layer.
    Write { bytes: Vec<u8>, layer: String },
    Delete,
}

/// Identifies one chunk within a package. A path can appear on several layers,
/// so neither half alone is unique.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct ChunkKey {
    path: String,
    layer: String,
}

/// A live session: where it came from, plus whatever the user has staged.
#[derive(Debug, Default)]
struct SessionState {
    source: PathBuf,
    /// Keyed by chunk path. A rename is a Write of the new path plus a Delete of
    /// the old one, so the delta set stays a flat path→change map.
    deltas: HashMap<ChunkKey, ChunkDelta>,
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

/// The layer a chunk added by an edit lands on when none is named.
const DEFAULT_LAYER: &str = "base";

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
    /// The layer this chunk lives on. The same path may exist on several.
    pub layer: String,
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
            tracing::info!("modpkg {} uses {} layers", path, layers.len());
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
        let mut seen: std::collections::HashSet<ChunkKey> = std::collections::HashSet::new();

        // A path can exist on several layers, so each (path, layer) pair is its
        // own chunk rather than a duplicate to be filtered out.
        for (path_hash, layer_hash) in modpkg.chunks.keys().copied().collect::<Vec<_>>() {
            let Some(path) = modpkg.chunk_paths.get(&path_hash).cloned() else {
                continue;
            };
            if path.starts_with("_meta_/") {
                continue;
            }
            let layer = modpkg
                .layers
                .get(&layer_hash)
                .map(|l| l.name.clone())
                .unwrap_or_else(|| DEFAULT_LAYER.to_string());
            let key = ChunkKey { path: path.clone(), layer: layer.clone() };
            if !seen.insert(key.clone()) {
                continue;
            }

            match deltas.get(&key) {
                Some(ChunkDelta::Delete) => continue,
                Some(ChunkDelta::Write { bytes, .. }) => out.push(ModpkgChunkInfo {
                    path,
                    layer,
                    size: bytes.len() as u64,
                    dirty: true,
                }),
                None => {
                    let size = modpkg
                        .load_chunk_decompressed_by_hash(path_hash, layer_hash)
                        .map(|d| d.len() as u64)
                        .unwrap_or(0);
                    out.push(ModpkgChunkInfo { path, layer, size, dirty: false });
                }
            }
        }

        // Chunks added by an edit have no counterpart in the file on disk.
        for (key, delta) in &deltas {
            if let ChunkDelta::Write { bytes, .. } = delta {
                if !seen.contains(key) {
                    out.push(ModpkgChunkInfo {
                        path: key.path.clone(),
                        layer: key.layer.clone(),
                        size: bytes.len() as u64,
                        dirty: true,
                    });
                }
            }
        }

        out.sort_by(|a, b| (&a.path, &a.layer).cmp(&(&b.path, &b.layer)));
        Ok(out)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Decompressed bytes for one chunk, taking a staged edit over what is on disk.
/// `layer` selects among same-path chunks; `None` takes whichever layer holds it.
async fn chunk_bytes(
    session_id: &str,
    path: &str,
    layer: Option<&str>,
) -> Result<(Vec<u8>, String), String> {
    let wanted = layer.map(|l| ChunkKey { path: path.to_string(), layer: l.to_string() });
    let (source, staged) = with_session(session_id, |s| {
        let staged = match &wanted {
            Some(key) => s.deltas.get(key).cloned().map(|d| (d, key.layer.clone())),
            // With no layer named, any staged edit for this path will do.
            None => s
                .deltas
                .iter()
                .find(|(k, _)| k.path == path)
                .map(|(k, d)| (d.clone(), k.layer.clone())),
        };
        Ok((s.source.clone(), staged))
    })?;

    match staged {
        Some((ChunkDelta::Write { bytes, layer }, _)) => Ok((bytes, layer)),
        Some((ChunkDelta::Delete, _)) => Err(format!("Chunk was removed: {}", path)),
        None => {
            let path = path.to_string();
            let layer = layer.map(|l| l.to_string());
            tokio::task::spawn_blocking(move || {
                let mut modpkg = mount(&source.to_string_lossy())?;
                let found = modpkg
                    .chunks
                    .keys()
                    .find(|(ph, lh)| {
                        modpkg.chunk_paths.get(ph).is_some_and(|p| *p == path)
                            && layer.as_ref().is_none_or(|want| {
                                modpkg.layers.get(lh).is_some_and(|l| l.name == *want)
                            })
                    })
                    .copied();
                let (path_hash, layer_hash) =
                    found.ok_or_else(|| format!("Chunk not found: {}", path))?;
                let layer_name = modpkg
                    .layers
                    .get(&layer_hash)
                    .map(|l| l.name.clone())
                    .unwrap_or_else(|| DEFAULT_LAYER.to_string());
                let data = modpkg
                    .load_chunk_decompressed_by_hash(path_hash, layer_hash)
                    .map_err(|e| format!("Failed to decompress '{}': {}", path, e))?;
                Ok((data.to_vec(), layer_name))
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
    layer: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let (bytes, _) = chunk_bytes(&session_id, &path, layer.as_deref()).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Stage replacement bytes for a chunk (adds it when the path is new).
#[tauri::command]
pub async fn write_modpkg_chunk(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let session_id = header_string(&request, "session-id")?;
    let path = header_string(&request, "chunk-path")?;
    // Absent header = the package's default layer, which is what a plain
    // single-layer package wants.
    let layer = header_string(&request, "chunk-layer").unwrap_or_else(|_| DEFAULT_LAYER.to_string());
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("write_modpkg_chunk expects a raw body".to_string()),
    };

    with_session(&session_id, |s| {
        s.deltas.insert(
            ChunkKey { path, layer: layer.clone() },
            ChunkDelta::Write { bytes, layer },
        );
        Ok(())
    })
}

/// Stage removal of a chunk.
#[tauri::command]
pub async fn remove_modpkg_chunk(
    session_id: String,
    path: String,
    layer: Option<String>,
) -> Result<(), String> {
    // Resolve the layer the same way a read would, so removing without naming
    // one targets the chunk the user is actually looking at rather than
    // guessing at `base`.
    let layer = match layer {
        Some(l) => l,
        None => chunk_bytes(&session_id, &path, None).await?.1,
    };
    with_session(&session_id, |s| {
        s.deltas.insert(ChunkKey { path, layer }, ChunkDelta::Delete);
        Ok(())
    })
}

/// Stage a move: the bytes reappear under `new_path` and the old path is dropped.
#[tauri::command]
pub async fn rename_modpkg_chunk(
    session_id: String,
    old_path: String,
    new_path: String,
    layer: Option<String>,
) -> Result<(), String> {
    if new_path.trim().is_empty() {
        return Err("New path cannot be empty".to_string());
    }
    if new_path.starts_with("_meta_/") {
        return Err("'_meta_/' is reserved for package metadata".to_string());
    }

    // Carry the current bytes over to the new path, taking a staged edit when
    // there is one so a rename after an edit moves the edited bytes. The chunk
    // stays on its own layer.
    let (bytes, layer) = chunk_bytes(&session_id, &old_path, layer.as_deref()).await?;

    with_session(&session_id, |s| {
        s.deltas.insert(
            ChunkKey { path: new_path.clone(), layer: layer.clone() },
            ChunkDelta::Write { bytes, layer: layer.clone() },
        );
        if old_path != new_path {
            s.deltas.insert(
                ChunkKey { path: old_path.clone(), layer },
                ChunkDelta::Delete,
            );
        }
        Ok(())
    })
}

/// Paths with unsaved edits staged against them.
#[tauri::command]
pub async fn modpkg_dirty_chunks(session_id: String) -> Result<Vec<String>, String> {
    with_session(&session_id, |s| {
        let mut paths: Vec<String> = s.deltas.keys().map(|k| k.path.clone()).collect();
        paths.sort();
        paths.dedup();
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
    deltas: &HashMap<ChunkKey, ChunkDelta>,
) -> Result<(), String> {
    let mut modpkg = mount(&source.to_string_lossy())?;

    // Every layer in the source, so the rebuild can recreate each one with its
    // original name and priority instead of collapsing onto `base`.
    let mut layer_defs: HashMap<String, i32> = modpkg
        .layers
        .values()
        .map(|l| (l.name.clone(), l.priority))
        .collect();

    // Content chunks keyed by (path, layer): the same path can legitimately
    // appear on several layers, and each is its own chunk.
    let entries: Vec<(u64, u64, ChunkKey)> = modpkg
        .chunks
        .keys()
        .filter_map(|(path_hash, layer_hash)| {
            let path = modpkg.chunk_paths.get(path_hash)?;
            if path.starts_with("_meta_/") {
                return None;
            }
            let layer = modpkg
                .layers
                .get(layer_hash)
                .map(|l| l.name.clone())
                .unwrap_or_else(|| DEFAULT_LAYER.to_string());
            Some((
                *path_hash,
                *layer_hash,
                ChunkKey { path: path.clone(), layer },
            ))
        })
        .collect();

    let mut chunk_bytes: HashMap<ChunkKey, Vec<u8>> = HashMap::new();
    for (path_hash, layer_hash, key) in &entries {
        if chunk_bytes.contains_key(key) {
            continue;
        }
        let data = modpkg
            .load_chunk_decompressed_by_hash(*path_hash, *layer_hash)
            .map_err(|e| format!("Failed to decompress '{}': {}", key.path, e))?;
        chunk_bytes.insert(key.clone(), data.to_vec());
    }

    // Apply staged edits over the chunks read from disk: a Write replaces or adds,
    // a Delete drops that (path, layer) entirely (a rename arrives as both).
    for (key, delta) in deltas {
        match delta {
            ChunkDelta::Write { bytes, layer } => {
                // An edit may introduce a layer the source never had.
                layer_defs.entry(layer.clone()).or_insert(0);
                chunk_bytes.insert(key.clone(), bytes.clone());
            }
            ChunkDelta::Delete => {
                chunk_bytes.remove(key);
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
        .map_err(|e| format!("Failed to set metadata: {}", e))?;

    // Recreate every layer the package had, with its original priority, so a
    // layered package survives the round-trip. `base` is always present.
    layer_defs.entry(DEFAULT_LAYER.to_string()).or_insert(0);
    let mut layer_names: Vec<(&String, &i32)> = layer_defs.iter().collect();
    layer_names.sort();
    for (name, priority) in layer_names {
        builder = builder.with_layer(if name == DEFAULT_LAYER {
            ModpkgLayerBuilder::base()
        } else {
            ModpkgLayerBuilder::new(name).with_priority(*priority)
        });
    }

    if let Some(thumb) = thumbnail {
        builder = builder
            .with_thumbnail(thumb)
            .map_err(|e| format!("Failed to set thumbnail: {}", e))?;
    }

    for key in chunk_bytes.keys() {
        let chunk = ModpkgChunkBuilder::new()
            .with_path(&key.path)
            .map_err(|e| format!("Failed to set chunk path '{}': {}", key.path, e))?
            .with_layer(&key.layer);
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
                let key = ChunkKey {
                    path: chunk_builder.path.clone(),
                    layer: chunk_builder.layer().to_string(),
                };
                if let Some(data) = chunk_bytes.get(&key) {
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
