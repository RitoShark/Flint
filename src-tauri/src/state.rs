use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use flint_ltk::heed;
use flint_ltk::hash::{drop_lmdb_cache, get_or_open_env, get_wad_env, hashes_present};
use flint_ltk::wad::cache::WadCache;
use flint_ltk::wad_jade::format::WadChunk;
use parking_lot::RwLock;

/// Holds a file path handed to Flint via "Open with" / a file association at
/// launch, until the frontend is mounted and pulls it. On a cold start the
/// webview takes many seconds to boot, so emitting `file-open-request` on a
/// fixed delay races the frontend's listener and is lost. Instead we ALSO stash
/// the path here and let the frontend drain it once its listener exists
/// (`take_pending_file_open`) — race-free regardless of boot time.
#[derive(Clone, Default)]
pub struct PendingFileOpenState(Arc<RwLock<Option<String>>>);

impl PendingFileOpenState {
    pub fn new() -> Self { Self::default() }

    pub fn set(&self, path: String) {
        *self.0.write() = Some(path);
    }

    /// Return the pending path (if any) and clear it, so it's delivered once.
    pub fn take(&self) -> Option<String> {
        self.0.write().take()
    }
}

/// Global WAD metadata cache. WADs are immutable once written, so caching
/// headers is safe.
#[derive(Clone)]
pub struct WadCacheState(pub Arc<WadCache>);

impl Default for WadCacheState {
    fn default() -> Self {
        Self::new()
    }
}

impl WadCacheState {
    pub fn new() -> Self {
        Self(Arc::new(WadCache::new()))
    }

    pub fn get(&self) -> Arc<WadCache> {
        Arc::clone(&self.0)
    }
}

// =============================================================================
// LMDB env cache state
// =============================================================================

/// Tauri-managed handle to the global LMDB env caches, backed by process-wide
/// statics in `flint_ltk::hash::lmdb_cache`. Two LMDBs are managed: WAD hashes
/// (`hashes-wad.lmdb`, 64-bit xxh64 keys, named DB `"wad"`) and BIN hashes
/// (`hashes-bin.lmdb`, 32-bit FNV1a keys, named DB `"bin"`).
#[derive(Clone, Default)]
pub struct LmdbCacheState;

impl LmdbCacheState {
    pub fn new() -> Self { Self }

    /// Return the WAD env, opening it on first call.
    pub fn get_wad_env(&self, hash_dir: &str) -> Option<Arc<heed::Env>> {
        get_wad_env(hash_dir)
    }

    pub fn get_env(&self, hash_dir: &str) -> Option<Arc<heed::Env>> {
        get_or_open_env(hash_dir)
    }

    /// Ensure the WAD env is open and return it. Returns `None` if the LMDB
    /// files are missing.
    pub fn prime(&self, hash_dir: &str) -> Option<Arc<heed::Env>> {
        if !hashes_present(std::path::Path::new(hash_dir)) {
            tracing::warn!("Hash LMDBs not present at {} — run download_hashes first", hash_dir);
            return None;
        }
        get_wad_env(hash_dir)
    }

    /// Drop the cached WAD and BIN envs — frees mmap pages and closes file handles.
    pub fn clear(&self) {
        drop_lmdb_cache();
    }
}

// =============================================================================
// In-memory WAD edit sessions
// =============================================================================

/// One pending edit inside a session. Bytes are stored uncompressed; the
/// writer re-compresses on save.
#[derive(Debug, Clone)]
pub enum WadEditDelta {
    /// Replace or add a chunk with these decompressed bytes.
    Write(Vec<u8>),
    /// Remove the chunk on save.
    Delete,
}

/// Backing store for a session's untouched chunks.
#[derive(Debug, Clone)]
pub enum WadEditBacking {
    /// A packed `.wad.client` file. Untouched chunks are seeked+decompressed
    /// from `source_path` on read.
    Wad,
    /// A WAD stored as a FOLDER tree of loose files (some `.fantome`s ship WADs
    /// unpacked; launchers pack them on import). We edit the loose files
    /// directly — no packing, so the real string paths are preserved. `root` is
    /// the extracted folder; `paths` maps chunk hash → real WAD-relative path
    /// (forward slashes) so the browser shows real paths without any LMDB
    /// lookup, and save writes files back under those paths.
    Folder {
        root: PathBuf,
        paths: HashMap<u64, String>,
    },
}

/// One in-flight WAD edit session — holds the source TOC plus a delta map.
#[derive(Debug)]
pub struct WadEditSession {
    pub session_id: String,
    pub source_path: PathBuf,
    /// Original TOC, captured at open time; untouched chunks are seeked from
    /// the file on read to keep memory bounded.
    pub original_chunks: Vec<WadChunk>,
    /// hash → delta (Write replaces / adds, Delete removes).
    pub deltas: HashMap<u64, WadEditDelta>,
    /// Where untouched chunks come from — a packed WAD file or a loose folder.
    pub backing: WadEditBacking,
}

#[derive(Clone, Default)]
pub struct WadEditState(Arc<RwLock<HashMap<String, Arc<RwLock<WadEditSession>>>>>);

impl WadEditState {
    pub fn new() -> Self { Self::default() }

    pub fn insert(&self, session: WadEditSession) -> String {
        let id = session.session_id.clone();
        self.0.write().insert(id.clone(), Arc::new(RwLock::new(session)));
        id
    }

    pub fn remove(&self, session_id: &str) -> bool {
        self.0.write().remove(session_id).is_some()
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<RwLock<WadEditSession>>> {
        self.0.read().get(session_id).cloned()
    }

    /// Snapshot of every active session as `(id, source_path, chunk_count)`.
    pub fn snapshot(&self) -> Vec<(String, PathBuf, usize)> {
        self.0
            .read()
            .iter()
            .map(|(id, s)| {
                let g = s.read();
                (id.clone(), g.source_path.clone(), g.original_chunks.len())
            })
            .collect()
    }
}

/// In-memory store of parsed CDN manifests, keyed by a generated session id.
/// Mirrors `WadEditState`: one entry per open manifest tab. The `Manifest` is
/// read-only after parse, so it's stored as a plain `Arc` (no inner lock).
#[derive(Clone, Default)]
pub struct CdnSessionState(Arc<RwLock<HashMap<String, Arc<flint_ltk::cdn::manifest::Manifest>>>>);

impl CdnSessionState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Store a manifest, returning its new session id.
    pub fn insert(&self, manifest: flint_ltk::cdn::manifest::Manifest) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.0.write().insert(id.clone(), Arc::new(manifest));
        id
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<flint_ltk::cdn::manifest::Manifest>> {
        self.0.read().get(session_id).cloned()
    }

    pub fn remove(&self, session_id: &str) -> bool {
        self.0.write().remove(session_id).is_some()
    }
}
