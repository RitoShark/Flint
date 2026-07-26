//! Global LMDB environment cache.
//!
//! Two separate LMDBs:
//! - `hashes-wad.lmdb` — named DB `"wad"`, 8-byte BE keys (xxh64), WAD path hashes.
//! - `hashes-bin.lmdb` — named DB `"bin"`, 4-byte BE keys (FNV1a), BIN hashes.

use heed::types::{Bytes, Str};
use heed::{Database, EnvOpenOptions};
use rustc_hash::FxHashMap;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

// ── Arena-backed resolved-hash table ──────────────────────────────────────────
#[derive(Default, Clone)]
pub struct ResolvedHashes {
    arena: Vec<u8>,
    index: FxHashMap<u64, (u32, u32)>,
}

impl ResolvedHashes {
    pub fn new() -> Self { Self::default() }

    /// Pre-size both the index and the arena. `entries` should be the
    /// expected number of hits; `arena_bytes` an estimate of total UTF-8.
    pub fn with_capacity(entries: usize, arena_bytes: usize) -> Self {
        Self {
            arena: Vec::with_capacity(arena_bytes),
            index: FxHashMap::with_capacity_and_hasher(entries, Default::default()),
        }
    }

    pub fn insert(&mut self, hash: u64, path: &str) {
        let bytes = path.as_bytes();
        let off = self.arena.len() as u32;
        let len = bytes.len() as u32;
        self.arena.extend_from_slice(bytes);
        self.index.insert(hash, (off, len));
    }

    pub fn get(&self, hash: &u64) -> Option<&str> {
        let (off, len) = *self.index.get(hash)?;
        let start = off as usize;
        let end = start + len as usize;
        // SAFETY: every byte in the arena was written via `insert` from a
        // valid `&str`. Slices are appended whole, never mid-codepoint.
        Some(unsafe { std::str::from_utf8_unchecked(&self.arena[start..end]) })
    }

    pub fn contains_key(&self, hash: &u64) -> bool { self.index.contains_key(hash) }

    pub fn iter(&self) -> impl Iterator<Item = (u64, &str)> + '_ {
        let arena = &self.arena;
        self.index.iter().map(move |(h, (off, len))| {
            let start = *off as usize;
            let end = start + *len as usize;
            // SAFETY: same invariant as `get`.
            (*h, unsafe { std::str::from_utf8_unchecked(&arena[start..end]) })
        })
    }

    pub fn len(&self) -> usize { self.index.len() }
    pub fn is_empty(&self) -> bool { self.index.is_empty() }

    /// Merge another arena into this one, rewriting offsets.
    pub fn extend_arena(&mut self, other: ResolvedHashes) {
        let base = self.arena.len() as u32;
        self.arena.extend_from_slice(&other.arena);
        self.index.reserve(other.index.len());
        for (h, (off, len)) in other.index {
            self.index.insert(h, (base + off, len));
        }
    }
}

impl FromIterator<(u64, String)> for ResolvedHashes {
    fn from_iter<I: IntoIterator<Item = (u64, String)>>(iter: I) -> Self {
        let it = iter.into_iter();
        let (lo, _) = it.size_hint();
        let mut out = ResolvedHashes::with_capacity(lo, lo * 32);
        for (h, s) in it {
            out.insert(h, &s);
        }
        out
    }
}

// ── Statics ───────────────────────────────────────────────────────────────────

struct EnvCache {
    key: String,
    env: Arc<heed::Env>,
}

static WAD_LMDB_CACHE: OnceLock<Mutex<Option<EnvCache>>> = OnceLock::new();
static BIN_LMDB_CACHE: OnceLock<Mutex<Option<EnvCache>>> = OnceLock::new();

fn wad_mutex() -> &'static Mutex<Option<EnvCache>> {
    WAD_LMDB_CACHE.get_or_init(|| Mutex::new(None))
}

fn bin_mutex() -> &'static Mutex<Option<EnvCache>> {
    BIN_LMDB_CACHE.get_or_init(|| Mutex::new(None))
}

// ── Open helpers ──────────────────────────────────────────────────────────────

fn open_env(lmdb_dir: &Path) -> Option<heed::Env> {
    if !lmdb_dir.join("data.mdb").exists() {
        tracing::debug!("LMDB data.mdb missing at: {}", lmdb_dir.display());
        return None;
    }

    // 1 GB virtual address reservation; max_dbs(2) for the named DBs.
    match unsafe {
        EnvOpenOptions::new()
            .map_size(1024 * 1024 * 1024)
            .max_dbs(2)
            .open(lmdb_dir)
    } {
        Ok(e) => Some(e),
        Err(e) => {
            tracing::warn!("Failed to open LMDB at {}: {}", lmdb_dir.display(), e);
            None
        }
    }
}

fn get_cached_env(
    slot: &Mutex<Option<EnvCache>>,
    lmdb_dir: &Path,
) -> Option<Arc<heed::Env>> {
    let key = lmdb_dir.to_string_lossy().into_owned();
    let mut g = slot.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(ref cache) = *g {
        if cache.key == key {
            return Some(Arc::clone(&cache.env));
        }
    }

    tracing::info!("Opening LMDB env: {}", lmdb_dir.display());
    let env = open_env(lmdb_dir)?;
    let arc = Arc::new(env);
    *g = Some(EnvCache { key, env: Arc::clone(&arc) });
    Some(arc)
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Get (and cache) the WAD hash env rooted at `hash_dir`.
///
/// Returns `None` if `hash_dir/hashes-wad.lmdb/data.mdb` is missing.
pub fn get_wad_env(hash_dir: &str) -> Option<Arc<heed::Env>> {
    let lmdb_dir = Path::new(hash_dir).join("hashes-wad.lmdb");
    get_cached_env(wad_mutex(), &lmdb_dir)
}

/// Get (and cache) the BIN hash env rooted at `hash_dir`.
///
/// Returns `None` if `hash_dir/hashes-bin.lmdb/data.mdb` is missing.
pub fn get_bin_env(hash_dir: &str) -> Option<Arc<heed::Env>> {
    let lmdb_dir = Path::new(hash_dir).join("hashes-bin.lmdb");
    get_cached_env(bin_mutex(), &lmdb_dir)
}

pub fn get_or_open_env(hash_dir: &str) -> Option<Arc<heed::Env>> {
    get_wad_env(hash_dir)
}

/// Drop both cached envs. Call before replacing the on-disk `data.mdb` so
/// Windows doesn't refuse the overwrite (the file is memory-mapped while open).
pub fn drop_lmdb_cache() {
    {
        let mut g = wad_mutex().lock().unwrap_or_else(|e| e.into_inner());
        *g = None;
    }
    {
        let mut g = bin_mutex().lock().unwrap_or_else(|e| e.into_inner());
        *g = None;
    }
    // DB handles are tied to the dropped envs — a reopened env gets a new
    // pointer and heed panics on a stale handle.
    if let Some(m) = DB_HANDLES.get() {
        m.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
    tracing::debug!("LMDB env caches cleared");
}

// ── Resolve helpers ───────────────────────────────────────────────────────────

static DB_HANDLES: OnceLock<Mutex<HashMap<String, Database<Bytes, Str>>>> = OnceLock::new();

/// Resolve the (named, else unnamed) DB handle for an env, opening it at most
/// once per process behind a mutex.
///
/// SAFETY-CRITICAL: LMDB forbids concurrent `mdb_dbi_open` within a process —
/// it mutates the env's dbi slot table without locking, and heed 0.20 adds no
/// serialization. Unguarded concurrent first opens (e.g. rayon tasks in
/// `resolve_hashes_lmdb_bulk`, or two parallel `load_all_wad_chunks` commands)
/// corrupt the heap (observed STATUS_HEAP_CORRUPTION). The opening txn is
/// COMMITTED so the dbi becomes env-global; the `Copy` handle is then shared.
pub fn cached_db(env: &heed::Env, name: &str) -> Option<Database<Bytes, Str>> {
    let key = format!("{}\u{1}{}", env.path().display(), name);
    let mut g = DB_HANDLES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(db) = g.get(&key) {
        return Some(*db);
    }
    let rtxn = env.read_txn().ok()?;
    let db = env
        .open_database::<Bytes, Str>(&rtxn, Some(name))
        .ok()
        .flatten()
        .or_else(|| env.open_database::<Bytes, Str>(&rtxn, None).ok().flatten())?;
    rtxn.commit().ok()?;
    g.insert(key, db);
    Some(db)
}

/// Open a read txn and the named DB in one shot, with a shared lifetime.
fn open_read_db<'a>(
    env: &'a heed::Env,
    name: &str,
) -> Option<(heed::RoTxn<'a>, Database<Bytes, Str>)> {
    let db = cached_db(env, name)?;
    let rtxn = env.read_txn().ok()?;
    Some((rtxn, db))
}

/// Resolve a slice of 64-bit WAD path hashes. Unresolved entries fall back to
/// their 16-char hex form, which is the format downstream code expects.
pub fn resolve_hashes_lmdb(hashes: &[u64], env: &heed::Env) -> Vec<String> {
    let Some((rtxn, db)) = open_read_db(env, "wad") else {
        return hashes.iter().map(|h| format!("{:016x}", h)).collect();
    };

    hashes
        .iter()
        .map(|h| {
            let key = h.to_be_bytes();
            db.get(&rtxn, &key[..])
                .ok()
                .flatten()
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("{:016x}", h))
        })
        .collect()
}

/// Bulk WAD hash resolution, parallelized across rayon.
///
/// Returns a [`ResolvedHashes`] containing **only the hashes that resolved** to
/// a real path. Misses are omitted — callers that need a hex fallback produce
/// it themselves.
pub fn resolve_hashes_lmdb_bulk(
    hashes: &[u64],
    env: &heed::Env,
) -> ResolvedHashes {
    use rayon::prelude::*;

    if hashes.is_empty() {
        return ResolvedHashes::default();
    }

    let Some((probe_txn, _)) = open_read_db(env, "wad") else {
        return ResolvedHashes::default();
    };
    drop(probe_txn);

    const CHUNK: usize = 64 * 1024;
    const ARENA_GUESS_PER_HASH: usize = 20;

    let partials: Vec<ResolvedHashes> = hashes
        .par_chunks(CHUNK)
        .map(|chunk| {
            let Some((rtxn, db)) = open_read_db(env, "wad") else {
                return ResolvedHashes::default();
            };
            let mut local = ResolvedHashes::with_capacity(
                chunk.len() / 2,
                chunk.len() * ARENA_GUESS_PER_HASH,
            );
            for h in chunk {
                let key = h.to_be_bytes();
                if let Ok(Some(s)) = db.get(&rtxn, &key[..]) {
                    local.insert(*h, s);
                }
            }
            local
        })
        .collect();

    let total_entries: usize = partials.iter().map(|p| p.len()).sum();
    let total_arena: usize = partials.iter().map(|p| p.arena.len()).sum();
    let mut out = ResolvedHashes::with_capacity(total_entries, total_arena);
    for p in partials {
        out.extend_arena(p);
    }
    out
}

/// Resolves 32-bit FNV1a BIN hashes; unresolved entries fall back to 8-char hex.
pub fn resolve_bin_hashes_lmdb(hashes: &[u32], env: &heed::Env) -> HashMap<u32, String> {
    let Some((rtxn, db)) = open_read_db(env, "bin") else {
        return hashes.iter().map(|h| (*h, format!("{:08x}", h))).collect();
    };

    hashes
        .iter()
        .map(|h| {
            let key = h.to_be_bytes();
            let resolved = db
                .get(&rtxn, &key[..])
                .ok()
                .flatten()
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("{:08x}", h));
            (*h, resolved)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_overwrites_on_a_duplicate_key() {
        let mut r = ResolvedHashes::new();
        r.insert(7, "assets/first.dds");
        r.insert(7, "assets/second.dds");

        // resolve_wad_bulk layers overlay hits over LMDB results by re-inserting
        // the same hash — if insert did not overwrite, the overlay would
        // silently lose to the global database.
        assert_eq!(r.get(&7), Some("assets/second.dds"));
        assert_eq!(r.len(), 1);
    }
}
