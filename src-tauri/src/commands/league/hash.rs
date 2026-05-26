use flint_ltk::hash::{
    download_hashes as core_download_hashes, get_hash_dir, DownloadStats,
};
use crate::state::LmdbCacheState;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Status information about the loaded hash databases.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashStatus {
    /// Approximate entry count across both LMDBs (via file size heuristic).
    pub loaded_count: usize,
    pub last_updated: Option<String>,
}

/// Download pre-built LMDB hash databases from the `lmdb-hashes` GitHub releases.
///
/// Replaces the old per-file CommunityDragon download. Two zstd-compressed LMDBs
/// are pulled and decompressed: `hashes-wad.lmdb` and `hashes-bin.lmdb`.
#[tauri::command]
pub async fn download_hashes(force: bool) -> Result<DownloadStats, String> {
    let hash_dir = get_hash_dir()
        .map_err(|e| format!("Failed to get hash directory: {}", e))?;
    let stats = core_download_hashes(&hash_dir, force)
        .await
        .map_err(|e| format!("Failed to download hashes: {}", e))?;
    Ok(stats)
}

/// Returns information about the currently-open LMDB hash databases.
#[tauri::command]
pub async fn get_hash_status(lmdb: State<'_, LmdbCacheState>) -> Result<HashStatus, String> {
    let hash_dir = get_hash_dir()
        .map_err(|e| format!("Failed to get hash directory: {}", e))?;

    // Approximate: combined data.mdb sizes / ~40 bytes per entry.
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

    // Warm the WAD env (open if not already open).
    let hash_dir_str = hash_dir.to_string_lossy().into_owned();
    let _ = lmdb.get_wad_env(&hash_dir_str);

    Ok(HashStatus { loaded_count, last_updated })
}

/// Re-sync hash LMDBs from the GitHub release, replacing local files if needed.
#[tauri::command]
pub async fn reload_hashes(lmdb: State<'_, LmdbCacheState>) -> Result<(), String> {
    let hash_dir = get_hash_dir()
        .map_err(|e| format!("Failed to get hash directory: {}", e))?;
    let hash_dir_str = hash_dir.to_string_lossy().into_owned();

    // Drop open envs first — Windows won't let us overwrite mmap'd data.mdb.
    lmdb.clear();

    core_download_hashes(&hash_dir, false)
        .await
        .map_err(|e| format!("Failed to download hashes: {}", e))?;

    // Reload the in-memory BIN hash cache too.
    flint_ltk::bin::reload_bin_hash_cache();

    if lmdb.prime(&hash_dir_str).is_some() {
        tracing::info!("Hash LMDBs reloaded from {}", hash_dir_str);
        Ok(())
    } else {
        Err("Hash LMDBs not available after download".to_string())
    }
}

/// Force re-download of hash LMDBs regardless of local release-tag cache.
#[tauri::command]
pub async fn force_rebuild_hashes(lmdb: State<'_, LmdbCacheState>) -> Result<(), String> {
    let hash_dir = get_hash_dir()
        .map_err(|e| format!("Failed to get hash directory: {}", e))?;
    let hash_dir_str = hash_dir.to_string_lossy().into_owned();

    lmdb.clear();

    core_download_hashes(&hash_dir, true)
        .await
        .map_err(|e| format!("Failed to force-download hashes: {}", e))?;

    flint_ltk::bin::reload_bin_hash_cache();

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
