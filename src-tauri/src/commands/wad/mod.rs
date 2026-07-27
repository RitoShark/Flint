//! WAD file IO: reading the on-disk WAD format, extracting chunks, and the
//! in-memory edit-session API. Also covers the hash-extraction scanner that
//! mines path hashes out of BIN/SKN chunks.

#[allow(clippy::module_inception)]
pub mod wad;
pub mod wad_edit;
pub mod extract_hashes;
pub mod wad_pack;

pub use wad::*;
