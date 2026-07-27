//! Minimal ModPkg editing — open a `.modpkg`, edit its metadata, re-save.
//!
//! This mirrors the WAD edit-session pattern (`wad_edit.rs`): callers open a
//! session against a file on disk, receive its metadata + file list, then save
//! back (in place or to a new path). The session itself is intentionally light —
//! it only remembers the source path, so save re-mounts the original and rewrites
//! it with the updated metadata while preserving every content chunk and the
//! thumbnail.
//!
//! Scope is deliberately "minimal" (metadata only): name, display name, version,
//! description and authors. File add/remove and per-chunk editing are future work.

use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use flint_core::types::{
    Modpkg, ModpkgAuthor, ModpkgBuilder, ModpkgChunkBuilder, ModpkgLayerBuilder, ModpkgMetadata,
};

/// Live sessions: session id → source `.modpkg` path. Self-contained global so we
/// don't have to thread a managed Tauri state through `main.rs`.
fn sessions() -> &'static Mutex<HashMap<String, PathBuf>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
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

        let session_id = Uuid::new_v4().to_string();
        sessions()
            .lock()
            .map_err(|_| "Session store poisoned".to_string())?
            .insert(session_id.clone(), PathBuf::from(&path));

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
    let source = sessions()
        .lock()
        .map_err(|_| "Session store poisoned".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| format!("Unknown modpkg session: {}", session_id))?;

    tokio::task::spawn_blocking(move || save_modpkg(&source, &metadata, &output_path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
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
