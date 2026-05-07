//! WAD support — hashtable lookup, downloader, custom TOC parser, and
//! a mount registry. The LMDB hashtable is shared with Quartz via the
//! FrogTools hash directory; see `hash_downloader::detect_layout` for
//! the two on-disk layouts we transparently support.

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

pub use extractor::{cancel_extraction, extract_to_dir, ExtractResult};
pub use extractor::chunk_io::read_chunk_decompressed_bytes;

pub use hash_extractor::{extract_hashes, HashScanResult};

pub use hash_downloader::{
    check_for_hash_update, detect_layout, download_combined_hashes, hashes_present,
    HashUpdateStatus,
};
// `lookup_bin` stays exported (it's still used by `extractor` /
// `sniff` / etc. for BIN-property resolution inside chunk content),
// but the BIN converter doesn't go through it anymore — that path
// uses the in-RAM text table on the Jade side.
#[allow(unused_imports)]
pub use lmdb_hashes::lookup_bin;
pub use lmdb_hashes::{loaded_stats, lookup_wad, resolve_wad, unload_envs};
// `preload_envs` is still useful for tests and future eager-warmup hooks
// even though no command exposes it today.
#[allow(unused_imports)]
pub use lmdb_hashes::preload_envs;
pub use mount::{list_mounted, mount, unmount, with_mount, MountInfo};

// Surface reserved for Phase 3 (extraction needs the live mount handle).
#[allow(unused_imports)]
pub use mount::{MountId, MountedWad};

// Surface reserved for Phase 3 (extraction) and the future BIN converter
// migration. Suppress until consumed.
#[allow(unused_imports)]
pub use format::{WadChunk, WadCompression, WadVersion};
#[allow(unused_imports)]
pub use hash_downloader::HashLayout;
#[allow(unused_imports)]
pub use lmdb_hashes::{resolve_wad_bulk, LoadedStats};
