use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;

const GITHUB_OWNER: &str = "DexalGT";
const GITHUB_REPO: &str = "Flint";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub release_notes: String,
    pub download_url: String,
    pub published_at: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    body: Option<String>,
    published_at: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[tauri::command]
pub fn get_current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    let current_version = get_current_version();
    
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        GITHUB_OWNER, GITHUB_REPO
    );
    
    let response = client
        .get(&url)
        .header("User-Agent", format!("Flint/{}", current_version))
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {}", e))?;
    
    if response.status() == 404 {
        return Ok(UpdateInfo {
            available: false,
            current_version: current_version.clone(),
            latest_version: current_version,
            release_notes: String::new(),
            download_url: String::new(),
            published_at: String::new(),
        });
    }
    
    if !response.status().is_success() {
        return Err(format!("GitHub API error: {}", response.status()));
    }
    
    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse release: {}", e))?;
    
    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    
    let download_url = release
        .assets
        .iter()
        .find(|asset| {
            let name = asset.name.to_lowercase();
            name.ends_with(".exe") && (name.contains("windows") || name.contains("setup") || name.contains("installer"))
        })
        .or_else(|| {
            release.assets.iter().find(|asset| asset.name.to_lowercase().ends_with(".exe"))
        })
        .map(|asset| asset.browser_download_url.clone())
        .unwrap_or_default();
    
    let update_available = match (
        semver::Version::parse(&current_version),
        semver::Version::parse(&latest_version),
    ) {
        (Ok(current), Ok(latest)) => latest > current,
        _ => latest_version != current_version,
    };
    
    Ok(UpdateInfo {
        available: update_available,
        current_version,
        latest_version,
        release_notes: release.body.unwrap_or_default(),
        download_url,
        published_at: release.published_at,
    })
}

#[tauri::command]
pub async fn download_and_install_update(
    app: AppHandle,
    download_url: String,
) -> Result<(), String> {
    if download_url.is_empty() {
        return Err("No download URL provided".to_string());
    }
    
    tracing::info!("Downloading update from: {}", download_url);
    
    let client = reqwest::Client::new();
    let response = client
        .get(&download_url)
        .header("User-Agent", format!("Flint/{}", get_current_version()))
        .send()
        .await
        .map_err(|e| format!("Failed to download update: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Download failed: {}", response.status()));
    }
    
    let filename = download_url
        .split('/')
        .last()
        .unwrap_or("flint-update.exe")
        .to_string();
    
    let temp_dir = std::env::temp_dir();
    let installer_path: PathBuf = temp_dir.join(&filename);
    
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read download: {}", e))?;
    
    let mut file = std::fs::File::create(&installer_path)
        .map_err(|e| format!("Failed to create installer file: {}", e))?;
    
    file.write_all(&bytes)
        .map_err(|e| format!("Failed to write installer: {}", e))?;
    
    tracing::info!("Update downloaded to: {}", installer_path.display());
    
    #[cfg(target_os = "windows")]
    {
        Command::new(&installer_path)
            .spawn()
            .map_err(|e| format!("Failed to launch installer: {}", e))?;
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        return Err("Auto-update is only supported on Windows".to_string());
    }
    
    tracing::info!("Exiting for update...");
    app.exit(0);
    
    Ok(())
}
