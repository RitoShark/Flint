pub mod downloader;
pub mod lmdb_cache;
pub mod overlay;

pub use downloader::{download_hashes, get_hash_dir, get_ritoshark_hash_dir, hashes_present, DownloadStats};
pub use lmdb_cache::{
    drop_lmdb_cache, get_bin_env, get_or_open_env, get_wad_env,
    resolve_bin_hashes_lmdb, resolve_hashes_lmdb, resolve_hashes_lmdb_bulk,
};

/// Arena-backed map of `xxh64 path hash → resolved path`, returned by the
/// WAD-LMDB resolver.
pub use lmdb_cache::ResolvedHashes;

pub use overlay::{collect_disk_paths, ProjectHashOverlay};
