//! Full archive editor for `.fantome` (zip) and `.modpkg`. Exposes the real
//! container layout — META + inner WADs — and lets callers edit the meta JSON
//! and open each inner WAD live in a normal WAD edit session, saving the edited
//! WADs back into the archive.

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use uuid::Uuid;
use zip::ZipArchive;

use flint_ltk::ltk_types::{
    Modpkg, ModpkgAuthor, ModpkgBuilder, ModpkgChunkBuilder, ModpkgLayerBuilder, ModpkgMetadata,
};

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveWadInfo {
    pub name: String, // e.g. "Aatrox.wad.client"
    pub chunk_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveLayout {
    pub session_id: String,
    pub source_path: String,
    pub kind: String,      // "fantome" | "modpkg"
    pub meta_json: String, // info.json text (fantome) or modpkg metadata JSON
    pub wads: Vec<ArchiveWadInfo>,
}

struct ArchiveSession {
    source_path: PathBuf,
    kind: String,
    meta_json: String,
    temp_dir: PathBuf,
    /// inner WAD name -> open WAD edit-session id (only for opened WADs).
    open_wads: HashMap<String, String>,
}

fn sessions() -> &'static Mutex<HashMap<String, ArchiveSession>> {
    static S: OnceLock<Mutex<HashMap<String, ArchiveSession>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn detect_kind(path: &str) -> String {
    if path.to_lowercase().ends_with(".modpkg") {
        "modpkg".into()
    } else {
        "fantome".into()
    }
}

#[tauri::command]
pub async fn open_archive_session(path: String) -> Result<ArchiveLayout, String> {
    tokio::task::spawn_blocking(move || {
        let kind = detect_kind(&path);
        let (meta_json, wads) = if kind == "fantome" {
            read_fantome_layout(&path)?
        } else {
            read_modpkg_layout(&path)?
        };
        let session_id = Uuid::new_v4().to_string();
        let temp_dir = std::env::temp_dir().join(format!("flint_archive_{}", session_id));
        std::fs::create_dir_all(&temp_dir).map_err(|e| format!("temp dir: {}", e))?;
        sessions()
            .lock()
            .map_err(|_| "poisoned".to_string())?
            .insert(
                session_id.clone(),
                ArchiveSession {
                    source_path: PathBuf::from(&path),
                    kind: kind.clone(),
                    meta_json: meta_json.clone(),
                    temp_dir,
                    open_wads: HashMap::new(),
                },
            );
        Ok(ArchiveLayout {
            session_id,
            source_path: path,
            kind,
            meta_json,
            wads,
        })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Read a `.fantome` zip's META/info.json text and the list of inner WADs.
fn read_fantome_layout(path: &str) -> Result<(String, Vec<ArchiveWadInfo>), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open: {}", e))?;
    let mut zip = ZipArchive::new(BufReader::new(file)).map_err(|e| format!("zip: {}", e))?;
    let mut meta_json = String::new();
    let mut wads: Vec<ArchiveWadInfo> = Vec::new();
    for i in 0..zip.len() {
        let mut e = zip.by_index(i).map_err(|err| format!("entry: {}", err))?;
        let name = e.name().to_string();
        if name.eq_ignore_ascii_case("META/info.json") {
            e.read_to_string(&mut meta_json)
                .map_err(|err| format!("read meta: {}", err))?;
        } else if name.to_lowercase().ends_with(".wad.client")
            || name.to_lowercase().ends_with(".wad")
        {
            // Chunk count is filled lazily on open; report 0 here (cheap layout).
            let base = name.rsplit('/').next().unwrap_or(&name).to_string();
            wads.push(ArchiveWadInfo {
                name: base,
                chunk_count: 0,
            });
        }
    }
    Ok((meta_json, wads))
}

/// Read a `.modpkg`'s metadata as JSON text + treat its content chunks as a
/// single synthetic inner WAD (modpkg stores chunks flat, not in named WADs).
fn read_modpkg_layout(path: &str) -> Result<(String, Vec<ArchiveWadInfo>), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open: {}", e))?;
    let mut modpkg =
        Modpkg::mount_from_reader(BufReader::new(file)).map_err(|e| format!("mount: {}", e))?;
    let meta = modpkg.load_metadata().ok();
    let meta_json = serde_json::to_string_pretty(&serde_json::json!({
        "Name": meta.as_ref().map(|m| m.display_name.clone()).unwrap_or_default(),
        "Version": meta.as_ref().map(|m| m.version.to_string()).unwrap_or_else(|| "0.1.0".into()),
        "Description": meta.as_ref().and_then(|m| m.description.clone()).unwrap_or_default(),
        "Author": meta.as_ref().map(|m| m.authors.iter().map(|a| a.name.clone()).collect::<Vec<_>>().join(", ")).unwrap_or_default(),
    }))
    .map_err(|e| format!("meta json: {}", e))?;
    let count = modpkg
        .chunk_paths
        .values()
        .filter(|p| !p.starts_with("_meta_/"))
        .count();
    Ok((
        meta_json,
        vec![ArchiveWadInfo {
            name: "content".into(),
            chunk_count: count,
        }],
    ))
}

#[tauri::command]
pub async fn write_archive_meta(session_id: String, meta_json: String) -> Result<(), String> {
    let mut guard = sessions().lock().map_err(|_| "poisoned".to_string())?;
    let s = guard
        .get_mut(&session_id)
        .ok_or_else(|| format!("no session {}", session_id))?;
    s.meta_json = meta_json;
    Ok(())
}

#[tauri::command]
pub async fn close_archive_session(session_id: String) -> Result<(), String> {
    if let Some(s) = sessions()
        .lock()
        .map_err(|_| "poisoned".to_string())?
        .remove(&session_id)
    {
        let _ = std::fs::remove_dir_all(&s.temp_dir);
    }
    Ok(())
}

/// Open a named inner WAD live: extract its bytes to the session temp dir and
/// open a normal `WadEditState` session against it (so every chunk op works
/// unchanged). Re-opening an already-open inner WAD returns its existing session
/// info without re-extracting.
#[tauri::command]
pub async fn open_inner_wad(
    session_id: String,
    wad_name: String,
    wad_state: tauri::State<'_, crate::state::WadEditState>,
) -> Result<crate::commands::wad::wad_edit::WadEditSessionInfo, String> {
    let (source_path, kind, temp_dir, existing) = {
        let guard = sessions().lock().map_err(|_| "poisoned".to_string())?;
        let s = guard
            .get(&session_id)
            .ok_or_else(|| format!("no session {}", session_id))?;
        (
            s.source_path.clone(),
            s.kind.clone(),
            s.temp_dir.clone(),
            s.open_wads.get(&wad_name).cloned(),
        )
    };

    if kind != "fantome" {
        return Err(
            "modpkg inner-WAD open is not supported — edit modpkg metadata only".into(),
        );
    }

    let temp_wad = temp_dir.join(&wad_name);

    // Already open: reuse the existing WAD edit session (don't re-extract).
    if let Some(existing_id) = existing {
        return Ok(crate::commands::wad::wad_edit::WadEditSessionInfo {
            session_id: existing_id,
            source_path: temp_wad.to_string_lossy().into_owned(),
            initial_chunk_count: 0,
        });
    }

    // Extract the inner WAD bytes to the session temp dir if not already present.
    if !temp_wad.exists() {
        let source = source_path.clone();
        let name = wad_name.clone();
        let out = temp_wad.clone();
        tokio::task::spawn_blocking(move || extract_fantome_inner_wad(&source, &name, &out))
            .await
            .map_err(|e| format!("extract task: {}", e))??;
    }

    // Open a WAD edit session on the temp file (reuse the shared opener).
    let info = crate::commands::wad::wad_edit::open_wad_session_for_path(
        temp_wad.to_string_lossy().as_ref(),
        &wad_state,
    )?;

    // Record the mapping.
    {
        let mut guard = sessions().lock().map_err(|_| "poisoned".to_string())?;
        if let Some(s) = guard.get_mut(&session_id) {
            s.open_wads.insert(wad_name, info.session_id.clone());
        }
    }
    Ok(info)
}

fn extract_fantome_inner_wad(
    archive: &std::path::Path,
    wad_name: &str,
    out: &std::path::Path,
) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("open: {}", e))?;
    let mut zip = ZipArchive::new(BufReader::new(file)).map_err(|e| format!("zip: {}", e))?;
    // Match by basename so "WAD/Name.wad.client" matches "Name.wad.client".
    let idx = (0..zip.len())
        .find(|&i| {
            zip.by_index(i)
                .ok()
                .map(|e| {
                    e.name()
                        .rsplit('/')
                        .next()
                        .map(|b| b.eq_ignore_ascii_case(wad_name))
                        .unwrap_or(false)
                })
                .unwrap_or(false)
        })
        .ok_or_else(|| format!("inner WAD not found: {}", wad_name))?;
    let mut entry = zip.by_index(idx).map_err(|e| format!("entry: {}", e))?;
    let mut f = std::fs::File::create(out).map_err(|e| format!("create: {}", e))?;
    std::io::copy(&mut entry, &mut f).map_err(|e| format!("extract: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn save_archive_session(
    session_id: String,
    output_path: String,
    wad_state: tauri::State<'_, crate::state::WadEditState>,
) -> Result<(), String> {
    // Snapshot session info.
    let (source_path, kind, meta_json, open_wads) = {
        let guard = sessions().lock().map_err(|_| "poisoned".to_string())?;
        let s = guard
            .get(&session_id)
            .ok_or_else(|| format!("no session {}", session_id))?;
        (
            s.source_path.clone(),
            s.kind.clone(),
            s.meta_json.clone(),
            s.open_wads.clone(),
        )
    };

    if kind != "fantome" {
        return save_modpkg_archive(&source_path, &meta_json, &output_path).await;
    }

    // Serialize edited inner WADs to bytes first (off the zip).
    let mut edited: HashMap<String, Vec<u8>> = HashMap::new();
    for (wad_name, wad_session_id) in &open_wads {
        let (bytes, _count) =
            crate::commands::wad::wad_edit::serialize_session_to_bytes(wad_session_id, &wad_state)
                .await?;
        edited.insert(wad_name.clone(), bytes);
    }

    let out = PathBuf::from(&output_path);
    let tmp = out.with_extension("fantome.tmp");
    let src = source_path.clone();
    let tmp_for_task = tmp.clone();
    let meta_for_task = meta_json.clone();
    tokio::task::spawn_blocking(move || {
        rebuild_fantome_zip(&src, &tmp_for_task, &meta_for_task, &edited)
    })
    .await
    .map_err(|e| format!("rebuild task: {}", e))??;
    std::fs::rename(&tmp, &out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("finalize: {}", e)
    })?;
    Ok(())
}

/// Copy the source zip into `tmp`, replacing META/info.json with `meta_json` and
/// any inner WAD present in `edited` with its new bytes; everything else verbatim.
fn rebuild_fantome_zip(
    source: &std::path::Path,
    tmp: &std::path::Path,
    meta_json: &str,
    edited: &HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    use zip::write::SimpleFileOptions;
    let in_file = std::fs::File::open(source).map_err(|e| format!("open src: {}", e))?;
    let mut zin = ZipArchive::new(BufReader::new(in_file)).map_err(|e| format!("zip in: {}", e))?;
    let out_file = std::fs::File::create(tmp).map_err(|e| format!("create tmp: {}", e))?;
    let mut zout = zip::ZipWriter::new(out_file);

    for i in 0..zin.len() {
        let e = zin.by_index(i).map_err(|err| format!("entry: {}", err))?;
        let name = e.name().to_string();
        let base = name.rsplit('/').next().unwrap_or(&name).to_string();
        if name.eq_ignore_ascii_case("META/info.json") {
            zout.start_file(
                &name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .map_err(|err| format!("meta: {}", err))?;
            zout.write_all(meta_json.as_bytes())
                .map_err(|err| format!("meta write: {}", err))?;
        } else if let Some(bytes) = edited.get(&base) {
            zout.start_file(
                &name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .map_err(|err| format!("wad: {}", err))?;
            zout.write_all(bytes)
                .map_err(|err| format!("wad write: {}", err))?;
        } else {
            zout.raw_copy_file(e).map_err(|err| format!("copy: {}", err))?;
        }
    }
    zout.finish().map_err(|e| format!("finish: {}", e))?;
    Ok(())
}

/// Re-save a `.modpkg` with the edited metadata, preserving every content chunk
/// and the thumbnail. Mirrors `modpkg_edit::save_modpkg` but parses the meta
/// fields out of the archive editor's `meta_json` (Name/Version/Description/Author).
async fn save_modpkg_archive(
    source: &std::path::Path,
    meta_json: &str,
    output_path: &str,
) -> Result<(), String> {
    let meta: serde_json::Value =
        serde_json::from_str(meta_json).map_err(|e| format!("parse meta json: {}", e))?;
    let name = meta
        .get("Name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let version_str = meta
        .get("Version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.1.0")
        .to_string();
    let description = meta
        .get("Description")
        .and_then(|v| v.as_str())
        .filter(|d| !d.is_empty())
        .map(|d| d.to_string());
    let authors: Vec<String> = meta
        .get("Author")
        .and_then(|v| v.as_str())
        .map(|a| {
            a.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let source = source.to_path_buf();
    let output_path = output_path.to_string();
    tokio::task::spawn_blocking(move || {
        let mut modpkg = {
            let file =
                std::fs::File::open(&source).map_err(|e| format!("Failed to open modpkg: {}", e))?;
            Modpkg::mount_from_reader(BufReader::new(file))
                .map_err(|e| format!("Failed to read modpkg: {}", e))?
        };

        // Collect content chunk bytes keyed by path; collapse multi-layer onto base.
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
        let version = semver::Version::parse(&version_str)
            .unwrap_or_else(|_| semver::Version::new(0, 1, 0));

        let new_metadata = ModpkgMetadata {
            name: name.clone(),
            display_name: name.clone(),
            version,
            description,
            authors: authors
                .iter()
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

        let out = PathBuf::from(&output_path);
        let tmp = out.with_extension("modpkg.tmp");
        {
            let mut tmp_file = std::fs::File::create(&tmp)
                .map_err(|e| format!("Failed to create temp file: {}", e))?;
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
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}
