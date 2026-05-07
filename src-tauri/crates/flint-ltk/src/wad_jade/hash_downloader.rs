//! Download + decompress `lol-hashes-combined.zst` into the FrogTools
//! hash directory shared with Quartz.
//!
//! Detection is layout-aware: if Quartz's split layout
//! (`hashes-wad.lmdb` + `hashes-bin.lmdb`) is already populated in
//! `%APPDATA%/FrogTools/hashes`, we keep using it and skip the download —
//! both layouts contain identical named-DB content. Only when neither
//! layout is present (or `force == true`) do we hit GitHub.

use crate::wad_jade::lmdb_hashes::unload_envs;
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::Path;
use tauri::Emitter;

const COMBINED_URL: &str =
    "https://github.com/LeagueToolkit/lmdb-hashes/releases/latest/download/lol-hashes-combined.zst";
const RELEASE_API_URL: &str =
    "https://api.github.com/repos/LeagueToolkit/lmdb-hashes/releases/latest";
const COMBINED_LMDB_DIR: &str = "hashes-combined.lmdb";
const SPLIT_WAD_DIR: &str = "hashes-wad.lmdb";
const SPLIT_BIN_DIR: &str = "hashes-bin.lmdb";
const META_FILE_NAME: &str = "hashes-meta.json";

/// Subset of `hashes-meta.json` we care about. Quartz writes the same
/// shape and we deliberately leave unknown fields untouched on rewrite,
/// so the two tools stay interoperable.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct HashesMeta {
    #[serde(rename = "releaseTag", skip_serializing_if = "Option::is_none")]
    release_tag: Option<String>,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    #[serde(rename = "lastCheckedAt", skip_serializing_if = "Option::is_none")]
    last_checked_at: Option<String>,
    /// Captures any extra fields Quartz/other tools wrote so we round-trip
    /// without nuking their state.
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

fn meta_path(hash_dir: &Path) -> std::path::PathBuf {
    hash_dir.join(META_FILE_NAME)
}

fn read_meta(hash_dir: &Path) -> HashesMeta {
    let path = meta_path(hash_dir);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return HashesMeta::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn write_meta(hash_dir: &Path, meta: &HashesMeta) {
    let path = meta_path(hash_dir);
    if let Ok(json) = serde_json::to_string_pretty(meta) {
        let _ = std::fs::write(&path, json);
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: Option<String>,
}

/// Result of comparing the local `releaseTag` against the latest GitHub
/// release. Cheap — one HTTPS call.
#[derive(Debug, Clone, Serialize)]
pub struct HashUpdateStatus {
    pub up_to_date: bool,
    pub current_tag: String,
    pub latest_tag: String,
    /// `true` iff at least one supported on-disk layout is populated.
    pub layout_present: bool,
}

/// Fetch the latest release tag from `lmdb-hashes` and compare with the
/// tag stored in our local `hashes-meta.json`. The "every-launch" auto-
/// update mode runs this and only triggers a download when the tags
/// differ — same fingerprint pattern Quartz uses.
pub async fn check_for_hash_update(hash_dir: &Path) -> Result<HashUpdateStatus> {
    let meta = read_meta(hash_dir);
    let current_tag = meta.release_tag.clone().unwrap_or_default();

    let client = reqwest::Client::builder()
        .user_agent("Jade-WadHashes/1.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(Error::Network)?;

    let resp = client
        .get(RELEASE_API_URL)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(Error::Network)?;

    if !resp.status().is_success() {
        return Err(Error::Hash(format!(
            "GitHub releases API failed: HTTP {}",
            resp.status()
        )));
    }

    let release: GitHubRelease = resp.json().await.map_err(Error::Network)?;
    let latest_tag = release.tag_name.unwrap_or_default();

    let layout_present = hashes_present(hash_dir);
    let up_to_date = layout_present
        && !latest_tag.is_empty()
        && !current_tag.is_empty()
        && latest_tag == current_tag;

    // Persist the check timestamp so the UI can show "last checked" without
    // forcing a second round-trip.
    let mut updated_meta = meta;
    updated_meta.last_checked_at = Some(now_iso());
    write_meta(hash_dir, &updated_meta);

    Ok(HashUpdateStatus {
        up_to_date,
        current_tag,
        latest_tag,
        layout_present,
    })
}

/// Which layout (if any) is currently on disk in the FrogTools hash dir.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashLayout {
    /// `hashes-wad.lmdb/data.mdb` AND `hashes-bin.lmdb/data.mdb` exist.
    /// What Quartz writes — Jade reuses without downloading.
    Split,
    /// `hashes-combined.lmdb/data.mdb` exists. What `lol-hashes-combined.zst`
    /// decompresses to.
    Combined,
    /// Neither layout has the required `data.mdb` file(s).
    Missing,
}

impl HashLayout {
    pub fn as_str(self) -> &'static str {
        match self {
            HashLayout::Split => "split",
            HashLayout::Combined => "combined",
            HashLayout::Missing => "missing",
        }
    }
}

pub fn detect_layout(hash_dir: &Path) -> HashLayout {
    let split_wad = hash_dir.join(SPLIT_WAD_DIR).join("data.mdb");
    let split_bin = hash_dir.join(SPLIT_BIN_DIR).join("data.mdb");
    if split_wad.exists() && split_bin.exists() {
        return HashLayout::Split;
    }
    if hash_dir.join(COMBINED_LMDB_DIR).join("data.mdb").exists() {
        return HashLayout::Combined;
    }
    HashLayout::Missing
}

/// `true` when at least one supported layout is populated on disk.
pub fn hashes_present(hash_dir: &Path) -> bool {
    !matches!(detect_layout(hash_dir), HashLayout::Missing)
}

#[derive(Clone, Serialize)]
pub struct HashDownloadProgress {
    /// "checking" | "downloading" | "decompressing" | "complete" | "error"
    pub phase: String,
    pub message: String,
    pub downloaded: u64,
    pub total: u64,
}

fn emit_progress(app: &tauri::AppHandle<tauri::Wry>, phase: &str, msg: &str, downloaded: u64, total: u64) {
    let _ = app.emit(
        "wad-hash-download-progress",
        HashDownloadProgress {
            phase: phase.to_string(),
            message: msg.to_string(),
            downloaded,
            total,
        },
    );
}

/// Download `lol-hashes-combined.zst` into the FrogTools dir, decompress
/// it to `hashes-combined.lmdb/data.mdb`, and return the resulting layout.
/// Skips the download when a layout is already present unless `force`.
pub async fn download_combined_hashes(
    app: &tauri::AppHandle<tauri::Wry>,
    hash_dir: &Path,
    force: bool,
) -> Result<HashLayout> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    std::fs::create_dir_all(hash_dir).map_err(|e| Error::io_with_path(e, hash_dir))?;

    if !force {
        let layout = detect_layout(hash_dir);
        if layout != HashLayout::Missing {
            emit_progress(app, "complete", "Hashes already present", 0, 0);
            return Ok(layout);
        }
    }

    emit_progress(app, "downloading", "Downloading WAD+BIN hashes...", 0, 0);

    // Resolve the release tag we're about to fetch in the same shot, so
    // we can stamp it into hashes-meta.json after a successful download
    // and let future fingerprint checks short-circuit. Falls back to "" if
    // the API hiccups — the download still proceeds on the static URL.
    let client = reqwest::Client::builder()
        .user_agent("Jade-WadHashes/1.0")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(Error::Network)?;

    let release_tag = match client
        .get(RELEASE_API_URL)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r
            .json::<GitHubRelease>()
            .await
            .ok()
            .and_then(|j| j.tag_name)
            .unwrap_or_default(),
        _ => String::new(),
    };

    let resp = client.get(COMBINED_URL).send().await.map_err(Error::Network)?;
    if !resp.status().is_success() {
        let msg = format!("Download failed: HTTP {}", resp.status());
        emit_progress(app, "error", &msg, 0, 0);
        return Err(Error::Hash(msg));
    }

    let total = resp.content_length().unwrap_or(0);
    let lmdb_dir = hash_dir.join(COMBINED_LMDB_DIR);
    std::fs::create_dir_all(&lmdb_dir).map_err(|e| Error::io_with_path(e, &lmdb_dir))?;
    let zst_path = lmdb_dir.join("data.mdb.zst");

    let mut downloaded: u64 = 0;
    {
        let mut file = tokio::fs::File::create(&zst_path)
            .await
            .map_err(|e| Error::io_with_path(e, &zst_path))?;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(Error::Network)?;
            downloaded += chunk.len() as u64;
            file.write_all(&chunk)
                .await
                .map_err(|e| Error::io_with_path(e, &zst_path))?;
            emit_progress(app, "downloading", "Downloading hashes...", downloaded, total);
        }
        file.flush()
            .await
            .map_err(|e| Error::io_with_path(e, &zst_path))?;
    }

    emit_progress(app, "decompressing", "Decompressing...", downloaded, total);

    // Drop any cached envs before we overwrite data.mdb. Windows refuses
    // to replace a memory-mapped file held open by this process.
    unload_envs();

    let zst_path_owned = zst_path.clone();
    let lmdb_dir_owned = lmdb_dir.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let bytes = std::fs::read(&zst_path_owned)
            .map_err(|e| Error::io_with_path(e, &zst_path_owned))?;
        let decompressed = zstd::stream::decode_all(Cursor::new(bytes))
            .map_err(|e| Error::Hash(format!("Zstd decode failed: {}", e)))?;

        let tmp = lmdb_dir_owned.join("data.mdb.tmp");
        std::fs::write(&tmp, &decompressed).map_err(|e| Error::io_with_path(e, &tmp))?;

        // Drop any stale lock file so the next env open starts clean.
        let _ = std::fs::remove_file(lmdb_dir_owned.join("lock.mdb"));

        let final_path = lmdb_dir_owned.join("data.mdb");
        std::fs::rename(&tmp, &final_path).map_err(|e| Error::io_with_path(e, &final_path))?;
        let _ = std::fs::remove_file(&zst_path_owned);
        Ok(())
    })
    .await
    .map_err(|e| Error::Hash(format!("Decompress task failed: {}", e)))??;

    // Record the new tag + timestamps so the every-launch fingerprint check
    // skips re-download on the next start.
    let mut meta = read_meta(hash_dir);
    if !release_tag.is_empty() {
        meta.release_tag = Some(release_tag);
    }
    let now = now_iso();
    meta.updated_at = Some(now.clone());
    meta.last_checked_at = Some(now);
    write_meta(hash_dir, &meta);

    emit_progress(app, "complete", "Hashes ready", downloaded, total);
    Ok(HashLayout::Combined)
}
