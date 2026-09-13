//! Cached metadata refresh shared by default editor checks and project audits.
use flint_core::bin::meta_schema::{self, Schema};
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};
use tauri::Manager;

const RELEASE: &str = "https://api.github.com/repos/LeagueToolkit/lol-meta-classes/releases/latest";
const MAX_BYTES: usize = 64 * 1024 * 1024;
const REFRESH: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(serde::Deserialize)]
struct Release {
    assets: Vec<Asset>,
}
#[derive(serde::Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

async fn fetch(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("Metadata response too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > limit {
            return Err("Metadata response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub async fn refresh(app: &tauri::AppHandle) {
    static LAST: OnceLock<tokio::sync::Mutex<Option<Instant>>> = OnceLock::new();
    let mut last = LAST
        .get_or_init(|| tokio::sync::Mutex::new(None))
        .lock()
        .await;
    if last.is_some_and(|t| t.elapsed() < REFRESH) {
        return;
    }
    // Throttle failed attempts too; offline editing must not repeatedly wait for HTTP.
    *last = Some(Instant::now());
    let result = async {
        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("class-metadata");
        let path = dir.join("dump.json");
        if meta_schema::current().is_none() {
            if let Ok(bytes) = tokio::fs::read(&path).await {
                if bytes.len() <= MAX_BYTES {
                    if let Ok(schema) = Schema::parse(&bytes) {
                        meta_schema::install(schema);
                    }
                }
            }
        }
        // Reuse a recent disk cache across app restarts.
        if meta_schema::current().is_some()
            && tokio::fs::metadata(&path)
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age < REFRESH)
        {
            return Ok::<(), String>(());
        }
        let client = reqwest::Client::builder()
            .user_agent("Flint-class-metadata")
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        let release: Release = serde_json::from_slice(&fetch(&client, RELEASE, 1024 * 1024).await?)
            .map_err(|e| e.to_string())?;
        let asset = release
            .assets
            .into_iter()
            .find(|a| a.name.ends_with(".json"))
            .ok_or("LeagueToolkit release has no JSON dump")?;
        if !asset
            .browser_download_url
            .starts_with("https://github.com/LeagueToolkit/lol-meta-classes/releases/download/")
        {
            return Err("Unexpected metadata download URL".into());
        }
        let bytes = fetch(&client, &asset.browser_download_url, MAX_BYTES).await?;
        let schema = Schema::parse(&bytes)?;
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| e.to_string())?;
        let temporary = dir.join("dump.new.json");
        tokio::fs::write(&temporary, &bytes)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::rename(&temporary, &path)
            .await
            .map_err(|e| e.to_string())?;
        meta_schema::install(schema);
        Ok(())
    }
    .await;
    if let Err(error) = result {
        tracing::warn!(%error, "Class metadata refresh unavailable; retaining cached metadata and bundled migration checks");
    }
}
