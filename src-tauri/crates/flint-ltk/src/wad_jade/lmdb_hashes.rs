//! LMDB hash lookup for WAD path hashes (xxh64 u64) and BIN names (FNV1a u32).

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
    layout_root: PathBuf,
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

/// Returns `true` when at least one env was loaded; `false` if neither
/// layout is present (caller should trigger [`super::download_combined_hashes`]).
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

/// Call this before overwriting `data.mdb` on Windows so the memory map
/// is released. Next lookup re-opens lazily; the on-disk hash dir is untouched.
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

/// Checks the extracted-overlay first, then LMDB, then falls back to the
/// 16-char hex form.
pub fn resolve_wad(hash: u64, hash_dir: &Path) -> String {
    let overlay = wad_overlay(hash_dir);
    if let Some(p) = overlay.get(&hash) {
        return p.as_ref().to_string();
    }

    let Some(env) = clone_wad_env(hash_dir) else {
        return format!("{:016x}", hash);
    };
    let Some(db) = crate::hash::lmdb_cache::cached_db(&env, "wad") else {
        return format!("{:016x}", hash);
    };
    let Ok(rtxn) = env.read_txn() else {
        return format!("{:016x}", hash);
    };
    db.get(&rtxn, &hash.to_be_bytes()[..])
        .ok()
        .flatten()
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{:016x}", hash))
}

/// Bulk WAD hash resolution — single read txn for the whole batch. The
/// extracted-overlay is layered first. Returns a `HashMap<hash, path>`.
pub fn resolve_wad_bulk(hashes: &[u64], hash_dir: &Path) -> HashMap<u64, String> {
    let mut out: HashMap<u64, String> = HashMap::with_capacity(hashes.len());

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
    let db = match crate::hash::lmdb_cache::cached_db(&env, "wad") {
        Some(db) => db,
        None => {
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
/// overlay → cached LMDB.
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
        let db = crate::hash::lmdb_cache::cached_db(&env, "bin")?;
        let rtxn = env.read_txn().ok()?;
        let bytes = db.get(&rtxn, &hash.to_be_bytes()[..]).ok().flatten()?;
        Some(Arc::from(bytes))
    })();

    let g = cache_slot().lock();
    if let Some(c) = g.as_ref() {
        c.bin_lookups.lock().insert(hash, result.clone());
    }
    result
}

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
        let db = crate::hash::lmdb_cache::cached_db(&env, "wad")?;
        let rtxn = env.read_txn().ok()?;
        let bytes = db.get(&rtxn, &hash.to_be_bytes()[..]).ok().flatten()?;
        Some(Arc::from(bytes))
    })();

    let g = cache_slot().lock();
    if let Some(c) = g.as_ref() {
        c.wad_lookups.lock().insert(hash, result.clone());
    }
    result
}

/// Snapshot of which named DBs are currently cached.
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
