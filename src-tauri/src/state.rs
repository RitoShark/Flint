use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;
use crate::core::hash::Hashtable;
use crate::error::Result;

/// Thread-safe wrapper for the global hashtable state.
/// Uses Arc<Hashtable> internally to avoid expensive clones when accessing the hashtable.
#[derive(Clone)]
pub struct HashtableState(pub Arc<Mutex<Option<Arc<Hashtable>>>>);

impl HashtableState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
    
    pub fn init(&self, hash_dir: PathBuf) -> Result<()> {
        // Create hash directory if it doesn't exist
        std::fs::create_dir_all(&hash_dir)?;
        
        let mut state = self.0.lock();
        *state = Some(Arc::new(Hashtable::from_directory(hash_dir)?));
        Ok(())
    }
    
    pub fn len(&self) -> usize {
        self.0.lock().as_ref().map(|h| h.len()).unwrap_or(0)
    }
    
    /// Get a reference-counted handle to the hashtable for use in extraction.
    /// This is cheap (just Arc::clone) compared to cloning the entire HashMap.
    pub fn get_hashtable(&self) -> Option<Arc<Hashtable>> {
        self.0.lock().as_ref().map(Arc::clone)
    }
}

