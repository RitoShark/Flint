/// WAD Metadata Cache
///
/// Caches parsed WAD chunk metadata to avoid re-parsing WAD headers on every operation.
/// WAD files are immutable once written, so headers can be safely cached indefinitely.
///
/// Benefits:
/// - `get_wad_chunks` calls are ~100x faster after first read (no I/O or parsing)
/// - WAD Explorer indexing is near-instant for previously scanned WADs
/// - Project extraction avoids repeated header parses
use dashmap::DashMap;
// WAD chunks now flow through Flint as Jade's native type — the cache
// stores those so `WadHandle::chunks()` and `cache.get()` line up.
use crate::wad_jade::format::WadChunk;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

/// Cached metadata for a single WAD file
#[derive(Debug, Clone)]
pub struct CachedWadMetadata {
    /// Last modified time of the WAD file when cached
    pub mtime: SystemTime,
    /// Chunk metadata (shared via Arc to avoid cloning on cache hits)
    pub chunks: Arc<Vec<WadChunk>>,
}

/// Thread-safe WAD metadata cache using DashMap for concurrent access
pub struct WadCache {
    cache: Arc<DashMap<PathBuf, CachedWadMetadata>>,
}

impl WadCache {
    /// Create a new empty cache
    pub fn new() -> Self {
        Self {
            cache: Arc::new(DashMap::new()),
        }
    }

    /// Get cached metadata for a WAD file, or None if not cached or stale
    ///
    /// Returns None if:
    /// - WAD not in cache
    /// - WAD file modified since cache entry was created
    /// - WAD file no longer exists
    pub fn get(&self, path: impl AsRef<Path>) -> Option<Arc<Vec<WadChunk>>> {
        let path = path.as_ref();
        let entry = self.cache.get(path)?;

        // Validate cache freshness - check if file was modified
        let current_mtime = std::fs::metadata(path).ok()?.modified().ok()?;
        if current_mtime != entry.mtime {
            // File modified - invalidate cache entry
            drop(entry); // Release read lock before removing
            self.cache.remove(path);
            return None;
        }

        Some(Arc::clone(&entry.chunks))
    }

    /// Remove a WAD entry from the cache (used by Reload WAD)
    pub fn remove(&self, path: impl AsRef<Path>) {
        self.cache.remove(path.as_ref());
    }

    /// Insert WAD metadata into cache
    ///
    /// # Arguments
    /// * `path` - Absolute path to WAD file
    /// * `chunks` - Parsed chunk metadata
    ///
    /// # Returns
    /// * `Ok(())` if cached successfully
    /// * `Err(std::io::Error)` if file metadata cannot be read
    pub fn insert(&self, path: impl AsRef<Path>, chunks: Arc<Vec<WadChunk>>) -> std::io::Result<()> {
        let path = path.as_ref().to_path_buf();
        let mtime = std::fs::metadata(&path)?.modified()?;

        self.cache.insert(
            path,
            CachedWadMetadata {
                mtime,
                chunks,
            },
        );

        Ok(())
    }

}

impl Default for WadCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_miss() {
        let cache = WadCache::new();
        assert!(cache.get("/nonexistent/file.wad").is_none());
    }

}
