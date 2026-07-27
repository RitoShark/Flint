//! WAD chunk metadata cache. WAD files are immutable once written, so parsed
//! headers can be cached and validated by mtime.
use dashmap::DashMap;
use crate::wad_jade::format::WadChunk;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

#[derive(Debug, Clone)]
pub struct CachedWadMetadata {
    pub mtime: SystemTime,
    pub chunks: Arc<Vec<WadChunk>>,
}

pub struct WadCache {
    cache: Arc<DashMap<PathBuf, CachedWadMetadata>>,
}

impl WadCache {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(DashMap::new()),
        }
    }

    /// Returns None if not cached, the file no longer exists, or the file was
    /// modified since the entry was created (the stale entry is then evicted).
    pub fn get(&self, path: impl AsRef<Path>) -> Option<Arc<Vec<WadChunk>>> {
        let path = path.as_ref();
        let entry = self.cache.get(path)?;

        let current_mtime = std::fs::metadata(path).ok()?.modified().ok()?;
        if current_mtime != entry.mtime {
            drop(entry); // Release read lock before removing
            self.cache.remove(path);
            return None;
        }

        Some(Arc::clone(&entry.chunks))
    }

    pub fn remove(&self, path: impl AsRef<Path>) {
        self.cache.remove(path.as_ref());
    }

    /// # Errors
    /// Returns an error if the file's metadata cannot be read.
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
