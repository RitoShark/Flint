use flint_core::hash::{
    check_hashes_now, download_hashes as core_download_hashes, get_hash_dir, DownloadStats,
};
use crate::state::LmdbCacheState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashStatus {
    pub loaded_count: usize,
    pub last_updated: Option<String>,
}

#[tauri::command]
pub async fn download_hashes(force: bool) -> Result<DownloadStats, String> {
    let hash_dir = get_hash_dir()
        .map_err(|e| format!("Failed to get hash directory: {}", e))?;
    let stats = core_download_hashes(&hash_dir, force)
        .await
        .map_err(|e| format!("Failed to download hashes: {}", e))?;
    Ok(stats)
}

#[tauri::command]
pub async fn get_hash_status(lmdb: State<'_, LmdbCacheState>) -> Result<HashStatus, String> {
    let hash_dir = get_hash_dir()
        .map_err(|e| format!("Failed to get hash directory: {}", e))?;

    let wad_bytes = std::fs::metadata(hash_dir.join("hashes-wad.lmdb").join("data.mdb"))
        .map(|m| m.len())
        .unwrap_or(0);
    let bin_bytes = std::fs::metadata(hash_dir.join("hashes-bin.lmdb").join("data.mdb"))
        .map(|m| m.len())
        .unwrap_or(0);
    let loaded_count = ((wad_bytes + bin_bytes) / 40) as usize;

    let last_updated = std::fs::metadata(hash_dir.join("hashes-meta.json"))
        .or_else(|_| std::fs::metadata(&hash_dir))
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|time| {
            use std::time::SystemTime;
            time.duration_since(SystemTime::UNIX_EPOCH).ok().map(|d| {
                let secs = d.as_secs();
                chrono::DateTime::from_timestamp(secs as i64, 0)
                    .unwrap_or_default()
                    .format("%Y-%m-%dT%H:%M:%SZ")
                    .to_string()
            })
        });

    let hash_dir_str = hash_dir.to_string_lossy().into_owned();
    let _ = lmdb.get_wad_env(&hash_dir_str);

    Ok(HashStatus { loaded_count, last_updated })
}

#[tauri::command]
pub async fn reload_hashes(lmdb: State<'_, LmdbCacheState>) -> Result<(), String> {
    let hash_dir = get_hash_dir()
        .map_err(|e| format!("Failed to get hash directory: {}", e))?;
    let hash_dir_str = hash_dir.to_string_lossy().into_owned();

    lmdb.clear();

    // An explicit "Reload hashes" click must always re-check the release rather
    // than honour the "checked recently" skip window — with the old
    // `download_hashes(.., false)` this button did nothing at all once the DBs
    // existed on disk. It still skips the ~290MB download when the tag matches.
    check_hashes_now(&hash_dir)
        .await
        .map_err(|e| format!("Failed to download hashes: {}", e))?;

    flint_core::bin::reload_bin_hash_cache();

    if lmdb.prime(&hash_dir_str).is_some() {
        tracing::info!("Hash LMDBs reloaded from {}", hash_dir_str);
        Ok(())
    } else {
        Err("Hash LMDBs not available after download".to_string())
    }
}

#[tauri::command]
pub async fn force_rebuild_hashes(lmdb: State<'_, LmdbCacheState>) -> Result<(), String> {
    let hash_dir = get_hash_dir()
        .map_err(|e| format!("Failed to get hash directory: {}", e))?;
    let hash_dir_str = hash_dir.to_string_lossy().into_owned();

    lmdb.clear();

    core_download_hashes(&hash_dir, true)
        .await
        .map_err(|e| format!("Failed to force-download hashes: {}", e))?;

    flint_core::bin::reload_bin_hash_cache();

    if lmdb.prime(&hash_dir_str).is_some() {
        tracing::info!("Hash LMDBs force-re-downloaded from {}", hash_dir_str);
        Ok(())
    } else {
        Err("Hash LMDBs not available after force download".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_status_serialization() {
        let status = HashStatus {
            loaded_count: 100,
            last_updated: Some("2024-01-01T00:00:00Z".to_string()),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("loaded_count"));
        assert!(json.contains("100"));
    }
}
