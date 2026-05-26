use std::path::Path;
use parking_lot::RwLock;
use std::sync::OnceLock;
use crate::hash::{get_bin_env, downloader::get_hash_dir};

/// High-performance hash manager with sorted arrays and binary search.
/// Matches the C# HashManager design: packed offset+length in a single
/// byte pool to minimize allocations.
#[derive(Default)]
pub struct HashManager {
    fnv_keys: Vec<u32>,
    fnv_data: Vec<u64>, // packed: (offset << 16) | length
    xxh_keys: Vec<u64>,
    xxh_data: Vec<u64>, // packed: (offset << 16) | length
    string_storage: Vec<u8>,
}

impl HashManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up an FNV1a hash name.
    pub fn get_fnv1a(&self, hash: u32) -> Option<&str> {
        let idx = self.fnv_keys.binary_search(&hash).ok()?;
        let dat = self.fnv_data[idx];
        let offset = (dat >> 16) as usize;
        let length = (dat & 0xFFFF) as usize;
        std::str::from_utf8(&self.string_storage[offset..offset + length]).ok()
    }

    /// Look up an XXH64 hash name.
    pub fn get_xxh64(&self, hash: u64) -> Option<&str> {
        let idx = self.xxh_keys.binary_search(&hash).ok()?;
        let dat = self.xxh_data[idx];
        let offset = (dat >> 16) as usize;
        let length = (dat & 0xFFFF) as usize;
        std::str::from_utf8(&self.string_storage[offset..offset + length]).ok()
    }

    /// Load hash files from a directory.
    /// Prefers .bin (HHSH) format over .txt. Skips game-specific hash files.
    pub fn load(hash_dir: &Path) -> Self {
        let mut mgr = Self::new();

        if !hash_dir.exists() {
            eprintln!("[jade::hash_manager] Hash directory does not exist: {}", hash_dir.display());
            return mgr;
        }

        // Collect files, preferring .bin over .txt
        let mut files_to_load = Vec::new();
        let mut base_names = std::collections::HashSet::new();

        let entries: Vec<_> = match std::fs::read_dir(hash_dir) {
            Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
            Err(e) => {
                eprintln!("[jade::hash_manager] Failed to read hash dir: {}", e);
                return mgr;
            }
        };

        // First pass: .bin files
        for entry in &entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("hashes.game.") { continue; }
            if name.ends_with(".bin") {
                files_to_load.push(entry.path());
                if let Some(stem) = entry.path().file_stem() {
                    base_names.insert(stem.to_string_lossy().to_string());
                }
            }
        }

        // Second pass: .txt files only if no .bin exists
        for entry in &entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("hashes.game.") { continue; }
            if name.ends_with(".txt") {
                if let Some(stem) = entry.path().file_stem() {
                    if !base_names.contains(&*stem.to_string_lossy()) {
                        files_to_load.push(entry.path());
                    }
                }
            }
        }

        // Pre-scan for allocation sizing
        let mut total_fnv = 0usize;
        let mut total_xxh = 0usize;
        let mut total_string_size = 0usize;

        for file in &files_to_load {
            let name = file.to_string_lossy();
            if name.ends_with(".bin") {
                if let Ok(data) = std::fs::read(file) {
                    if data.len() >= 16 && &data[0..4] == b"HHSH" {
                        let fnv_count = u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize;
                        let xxh_count = u32::from_le_bytes([data[12], data[13], data[14], data[15]]) as usize;
                        total_fnv += fnv_count;
                        total_xxh += xxh_count;
                        total_string_size += data.len();
                    }
                }
            } else if let Ok(meta) = std::fs::metadata(file) {
                total_string_size += meta.len() as usize;
            }
        }

        mgr.fnv_keys = Vec::with_capacity(total_fnv);
        mgr.fnv_data = Vec::with_capacity(total_fnv);
        mgr.xxh_keys = Vec::with_capacity(total_xxh);
        mgr.xxh_data = Vec::with_capacity(total_xxh);
        mgr.string_storage = Vec::with_capacity(total_string_size);

        // Load data
        for file in &files_to_load {
            let name = file.to_string_lossy();
            if name.ends_with(".bin") {
                mgr.load_binary(file);
            } else {
                mgr.load_text(file);
            }
        }

        // Sort for binary search
        sort_parallel(&mut mgr.fnv_keys, &mut mgr.fnv_data);
        sort_parallel_u64(&mut mgr.xxh_keys, &mut mgr.xxh_data);

        let total = mgr.fnv_keys.len() + mgr.xxh_keys.len();
        println!(
            "[jade::hash_manager] Loaded {} hashes ({} FNV1a, {} XXH64). String pool: {}KB",
            total, mgr.fnv_keys.len(), mgr.xxh_keys.len(), mgr.string_storage.len() / 1024
        );

        mgr
    }

    fn load_binary(&mut self, path: &Path) {
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(_) => return,
        };
        if data.len() < 16 || &data[0..4] != b"HHSH" { return; }

        let _version = i32::from_le_bytes([data[4], data[5], data[6], data[7]]);
        let fnv_count = u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize;
        let xxh_count = u32::from_le_bytes([data[12], data[13], data[14], data[15]]) as usize;

        let mut offset = 16;

        for _ in 0..fnv_count {
            if offset + 4 > data.len() { break; }
            let hash = u32::from_le_bytes([data[offset], data[offset+1], data[offset+2], data[offset+3]]);
            offset += 4;

            let len = match read_7bit_int(&data, &mut offset) {
                Some(l) => l,
                None => break,
            };
            if offset + len > data.len() { break; }

            let str_offset = self.string_storage.len();
            self.string_storage.extend_from_slice(&data[offset..offset + len]);
            offset += len;

            self.fnv_keys.push(hash);
            self.fnv_data.push(((str_offset as u64) << 16) | (len as u64 & 0xFFFF));
        }

        for _ in 0..xxh_count {
            if offset + 8 > data.len() { break; }
            let hash = u64::from_le_bytes([
                data[offset], data[offset+1], data[offset+2], data[offset+3],
                data[offset+4], data[offset+5], data[offset+6], data[offset+7],
            ]);
            offset += 8;

            let len = match read_7bit_int(&data, &mut offset) {
                Some(l) => l,
                None => break,
            };
            if offset + len > data.len() { break; }

            let str_offset = self.string_storage.len();
            self.string_storage.extend_from_slice(&data[offset..offset + len]);
            offset += len;

            self.xxh_keys.push(hash);
            self.xxh_data.push(((str_offset as u64) << 16) | (len as u64 & 0xFFFF));
        }
    }

    fn load_text(&mut self, path: &Path) {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => return,
        };

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }
            let space = match line.find(' ') {
                Some(i) if i > 0 && i < line.len() - 1 => i,
                _ => continue,
            };
            let hex_part = &line[..space];
            let name_part = &line[space + 1..];
            let name_bytes = name_part.as_bytes();

            let str_offset = self.string_storage.len();
            self.string_storage.extend_from_slice(name_bytes);

            if hex_part.len() == 16 {
                // XXH64
                if let Ok(hash) = u64::from_str_radix(hex_part, 16) {
                    self.xxh_keys.push(hash);
                    self.xxh_data.push(((str_offset as u64) << 16) | (name_bytes.len() as u64 & 0xFFFF));
                }
            } else if hex_part.len() == 8 {
                // FNV1a
                if let Ok(hash) = u32::from_str_radix(hex_part, 16) {
                    self.fnv_keys.push(hash);
                    self.fnv_data.push(((str_offset as u64) << 16) | (name_bytes.len() as u64 & 0xFFFF));
                }
            }
        }
    }
}

fn read_7bit_int(data: &[u8], offset: &mut usize) -> Option<usize> {
    let mut result = 0usize;
    let mut shift = 0;
    loop {
        if *offset >= data.len() { return None; }
        let b = data[*offset];
        *offset += 1;
        result |= ((b & 0x7F) as usize) << shift;
        if (b & 0x80) == 0 { break; }
        shift += 7;
    }
    Some(result)
}

fn sort_parallel(keys: &mut Vec<u32>, data: &mut Vec<u64>) {
    let mut indices: Vec<usize> = (0..keys.len()).collect();
    indices.sort_by_key(|&i| keys[i]);
    let sorted_keys: Vec<u32> = indices.iter().map(|&i| keys[i]).collect();
    let sorted_data: Vec<u64> = indices.iter().map(|&i| data[i]).collect();
    *keys = sorted_keys;
    *data = sorted_data;
}

fn sort_parallel_u64(keys: &mut Vec<u64>, data: &mut Vec<u64>) {
    let mut indices: Vec<usize> = (0..keys.len()).collect();
    indices.sort_by_key(|&i| keys[i]);
    let sorted_keys: Vec<u64> = indices.iter().map(|&i| keys[i]).collect();
    let sorted_data: Vec<u64> = indices.iter().map(|&i| data[i]).collect();
    *keys = sorted_keys;
    *data = sorted_data;
}

fn load_from_lmdb() -> HashManager {
    let hash_dir = match get_hash_dir() {
        Ok(d) => d.to_string_lossy().into_owned(),
        Err(e) => {
            tracing::warn!("[jade::hash_manager] Failed to get hash dir: {}", e);
            return HashManager::new();
        }
    };

    let env = match get_bin_env(&hash_dir) {
        Some(e) => e,
        None => {
            tracing::warn!("[jade::hash_manager] hashes-bin.lmdb not found at {}", hash_dir);
            return HashManager::new();
        }
    };

    let rtxn = match env.read_txn() {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("[jade::hash_manager] LMDB read txn failed: {}", e);
            return HashManager::new();
        }
    };

    let db = match env.open_database::<heed::types::Bytes, heed::types::Str>(&rtxn, Some("bin")) {
        Ok(Some(d)) => d,
        Ok(None) => {
            tracing::warn!("[jade::hash_manager] No 'bin' named DB in hashes-bin.lmdb");
            return HashManager::new();
        }
        Err(e) => {
            tracing::warn!("[jade::hash_manager] Failed to open 'bin' DB: {}", e);
            return HashManager::new();
        }
    };

    let iter = match db.iter(&rtxn) {
        Ok(i) => i,
        Err(e) => {
            tracing::warn!("[jade::hash_manager] LMDB iter failed: {}", e);
            return HashManager::new();
        }
    };

    let mut mgr = HashManager::new();
    let mut count = 0usize;
    for (key_bytes, name) in iter.flatten() {
        if key_bytes.len() == 4 {
            let hash = u32::from_be_bytes([key_bytes[0], key_bytes[1], key_bytes[2], key_bytes[3]]);
            let name_bytes = name.as_bytes();
            let str_offset = mgr.string_storage.len();
            mgr.string_storage.extend_from_slice(name_bytes);
            mgr.fnv_keys.push(hash);
            mgr.fnv_data.push(((str_offset as u64) << 16) | (name_bytes.len() as u64 & 0xFFFF));
            count += 1;
        }
    }

    // Must be sorted for binary_search
    sort_parallel(&mut mgr.fnv_keys, &mut mgr.fnv_data);

    tracing::info!("[jade::hash_manager] Loaded {} BIN hashes from LMDB", count);
    mgr
}

/// Global cached hash manager. Uses RwLock so it can be refreshed in-process.
static JADE_HASHES: OnceLock<RwLock<HashManager>> = OnceLock::new();

/// Get or initialize the cached hash manager.
pub fn get_cached_hashes() -> &'static RwLock<HashManager> {
    JADE_HASHES.get_or_init(|| RwLock::new(load_from_lmdb()))
}

/// Reload the Jade hash cache from LMDB (call after a successful hash download).
pub fn reload_jade_hashes() {
    if let Some(lock) = JADE_HASHES.get() {
        *lock.write() = load_from_lmdb();
        tracing::info!("[jade::hash_manager] Jade hash cache reloaded");
    }
}
