//! WAD archives and the hash resolution that makes their contents readable.
//!
//! `wad` holds the TOC parser, mount registry, chunk extraction and writer.
//! `overlay` resolves a project's own hashes before falling back to the
//! shared dictionaries.

pub mod overlay;
pub mod wad;
