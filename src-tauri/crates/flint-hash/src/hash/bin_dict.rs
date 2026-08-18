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
        } else if key.len() == 8 {
            let hash = u64::from_be_bytes([
                key[0], key[1], key[2], key[3], key[4], key[5], key[6], key[7],
            ]);
            hashes.insert(hash, name.to_string());
            count += 1;
        }
    }
    count
}

fn merge_wad_hashes(hashes: &mut HashMapper, hash_dir: &str) -> usize {
    let Some(env) = crate::hash::get_wad_env(hash_dir) else {
        tracing::warn!("WAD LMDB not found at {}/hashes-wad.lmdb — WAD hashes unavailable for BIN resolving", hash_dir);
        return 0;
    };
    let Some(db) = crate::hash::lmdb_cache::cached_db(&env, "wad") else {
        tracing::warn!("WAD LMDB has no 'wad' named database");
        return 0;
    };
    let Ok(rtxn) = env.read_txn() else {
        tracing::warn!("Failed to open WAD LMDB read txn: {}", hash_dir);
        return 0;
    };
    let Ok(iter) = db.iter(&rtxn) else {
        tracing::warn!("Failed to create WAD LMDB iterator: {}", hash_dir);
        return 0;
    };
    let mut count = 0;
    for result in iter {
        match result {
            Ok((key_bytes, path_str)) => {
                if key_bytes.len() == 8 {
                    let hash = u64::from_be_bytes([
                        key_bytes[0], key_bytes[1], key_bytes[2], key_bytes[3],
                        key_bytes[4], key_bytes[5], key_bytes[6], key_bytes[7],
                    ]);
                    hashes.insert(hash, path_str.to_string());
                    count += 1;
                }
            }
            Err(e) => {
                tracing::warn!("Error reading WAD LMDB entry: {}", e);
            }
        }
    }
    count
}

fn merge_extracted_wad_overlay(hashes: &mut HashMapper, hash_dir: &str) -> usize {
    let path = std::path::Path::new(hash_dir).join("hashes.extracted.txt");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return 0;
    };
    let mut count = 0;
    for line in content.lines() {
        if let Some((h_str, path_str)) = line.split_once(' ') {
            if let Ok(h) = u64::from_str_radix(h_str.trim(), 16) {
                hashes.insert(h, path_str.trim().to_string());
                count += 1;
            }
        }
    }
    count
}

fn merge_extracted_bin_overlay(hashes: &mut HashMapper, hash_dir: &str) -> usize {
    let path = std::path::Path::new(hash_dir).join("hashes.binhashes.extracted.txt");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return 0;
    };
    let mut count = 0;
    for line in content.lines() {
        if let Some((h_str, path_str)) = line.split_once(' ') {
            if let Ok(h) = u32::from_str_radix(h_str.trim(), 16) {
                hashes.insert(h as u64, path_str.trim().to_string());
                count += 1;
            }
        }
    }
    count
}

/// Load BIN hashes from `hashes-bin.lmdb` (named DB `"bin"`, 4-byte BE keys)
/// and WAD hashes from `hashes-wad.lmdb` (named DB `"wad"`, 8-byte BE keys).
///
/// The lmdb-hashes release bundles all 4 BIN hash categories (entries, fields,
/// hashes, types) into a single DB keyed by FNV1a-32, and all WAD asset paths
/// into a DB keyed by xxHash64. `rs_bin::to_text` resolves every u32 hash by
/// widening it to `u64` (`mapper.get(hash as u64)`), and resolves 64-bit WAD
/// file references (`file = <xxh64>`) via `mapper.get(hash)`.
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

    let mut bin_count = 0;
    if let Some(env) = get_bin_env(&hash_dir) {
        // Open (and cache) the "bin" dbi handle BEFORE starting the read txn.
        if let Some(db) = crate::hash::lmdb_cache::cached_db(&env, "bin") {
            if let Ok(rtxn) = env.read_txn() {
                if let Ok(iter) = db.iter(&rtxn) {
                    for result in iter {
                        match result {
                            Ok((key_bytes, path_str)) => {
                                if key_bytes.len() == 4 {
                                    let hash = u32::from_be_bytes([
                                        key_bytes[0], key_bytes[1], key_bytes[2], key_bytes[3],
                                    ]);
                                    hashes.insert(hash as u64, path_str.to_string());
                                    bin_count += 1;
                                }
                            }
                            Err(e) => {
                                tracing::warn!("Error reading BIN LMDB entry: {}", e);
                            }
                        }
                    }
                } else {
                    tracing::warn!("Failed to create BIN LMDB iterator: {}", hash_dir);
                }
            } else {
                tracing::warn!("Failed to open BIN LMDB read txn: {}", hash_dir);
            }
        } else {
            tracing::warn!("BIN LMDB has no 'bin' named database");
        }
    } else {
        tracing::warn!("BIN LMDB not found at {}/hashes-bin.lmdb — BIN hashes unavailable", hash_dir);
    }

    let wad_count = merge_wad_hashes(&mut hashes, &hash_dir);
    let custom_count = merge_custom_hashes(&mut hashes, &hash_dir);
    let extracted_wad_count = merge_extracted_wad_overlay(&mut hashes, &hash_dir);
    let extracted_bin_count = merge_extracted_bin_overlay(&mut hashes, &hash_dir);

    tracing::info!(
        "Loaded {} BIN hashes, {} WAD hashes, and {} custom/overlay hashes (total: {})",
        bin_count,
        wad_count,
        custom_count + extracted_wad_count + extracted_bin_count,
        hashes.len()
    );
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

fn write_custom_file_hashes(
    env: &heed::Env,
    entries: &BTreeMap<u64, String>,
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

pub fn save_custom_file_hashes(entries: &BTreeMap<u64, String>) -> Result<usize, String> {
    if entries.is_empty() {
        return Ok(0);
    }
    let hash_dir = crate::hash::get_hash_dir().map_err(|e| e.to_string())?;
    let hash_dir = hash_dir.to_string_lossy().into_owned();
    let env = crate::hash::get_or_create_custom_env(&hash_dir)
        .ok_or_else(|| "Failed to open custom hash database".to_string())?;
    let changed = write_custom_file_hashes(&env, entries)?;
    let mut cache = get_cached_bin_hashes().write();
    for (hash, name) in entries {
        cache.insert(*hash, name.clone());
    }
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

    #[test]
    fn file_hashes_round_trip_under_eight_byte_keys() {
        let dir = std::env::temp_dir().join(format!(
            "flint-custom-file-hashes-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let dir_str = dir.to_string_lossy().into_owned();
        let env = crate::hash::get_or_create_custom_env(&dir_str).unwrap();

        let path = "assets/characters/flint/skins/skin0/custom.dds";
        let hash = ritoshark::hash::xxh64(path);
        let entries = BTreeMap::from([(hash, path.to_string())]);
        assert_eq!(write_custom_file_hashes(&env, &entries).unwrap(), 1);
        assert_eq!(write_custom_file_hashes(&env, &entries).unwrap(), 0);

        let mut hashes = HashMapper::new();
        assert_eq!(merge_custom_hashes(&mut hashes, &dir_str), 1);
        assert_eq!(hashes.get(hash), Some(path));

        drop(env);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn merge_extracted_wad_overlay_loads_xxhash64_hashes() {
        let dir = std::env::temp_dir().join(format!(
            "flint-extracted-hashes-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let overlay_file = dir.join("hashes.extracted.txt");
        std::fs::write(
            &overlay_file,
            "123456789abcdef0 assets/characters/ahri/skins/skin01/ahri.dds\n",
        )
        .unwrap();

        let mut mapper = HashMapper::new();
        let loaded = merge_extracted_wad_overlay(&mut mapper, dir.to_str().unwrap());
        assert_eq!(loaded, 1);
        assert_eq!(
            mapper.get(0x1234_5678_9abc_def0),
            Some("assets/characters/ahri/skins/skin01/ahri.dds")
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
