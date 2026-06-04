//! WAD support — hashtable lookup, downloader, custom TOC parser, and
//! a mount registry. The LMDB hashtable is shared with Quartz via the
//! FrogTools hash directory; see `hash_downloader::detect_layout` for
//! the two on-disk layouts we transparently support.

pub mod adapter;
pub mod extracted_overlay;
pub mod extractor;
pub mod format;
pub mod hash_downloader;
pub mod hash_extractor;
pub mod hash_scanner;
pub mod lmdb_hashes;
pub mod mount;
pub mod reader;
pub mod sniff;
pub mod writer;

pub use extractor::{cancel_extraction, extract_to_dir, ExtractResult};
pub use extractor::chunk_io::read_chunk_decompressed_bytes;

pub use hash_extractor::{extract_hashes, HashScanResult};

pub use hash_downloader::{
    check_for_hash_update, detect_layout, download_combined_hashes, hashes_present,
    HashUpdateStatus,
};
pub use lmdb_hashes::{loaded_stats, lookup_wad, resolve_wad, unload_envs};
pub use mount::{list_mounted, mount, unmount, with_mount, MountInfo};
