//! Global LMDB environment cache.
//!
//! Two separate LMDBs:
//! - `hashes-wad.lmdb` — named DB `"wad"`, 8-byte BE keys (xxh64), WAD path hashes.
//! - `hashes-bin.lmdb` — named DBs `"binentries"`, `"bintypes"`, `"binfields"`, `"binhashes"` (or legacy `"bin"`), 4-byte BE keys (FNV1a), BIN hashes.

use heed::types::{Bytes, Str};
use heed::{Database, EnvOpenOptions};
use rustc_hash::FxHashMap;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicU64, Ordering};

pub const BIN_V2_TABLES: [&str; 4] = ["binentries", "bintypes", "binfields", "binhashes"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinHashCategory {
    Entries,
    Types,
    Fields,
    Hashes,
}

impl BinHashCategory {
    pub const ALL: [Self; 4] = [Self::Entries, Self::Types, Self::Fields, Self::Hashes];

    pub const fn db_name(self) -> &'static str {
        match self {
            Self::Entries => "binentries",
            Self::Types => "bintypes",
            Self::Fields => "binfields",
            Self::Hashes => "binhashes",
        }
    }
}

static DATABASE_REVISION: AtomicU64 = AtomicU64::new(0);

pub fn database_revision() -> u64 {
    DATABASE_REVISION.load(Ordering::Acquire)
}

#[derive(Default, Clone)]
pub struct ResolvedHashes {
    arena: Vec<u8>,
    index: FxHashMap<u64, (u32, u32)>,
}

impl ResolvedHashes {
    pub fn new() -> Self { Self::default() }

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
        Some(unsafe { std::str::from_utf8_unchecked(&self.arena[start..end]) })
    }

    pub fn contains_key(&self, hash: &u64) -> bool { self.index.contains_key(hash) }

    pub fn iter(&self) -> impl Iterator<Item = (u64, &str)> + '_ {
        let arena = &self.arena;
        self.index.iter().map(move |(h, (off, len))| {
            let start = *off as usize;
            let end = start + *len as usize;
            (*h, unsafe { std::str::from_utf8_unchecked(&arena[start..end]) })
        })
    }

    pub fn len(&self) -> usize { self.index.len() }
    pub fn is_empty(&self) -> bool { self.index.is_empty() }

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

struct EnvCache {
    key: String,
    env: Arc<heed::Env>,
}

static WAD_LMDB_CACHE: OnceLock<Mutex<Option<EnvCache>>> = OnceLock::new();
static BIN_LMDB_CACHE: OnceLock<Mutex<Option<EnvCache>>> = OnceLock::new();
static CUSTOM_LMDB_CACHE: OnceLock<Mutex<Option<EnvCache>>> = OnceLock::new();

fn wad_mutex() -> &'static Mutex<Option<EnvCache>> {
    WAD_LMDB_CACHE.get_or_init(|| Mutex::new(None))
}

fn bin_mutex() -> &'static Mutex<Option<EnvCache>> {
    BIN_LMDB_CACHE.get_or_init(|| Mutex::new(None))
}

fn custom_mutex() -> &'static Mutex<Option<EnvCache>> {
    CUSTOM_LMDB_CACHE.get_or_init(|| Mutex::new(None))
}

fn open_env(lmdb_dir: &Path) -> Option<heed::Env> {
    if !lmdb_dir.join("data.mdb").exists() {
        tracing::debug!("LMDB data.mdb missing at: {}", lmdb_dir.display());
        return None;
    }

    match unsafe {
        EnvOpenOptions::new()
            .map_size(1024 * 1024 * 1024)
            .max_dbs(8)
            .open(lmdb_dir)
    } {
        Ok(e) => Some(e),
        Err(e) => {
            tracing::warn!("Failed to open LMDB at {}: {}", lmdb_dir.display(), e);
            None
        }
    }
}

fn create_env(lmdb_dir: &Path) -> Option<heed::Env> {
    std::fs::create_dir_all(lmdb_dir).ok()?;
    match unsafe {
        EnvOpenOptions::new()
            .map_size(64 * 1024 * 1024)
            .max_dbs(8)
            .open(lmdb_dir)
    } {
        Ok(e) => Some(e),
        Err(e) => {
            tracing::warn!("Failed to create LMDB at {}: {}", lmdb_dir.display(), e);
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

pub fn get_wad_env(hash_dir: &str) -> Option<Arc<heed::Env>> {
    let lmdb_dir = Path::new(hash_dir).join("hashes-wad.lmdb");
    get_cached_env(wad_mutex(), &lmdb_dir)
}

pub fn get_bin_env(hash_dir: &str) -> Option<Arc<heed::Env>> {
    let lmdb_dir = Path::new(hash_dir).join("hashes-bin.lmdb");
    get_cached_env(bin_mutex(), &lmdb_dir)
}

pub fn get_custom_env(hash_dir: &str) -> Option<Arc<heed::Env>> {
    let lmdb_dir = Path::new(hash_dir).join("hashes-custom.lmdb");
    get_cached_env(custom_mutex(), &lmdb_dir)
}

pub fn get_or_create_custom_env(hash_dir: &str) -> Option<Arc<heed::Env>> {
    let lmdb_dir = Path::new(hash_dir).join("hashes-custom.lmdb");
    let key = lmdb_dir.to_string_lossy().into_owned();
    let mut g = custom_mutex().lock().unwrap_or_else(|e| e.into_inner());

    if let Some(ref cache) = *g {
        if cache.key == key {
            return Some(Arc::clone(&cache.env));
        }
    }

    let env = create_env(&lmdb_dir)?;
    let arc = Arc::new(env);
    *g = Some(EnvCache { key, env: Arc::clone(&arc) });
    Some(arc)
}

pub fn get_or_open_env(hash_dir: &str) -> Option<Arc<heed::Env>> {
    get_wad_env(hash_dir)
}

pub fn drop_lmdb_cache() {
    {
        let mut g = wad_mutex().lock().unwrap_or_else(|e| e.into_inner());
        *g = None;
    }
    {
        let mut g = bin_mutex().lock().unwrap_or_else(|e| e.into_inner());
        *g = None;
    }
    {
        let mut g = custom_mutex().lock().unwrap_or_else(|e| e.into_inner());
        *g = None;
    }
    if let Some(m) = DB_HANDLES.get() {
        m.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
    tracing::debug!("LMDB env caches cleared");
}

static DB_HANDLES: OnceLock<Mutex<HashMap<String, Database<Bytes, Str>>>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn install_database(source: &Path, target: &Path, name: &str) -> heed::Result<()> {
    install_databases(source, target, &[name])
}

pub(crate) fn install_databases(source: &Path, target: &Path, names: &[&str]) -> heed::Result<()> {
    let staged = unsafe {
        EnvOpenOptions::new()
            .max_dbs(8)
            .flags(heed::EnvFlags::NO_SUB_DIR | heed::EnvFlags::READ_ONLY | heed::EnvFlags::NO_LOCK)
            .open(source)?
    };
    let result = (|| {
        let read = staged.read_txn()?;
        let mut inputs = Vec::with_capacity(names.len());
        for &name in names {
            let input = staged
                .open_database::<Bytes, Str>(&read, Some(name))?
                .ok_or(heed::Error::Mdb(heed::MdbError::NotFound))?;
            inputs.push((name, input));
        }
        let env = unsafe {
            EnvOpenOptions::new()
                .map_size(1024 * 1024 * 1024)
                .max_dbs(8)
                .open(target)?
        };
        let mut handles = DB_HANDLES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut write = env.write_txn()?;
        let mut outputs = Vec::with_capacity(inputs.len());
        for &(name, input) in &inputs {
            let output = env.create_database::<Bytes, Str>(&mut write, Some(name))?;
            outputs.push((name, input, output));
        }
        write.commit()?;
        for &(name, _, output) in &outputs {
            handles.insert(format!("{}\u{1}{}", env.path().display(), name), output);
        }
        drop(handles);

        let mut write = env.write_txn()?;
        if names == BIN_V2_TABLES {
            if let Some(legacy) = env.open_database::<Bytes, Str>(&write, Some("bin"))? {
                legacy.clear(&mut write)?;
            }
        }
        for (_, input, output) in outputs {
            output.clear(&mut write)?;
            for entry in input.iter(&read)? {
                let (key, value) = entry?;
                output.put(&mut write, key, value)?;
            }
        }
        write.commit()?;
        DATABASE_REVISION.fetch_add(1, Ordering::Release);
        Ok(())
    })();
    staged.prepare_for_closing().wait();
    result
}

/// SAFETY-CRITICAL: LMDB forbids concurrent `mdb_dbi_open` within a process —
/// it mutates the env's dbi slot table without locking, and heed 0.20 adds no
/// serialization. The opening txn is COMMITTED so the dbi becomes env-global.
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
        .flatten()?;
    rtxn.commit().ok()?;
    g.insert(key, db);
    Some(db)
}

pub fn has_v2_bin_tables(env: &heed::Env) -> bool {
    BIN_V2_TABLES.iter().any(|name| cached_db(env, name).is_some())
}

pub fn open_bin_dbs(env: &heed::Env) -> Vec<(&'static str, Database<Bytes, Str>)> {
    let mut dbs: Vec<(&'static str, Database<Bytes, Str>)> = BIN_V2_TABLES
        .iter()
        .filter_map(|&name| cached_db(env, name).map(|db| (name, db)))
        .collect();
    if dbs.is_empty() {
        if let Some(db) = cached_db(env, "bin") {
            dbs.push(("bin", db));
        }
    }
    dbs
}

pub fn primary_bin_hashes_db_name(env: &heed::Env) -> &'static str {
    if has_v2_bin_tables(env) {
        "binhashes"
    } else {
        "bin"
    }
}

pub fn lookup_bin_in_env(env: &heed::Env, hash: u32) -> Option<String> {
    let dbs = open_bin_dbs(env);
    if dbs.is_empty() {
        return None;
    }
    let rtxn = env.read_txn().ok()?;
    let key = hash.to_be_bytes();
    for (_, db) in dbs {
        if let Ok(Some(value)) = db.get(&rtxn, &key[..]) {
            return Some(value.to_string());
        }
    }
    None
}

pub fn resolve_bin_hash_in_category(
    hash: u32,
    category: BinHashCategory,
    env: &heed::Env,
) -> Option<String> {
    let db = if has_v2_bin_tables(env) {
        cached_db(env, category.db_name())?
    } else {
        cached_db(env, "bin")?
    };
    let rtxn = env.read_txn().ok()?;
    let key = hash.to_be_bytes();
    db.get(&rtxn, &key[..]).ok().flatten().map(|s| s.to_string())
}

pub fn resolve_bin_hashes_by_category_lmdb(
    hashes: &[u32],
    category: BinHashCategory,
    env: &heed::Env,
) -> HashMap<u32, String> {
    let db = if has_v2_bin_tables(env) {
        cached_db(env, category.db_name())
    } else {
        cached_db(env, "bin")
    };
    let Some(db) = db else {
        return hashes.iter().map(|h| (*h, format!("{:08x}", h))).collect();
    };
    let Ok(rtxn) = env.read_txn() else {
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

fn open_read_db<'a>(
    env: &'a heed::Env,
    name: &str,
) -> Option<(heed::RoTxn<'a>, Database<Bytes, Str>)> {
    let db = cached_db(env, name)?;
    let rtxn = env.read_txn().ok()?;
    Some((rtxn, db))
}

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

pub fn resolve_bin_hashes_lmdb(hashes: &[u32], env: &heed::Env) -> HashMap<u32, String> {
    let dbs = open_bin_dbs(env);
    if dbs.is_empty() {
        return hashes.iter().map(|h| (*h, format!("{:08x}", h))).collect();
    }
    let Ok(rtxn) = env.read_txn() else {
        return hashes.iter().map(|h| (*h, format!("{:08x}", h))).collect();
    };

    hashes
        .iter()
        .map(|h| {
            let key = h.to_be_bytes();
            let resolved = dbs
                .iter()
                .find_map(|(_, db)| db.get(&rtxn, &key[..]).ok().flatten().map(|s| s.to_string()))
                .unwrap_or_else(|| format!("{:08x}", h));
            (*h, resolved)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_updates_live_readers_and_preserves_existing_snapshots() {
        let root = std::env::temp_dir().join(format!("flint-live-hash-install-{}-{}",
            std::process::id(), std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        for name in ["wad", "bin"] {
            let target = root.join(name);
            std::fs::create_dir_all(&target).unwrap();
            let env = unsafe { EnvOpenOptions::new().map_size(1024 * 1024 * 1024)
                .max_dbs(8).open(&target).unwrap() };
            let mut write = env.write_txn().unwrap();
            let db = env.create_database::<Bytes, Str>(&mut write, Some(name)).unwrap();
            db.put(&mut write, b"old", "old value").unwrap();
            write.commit().unwrap();
            let db = cached_db(&env, name).unwrap();
            let snapshot = env.read_txn().unwrap();

            let source = root.join(format!("{name}.tmp"));
            let staged = unsafe { EnvOpenOptions::new().map_size(1024 * 1024)
                .max_dbs(8).flags(heed::EnvFlags::NO_SUB_DIR).open(&source).unwrap() };
            let mut write = staged.write_txn().unwrap();
            let input = staged.create_database::<Bytes, Str>(&mut write, Some(name)).unwrap();
            input.put(&mut write, b"new", "new value").unwrap();
            write.commit().unwrap();
            staged.prepare_for_closing().wait();

            let src = source.clone();
            let dst = target.clone();
            std::thread::spawn(move || install_database(&src, &dst, name)).join().unwrap().unwrap();
            assert_eq!(db.get(&snapshot, b"old").unwrap(), Some("old value"));
            assert_eq!(db.get(&snapshot, b"new").unwrap(), None);
            drop(snapshot);
            let current = env.read_txn().unwrap();
            assert_eq!(db.get(&current, b"old").unwrap(), None);
            assert_eq!(db.get(&current, b"new").unwrap(), Some("new value"));
            drop(current);

            let fresh = root.join(format!("fresh-{name}"));
            std::fs::create_dir_all(&fresh).unwrap();
            install_database(&source, &fresh, name).unwrap();
            let fresh_env = open_env(&fresh).unwrap();
            let read = fresh_env.read_txn().unwrap();
            let fresh_db = fresh_env.open_database::<Bytes, Str>(&read, Some(name)).unwrap().unwrap();
            assert_eq!(fresh_db.get(&read, b"new").unwrap(), Some("new value"));
            drop(read);
            fresh_env.prepare_for_closing().wait();

            assert!(install_database(&source, &target, "missing").is_err());
            let current = env.read_txn().unwrap();
            assert_eq!(db.get(&current, b"new").unwrap(), Some("new value"));
            drop(current);
            let staged = unsafe { EnvOpenOptions::new().map_size(1024 * 1024)
                .max_dbs(8).flags(heed::EnvFlags::NO_SUB_DIR).open(&source).unwrap() };
            let mut write = staged.write_txn().unwrap();
            let input = staged.create_database::<Bytes, Bytes>(&mut write, Some(name)).unwrap();
            input.put(&mut write, b"bad", &[0xff]).unwrap();
            write.commit().unwrap();
            staged.prepare_for_closing().wait();
            assert!(install_database(&source, &target, name).is_err());
            let current = env.read_txn().unwrap();
            assert_eq!(db.get(&current, b"new").unwrap(), Some("new value"));
            assert_eq!(db.get(&current, b"bad").unwrap(), None);
            drop(current);
            std::fs::remove_file(&source).unwrap();
            env.prepare_for_closing().wait();
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v2_bin_tables_resolve_by_category_and_ordered_lookup() {
        let root = std::env::temp_dir().join(format!(
            "flint-v2-bin-tables-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let source = root.join("bin.tmp");
        let target = root.join("hashes-bin.lmdb");
        std::fs::create_dir_all(&target).unwrap();

        let staged = unsafe {
            EnvOpenOptions::new()
                .map_size(1024 * 1024)
                .max_dbs(8)
                .flags(heed::EnvFlags::NO_SUB_DIR)
                .open(&source)
                .unwrap()
        };
        let mut write = staged.write_txn().unwrap();
        let entries_db = staged.create_database::<Bytes, Str>(&mut write, Some("binentries")).unwrap();
        let types_db = staged.create_database::<Bytes, Str>(&mut write, Some("bintypes")).unwrap();
        let fields_db = staged.create_database::<Bytes, Str>(&mut write, Some("binfields")).unwrap();
        let hashes_db = staged.create_database::<Bytes, Str>(&mut write, Some("binhashes")).unwrap();

        entries_db.put(&mut write, &0x1111_1111u32.to_be_bytes(), "Characters/Ahri/Skins/Skin0").unwrap();
        types_db.put(&mut write, &0x4247_cbb9u32.to_be_bytes(), "VfxSystemDefinitionData").unwrap();
        fields_db.put(&mut write, &0x3333_3333u32.to_be_bytes(), "particleName").unwrap();
        hashes_db.put(&mut write, &0x4444_4444u32.to_be_bytes(), "Ahri_Base_Q_Orb").unwrap();
        write.commit().unwrap();
        staged.prepare_for_closing().wait();

        install_databases(&source, &target, &BIN_V2_TABLES).unwrap();
        std::fs::remove_file(&source).unwrap();

        let env = open_env(&target).unwrap();
        assert!(has_v2_bin_tables(&env));
        assert_eq!(primary_bin_hashes_db_name(&env), "binhashes");

        assert_eq!(
            resolve_bin_hash_in_category(0x1111_1111, BinHashCategory::Entries, &env).as_deref(),
            Some("Characters/Ahri/Skins/Skin0")
        );
        assert_eq!(
            resolve_bin_hash_in_category(0x4247_cbb9, BinHashCategory::Types, &env).as_deref(),
            Some("VfxSystemDefinitionData")
        );
        assert_eq!(
            resolve_bin_hash_in_category(0x3333_3333, BinHashCategory::Fields, &env).as_deref(),
            Some("particleName")
        );
        assert_eq!(
            resolve_bin_hash_in_category(0x4444_4444, BinHashCategory::Hashes, &env).as_deref(),
            Some("Ahri_Base_Q_Orb")
        );
        assert_eq!(
            resolve_bin_hash_in_category(0x4247_cbb9, BinHashCategory::Fields, &env),
            None
        );

        let bulk = resolve_bin_hashes_lmdb(
            &[0x1111_1111, 0x4247_cbb9, 0x3333_3333, 0x4444_4444, 0xdead_beef],
            &env,
        );
        assert_eq!(bulk.get(&0x1111_1111).map(String::as_str), Some("Characters/Ahri/Skins/Skin0"));
        assert_eq!(bulk.get(&0x4247_cbb9).map(String::as_str), Some("VfxSystemDefinitionData"));
        assert_eq!(bulk.get(&0x3333_3333).map(String::as_str), Some("particleName"));
        assert_eq!(bulk.get(&0x4444_4444).map(String::as_str), Some("Ahri_Base_Q_Orb"));
        assert_eq!(bulk.get(&0xdead_beef).map(String::as_str), Some("deadbeef"));

        env.prepare_for_closing().wait();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn insert_overwrites_on_a_duplicate_key() {
        let mut r = ResolvedHashes::new();
        r.insert(7, "assets/first.dds");
        r.insert(7, "assets/second.dds");

        assert_eq!(r.get(&7), Some("assets/second.dds"));
        assert_eq!(r.len(), 1);
    }
}
