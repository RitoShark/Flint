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
    /// inner WAD names that came in as a FOLDER tree (not a packed file). These
    /// are opened as folder-backed sessions and written back as folders on save.
    folder_wads: std::collections::HashSet<String>,
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
                    folder_wads: Default::default(),
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
/// Given a zip entry name, return the inner-WAD name if the entry belongs to a
/// WAD stored as a FOLDER tree (loose files under `.../<name>.wad.client/...`).
/// Some tools ship fantomes where the WAD is an unpacked directory rather than a
/// single packed `.wad.client` file; launchers pack these on import. Flint packs
/// them on open (see `extract_fantome_inner_wad`) so the WAD editor can edit them.
fn folder_wad_name_of(entry_name: &str) -> Option<String> {
    let lower = entry_name.to_lowercase();
    // Find a path segment that ENDS a WAD dir, i.e. "<name>.wad.client/" or
    // "<name>.wad/" with something after it (so it's a directory, not the file).
    for marker in [".wad.client/", ".wad/"] {
        if let Some(pos) = lower.find(marker) {
            let dir_end = pos + marker.len() - 1; // index of the trailing '/'
            let dir_path = &entry_name[..dir_end]; // e.g. "WAD/Aatrox.wad.client"
            let base = dir_path.rsplit('/').next().unwrap_or(dir_path).to_string();
            if !base.is_empty() {
                return Some(base);
            }
        }
    }
    None
}

fn read_fantome_layout(path: &str) -> Result<(String, Vec<ArchiveWadInfo>), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open: {}", e))?;
    let mut zip = ZipArchive::new(BufReader::new(file)).map_err(|e| format!("zip: {}", e))?;
    let mut meta_json = String::new();
    let mut wads: Vec<ArchiveWadInfo> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for i in 0..zip.len() {
        let mut e = zip.by_index(i).map_err(|err| format!("entry: {}", err))?;
        let name = e.name().to_string();
        let lower = name.to_lowercase();
        if name.eq_ignore_ascii_case("META/info.json") {
            e.read_to_string(&mut meta_json)
                .map_err(|err| format!("read meta: {}", err))?;
        } else if lower.ends_with(".wad.client") || lower.ends_with(".wad") {
            // Packed-file WAD (a single entry IS the WAD).
            let base = name.rsplit('/').next().unwrap_or(&name).to_string();
            if seen.insert(base.to_lowercase()) {
                // Chunk count is filled lazily on open; report 0 here (cheap layout).
                wads.push(ArchiveWadInfo { name: base, chunk_count: 0 });
            }
        } else if let Some(base) = folder_wad_name_of(&name) {
            // Folder-form WAD (loose files under "<name>.wad.client/…"). Collapse
            // all its entries to one logical WAD; packed on open.
            if seen.insert(base.to_lowercase()) {
                wads.push(ArchiveWadInfo { name: base, chunk_count: 0 });
            }
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
pub async fn close_archive_session(
    session_id: String,
    wad_state: tauri::State<'_, crate::state::WadEditState>,
) -> Result<(), String> {
    // Remove the ArchiveSession first, capturing what we need, and drop the
    // guard before touching wad_state (don't hold the sessions() lock across it).
    let removed = sessions()
        .lock()
        .map_err(|_| "poisoned".to_string())?
        .remove(&session_id);
    if let Some(s) = removed {
        // Close every inner-WAD edit session this archive opened so their
        // decompressed chunk bytes don't leak for the app lifetime.
        for wad_session_id in s.open_wads.values() {
            wad_state.remove(wad_session_id);
        }
        let _ = std::fs::remove_dir_all(&s.temp_dir);
    }
    Ok(())
}

/// Result of opening an inner WAD. `folder_chunks` is populated (real paths, no
/// LMDB) when the WAD came in as a FOLDER tree; for a packed WAD it's `None` and
/// the caller uses the normal `getWadChunks` path.
#[derive(Debug, Clone, Serialize)]
pub struct InnerWadOpen {
    #[serde(flatten)]
    pub info: crate::commands::wad::wad_edit::WadEditSessionInfo,
    pub is_folder: bool,
    pub folder_chunks: Option<Vec<crate::commands::wad::wad_edit::FolderWadChunk>>,
}

/// Open a named inner WAD live. A packed `.wad.client` opens as a normal WAD
/// edit session; a folder-form WAD (loose files) is extracted to a scratch dir
/// and opened as a FOLDER-backed session — no packing, so its real string paths
/// are preserved (no hashed `data/` in the browser). Re-opening an already-open
/// inner WAD reuses its session.
#[tauri::command]
pub async fn open_inner_wad(
    session_id: String,
    wad_name: String,
    wad_state: tauri::State<'_, crate::state::WadEditState>,
) -> Result<InnerWadOpen, String> {
    let (source_path, kind, temp_dir, existing, existing_is_folder) = {
        let guard = sessions().lock().map_err(|_| "poisoned".to_string())?;
        let s = guard
            .get(&session_id)
            .ok_or_else(|| format!("no session {}", session_id))?;
        (
            s.source_path.clone(),
            s.kind.clone(),
            s.temp_dir.clone(),
            s.open_wads.get(&wad_name).cloned(),
            s.folder_wads.contains(&wad_name),
        )
    };

    if kind != "fantome" {
        return Err(
            "modpkg inner-WAD open is not supported — edit modpkg metadata only".into(),
        );
    }

    // Already open: reuse the existing edit session.
    if let Some(existing_id) = existing {
        let folder_chunks = if existing_is_folder {
            Some(
                crate::commands::wad::wad_edit::folder_wad_chunks(existing_id.clone(), wad_state)
                    .await?,
            )
        } else {
            None
        };
        return Ok(InnerWadOpen {
            info: crate::commands::wad::wad_edit::WadEditSessionInfo {
                session_id: existing_id,
                source_path: wad_name.clone(),
                initial_chunk_count: 0,
            },
            is_folder: existing_is_folder,
            folder_chunks,
        });
    }

    // Classify: is this a packed-file WAD entry, or a folder tree?
    let src_for_classify = source_path.clone();
    let name_for_classify = wad_name.clone();
    let is_folder =
        tokio::task::spawn_blocking(move || inner_wad_is_folder(&src_for_classify, &name_for_classify))
            .await
            .map_err(|e| format!("classify task: {}", e))??;

    if is_folder {
        // Extract the loose tree to a scratch dir (NO packing) and open a
        // folder-backed session against it.
        let scratch = temp_dir.join(format!("{}.folder", wad_name.replace('/', "_")));
        let src = source_path.clone();
        let name = wad_name.clone();
        let scratch_for_task = scratch.clone();
        tokio::task::spawn_blocking(move || {
            extract_fantome_inner_wad_folder(&src, &name, &scratch_for_task)
        })
        .await
        .map_err(|e| format!("extract task: {}", e))??;

        let (info, chunks) = crate::commands::wad::wad_edit::open_folder_wad_session(
            &scratch, &wad_name, &wad_state,
        )?;

        {
            let mut guard = sessions().lock().map_err(|_| "poisoned".to_string())?;
            if let Some(s) = guard.get_mut(&session_id) {
                s.open_wads.insert(wad_name.clone(), info.session_id.clone());
                s.folder_wads.insert(wad_name);
            }
        }
        return Ok(InnerWadOpen { info, is_folder: true, folder_chunks: Some(chunks) });
    }

    // Packed-file WAD: extract the single entry and open a normal WAD session.
    let temp_wad = temp_dir.join(&wad_name);
    if !temp_wad.exists() {
        let source = source_path.clone();
        let name = wad_name.clone();
        let out = temp_wad.clone();
        tokio::task::spawn_blocking(move || extract_fantome_inner_wad(&source, &name, &out))
            .await
            .map_err(|e| format!("extract task: {}", e))??;
    }
    let info = crate::commands::wad::wad_edit::open_wad_session_for_path(
        temp_wad.to_string_lossy().as_ref(),
        &wad_state,
    )?;
    {
        let mut guard = sessions().lock().map_err(|_| "poisoned".to_string())?;
        if let Some(s) = guard.get_mut(&session_id) {
            s.open_wads.insert(wad_name, info.session_id.clone());
        }
    }
    Ok(InnerWadOpen { info, is_folder: false, folder_chunks: None })
}

/// True if the named inner WAD is stored as a FOLDER tree rather than a packed
/// `.wad.client` file entry.
fn inner_wad_is_folder(archive: &std::path::Path, wad_name: &str) -> Result<bool, String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("open: {}", e))?;
    let mut zip = ZipArchive::new(BufReader::new(file)).map_err(|e| format!("zip: {}", e))?;
    let mut saw_packed = false;
    let mut saw_folder = false;
    for i in 0..zip.len() {
        let e = zip.by_index(i).map_err(|err| format!("entry: {}", err))?;
        let name = e.name().to_string();
        if !e.is_dir()
            && name
                .rsplit('/')
                .next()
                .map(|b| b.eq_ignore_ascii_case(wad_name))
                .unwrap_or(false)
        {
            saw_packed = true;
            break;
        }
        if folder_wad_name_of(&name).as_deref() == Some(wad_name) {
            saw_folder = true;
        }
    }
    if saw_packed {
        Ok(false)
    } else if saw_folder {
        Ok(true)
    } else {
        Err(format!("inner WAD not found: {}", wad_name))
    }
}

/// Extract a packed-file inner WAD (single zip entry) to `out`.
fn extract_fantome_inner_wad(
    archive: &std::path::Path,
    wad_name: &str,
    out: &std::path::Path,
) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("open: {}", e))?;
    let mut zip = ZipArchive::new(BufReader::new(file)).map_err(|e| format!("zip: {}", e))?;
    let idx = (0..zip.len())
        .find(|&i| {
            zip.by_index(i)
                .ok()
                .map(|e| {
                    let n = e.name();
                    !n.ends_with('/')
                        && n.rsplit('/')
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

/// Extract a folder-form inner WAD's loose files into `scratch`, preserving the
/// WAD-relative sub-tree. NO packing — the files stay loose so the real string
/// paths are edited/saved directly.
fn extract_fantome_inner_wad_folder(
    archive: &std::path::Path,
    wad_name: &str,
    scratch: &std::path::Path,
) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("open: {}", e))?;
    let mut zip = ZipArchive::new(BufReader::new(file)).map_err(|e| format!("zip: {}", e))?;
    let _ = std::fs::remove_dir_all(scratch);
    std::fs::create_dir_all(scratch).map_err(|e| format!("scratch dir: {}", e))?;

    let marker_dir = format!("{}/", wad_name.to_lowercase());
    let mut extracted = 0usize;
    for i in 0..zip.len() {
        let mut e = zip.by_index(i).map_err(|err| format!("entry: {}", err))?;
        let name = e.name().to_string();
        if e.is_dir() || folder_wad_name_of(&name).as_deref() != Some(wad_name) {
            continue;
        }
        let lower = name.to_lowercase();
        let Some(pos) = lower.find(&marker_dir) else { continue };
        let rel = &name[pos + marker_dir.len()..];
        if rel.is_empty() {
            continue;
        }
        let dest = scratch.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|err| format!("mkdir: {}", err))?;
        }
        let mut f = std::fs::File::create(&dest).map_err(|err| format!("create: {}", err))?;
        std::io::copy(&mut e, &mut f).map_err(|err| format!("extract: {}", err))?;
        extracted += 1;
    }
    if extracted == 0 {
        return Err(format!("inner WAD not found: {}", wad_name));
    }
    tracing::info!(
        "Extracted folder-form WAD '{}' ({} loose files) for direct editing",
        wad_name, extracted
    );
    Ok(())
}

#[tauri::command]
pub async fn save_archive_session(
    session_id: String,
    output_path: String,
    wad_state: tauri::State<'_, crate::state::WadEditState>,
) -> Result<(), String> {
    // Snapshot session info.
    let (source_path, kind, meta_json, open_wads, folder_wads) = {
        let guard = sessions().lock().map_err(|_| "poisoned".to_string())?;
        let s = guard
            .get(&session_id)
            .ok_or_else(|| format!("no session {}", session_id))?;
        (
            s.source_path.clone(),
            s.kind.clone(),
            s.meta_json.clone(),
            s.open_wads.clone(),
            s.folder_wads.clone(),
        )
    };

    if kind != "fantome" {
        return save_modpkg_archive(&source_path, &meta_json, &output_path).await;
    }

    // Serialize edited inner WADs. Packed WADs → replacement bytes; folder WADs
    // → their (relative_path, bytes) loose-file lists (stay folders on save).
    let mut edited_packed: HashMap<String, Vec<u8>> = HashMap::new();
    let mut edited_folders: HashMap<String, Vec<(String, Vec<u8>)>> = HashMap::new();
    for (wad_name, wad_session_id) in &open_wads {
        if folder_wads.contains(wad_name) {
            let files = crate::commands::wad::wad_edit::serialize_folder_session_to_files(
                wad_session_id,
                &wad_state,
            )
            .await?;
            edited_folders.insert(wad_name.clone(), files);
        } else {
            let (bytes, _count) =
                crate::commands::wad::wad_edit::serialize_session_to_bytes(wad_session_id, &wad_state)
                    .await?;
            edited_packed.insert(wad_name.clone(), bytes);
        }
    }

    let out = PathBuf::from(&output_path);
    let tmp = out.with_extension("fantome.tmp");
    let src = source_path.clone();
    let tmp_for_task = tmp.clone();
    let meta_for_task = meta_json.clone();
    tokio::task::spawn_blocking(move || {
        rebuild_fantome_zip(&src, &tmp_for_task, &meta_for_task, &edited_packed, &edited_folders)
    })
    .await
    .map_err(|e| format!("rebuild task: {}", e))??;
    std::fs::rename(&tmp, &out).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("finalize: {}", e)
    })?;
    Ok(())
}

/// Copy the source zip into `tmp`, replacing META/info.json with `meta_json`,
/// packed inner WADs present in `edited_packed` with their new bytes, and
/// folder-form inner WADs present in `edited_folders` with their new loose files
/// (kept as a folder tree under `WAD/<name>.wad.client/`); everything else
/// verbatim.
fn rebuild_fantome_zip(
    source: &std::path::Path,
    tmp: &std::path::Path,
    meta_json: &str,
    edited_packed: &HashMap<String, Vec<u8>>,
    edited_folders: &HashMap<String, Vec<(String, Vec<u8>)>>,
) -> Result<(), String> {
    use zip::write::SimpleFileOptions;
    let in_file = std::fs::File::open(source).map_err(|e| format!("open src: {}", e))?;
    let mut zin = ZipArchive::new(BufReader::new(in_file)).map_err(|e| format!("zip in: {}", e))?;
    let out_file = std::fs::File::create(tmp).map_err(|e| format!("create tmp: {}", e))?;
    let mut zout = zip::ZipWriter::new(out_file);

    // Prefix (everything up to and incl. "<name>.wad.client/") used when the
    // source stored the folder WAD, so we re-emit its files under the same root.
    let mut folder_prefix: HashMap<String, String> = HashMap::new();
    // Folder WADs we've already re-emitted (emit their new files once).
    let mut folders_written: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut wrote_meta = false;
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
            wrote_meta = true;
        } else if let Some(bytes) = edited_packed.get(&base) {
            // Packed-file WAD replaced in place.
            zout.start_file(
                &name,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
            )
            .map_err(|err| format!("wad: {}", err))?;
            zout.write_all(bytes)
                .map_err(|err| format!("wad write: {}", err))?;
        } else if let Some(folder_wad) = folder_wad_name_of(&name) {
            if let Some(files) = edited_folders.get(&folder_wad) {
                // Compute+remember the source's WAD-root prefix once (e.g.
                // "WAD/Talon.wad.client/") so we re-emit under the same shape.
                if !folder_prefix.contains_key(&folder_wad) {
                    let lower = name.to_lowercase();
                    let marker = format!("{}/", folder_wad.to_lowercase());
                    if let Some(pos) = lower.find(&marker) {
                        folder_prefix
                            .insert(folder_wad.clone(), name[..pos + marker.len()].to_string());
                    }
                }
                // Emit the edited folder's loose files exactly once; drop the
                // original loose entries (they're superseded).
                if folders_written.insert(folder_wad.to_lowercase()) {
                    let prefix = folder_prefix
                        .get(&folder_wad)
                        .cloned()
                        .unwrap_or_else(|| format!("WAD/{}/", folder_wad));
                    for (rel, bytes) in files {
                        let entry_name = format!("{}{}", prefix, rel);
                        zout.start_file(
                            &entry_name,
                            SimpleFileOptions::default()
                                .compression_method(zip::CompressionMethod::Deflated),
                        )
                        .map_err(|err| format!("folder wad: {}", err))?;
                        zout.write_all(bytes)
                            .map_err(|err| format!("folder wad write: {}", err))?;
                    }
                }
                // else: another original loose entry of an already-rewritten folder → drop.
            } else {
                // Folder WAD the user never opened — preserve verbatim.
                zout.raw_copy_file(e).map_err(|err| format!("copy: {}", err))?;
            }
        } else {
            zout.raw_copy_file(e).map_err(|err| format!("copy: {}", err))?;
        }
    }
    if !wrote_meta {
        zout.start_file(
            "META/info.json",
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(|e| format!("meta: {}", e))?;
        zout.write_all(meta_json.as_bytes())
            .map_err(|e| format!("meta write: {}", e))?;
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
