//! Compatibility bridge to RitoShark's `rs_bin` for BIN file handling.
//!
//! This module provides a simplified interface to RitoShark's BIN reader/writer
//! and ritobin text printer/parser, wrapping their APIs for use throughout the
//! application. Hash-name resolution for the text form goes through a globally
//! cached `HashMapper` populated from the `hashes-bin.lmdb` dictionary.

use std::sync::OnceLock;
use parking_lot::RwLock;
use ritoshark::bin::Bin;
use ritoshark::hash::HashMapper;
use ritoshark::prelude::{Parse as _, Serialize as _};

/// Maximum allowed BIN file size (50MB - no legitimate BIN should be larger)
pub const MAX_BIN_SIZE: usize = 50 * 1024 * 1024;

#[derive(Debug)]
pub struct BinError(pub String);

impl std::fmt::Display for BinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for BinError {}

pub type Result<T> = std::result::Result<T, BinError>;

/// # Safety
/// This function validates file size and magic bytes to prevent memory issues
/// from corrupt files. Files larger than 50MB are rejected.
pub fn read_bin(data: &[u8]) -> Result<Bin> {
    tracing::debug!(
        "read_bin: size={} bytes, magic={:02x?}",
        data.len(),
        &data[..std::cmp::min(8, data.len())]
    );

    if data.len() > MAX_BIN_SIZE {
        tracing::error!(
            "BIN file rejected: {} bytes exceeds max size of {} bytes",
            data.len(),
            MAX_BIN_SIZE
        );
        return Err(BinError(format!(
            "BIN file too large ({} bytes, max {} bytes) - likely corrupt",
            data.len(),
            MAX_BIN_SIZE
        )));
    }

    if data.len() >= 4 {
        let magic = &data[0..4];
        if magic != b"PROP" && magic != b"PTCH" {
            tracing::error!(
                "Invalid BIN magic bytes: {:02x?} (expected PROP or PTCH)",
                magic
            );
            return Err(BinError(format!(
                "Invalid BIN magic bytes: {:02x?} (expected PROP or PTCH)",
                magic
            )));
        }
    } else {
        tracing::error!("BIN file too small: {} bytes (minimum 4 bytes for magic)", data.len());
        return Err(BinError(format!(
            "BIN file too small ({} bytes, minimum 4 bytes for magic)",
            data.len()
        )));
    }

    // catch_unwind to handle OOM panics from the parser
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        Bin::from_bytes(data)
    }));

    match result {
        Ok(Ok(tree)) => {
            tracing::debug!(
                "Successfully parsed BIN: {} entries, {} linked",
                tree.entries.len(),
                tree.linked.len()
            );
            Ok(tree)
        }
        Ok(Err(e)) => {
            tracing::error!("BIN parse failed: {} (file was {} bytes)", e, data.len());
            Err(BinError(format!("Failed to parse bin: {}", e)))
        }
        Err(panic_info) => {
            let panic_msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic_info.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic".to_string()
            };
            tracing::error!(
                "CRITICAL: Parser panicked on {} byte file: {}",
                data.len(),
                panic_msg
            );
            Err(BinError(format!(
                "Parser panicked (likely OOM or stack overflow): {}",
                panic_msg
            )))
        }
    }
}

pub fn write_bin(tree: &Bin) -> Result<Vec<u8>> {
    tree.to_bytes()
        .map_err(|e| BinError(format!("Failed to write bin: {}", e)))
}

pub fn tree_to_text_with_hashes(tree: &Bin, hashes: &HashMapper) -> Result<String> {
    Ok(ritoshark::bin::to_text(tree, Some(hashes)))
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

    let rtxn = match env.read_txn() {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("Failed to open BIN LMDB read txn: {}", e);
            return hashes;
        }
    };

    let db = match env.open_database::<heed::types::Bytes, heed::types::Str>(&rtxn, Some("bin")) {
        Ok(Some(d)) => d,
        Ok(None) => {
            tracing::warn!("BIN LMDB has no 'bin' named database");
            return hashes;
        }
        Err(e) => {
            tracing::warn!("Failed to open 'bin' named DB: {}", e);
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

    tracing::info!("Loaded {} BIN hashes from hashes-bin.lmdb", count);
    hashes
}

static BIN_HASHES_CACHE: OnceLock<RwLock<HashMapper>> = OnceLock::new();

/// Thread-safe; loads hashes from disk only once.
pub fn get_cached_bin_hashes() -> &'static RwLock<HashMapper> {
    BIN_HASHES_CACHE.get_or_init(|| {
        tracing::info!("Initializing global BIN hash cache...");
        let hashes = load_bin_hashes();
        tracing::info!("Global BIN hash cache initialized with {} hashes", hashes.len());
        RwLock::new(hashes)
    })
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

pub fn tree_to_text_cached(tree: &Bin) -> Result<String> {
    let hashes = get_cached_bin_hashes().read();
    tree_to_text_with_hashes(tree, &hashes)
}

pub fn text_to_tree(text: &str) -> Result<Bin> {
    ritoshark::bin::from_text(text, None)
        .map_err(|e| BinError(format!("Failed to parse text: {}", e)))
}
