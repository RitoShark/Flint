//! LMDB-backed dictionary mapping BIN hashes to their names.

use parking_lot::RwLock;
use ritoshark::hash::HashMapper;
use std::collections::BTreeMap;
use std::sync::OnceLock;

fn merge_custom_hashes(hashes: &mut HashMapper, hash_dir: &str) -> usize {
    let Some(env) = crate::hash::get_custom_env(hash_dir) else {
        return 0;
    };
    let Some(db) = crate::hash::lmdb_cache::cached_db(&env, "custom") else {
        return 0;
    };
    let Ok(rtxn) = env.read_txn() else {
        return 0;
    };
    let Ok(iter) = db.iter(&rtxn) else {
        return 0;
    };
    let mut count = 0;
    for (key, name) in iter.flatten() {
        if key.len() == 4 {
            let hash = u32::from_be_bytes([key[0], key[1], key[2], key[3]]);
            hashes.insert(hash as u64, name.to_string());
            count += 1;
        }
    }
    count
}

/// Load BIN hashes from `hashes-bin.lmdb` (named DB `"bin"`, 4-byte BE keys).
///
/// The lmdb-hashes release bundles all 4 BIN hash categories (entries, fields,
/// hashes, types) into a single DB keyed by FNV1a-32. `rs_bin::to_text` resolves
/// every u32 hash by widening it to `u64` (`mapper.get(hash as u64)`), so we
/// insert each 32-bit key as `hash as u64` and a single map covers all categories.
pub fn load_bin_hashes() -> HashMapper {
    use crate::hash::{downloader::get_hash_dir, get_bin_env};

    let mut hashes = HashMapper::new();

    let hash_dir = match get_hash_dir() {
        Ok(dir) => dir.to_string_lossy().into_owned(),
        Err(e) => {
            tracing::warn!("Failed to get hash directory: {}", e);
            return hashes;
        }
    };

    let env = match get_bin_env(&hash_dir) {
        Some(e) => e,
        None => {
            tracing::warn!("BIN LMDB not found at {}/hashes-bin.lmdb — BIN hashes unavailable", hash_dir);
            return hashes;
        }
    };

    // Open (and cache) the "bin" dbi handle BEFORE starting the read txn.
    // `cached_db` performs the first-ever `mdb_dbi_open` for this dbi in its own
    // txn and COMMITS it. If we opened the read txn first, its snapshot would
    // predate that commit and the named DB would be invisible in it — the
    // iterator then yields zero entries, the OnceLock caches an empty map, and
    // every BIN conversion shows raw hashes forever (observed after a cold LMDB
    // start). Mirror the working WAD path (`open_read_db`): dbi first, txn after.
    let db = match crate::hash::lmdb_cache::cached_db(&env, "bin") {
        Some(d) => d,
        None => {
            tracing::warn!("BIN LMDB has no 'bin' named database");
            return hashes;
        }
    };

    let rtxn = match env.read_txn() {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("Failed to open BIN LMDB read txn: {}", e);
            return hashes;
        }
    };

    let iter = match db.iter(&rtxn) {
        Ok(i) => i,
        Err(e) => {
            tracing::warn!("Failed to create BIN LMDB iterator: {}", e);
            return hashes;
        }
    };

    let mut count = 0;
    for result in iter {
        match result {
            Ok((key_bytes, path_str)) => {
                if key_bytes.len() == 4 {
                    let hash = u32::from_be_bytes([
                        key_bytes[0], key_bytes[1], key_bytes[2], key_bytes[3],
                    ]);
                    hashes.insert(hash as u64, path_str.to_string());
                    count += 1;
                }
            }
            Err(e) => {
                tracing::warn!("Error reading BIN LMDB entry: {}", e);
            }
        }
    }

    let custom_count = merge_custom_hashes(&mut hashes, &hash_dir);
    tracing::info!("Loaded {} BIN hashes and {} custom hashes", count, custom_count);
    hashes
}

fn write_custom_bin_hashes(
    env: &heed::Env,
    entries: &BTreeMap<u32, String>,
) -> Result<usize, String> {
    let mut wtxn = env.write_txn().map_err(|e| e.to_string())?;
    let db = env
        .create_database::<heed::types::Bytes, heed::types::Str>(&mut wtxn, Some("custom"))
        .map_err(|e| e.to_string())?;
    let mut changed = 0;
    for (hash, name) in entries {
        let key = hash.to_be_bytes();
        if db.get(&wtxn, &key[..]).map_err(|e| e.to_string())? != Some(name.as_str()) {
            db.put(&mut wtxn, &key[..], name)
                .map_err(|e| e.to_string())?;
            changed += 1;
        }
    }
    wtxn.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

pub fn save_custom_bin_hashes(entries: &BTreeMap<u32, String>) -> Result<usize, String> {
    if entries.is_empty() {
        return Ok(0);
    }
    let hash_dir = crate::hash::get_hash_dir().map_err(|e| e.to_string())?;
    let hash_dir = hash_dir.to_string_lossy().into_owned();
    let env = crate::hash::get_or_create_custom_env(&hash_dir)
        .ok_or_else(|| "Failed to open custom hash database".to_string())?;
    let changed = write_custom_bin_hashes(&env, entries)?;
    let mut cache = get_cached_bin_hashes().write();
    for (hash, name) in entries {
        cache.insert(*hash as u64, name.clone());
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use heed::types::{Bytes, Str};
    use heed::EnvOpenOptions;

    #[test]
    fn custom_hashes_round_trip_through_the_custom_database() {
        let dir = std::env::temp_dir().join(format!(
            "flint-custom-hashes-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let env = unsafe {
            EnvOpenOptions::new()
                .map_size(1024 * 1024)
                .max_dbs(2)
                .open(&dir)
                .unwrap()
        };
        let entries = BTreeMap::from([(0x1234_5678, "FlintCustomName".to_string())]);
        assert_eq!(write_custom_bin_hashes(&env, &entries).unwrap(), 1);
        assert_eq!(write_custom_bin_hashes(&env, &entries).unwrap(), 0);
        let rtxn = env.read_txn().unwrap();
        let db = env
            .open_database::<Bytes, Str>(&rtxn, Some("custom"))
            .unwrap()
            .unwrap();
        assert_eq!(
            db.get(&rtxn, &0x1234_5678u32.to_be_bytes()).unwrap(),
            Some("FlintCustomName")
        );
        drop(rtxn);
        drop(env);
        let _ = std::fs::remove_dir_all(dir);
    }
}

static BIN_HASHES_CACHE: OnceLock<RwLock<HashMapper>> = OnceLock::new();

/// Thread-safe; loads hashes from disk once, then serves the cached map.
///
/// Self-heals an empty init: if the very first load returned nothing (LMDB not
/// yet downloaded, or a cold-start snapshot race), the `OnceLock` would
/// otherwise freeze that empty map forever and every BIN conversion would show
/// raw hashes. Instead, an empty cache is retried lazily on the next call, so a
/// later download / warm env fills it without an explicit `reload_bin_hash_cache`.
pub fn get_cached_bin_hashes() -> &'static RwLock<HashMapper> {
    let cache = BIN_HASHES_CACHE.get_or_init(|| {
        tracing::info!("Initializing global BIN hash cache...");
        let hashes = load_bin_hashes();
        tracing::info!("Global BIN hash cache initialized with {} hashes", hashes.len());
        RwLock::new(hashes)
    });

    if cache.read().is_empty() {
        let reloaded = load_bin_hashes();
        if !reloaded.is_empty() {
            tracing::info!("BIN hash cache was empty — reloaded {} hashes", reloaded.len());
            *cache.write() = reloaded;
        }
    }

    cache
}

/// Call after updating hash files on disk.
pub fn reload_bin_hash_cache() {
    if let Some(cache) = BIN_HASHES_CACHE.get() {
        tracing::info!("Reloading BIN hash cache from disk...");
        let new_hashes = load_bin_hashes();
        let total = new_hashes.len();
        *cache.write() = new_hashes;
        tracing::info!("BIN hash cache reloaded with {} hashes", total);
    }
}
