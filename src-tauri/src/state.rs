use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use crate::core::hash::Hashtable;
use crate::error::Result;

/// Global lazy-loaded hashtable - only loaded when first accessed
static LAZY_HASHTABLE: OnceLock<Arc<Hashtable>> = OnceLock::new();

/// Thread-safe wrapper for the global hashtable state.
/// Supports lazy loading - hashtable is only loaded from disk when first accessed.
#[derive(Clone)]
pub struct HashtableState(pub Arc<Mutex<Option<PathBuf>>>);

impl HashtableState {
    pub fn new() -> Self {
        // Store the hash directory path, not the loaded hashtable
        Self(Arc::new(Mutex::new(None)))
    }
    
    /// Set the hash directory path for lazy loading
    pub fn set_hash_dir(&self, hash_dir: PathBuf) {
        let mut state = self.0.lock();
        *state = Some(hash_dir);
    }
    
    /// Get the hash directory path (for downloading)
    #[allow(dead_code)] // Kept for API completeness
    pub fn get_hash_dir(&self) -> Option<PathBuf> {
        self.0.lock().clone()
    }
    
    /// Legacy init method - now just sets the hash directory for lazy loading
    #[allow(dead_code)] // Kept for API completeness
    pub fn init(&self, hash_dir: PathBuf) -> Result<()> {
        // Create hash directory if it doesn't exist
        std::fs::create_dir_all(&hash_dir)?;
        self.set_hash_dir(hash_dir);
        Ok(())
    }
    
    /// Lazily get or initialize the hashtable
    /// Only loads from disk on first call
    pub fn get_hashtable(&self) -> Option<Arc<Hashtable>> {
        // Return cached if already loaded
        if let Some(ht) = LAZY_HASHTABLE.get() {
            return Some(Arc::clone(ht));
        }
        
        // Try to load lazily
        let hash_dir = self.0.lock().clone()?;
        
        // Use get_or_init to handle race conditions
        let ht = LAZY_HASHTABLE.get_or_init(|| {
            tracing::info!("Lazy loading hashtable from {}...", hash_dir.display());
            match Hashtable::from_directory(&hash_dir) {
                Ok(hashtable) => {
                    tracing::info!("Hashtable lazy-loaded: {} entries", hashtable.len());
                    Arc::new(hashtable)
                }
                Err(e) => {
                    tracing::warn!("Failed to load hashtable: {}", e);
                    Arc::new(Hashtable::empty())
                }
            }
        });
        
        Some(Arc::clone(ht))
    }
    
    pub fn len(&self) -> usize {
        LAZY_HASHTABLE.get().map(|h| h.len()).unwrap_or(0)
    }
    
    /// Check if the hashtable has been loaded yet
    #[allow(dead_code)] // Kept for API completeness
    pub fn is_loaded(&self) -> bool {
        LAZY_HASHTABLE.get().is_some()
    }
}
