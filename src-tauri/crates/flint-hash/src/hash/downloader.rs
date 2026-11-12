//! Hash database downloader.
//!
//! Downloads pre-built LMDB databases from `lmdb-hashes` GitHub releases.
//!
//! Two separate LMDBs:
//! - `hashes-wad.lmdb` — 64-bit xxh64 WAD path hashes (named DB `"wad"`)
//! - `hashes-bin.lmdb` — 32-bit FNV1a BIN hashes (named DBs `"binentries"`, `"bintypes"`, `"binfields"`, `"binhashes"`)
//!
//! Hash dir: `%APPDATA%/RitoShark/Requirements/Hashes/`.

use crate::error::{Error, Result};
use reqwest::{header::ACCEPT, Client};
use serde::{Deserialize, Serialize};
use std::error::Error as _;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::fs;
use tokio::io::AsyncWriteExt;

const RELEASES_LIST_API_URL: &str =
    "https://api.github.com/repos/RitoShark/lmdb-hashes/releases?per_page=10";
const RELEASE_API_URL: &str =
    "https://api.github.com/repos/RitoShark/lmdb-hashes/releases/latest";
const META_FILE_NAME: &str = "hashes-meta.json";
const USER_AGENT: &str = "flint-hash-manager";

static UPDATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

struct Asset {
    db_names: &'static [&'static str],
    legacy_db_names: &'static [&'static str],
    release_name: &'static str,
    legacy_release_name: &'static str,
    lmdb_dir: &'static str,
    label: &'static str,
}

const ASSETS: &[Asset] = &[
    Asset {
        db_names: &["wad"],
        legacy_db_names: &["wad"],
        release_name: "lol-hashes-v2-wad.zst",
        legacy_release_name: "lol-hashes-wad.zst",
        lmdb_dir: "hashes-wad.lmdb",
        label: "WAD hashes",
    },
    Asset {
        db_names: &crate::hash::lmdb_cache::BIN_V2_TABLES,
        legacy_db_names: &["bin"],
        release_name: "lol-hashes-v2-bin.zst",
        legacy_release_name: "lol-hashes-bin.zst",
        lmdb_dir: "hashes-bin.lmdb",
        label: "BIN hashes",
    },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadStats {
    pub downloaded: usize,
    pub skipped: usize,
    pub errors: usize,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: Option<String>,
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    url: String,
    browser_download_url: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct HashesMeta {
    #[serde(rename = "releaseTag", skip_serializing_if = "Option::is_none")]
    release_tag: Option<String>,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    #[serde(rename = "lastCheckedAt", skip_serializing_if = "Option::is_none")]
    last_checked_at: Option<String>,
}

pub fn get_hash_dir() -> Result<PathBuf> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| Error::Hash("APPDATA environment variable not found".to_string()))?;

    Ok(PathBuf::from(appdata).join("RitoShark").join("Requirements").join("Hashes"))
}

pub fn get_ritoshark_hash_dir() -> Result<PathBuf> {
    get_hash_dir()
}

pub fn hashes_present(hash_dir: &Path) -> bool {
    ASSETS.iter().all(|a| hash_dir.join(a.lmdb_dir).join("data.mdb").exists())
}

fn release_has_v2_assets(release: &GitHubRelease) -> bool {
    ASSETS
        .iter()
        .all(|asset| release.assets.iter().any(|a| a.name == asset.release_name))
}

fn release_has_legacy_assets(release: &GitHubRelease) -> bool {
    ASSETS
        .iter()
        .all(|asset| release.assets.iter().any(|a| a.name == asset.legacy_release_name))
}

fn select_preferred_release(releases: Vec<GitHubRelease>) -> Option<GitHubRelease> {
    if let Some(idx) = releases.iter().position(release_has_v2_assets) {
        return releases.into_iter().nth(idx);
    }
    releases.into_iter().find(release_has_legacy_assets)
}

pub async fn download_hashes(output_dir: impl AsRef<Path>, force: bool) -> Result<DownloadStats> {
    download_hashes_inner(output_dir.as_ref(), force, force).await
}

pub async fn check_hashes_now(output_dir: impl AsRef<Path>) -> Result<DownloadStats> {
    download_hashes_inner(output_dir.as_ref(), false, true).await
}

async fn download_hashes_inner(
    output_dir: &Path,
    force: bool,
    skip_interval: bool,
) -> Result<DownloadStats> {
    let _update = UPDATE_LOCK.lock().await;
    tracing::debug!("Hash dir: {}", output_dir.display());
    fs::create_dir_all(output_dir).await.map_err(|e| {
        tracing::error!("Failed to create hash dir '{}': {}", output_dir.display(), e);
        e
    })?;

    for asset in ASSETS {
        let tmp = output_dir.join(asset.lmdb_dir).join("data.mdb.tmp");
        if tmp.exists() {
            tracing::info!("Removing stale {}", tmp.display());
            let _ = fs::remove_file(&tmp).await;
        }
    }

    let mut stats = DownloadStats { downloaded: 0, skipped: 0, errors: 0 };

    let installed_v2 = output_dir
        .to_str()
        .and_then(crate::hash::lmdb_cache::get_bin_env)
        .is_some_and(|env| crate::hash::lmdb_cache::has_v2_bin_tables(&env));

    if !skip_interval && hashes_present(output_dir) && installed_v2 {
        let meta = read_meta(output_dir).await;
        if let Some(age) = meta.last_checked_at.as_deref().and_then(age_since) {
            if age < CHECK_INTERVAL {
                tracing::info!(
                    "Hash databases present and checked {}h ago — skipping check",
                    age.as_secs() / 3600
                );
                stats.skipped = ASSETS.len();
                return Ok(stats);
            }
        }
    }

    let client = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(Error::Network)?;

    let release = fetch_latest_release(&client).await?;
    let latest_tag = release.tag_name.clone().unwrap_or_default();

    let mut meta = read_meta(output_dir).await;
    let stored_tag = meta.release_tag.clone().unwrap_or_default();
    let mut staged = Vec::new();

    for asset in ASSETS {
        let lmdb_dir = output_dir.join(asset.lmdb_dir);
        let data_mdb = lmdb_dir.join("data.mdb");

        let (release_asset, db_names) = if let Some(a) = release
            .assets
            .iter()
            .find(|a| a.name == asset.release_name)
        {
            (a, asset.db_names)
        } else if let Some(a) = release
            .assets
            .iter()
            .find(|a| a.name == asset.legacy_release_name)
        {
            (a, asset.legacy_db_names)
        } else {
            tracing::error!("Asset {} missing from release", asset.release_name);
            stats.errors += 1;
            continue;
        };

        let schema_matches = asset.lmdb_dir != "hashes-bin.lmdb"
            || (db_names == crate::hash::lmdb_cache::BIN_V2_TABLES) == installed_v2;

        if !force
            && data_mdb.exists()
            && schema_matches
            && !latest_tag.is_empty()
            && latest_tag == stored_tag
        {
            tracing::debug!("{} up-to-date (tag {})", asset.label, latest_tag);
            stats.skipped += 1;
            continue;
        }

        match download_and_stage(&client, release_asset, &lmdb_dir).await {
            Ok(tmp_path) => {
                tracing::info!("Staged {} (tag {})", asset.label, latest_tag);
                staged.push((asset, db_names, tmp_path));
            }
            Err(e) => {
                tracing::error!("Failed to download {}: {}", asset.label, e);
                stats.errors += 1;
            }
        }
    }

    if stats.errors == 0 && !staged.is_empty() {
        for (asset, db_names, tmp_path) in &staged {
            let lmdb_dir = output_dir.join(asset.lmdb_dir);
            let source = tmp_path.clone();
            let names = *db_names;
            let label = asset.label;
            let installed = tokio::task::spawn_blocking(move || {
                crate::hash::lmdb_cache::install_databases(&source, &lmdb_dir, names)
                    .map_err(|e| Error::Hash(format!("Failed to install {}: {}", label, e)))
            })
            .await
            .map_err(|e| Error::Hash(format!("Hash install task failed: {}", e)))?;
            match installed {
                Ok(()) => {
                    let _ = fs::remove_file(tmp_path).await;
                    tracing::info!("Installed {} (tag {})", asset.label, latest_tag);
                    stats.downloaded += 1;
                }
                Err(e) => {
                    tracing::error!("Failed to install {}: {}", asset.label, e);
                    stats.errors += 1;
                    break;
                }
            }
        }
    }

    if stats.errors > 0 {
        for (_, _, tmp_path) in &staged {
            let _ = fs::remove_file(tmp_path).await;
        }
    }

    if !latest_tag.is_empty() && stats.errors == 0 {
        meta.release_tag = Some(latest_tag);
        meta.updated_at = Some(now_iso());

        crate::hash::bin_dict::reload_bin_hash_cache();
        tracing::info!("BIN hash cache reloaded after successful download");
    }
    if stats.errors == 0 {
        meta.last_checked_at = Some(now_iso());
    }
    write_meta(output_dir, &meta).await;

    tracing::info!(
        "Hash download complete: {} downloaded, {} skipped, {} errors",
        stats.downloaded, stats.skipped, stats.errors
    );

    if stats.errors > 0 {
        return Err(Error::Hash(format!(
            "{} of {} hash databases failed to update (see log for details)",
            stats.errors,
            ASSETS.len(),
        )));
    }

    Ok(stats)
}

async fn fetch_latest_release(client: &Client) -> Result<GitHubRelease> {
    if let Ok(list_resp) = client
        .get(RELEASES_LIST_API_URL)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
    {
        if list_resp.status().is_success() {
            if let Ok(releases) = list_resp.json::<Vec<GitHubRelease>>().await {
                if let Some(selected) = select_preferred_release(releases) {
                    return Ok(selected);
                }
            }
        }
    }

    let response = client
        .get(RELEASE_API_URL)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(Error::Network)?;

    if !response.status().is_success() {
        return Err(Error::Hash(format!(
            "GitHub releases API failed: HTTP {}",
            response.status()
        )));
    }

    response.json::<GitHubRelease>().await.map_err(Error::Network)
}

fn network_error_message(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

async fn download_asset(client: &Client, release_asset: &GitHubReleaseAsset) -> Result<Vec<u8>> {
    const ATTEMPTS: usize = 4;
    let sources = [
        ("GitHub API", release_asset.url.as_str(), true),
        (
            "GitHub release URL",
            release_asset.browser_download_url.as_str(),
            false,
        ),
    ];
    let mut last_error = String::new();

    for attempt in 0..ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(250 * (1 << (attempt - 1)))).await;
        }

        let (source, url, use_api_accept) = sources[attempt % sources.len()];
        let mut request = client.get(url);
        if use_api_accept {
            request = request.header(ACCEPT, "application/octet-stream");
        }

        match request.send().await {
            Ok(response) if response.status().is_success() => match response.bytes().await {
                Ok(bytes) => return Ok(bytes.to_vec()),
                Err(e) => last_error = network_error_message(&e),
            },
            Ok(response) => {
                last_error = format!("HTTP {}", response.status());
            }
            Err(e) => last_error = network_error_message(&e),
        }

        tracing::warn!(
            "{} download attempt {}/{} via {} failed: {}",
            release_asset.name,
            attempt + 1,
            ATTEMPTS,
            source,
            last_error
        );
    }

    Err(Error::Hash(format!(
        "Download {} failed after {} attempts: {}",
        release_asset.name, ATTEMPTS, last_error
    )))
}

async fn download_and_stage(
    client: &Client,
    release_asset: &GitHubReleaseAsset,
    lmdb_dir: &Path,
) -> Result<PathBuf> {
    fs::create_dir_all(lmdb_dir).await?;
    let compressed = download_asset(client, release_asset).await?;

    let decompressed = tokio::task::spawn_blocking(move || {
        zstd::stream::decode_all(Cursor::new(compressed))
    })
    .await
    .map_err(|e| Error::Hash(format!("Zstd task join failed: {}", e)))?
    .map_err(|e| Error::Hash(format!("Zstd decode failed: {}", e)))?;

    let tmp_path = lmdb_dir.join("data.mdb.tmp");

    let mut f = fs::File::create(&tmp_path).await?;
    f.write_all(&decompressed).await?;
    f.flush().await?;
    drop(f);
    Ok(tmp_path)
}

async fn read_meta(hash_dir: &Path) -> HashesMeta {
    let path = hash_dir.join(META_FILE_NAME);
    let Ok(data) = fs::read_to_string(&path).await else {
        return HashesMeta::default();
    };
    serde_json::from_str(&data).unwrap_or_default()
}

async fn write_meta(hash_dir: &Path, meta: &HashesMeta) {
    let path = hash_dir.join(META_FILE_NAME);
    if let Ok(json) = serde_json::to_string_pretty(meta) {
        if let Err(e) = fs::write(&path, json).await {
            tracing::warn!("Failed to write {}: {}", META_FILE_NAME, e);
        }
    }
}

fn age_since(ts: &str) -> Option<Duration> {
    let then = chrono::DateTime::parse_from_rfc3339(ts).ok()?;
    chrono::Utc::now()
        .signed_duration_since(then.with_timezone(&chrono::Utc))
        .to_std()
        .ok()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_download_stats_creation() {
        let stats = DownloadStats { downloaded: 5, skipped: 2, errors: 1 };
        assert_eq!(stats.downloaded, 5);
        assert_eq!(stats.skipped, 2);
        assert_eq!(stats.errors, 1);
    }

    #[test]
    fn prefers_v2_release_over_older_stable_release() {
        let legacy = GitHubRelease {
            tag_name: Some("hashes-legacy".to_string()),
            assets: vec![
                GitHubReleaseAsset {
                    name: "lol-hashes-wad.zst".to_string(),
                    url: String::new(),
                    browser_download_url: String::new(),
                },
                GitHubReleaseAsset {
                    name: "lol-hashes-bin.zst".to_string(),
                    url: String::new(),
                    browser_download_url: String::new(),
                },
            ],
        };
        let v2 = GitHubRelease {
            tag_name: Some("hashes-v2-abcdef".to_string()),
            assets: vec![
                GitHubReleaseAsset {
                    name: "lol-hashes-v2-wad.zst".to_string(),
                    url: String::new(),
                    browser_download_url: String::new(),
                },
                GitHubReleaseAsset {
                    name: "lol-hashes-v2-bin.zst".to_string(),
                    url: String::new(),
                    browser_download_url: String::new(),
                },
            ],
        };
        let chosen = select_preferred_release(vec![legacy, v2]).unwrap();
        assert_eq!(chosen.tag_name.as_deref(), Some("hashes-v2-abcdef"));
    }

    #[test]
    fn stale_check_timestamp_does_not_suppress_the_release_check() {
        let stale = chrono::Utc::now() - chrono::Duration::hours(7);
        let age = age_since(&stale.to_rfc3339()).expect("parseable");
        assert!(age > CHECK_INTERVAL, "a 7h-old check must re-verify the tag");
    }

    #[test]
    fn recent_check_timestamp_skips_the_release_check() {
        let recent = chrono::Utc::now() - chrono::Duration::minutes(30);
        let age = age_since(&recent.to_rfc3339()).expect("parseable");
        assert!(age < CHECK_INTERVAL, "a 30m-old check should skip the network");
    }

    #[test]
    fn unparseable_or_future_timestamp_forces_a_check() {
        assert!(age_since("not a timestamp").is_none());
        let future = chrono::Utc::now() + chrono::Duration::hours(2);
        assert!(age_since(&future.to_rfc3339()).is_none(), "clock skew must not skip");
    }

    #[test]
    fn test_get_hash_dir() {
        if std::env::var("APPDATA").is_ok() {
            let path = get_hash_dir().unwrap();
            let s = path.to_string_lossy();
            assert!(s.contains("RitoShark"));
            assert!(s.contains("Hashes"));
        }
    }

    #[tokio::test]
    #[ignore]
    async fn github_bin_asset_downloads_and_decompresses() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = std::env::temp_dir().join(format!(
            "flint-bin-hash-download-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap();
        let release = fetch_latest_release(&client).await.unwrap();
        let asset = release
            .assets
            .iter()
            .find(|asset| {
                asset.name == "lol-hashes-v2-bin.zst" || asset.name == "lol-hashes-bin.zst"
            })
            .unwrap();
        let staged = download_and_stage(&client, asset, &dir).await.unwrap();
        assert!(fs::metadata(&staged).await.unwrap().len() > 1_000_000);
        fs::remove_dir_all(&dir).await.unwrap();
    }
}
