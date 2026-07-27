//! WAD support — hashtable lookup, downloader, custom TOC parser, and
//! a mount registry.

pub mod adapter;
pub mod chunk_io;
pub mod extracted_overlay;
pub mod format;
pub mod hash_downloader;
pub mod hash_scanner;
pub mod lmdb_hashes;
pub mod mount;
pub mod reader;
pub mod sniff;
pub mod writer;

pub use chunk_io::read_chunk_decompressed_bytes;

pub use hash_downloader::{
    check_for_hash_update, detect_layout, hashes_present, HashUpdateStatus,
};
pub use lmdb_hashes::{loaded_stats, lookup_wad, resolve_wad, unload_envs};
pub use mount::{list_mounted, mount, unmount, with_mount, MountInfo};
