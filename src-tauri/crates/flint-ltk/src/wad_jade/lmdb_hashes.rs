//! LMDB hash lookup for WAD path hashes (xxh64 u64) and BIN names (FNV1a u32).
//!
//! Two on-disk layouts are supported transparently:
//!
//! - **Split layout** — Quartz's: `hashes-wad.lmdb/data.mdb` (named DB
//!   `"wad"`) and `hashes-bin.lmdb/data.mdb` (named DB `"bin"`). When this
//!   exists in the FrogTools dir we reuse it without downloading.
//!
//! - **Combined layout** — what `lol-hashes-combined.zst` decompresses to:
//!   `hashes-combined.lmdb/data.mdb` with both `"wad"` and `"bin"` named
//!   DBs in the same env.
//!
//! Lookup is layout-agnostic — it always opens by name (`"wad"` or
//! `"bin"`) inside whichever env was loaded. Envs are opened lazily on
//! the first lookup and cached process-wide; subsequent reads reuse a
//! cheap per-call `read_txn()` (sub-microsecond on a warm env).

use heed::types::{Bytes, Str};
use heed::EnvOpenOptions;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use super::extracted_overlay::{bin_overlay, wad_overlay};
use super::hash_downloader::{detect_layout, HashLayout};

struct EnvCache {
    wad: Option<Arc<heed::Env>>,
    bin: Option<Arc<heed::Env>>,
    /// Path the envs were opened from. Used to invalidate the cache if a
    /// different `hash_dir` is queried (rare — only matters during tests).
    layout_root: PathBuf,
    /// In-memory result cache layered in front of LMDB. Per-call LMDB
    /// lookups are 1-5 µs each (mutex + read_txn + open_database +
    /// B-tree get + Arc allocation), and the BIN converter calls the
    /// same handful of field-name hashes ("value", "name", "x", "y",
    /// …) tens of thousands of times per file. Storing the resolved
    /// names lets us skip the LMDB roundtrip after the first hit;
    /// `None` is also cached so unknown hashes don't repeatedly hit
    /// the database. Memory cost is bounded by the number of unique
    /// hashes the converter touches — typically <50K entries per BIN
    /// (a few MB), and reused across files in the same session.
    bin_lookups: Mutex<HashMap<u32, Option<Arc<str>>>>,
    wad_lookups: Mutex<HashMap<u64, Option<Arc<str>>>>,
}

static ENV_CACHE: OnceLock<Mutex<Option<EnvCache>>> = OnceLock::new();

fn cache_slot() -> &'static Mutex<Option<EnvCache>> {
    ENV_CACHE.get_or_init(|| Mutex::new(None))
}

fn open_env(lmdb_dir: &Path) -> Option<Arc<heed::Env>> {
    if !lmdb_dir.join("data.mdb").exists() {
        return None;
    }
    // 1 GB virtual address reservation; the OS pages in only what we touch.
    // max_dbs(2) lets the combined env open both "wad" and "bin" by name.
    let result = unsafe {
        EnvOpenOptions::new()
            .map_size(1024 * 1024 * 1024)
            .max_dbs(2)
            .open(lmdb_dir)
    };
    match result {
        Ok(env) => Some(Arc::new(env)),
        Err(e) => {
            eprintln!("[WadHashes] Failed to open LMDB at {}: {}", lmdb_dir.display(), e);
            None
        }
    }
}

/// Open whichever layout is on disk, caching both envs. Returns `true`
/// when at least one env was loaded; `false` if neither layout is present
/// (caller should trigger [`super::download_combined_hashes`]).
pub fn preload_envs(hash_dir: &Path) -> bool {
    let (wad, bin) = match detect_layout(hash_dir) {
        HashLayout::Split => {
            let wad = open_env(&hash_dir.join("hashes-wad.lmdb"));
            let bin = open_env(&hash_dir.join("hashes-bin.lmdb"));
            (wad, bin)
        }
        HashLayout::Combined => {
            let env = open_env(&hash_dir.join("hashes-combined.lmdb"));
            (env.clone(), env)
        }
        HashLayout::Missing => (None, None),
    };

    if wad.is_none() && bin.is_none() {
        return false;
    }

    let mut g = cache_slot().lock();
    *g = Some(EnvCache {
        wad,
        bin,
        layout_root: hash_dir.to_path_buf(),
        bin_lookups: Mutex::new(HashMap::new()),
        wad_lookups: Mutex::new(HashMap::new()),
    });
    true
}

/// Drop the cached envs. Next lookup re-opens lazily; the on-disk hash
/// dir is untouched. Call this before overwriting `data.mdb` on Windows
/// so the memory map is released.
pub fn unload_envs() {
    let mut g = cache_slot().lock();
    *g = None;
}

fn ensure_loaded(hash_dir: &Path) -> bool {
    {
        let g = cache_slot().lock();
        if let Some(c) = g.as_ref() {
            if c.layout_root == hash_dir {
                return c.wad.is_some() || c.bin.is_some();
            }
        }
    }
    preload_envs(hash_dir)
}

fn clone_wad_env(hash_dir: &Path) -> Option<Arc<heed::Env>> {
    if !ensure_loaded(hash_dir) {
        return None;
    }
    let g = cache_slot().lock();
    g.as_ref()?.wad.clone()
}

fn clone_bin_env(hash_dir: &Path) -> Option<Arc<heed::Env>> {
    if !ensure_loaded(hash_dir) {
        return None;
    }
    let g = cache_slot().lock();
    g.as_ref()?.bin.clone()
}

/// Resolve a single WAD path hash. Checks the extracted-overlay first
/// (so user discoveries win over LMDB), then LMDB, then falls back to
/// the 16-char hex form.
pub fn resolve_wad(hash: u64, hash_dir: &Path) -> String {
    let overlay = wad_overlay(hash_dir);
    if let Some(p) = overlay.get(&hash) {
        return p.as_ref().to_string();
    }

    let Some(env) = clone_wad_env(hash_dir) else {
        return format!("{:016x}", hash);
    };
    let Ok(rtxn) = env.read_txn() else {
        return format!("{:016x}", hash);
    };
    let Ok(Some(db)) = env.open_database::<Bytes, Str>(&rtxn, Some("wad")) else {
        return format!("{:016x}", hash);
    };
    db.get(&rtxn, &hash.to_be_bytes()[..])
        .ok()
        .flatten()
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{:016x}", hash))
}

/// Bulk WAD hash resolution — single read txn for the whole batch. The
/// extracted-overlay is layered first so user-discovered names win over
/// LMDB. Returns a `HashMap<hash, path>` so callers can dedupe + index
/// in O(1).
#[allow(dead_code)] // Used by the WAD tree builder in `mount.rs`.
pub fn resolve_wad_bulk(hashes: &[u64], hash_dir: &Path) -> HashMap<u64, String> {
    let mut out: HashMap<u64, String> = HashMap::with_capacity(hashes.len());

    // Pass 1 — overlay. Cheap (already-loaded HashMap) and authoritative.
    let overlay = wad_overlay(hash_dir);
    if !overlay.is_empty() {
        for &h in hashes {
            if let Some(p) = overlay.get(&h) {
                out.insert(h, p.as_ref().to_string());
            }
        }
    }

    let Some(env) = clone_wad_env(hash_dir) else {
        for &h in hashes {
            out.entry(h).or_insert_with(|| format!("{:016x}", h));
        }
        return out;
    };
    let Ok(rtxn) = env.read_txn() else {
        for &h in hashes {
            out.entry(h).or_insert_with(|| format!("{:016x}", h));
        }
        return out;
    };
    let db = match env.open_database::<Bytes, Str>(&rtxn, Some("wad")) {
        Ok(Some(db)) => db,
        _ => {
            for &h in hashes {
                out.entry(h).or_insert_with(|| format!("{:016x}", h));
            }
            return out;
        }
    };

    for &h in hashes {
        if out.contains_key(&h) {
            continue;
        }
        let resolved = db
            .get(&rtxn, &h.to_be_bytes()[..])
            .ok()
            .flatten()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{:016x}", h));
        out.insert(h, resolved);
    }
    out
}

/// Resolve a single BIN name hash (FNV1a u32) via the extracted-name
/// overlay → cached LMDB. The BIN converter doesn't go through this
/// path anymore (it uses an in-RAM text table loaded via
/// `HashManager`), but other callers — mainly the WAD listing/extract
/// pipeline that resolves BIN-property names — still come through
/// here so we keep LMDB live for them.
pub fn lookup_bin(hash: u32, hash_dir: &Path) -> Option<Arc<str>> {
    let overlay = bin_overlay(hash_dir);
    if let Some(p) = overlay.get(&hash) {
        return Some(Arc::clone(p));
    }

    {
        let g = cache_slot().lock();
        if let Some(c) = g.as_ref() {
            if let Some(entry) = c.bin_lookups.lock().get(&hash) {
                return entry.as_ref().cloned();
            }
        }
    }

    let env = clone_bin_env(hash_dir)?;
    let result: Option<Arc<str>> = (|| {
        let rtxn = env.read_txn().ok()?;
        let db = env
            .open_database::<Bytes, Str>(&rtxn, Some("bin"))
            .ok()
            .flatten()?;
        let bytes = db.get(&rtxn, &hash.to_be_bytes()[..]).ok().flatten()?;
        Some(Arc::from(bytes))
    })();

    let g = cache_slot().lock();
    if let Some(c) = g.as_ref() {
        c.bin_lookups.lock().insert(hash, result.clone());
    }
    result
}

/// Resolve a single WAD path hash via overlay → cached LMDB.
pub fn lookup_wad(hash: u64, hash_dir: &Path) -> Option<Arc<str>> {
    let overlay = wad_overlay(hash_dir);
    if let Some(p) = overlay.get(&hash) {
        return Some(Arc::clone(p));
    }

    {
        let g = cache_slot().lock();
        if let Some(c) = g.as_ref() {
            if let Some(entry) = c.wad_lookups.lock().get(&hash) {
                return entry.as_ref().cloned();
            }
        }
    }

    let env = clone_wad_env(hash_dir)?;
    let result: Option<Arc<str>> = (|| {
        let rtxn = env.read_txn().ok()?;
        let db = env
            .open_database::<Bytes, Str>(&rtxn, Some("wad"))
            .ok()
            .flatten()?;
        let bytes = db.get(&rtxn, &hash.to_be_bytes()[..]).ok().flatten()?;
        Some(Arc::from(bytes))
    })();

    let g = cache_slot().lock();
    if let Some(c) = g.as_ref() {
        c.wad_lookups.lock().insert(hash, result.clone());
    }
    result
}

/// Snapshot of which named DBs are currently cached. Driven by the UI to
/// show a "hashes ready" indicator without forcing a load.
#[derive(Debug, Clone, Copy)]
pub struct LoadedStats {
    pub wad_loaded: bool,
    pub bin_loaded: bool,
}

pub fn loaded_stats(hash_dir: &Path) -> LoadedStats {
    let g = cache_slot().lock();
    let cache = g.as_ref().filter(|c| c.layout_root == hash_dir);
    LoadedStats {
        wad_loaded: cache.is_some_and(|c| c.wad.is_some()),
        bin_loaded: cache.is_some_and(|c| c.bin.is_some()),
    }
}
