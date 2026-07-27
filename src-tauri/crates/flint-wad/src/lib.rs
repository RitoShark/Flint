//! WAD archives and the hash resolution that makes their contents readable.
//!
//! `wad_jade` is the current TOC parser, mount registry and writer; `wad` holds
//! the older reader and the extraction pass still used by map projects.
//! `overlay` resolves a project's own hashes before falling back to the shared
//! dictionaries.

pub mod overlay;
pub mod wad;
pub mod wad_jade;
