//! WAD file IO: reading the on-disk WAD format, extracting chunks, and the
//! in-memory edit-session API. Also covers the hash-extraction scanner that
//! mines path hashes out of BIN/SKN chunks.

pub mod wad;
pub mod wad_edit;
pub mod extract_hashes;

// Flatten so `commands::wad::read_wad` keeps resolving as before.
pub use wad::*;
