pub mod downloader;
pub mod lmdb_cache;
pub mod bin_dict;

pub use downloader::{check_hashes_now, download_hashes, get_hash_dir, get_ritoshark_hash_dir, hashes_present, DownloadStats};
pub use lmdb_cache::{
    drop_lmdb_cache, get_bin_env, get_custom_env, get_or_create_custom_env, get_or_open_env, get_wad_env,
    has_v2_bin_tables, lookup_bin_in_env, open_bin_dbs, primary_bin_hashes_db_name,
    resolve_bin_hash_in_category, resolve_bin_hashes_by_category_lmdb, resolve_bin_hashes_lmdb,
    resolve_hashes_lmdb, resolve_hashes_lmdb_bulk, BinHashCategory, BIN_V2_TABLES,
};

pub use lmdb_cache::ResolvedHashes;
pub use bin_dict::{
    get_cached_bin_hashes, load_bin_hashes_from_env, local_custom_hashes, reload_bin_hash_cache,
    save_custom_bin_hashes, save_custom_file_hashes,
};

pub use ritoshark::hash::HashMapper;

pub fn wad_chunk_hash(wad_path: &str) -> u64 {
    xxhash_rust::xxh64::xxh64(wad_path.to_lowercase().as_bytes(), 0)
}
