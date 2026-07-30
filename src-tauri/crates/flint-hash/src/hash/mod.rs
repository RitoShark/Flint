pub mod downloader;
pub mod lmdb_cache;
pub mod bin_dict;

pub use downloader::{check_hashes_now, download_hashes, get_hash_dir, get_ritoshark_hash_dir, hashes_present, DownloadStats};
pub use lmdb_cache::{
    drop_lmdb_cache, get_bin_env, get_or_open_env, get_wad_env,
    resolve_bin_hashes_lmdb, resolve_hashes_lmdb, resolve_hashes_lmdb_bulk,
};

/// Arena-backed map of `xxh64 path hash → resolved path`, returned by the
/// WAD-LMDB resolver.
pub use lmdb_cache::ResolvedHashes;



/// Hash-to-name dictionary used when printing BIN in its text form.
pub use ritoshark::hash::HashMapper;

/// Canonical WAD path-hash: xxh64 of the **lowercased** forward-slash path.
///
/// Lowercasing before hashing is mandatory — the game, the LMDB tables and
/// every unhash path key on `xxh64(lowercase)`. Hashing a mixed-case path
/// yields a chunk the game cannot find and nothing can reverse back to the
/// lowercase string stored in the BIN.
pub fn wad_chunk_hash(wad_path: &str) -> u64 {
    xxhash_rust::xxh64::xxh64(wad_path.to_lowercase().as_bytes(), 0)
}
