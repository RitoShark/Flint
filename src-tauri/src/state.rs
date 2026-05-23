use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use flint_ltk::heed;
use flint_ltk::hash::{drop_lmdb_cache, get_or_open_env, get_wad_env, hashes_present};
use flint_ltk::wad::cache::WadCache;
use flint_ltk::wad_jade::format::WadChunk;
use parking_lot::RwLock;

/// Global WAD metadata cache for fast repeated access.
/// WADs are immutable once written, so caching headers is safe.
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

/// Tauri-managed handle to the global LMDB env caches.
///
/// Backed by process-wide statics in `flint_ltk::hash::lmdb_cache`; this struct
/// is a zero-cost wrapper exposing the API to Tauri commands via
/// `tauri::State<LmdbCacheState>`.
///
/// Two separate LMDBs are managed:
/// - WAD hashes — `hashes-wad.lmdb` (64-bit xxh64 keys, named DB `"wad"`).
/// - BIN hashes — `hashes-bin.lmdb` (32-bit FNV1a keys, named DB `"bin"`).
///
/// Both are pre-built and downloaded from the `LeagueToolkit/lmdb-hashes`
/// GitHub release — no local build step.
#[derive(Clone, Default)]
pub struct LmdbCacheState;

impl LmdbCacheState {
    pub fn new() -> Self { Self }

    /// Return the WAD env, opening it on first call.
    pub fn get_wad_env(&self, hash_dir: &str) -> Option<Arc<heed::Env>> {
        get_wad_env(hash_dir)
    }

    /// Legacy alias — returns the WAD env. Prefer [`Self::get_wad_env`] in new code.
    pub fn get_env(&self, hash_dir: &str) -> Option<Arc<heed::Env>> {
        get_or_open_env(hash_dir)
    }

    /// Ensure the WAD env is open and return it.
    ///
    /// The DB is downloaded as a pre-built zstd-compressed artifact, so priming
    /// just opens the env. Returns `None` if the LMDB files are missing.
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

/// One pending edit inside a session. We store the *uncompressed* bytes —
/// the writer re-compresses on save (it has a heuristic for "is zstd
/// worth it for this chunk size").
#[derive(Debug, Clone)]
pub enum WadEditDelta {
    /// Replace or add a chunk with these decompressed bytes.
    Write(Vec<u8>),
    /// Remove the chunk on save.
    Delete,
}

/// One in-flight WAD edit session — holds the source TOC + a delta map.
///
/// Read flow:
///   1. caller asks for chunk by hash
///   2. if hash is in `deltas` and value is `Write`, return those bytes
///   3. if hash is in `deltas` and value is `Delete`, return error
///   4. otherwise fall through to the on-disk WAD reader
///
/// Save flow: enumerate every original chunk hash, decompress those NOT
/// shadowed by a `Delete`, override with `Write` bytes where present,
/// then call `wad_jade::writer::write_wad`.
#[derive(Debug)]
pub struct WadEditSession {
    pub session_id: String,
    pub source_path: PathBuf,
    /// Original TOC, captured at open time. Used so we don't have to re-
    /// parse the WAD on every read — but we still seek into the file for
    /// untouched chunks to keep memory bounded.
    pub original_chunks: Vec<WadChunk>,
    /// hash → delta (Write replaces / adds, Delete removes).
    pub deltas: HashMap<u64, WadEditDelta>,
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

    /// Snapshot of every active session — used by `list_wad_edit_sessions`
    /// for UI restoration after a tab reload.
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
