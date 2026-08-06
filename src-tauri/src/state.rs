use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use flint_core::heed;
use flint_core::hash::{drop_lmdb_cache, get_or_open_env, get_wad_env, hashes_present};
use flint_core::overlay::ProjectHashOverlay;
use flint_core::wad::cache::WadCache;
use flint_core::wad::format::WadChunk;
use parking_lot::RwLock;

/// Holds a file path handed to Flint via "Open with" / a file association at
/// launch, until the frontend is mounted and pulls it. On a cold start the
/// webview takes many seconds to boot, so emitting `file-open-request` on a
/// fixed delay races the frontend's listener and is lost. Instead we ALSO stash
/// the path here and let the frontend drain it once its listener exists
/// (`take_pending_file_open`) — race-free regardless of boot time.
#[derive(Clone, Default)]
pub struct PendingFileOpenState(Arc<RwLock<Option<crate::shell_args::PendingFileOpen>>>);

impl PendingFileOpenState {
    pub fn new() -> Self { Self::default() }

    pub fn set(&self, pending: crate::shell_args::PendingFileOpen) {
        *self.0.write() = Some(pending);
    }

    /// Return the pending action (if any) and clear it, so it's delivered once.
    pub fn take(&self) -> Option<crate::shell_args::PendingFileOpen> {
        self.0.write().take()
    }
}

#[cfg(test)]
mod pending_file_open_tests {
    use super::*;
    use crate::shell_args::{PendingFileOpen, ShellAction};

    #[test]
    fn take_returns_the_pending_action_once() {
        let state = PendingFileOpenState::new();
        assert!(state.take().is_none());

        state.set(PendingFileOpen {
            action: ShellAction::PackWad,
            path: "C:/x/mod".into(),
        });

        let taken = state.take().expect("nothing pending");
        assert_eq!(taken.action, ShellAction::PackWad);
        assert_eq!(taken.path, "C:/x/mod");

        // Delivered once — a second take must be empty, or a cold-start pull
        // followed by the event would act twice.
        assert!(state.take().is_none());
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
/// statics in `flint_core::hash::lmdb_cache`. Two LMDBs are managed: WAD hashes
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

// =============================================================================
// 3D model edit sessions
// =============================================================================

/// One open `.skn` in the 3D editor. `pristine` is the parse of what is on disk
/// and is never mutated; every derived state is a fresh fold of `log.active()`
/// over it. Mirrors `WadEditSession`.
pub struct ModelEditSession {
    pub session_id: String,
    pub source_path: PathBuf,
    pub skeleton_path: Option<PathBuf>,
    pub pristine: ritoshark::mesh::SkinnedMesh,
    pub skeleton: Option<ritoshark::anim::Skeleton>,
    pub log: flint_core::mesh::edit::OpLog,
}

#[derive(Clone, Default)]
pub struct ModelEditState(Arc<RwLock<HashMap<String, Arc<RwLock<ModelEditSession>>>>>);

impl ModelEditState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, session: ModelEditSession) -> String {
        let id = session.session_id.clone();
        self.0.write().insert(id.clone(), Arc::new(RwLock::new(session)));
        id
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<RwLock<ModelEditSession>>> {
        self.0.read().get(session_id).cloned()
    }

    pub fn remove(&self, session_id: &str) -> bool {
        self.0.write().remove(session_id).is_some()
    }
}

/// In-memory store of parsed CDN manifests, keyed by a generated session id.
/// Mirrors `WadEditState`: one entry per open manifest tab. The `Manifest` is
/// read-only after parse, so it's stored as a plain `Arc` (no inner lock).
#[derive(Clone, Default)]
pub struct CdnSessionState(Arc<RwLock<HashMap<String, Arc<flint_core::cdn::manifest::Manifest>>>>);

impl CdnSessionState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Store a manifest, returning its new session id.
    pub fn insert(&self, manifest: flint_core::cdn::manifest::Manifest) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.0.write().insert(id.clone(), Arc::new(manifest));
        id
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<flint_core::cdn::manifest::Manifest>> {
        self.0.read().get(session_id).cloned()
    }

    pub fn remove(&self, session_id: &str) -> bool {
        self.0.write().remove(session_id).is_some()
    }
}

// =============================================================================
// Project-local hash overlay
// =============================================================================

/// The active project's path paired with its built overlay.
type HashOverlaySlot = Option<(String, Arc<ProjectHashOverlay>)>;

/// `slot` and `generation` are grouped behind one `Arc` (rather than each
/// clone holding its own `AtomicU64`) so every clone of `HashOverlayState`
/// shares the same counter — a build kicked off from one clone must be
/// validated against generation bumps made through any other.
#[derive(Default)]
struct HashOverlayInner {
    slot: RwLock<HashOverlaySlot>,
    generation: AtomicU64,
}

/// The active project's hash overlay, if one has been built.
///
/// Only one project is active at a time, so a single slot is enough. Switching
/// projects replaces it wholesale. `generation` is bumped on every store and
/// every `clear`; `set_if_current` uses it to detect that a build's result
/// has been superseded (by a newer build, or by a `clear`) before it gets a
/// chance to store — see `set_if_current`, the only way to store into this
/// state. There is no unconditional `set`: every write must prove its
/// generation is still current, so a stale build can never resurrect state
/// out from under a newer one.
#[derive(Clone, Default)]
pub struct HashOverlayState(Arc<HashOverlayInner>);

impl HashOverlayState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&self) {
        let mut slot = self.0.slot.write();
        *slot = None;
        self.0.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn get(&self) -> Option<Arc<ProjectHashOverlay>> {
        self.0.slot.read().as_ref().map(|(_, o)| Arc::clone(o))
    }

    // Test-only for now: exercised by three tests below. Kept as a plausible
    // consumer for a future guard against a project switch racing an
    // in-flight overlay build.
    #[allow(dead_code)]
    pub fn active_project(&self) -> Option<String> {
        self.0.slot.read().as_ref().map(|(p, _)| p.clone())
    }

    /// A snapshot to capture *before* starting a build. Pass it to
    /// `set_if_current` once the build finishes.
    pub fn current_generation(&self) -> u64 {
        self.0.generation.load(Ordering::SeqCst)
    }

    /// Store only if `gen` is still current — a build that began before a
    /// `clear` or a newer store must not resurrect itself. Returns whether
    /// the store happened.
    ///
    /// The generation check and the write both happen while holding the
    /// `slot` write lock, so a concurrent `clear`/`set_if_current` cannot
    /// interleave between the check and the write.
    pub fn set_if_current(&self, gen: u64, project_path: String, overlay: Arc<ProjectHashOverlay>) -> bool {
        let mut slot = self.0.slot.write();
        if self.0.generation.load(Ordering::SeqCst) != gen {
            return false;
        }
        *slot = Some((project_path, overlay));
        self.0.generation.fetch_add(1, Ordering::SeqCst);
        true
    }
}

#[cfg(test)]
mod hash_overlay_state_tests {
    use super::*;
    use flint_core::overlay::ProjectHashOverlay;

    /// Overlay entries must satisfy `key == wad_chunk_hash(value)`; the
    /// canonical hash function itself is crate-private to flint-core, so tests
    /// outside that crate recompute the documented formula (xxh64 of the
    /// lowercased path, seed 0) directly.
    fn wad_hash(path: &str) -> u64 {
        xxhash_rust::xxh64::xxh64(path.to_lowercase().as_bytes(), 0)
    }

    #[test]
    fn set_then_get_returns_the_overlay() {
        let state = HashOverlayState::new();
        assert!(state.get().is_none());

        let mut o = ProjectHashOverlay::new();
        let hash = wad_hash("assets/x.dds");
        o.insert_wad(hash, "assets/x.dds");
        let gen = state.current_generation();
        assert!(state.set_if_current(gen, "C:\\p".to_string(), std::sync::Arc::new(o)));

        assert_eq!(state.active_project().as_deref(), Some("C:\\p"));
        assert_eq!(state.get().unwrap().wad_get(hash), Some("assets/x.dds"));
    }

    #[test]
    fn clear_drops_the_overlay_and_the_project() {
        let state = HashOverlayState::new();
        let gen = state.current_generation();
        assert!(state.set_if_current(gen, "C:\\p".to_string(), std::sync::Arc::new(ProjectHashOverlay::new())));

        state.clear();

        assert!(state.get().is_none());
        assert!(state.active_project().is_none());
    }

    #[test]
    fn setting_a_new_project_replaces_the_previous_overlay() {
        let state = HashOverlayState::new();
        let hash_a = wad_hash("assets/a.dds");
        let mut first = ProjectHashOverlay::new();
        first.insert_wad(hash_a, "assets/a.dds");
        let gen = state.current_generation();
        assert!(state.set_if_current(gen, "C:\\a".to_string(), std::sync::Arc::new(first)));

        let hash_b = wad_hash("assets/b.dds");
        let mut second = ProjectHashOverlay::new();
        second.insert_wad(hash_b, "assets/b.dds");
        let gen = state.current_generation();
        assert!(state.set_if_current(gen, "C:\\b".to_string(), std::sync::Arc::new(second)));

        assert_eq!(state.active_project().as_deref(), Some("C:\\b"));
        assert!(state.get().unwrap().wad_get(hash_a).is_none());
        assert_eq!(state.get().unwrap().wad_get(hash_b), Some("assets/b.dds"));
    }

    #[test]
    fn set_if_current_stores_when_the_generation_still_matches() {
        let state = HashOverlayState::new();
        let gen = state.current_generation();

        let hash = wad_hash("assets/fresh.dds");
        let mut overlay = ProjectHashOverlay::new();
        overlay.insert_wad(hash, "assets/fresh.dds");

        let stored = state.set_if_current(gen, "C:\\p".to_string(), std::sync::Arc::new(overlay));

        assert!(stored);
        assert_eq!(state.active_project().as_deref(), Some("C:\\p"));
        assert_eq!(state.get().unwrap().wad_get(hash), Some("assets/fresh.dds"));
    }

    #[test]
    fn set_if_current_rejects_a_stale_generation_and_leaves_state_untouched() {
        let state = HashOverlayState::new();

        // A build "starts": it captures the generation before doing any work.
        let stale_gen = state.current_generation();

        // Meanwhile a clear happens — e.g. the project closed while the build
        // was in flight — which bumps the generation past what the build saw.
        state.clear();

        // The stale build finishes and tries to store its (now outdated) result.
        let hash = wad_hash("assets/stale.dds");
        let mut stale_overlay = ProjectHashOverlay::new();
        stale_overlay.insert_wad(hash, "assets/stale.dds");
        let stored = state.set_if_current(stale_gen, "C:\\stale".to_string(), std::sync::Arc::new(stale_overlay));

        assert!(!stored, "a stale generation must not be allowed to store");
        // State must remain exactly as `clear` left it — not resurrected.
        assert!(state.get().is_none());
        assert!(state.active_project().is_none());
    }
}
