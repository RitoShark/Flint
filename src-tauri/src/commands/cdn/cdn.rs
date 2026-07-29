//! Tauri commands for the online CDN manifest browser. These wrap
//! `flint_core::cdn` (sieve discovery, RMAN tree, remote-WAD TOC browse, extract)
//! and hold parsed manifests in `CdnSessionState`, one per open manifest tab.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, State};

use flint_core::cdn::{catalog, downloader, manifest::TreeNode, sieve, wad_browse};
use flint_core::hash::resolve_hashes_lmdb_bulk;

use crate::state::{CdnSessionState, LmdbCacheState};

fn http_client() -> reqwest::Client {
    reqwest::Client::new()
}

/// Persistent on-disk cache dir for the manifest catalog (tree + resolved URLs).
fn cdn_cache_dir() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(base).join("Flint").join("cache").join("cdn")
}

/// Where downloaded manifests are stored (keyed by URL basename).
fn manifest_dir() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(base).join("Flint").join("manifest")
}

// ── manifest discovery ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ManifestEntryDto {
    pub artifact_type: String,
    /// "game" | "client" | "other"
    pub kind: String,
    pub version: String,
    pub patch: String,
    pub url: String,
}

#[tauri::command]
pub async fn cdn_list_manifests(
    region: String,
    platform: String,
) -> Result<Vec<ManifestEntryDto>, String> {
    let plat = sieve::Platform::from_str_lenient(&platform);
    let entries = sieve::fetch_manifests(&http_client(), &region, plat)
        .await
        .map_err(|e| e.to_string())?;
    Ok(entries
        .into_iter()
        .map(|e| ManifestEntryDto {
            artifact_type: e.artifact_type,
            kind: e.kind.tag().to_string(),
            version: e.version,
            patch: e.patch,
            url: e.url,
        })
        .collect())
}

// ── catalog: full manifest history from Morilli/riot-manifests ───────────────

#[derive(Serialize)]
pub struct CatalogEntryDto {
    pub path: String,
    pub kind: String,
    pub patch: String,
    pub build: String,
    pub version: String,
}

/// List every catalogued manifest for a region+platform (all kinds), newest first.
/// Backed by the Morilli/riot-manifests GitHub tree, cached to disk; pass
/// `refresh = true` to re-fetch and discover newly-shipped patches.
#[tauri::command]
pub async fn cdn_list_versions(
    region: String,
    platform: String,
    refresh: bool,
) -> Result<Vec<CatalogEntryDto>, String> {
    let entries = catalog::list_versions(&http_client(), &cdn_cache_dir(), &region, &platform, refresh)
        .await
        .map_err(|e| e.to_string())?;
    Ok(entries
        .into_iter()
        .map(|e| CatalogEntryDto {
            path: e.path,
            kind: e.kind,
            patch: e.patch,
            build: e.build,
            version: e.version,
        })
        .collect())
}

/// Return which of the given catalog repo paths have their manifest already
/// downloaded to disk. Cache-only + filesystem check; never hits the network.
/// Drives the "Downloaded" badge in the load modal.
#[tauri::command]
pub async fn cdn_cached_versions(repo_paths: Vec<String>) -> Result<Vec<String>, String> {
    Ok(catalog::cached_versions(&cdn_cache_dir(), &manifest_dir(), &repo_paths))
}

// ── load manifest into a session ────────────────────────────────────────────

#[derive(Serialize)]
pub struct TreeNodeDto {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub file_index: Option<usize>,
    pub children: Vec<TreeNodeDto>,
}

fn tree_to_dto(node: &TreeNode, path_prefix: &str) -> TreeNodeDto {
    let path = if path_prefix.is_empty() {
        node.name.clone()
    } else if node.name.is_empty() {
        path_prefix.to_string()
    } else {
        format!("{path_prefix}/{}", node.name)
    };
    let mut children: Vec<TreeNodeDto> = node
        .children
        .values()
        .map(|c| tree_to_dto(c, &path))
        .collect();
    children.sort_by(|a, b| {
        // dirs first, then case-insensitive name
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    TreeNodeDto {
        name: node.name.clone(),
        path,
        size: node.total_size(),
        is_dir: node.is_dir(),
        file_index: node.file_index,
        children,
    }
}

#[derive(Serialize)]
pub struct CdnLoadResult {
    pub session_id: String,
    pub tree: TreeNodeDto,
    pub file_count: usize,
}

async fn load_manifest_from_url(url: &str, state: &State<'_, CdnSessionState>) -> Result<CdnLoadResult, String> {
    let file_name = url.split('/').next_back().unwrap_or("unknown.manifest");
    let dir = manifest_dir();
    let _ = std::fs::create_dir_all(&dir);
    let manifest_path = dir.join(file_name);

    let bytes: Vec<u8> = if manifest_path.exists() {
        std::fs::read(&manifest_path).map_err(|e| format!("failed to read cached manifest: {e}"))?
    } else {
        let b = http_client()
            .get(url)
            .send()
            .await
            .map_err(|e| format!("manifest request: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("manifest body: {e}"))?;
        let _ = std::fs::write(&manifest_path, &b);
        b.to_vec()
    };
    let manifest =
        flint_core::cdn::manifest::Manifest::from_bytes(&bytes).map_err(|e| e.to_string())?;
    let tree = tree_to_dto(&manifest.tree, "");
    let file_count = manifest.file_count();
    let session_id = state.insert(manifest);
    Ok(CdnLoadResult {
        session_id,
        tree,
        file_count,
    })
}

#[tauri::command]
pub async fn cdn_load_manifest(
    url: String,
    state: State<'_, CdnSessionState>,
) -> Result<CdnLoadResult, String> {
    load_manifest_from_url(&url, &state).await
}

/// Resolve a catalog repo path to its manifest URL (disk-cached) and load it.
/// This is the path the GitHub-catalog UI uses.
#[tauri::command]
pub async fn cdn_load_manifest_by_path(
    repo_path: String,
    state: State<'_, CdnSessionState>,
) -> Result<CdnLoadResult, String> {
    let url = catalog::resolve_manifest_url(&http_client(), &cdn_cache_dir(), &repo_path)
        .await
        .map_err(|e| e.to_string())?;
    load_manifest_from_url(&url, &state).await
}

// ── inner-name resolution (mirrors commands/wad/wad.rs) ──────────────────────

/// Resolve a batch of WAD inner-path hashes to names via the shared LMDB hash DB,
/// the same source the local WAD explorer uses (`get_hash_dir` + `get_env` +
/// `resolve_hashes_lmdb_bulk`). Unresolved hashes are simply absent from the map.
fn resolve_inner_names(hashes: &[u64], lmdb: &State<'_, LmdbCacheState>) -> HashMap<u64, String> {
    let hash_dir = flint_core::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let Some(env) = lmdb.get_env(&hash_dir) else {
        return HashMap::new();
    };
    let resolved = resolve_hashes_lmdb_bulk(hashes, &env);
    resolved.iter().map(|(h, s)| (h, s.to_string())).collect()
}

// ── browse a remote WAD ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CdnWadChunk {
    /// Hex "0x{:016x}" of the inner path hash.
    pub hash: String,
    /// Resolved inner path, or null if the hash is unknown.
    pub path: Option<String>,
    /// Uncompressed inner-file size in bytes.
    pub size: u64,
}

#[tauri::command]
pub async fn cdn_list_wad(
    session_id: String,
    file_index: usize,
    cdn: State<'_, CdnSessionState>,
    lmdb: State<'_, LmdbCacheState>,
) -> Result<Vec<CdnWadChunk>, String> {
    let manifest = cdn.get(&session_id).ok_or("cdn session not found")?;
    let chunks = manifest.file_chunks(file_index);
    let listing = wad_browse::list_wad_entries_from_chunks(&http_client(), &chunks)
        .await
        .map_err(|e| e.to_string())?;

    let hashes: Vec<u64> = listing.entries.iter().map(|e| e.path_hash).collect();
    let names = resolve_inner_names(&hashes, &lmdb);

    Ok(listing
        .entries
        .iter()
        .map(|e| CdnWadChunk {
            hash: format!("0x{:016x}", e.path_hash),
            path: names.get(&e.path_hash).cloned(),
            size: e.uncompressed_size as u64,
        })
        .collect())
}

// ── read one inner entry's decoded bytes (raw-bytes IPC) ─────────────────────

#[tauri::command]
pub async fn cdn_read_inner(
    request: tauri::ipc::Request<'_>,
    cdn: State<'_, CdnSessionState>,
    lmdb: State<'_, LmdbCacheState>,
) -> Result<tauri::ipc::Response, String> {
    let h = request.headers();
    let session_id = h
        .get("session-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing session-id")?
        .to_string();
    let file_index: usize = h
        .get("wad-file-index")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or("missing wad-file-index")?;
    let path_hash: u64 = {
        let raw = h
            .get("path-hash")
            .and_then(|v| v.to_str().ok())
            .ok_or("missing path-hash")?;
        let s = raw.strip_prefix("0x").unwrap_or(raw);
        u64::from_str_radix(s, 16).map_err(|e| format!("bad path-hash: {e}"))?
    };

    let manifest = cdn.get(&session_id).ok_or("cdn session not found")?;
    let chunks = manifest.file_chunks(file_index);
    let mut listing = wad_browse::list_wad_entries_from_chunks(&http_client(), &chunks)
        .await
        .map_err(|e| e.to_string())?;
    let hashes: Vec<u64> = listing.entries.iter().map(|e| e.path_hash).collect();
    listing.names = resolve_inner_names(&hashes, &lmdb);

    let entry = listing
        .entries
        .iter()
        .find(|e| e.path_hash == path_hash)
        .ok_or("inner entry not found")?
        .clone();
    let bytes = wad_browse::decode_inner_entry(&http_client(), &chunks, &listing, &entry)
        .await
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ── extract selected files to a folder ───────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CdnProgressDto {
    FileStart { path: String, size: u64 },
    FileDone { path: String, verified: bool },
    Note { message: String },
    FileError { path: String, error: String },
    AllDone { files: usize, errors: usize },
}

impl From<downloader::DownloadProgress> for CdnProgressDto {
    fn from(p: downloader::DownloadProgress) -> Self {
        use downloader::DownloadProgress as D;
        match p {
            D::FileStart { path, size } => CdnProgressDto::FileStart { path, size },
            D::FileDone { path, verified } => CdnProgressDto::FileDone { path, verified },
            D::Note(message) => CdnProgressDto::Note { message },
            D::FileError { path, error } => CdnProgressDto::FileError { path, error },
            D::AllDone { files, errors } => CdnProgressDto::AllDone { files, errors },
        }
    }
}

#[derive(Serialize)]
pub struct ExtractSummary {
    pub files: usize,
    pub errors: usize,
}

#[tauri::command]
pub async fn cdn_extract(
    app: tauri::AppHandle,
    session_id: String,
    file_indices: Vec<usize>,
    out_dir: String,
    cdn: State<'_, CdnSessionState>,
) -> Result<ExtractSummary, String> {
    let manifest = cdn.get(&session_id).ok_or("cdn session not found")?;
    let plan = downloader::plan_download(&manifest, &file_indices);
    let total = plan.files.len();
    let cancel = Arc::new(AtomicBool::new(false));

    let errors = downloader::download_plan(
        &http_client(),
        plan,
        std::path::PathBuf::from(&out_dir),
        |p| {
            let _ = app.emit("cdn-extract-progress", CdnProgressDto::from(p));
        },
        cancel,
    )
    .await;

    Ok(ExtractSummary {
        files: total,
        errors,
    })
}

// ── unpack a whole WAD's inner files into a folder ───────────────────────────

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CdnUnpackDto {
    Start { total: usize },
    Entry { done: usize, total: usize, name: String },
    EntryError { name: String, error: String },
}

impl From<wad_browse::UnpackProgress> for CdnUnpackDto {
    fn from(p: wad_browse::UnpackProgress) -> Self {
        use wad_browse::UnpackProgress as U;
        match p {
            U::Start { total } => CdnUnpackDto::Start { total },
            U::Entry { done, total, name } => CdnUnpackDto::Entry { done, total, name },
            U::EntryError { name, error } => CdnUnpackDto::EntryError { name, error },
        }
    }
}

/// Unpack EVERY inner file of a CDN WAD into `out_dir/<wad-file-name>/…`.
#[tauri::command]
pub async fn cdn_extract_wad_unpacked(
    app: tauri::AppHandle,
    session_id: String,
    file_index: usize,
    out_dir: String,
    cdn: State<'_, CdnSessionState>,
    lmdb: State<'_, LmdbCacheState>,
) -> Result<ExtractSummary, String> {
    let manifest = cdn.get(&session_id).ok_or("cdn session not found")?;
    let chunks = manifest.file_chunks(file_index);

    // Resolve inner names once so unpacked files land at their real paths.
    let listing = wad_browse::list_wad_entries_from_chunks(&http_client(), &chunks)
        .await
        .map_err(|e| e.to_string())?;
    let hashes: Vec<u64> = listing.entries.iter().map(|e| e.path_hash).collect();
    let names = resolve_inner_names(&hashes, &lmdb);

    // Unpack into a subfolder named after the WAD file (e.g. Aatrox.wad.client).
    let wad_rel = manifest
        .paths()
        .get(file_index)
        .map(|(p, _)| p.clone())
        .unwrap_or_default();
    let wad_name = wad_rel.rsplit(['/', '\\']).next().unwrap_or("wad").to_string();
    let dest_root = std::path::PathBuf::from(&out_dir).join(&wad_name);

    let (ok, errors) = wad_browse::unpack_wad_to_dir(
        &http_client(),
        &chunks,
        &names,
        &dest_root,
        |p| {
            let _ = app.emit("cdn-unpack-progress", CdnUnpackDto::from(p));
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(ExtractSummary {
        files: ok + errors,
        errors,
    })
}

// ── download the raw .wad.client file itself ─────────────────────────────────

/// Download the raw `.wad.client` bytes for one manifest WAD to `out_path`,
/// streaming per-chunk so memory stays flat.
#[tauri::command]
pub async fn cdn_download_wad_raw(
    app: tauri::AppHandle,
    session_id: String,
    file_index: usize,
    out_path: String,
    cdn: State<'_, CdnSessionState>,
) -> Result<u64, String> {
    let manifest = cdn.get(&session_id).ok_or("cdn session not found")?;
    let plan = downloader::plan_download(&manifest, &[file_index]);
    let file = plan.files.first().ok_or("file index not in manifest")?.clone();

    let written = downloader::stream_file_to_path(
        &http_client(),
        &file,
        std::path::Path::new(&out_path),
        |p| {
            let _ = app.emit("cdn-extract-progress", CdnProgressDto::from(p));
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(written)
}

#[tauri::command]
pub async fn cdn_close_session(
    session_id: String,
    cdn: State<'_, CdnSessionState>,
) -> Result<bool, String> {
    Ok(cdn.remove(&session_id))
}
