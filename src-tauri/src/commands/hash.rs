use crate::core::hash::{download_hashes as core_download_hashes, DownloadStats};
use crate::core::hash::downloader::get_ritoshark_hash_dir;
use crate::state::HashtableState;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Status information about the loaded hashtable
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashStatus {
    pub loaded_count: usize,
    pub last_updated: Option<String>,
}

/// Downloads hash files from CommunityDragon repository
///
/// # Arguments
/// * `force` - If true, downloads all files regardless of age
///
/// # Returns
/// * `Result<DownloadStats, String>` - Statistics about the download operation
#[tauri::command]
pub async fn download_hashes(force: bool) -> Result<DownloadStats, String> {
    // Get the RitoShark hash directory
    let hash_dir = get_ritoshark_hash_dir()
        .map_err(|e| format!("Failed to get hash directory: {}", e))?;
    
    // Download hashes to the directory
    let stats = core_download_hashes(&hash_dir, force)
        .await
        .map_err(|e| format!("Failed to download hashes: {}", e))?;
    
    Ok(stats)
}

/// Returns information about the currently loaded hashtable
///
/// # Arguments
/// * `state` - The managed HashtableState
///
/// # Returns
/// * `Result<HashStatus, String>` - Status information about the hashtable
#[tauri::command]
pub async fn get_hash_status(state: State<'_, HashtableState>) -> Result<HashStatus, String> {
    let hashtable_lock = state.0.lock();
    
    match hashtable_lock.as_ref() {
        Some(hashtable) => {
            let loaded_count = hashtable.len();
            
            // Try to get last modified time of the hash directory
            let hash_dir = get_ritoshark_hash_dir()
                .map_err(|e| format!("Failed to get hash directory: {}", e))?;
            
            let last_updated = if hash_dir.exists() {
                std::fs::metadata(&hash_dir)
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(|time| {
                        use std::time::SystemTime;
                        time.duration_since(SystemTime::UNIX_EPOCH)
                            .ok()
                            .map(|duration| {
                                // Format as ISO 8601 timestamp
                                let secs = duration.as_secs();
                                let datetime = chrono::DateTime::from_timestamp(secs as i64, 0)
                                    .unwrap_or_default();
                                datetime.format("%Y-%m-%dT%H:%M:%SZ").to_string()
                            })
                    })
            } else {
                None
            };
            
            Ok(HashStatus {
                loaded_count,
                last_updated,
            })
        }
        None => Ok(HashStatus {
            loaded_count: 0,
            last_updated: None,
        }),
    }
}

/// Reloads the hashtable from disk
///
/// # Arguments
/// * `state` - The managed HashtableState
///
/// # Returns
/// * `Result<(), String>` - Ok if reload succeeded, error message otherwise
#[tauri::command]
pub async fn reload_hashes(state: State<'_, HashtableState>) -> Result<(), String> {
    // Since hashtable is now Arc<Hashtable>, we can't mutate it.
    // Instead, we re-initialize it completely which creates a new Arc.
    let hash_dir = get_ritoshark_hash_dir()
        .map_err(|e| format!("Failed to get hash directory: {}", e))?;
    
    state
        .init(hash_dir)
        .map_err(|e| format!("Failed to reload hashtable: {}", e))?;
    
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::hash::Hashtable;
    use parking_lot::Mutex;
    use std::fs;
    use std::io::Write;
    use tempfile::TempDir;

    use std::sync::Arc;

    fn create_test_hashtable_state(dir: &std::path::Path) -> HashtableState {
        let hashtable = Hashtable::from_directory(dir).unwrap();
        HashtableState(Arc::new(Mutex::new(Some(Arc::new(hashtable)))))
    }

    #[tokio::test]
    async fn test_get_hash_status_with_loaded_hashtable() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        // Create a test hash file
        let hash_file = dir_path.join("hashes.txt");
        let mut file = fs::File::create(hash_file).unwrap();
        writeln!(file, "0x1a2b3c4d test.bin").unwrap();
        writeln!(file, "0x5e6f7a8b test2.bin").unwrap();

        let state = create_test_hashtable_state(dir_path);
        
        // Test by directly accessing the state
        let hashtable_lock = state.0.lock();
        let loaded_count = hashtable_lock.as_ref().map(|h| h.len()).unwrap_or(0);
        assert_eq!(loaded_count, 2);
    }

    #[tokio::test]
    async fn test_get_hash_status_with_no_hashtable() {
        let state = HashtableState::new();
        
        // Test by directly accessing the state
        let hashtable_lock = state.0.lock();
        let loaded_count = hashtable_lock.as_ref().map(|h| h.len()).unwrap_or(0);
        assert_eq!(loaded_count, 0);
    }

    #[tokio::test]
    async fn test_reload_hashes_with_loaded_hashtable() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        // Create initial hash file
        let hash_file = dir_path.join("hashes.txt");
        let mut file = fs::File::create(&hash_file).unwrap();
        writeln!(file, "0x1a2b3c4d test.bin").unwrap();

        let state = create_test_hashtable_state(dir_path);

        // Verify initial state
        {
            let lock = state.0.lock();
            assert_eq!(lock.as_ref().unwrap().len(), 1);
        }

        // Add another hash to the file
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&hash_file)
            .unwrap();
        writeln!(file, "0x5e6f7a8b test2.bin").unwrap();

        // Reload by re-initializing (since we now use Arc<Hashtable>)
        state.init(dir_path.to_path_buf()).unwrap();

        // Verify reloaded state
        {
            let lock = state.0.lock();
            assert_eq!(lock.as_ref().unwrap().len(), 2);
        }
    }

    #[test]
    fn test_hash_status_serialization() {
        let status = HashStatus {
            loaded_count: 100,
            last_updated: Some("2024-01-01T00:00:00Z".to_string()),
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("loaded_count"));
        assert!(json.contains("100"));
        assert!(json.contains("last_updated"));
    }

    #[test]
    fn test_download_stats_serialization() {
        let stats = DownloadStats {
            downloaded: 5,
            skipped: 2,
            errors: 1,
        };

        let json = serde_json::to_string(&stats).unwrap();
        assert!(json.contains("downloaded"));
        assert!(json.contains("5"));
        assert!(json.contains("skipped"));
        assert!(json.contains("2"));
        assert!(json.contains("errors"));
        assert!(json.contains("1"));
    }
}
