//! Layout detection and update checks for the on-disk hash dictionaries.
//!
//! Two layouts are recognised: combined (`hashes-combined.lmdb`) and split
//! (`hashes-wad.lmdb` + `hashes-bin.lmdb`). The installed release tag is
//! stamped into `hashes-meta.json` and compared against the latest release.

use flint_hash::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

const RELEASE_API_URL: &str =
    "https://api.github.com/repos/LeagueToolkit/lmdb-hashes/releases/latest";
const COMBINED_LMDB_DIR: &str = "hashes-combined.lmdb";
const SPLIT_WAD_DIR: &str = "hashes-wad.lmdb";
const SPLIT_BIN_DIR: &str = "hashes-bin.lmdb";
const META_FILE_NAME: &str = "hashes-meta.json";

/// Subset of `hashes-meta.json`. Unknown fields are preserved on rewrite
/// (via `extra`) so other tools' state stays intact.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct HashesMeta {
    #[serde(rename = "releaseTag", skip_serializing_if = "Option::is_none")]
    release_tag: Option<String>,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    #[serde(rename = "lastCheckedAt", skip_serializing_if = "Option::is_none")]
    last_checked_at: Option<String>,
    /// Captures any extra fields other tools wrote, to round-trip them.
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

/// Fetch the latest release tag from `lmdb-hashes` and compare with the tag
/// stored in the local `hashes-meta.json`.
pub async fn check_for_hash_update(hash_dir: &Path) -> Result<HashUpdateStatus> {
    let meta = read_meta(hash_dir);
    let current_tag = meta.release_tag.clone().unwrap_or_default();

    let client = reqwest::Client::builder()
        .user_agent("Flint-WadHashes/1.0")
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
    Split,
    /// `hashes-combined.lmdb/data.mdb` exists (what `lol-hashes-combined.zst`
    /// decompresses to).
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

