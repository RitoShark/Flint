//! Online CDN asset access: sieve manifest discovery, RMAN tree, remote-WAD TOC
//! browsing, and selective chunk extraction over HTTP range requests. Ported from
//! the Hextech-Vault core.

pub mod sieve;
pub mod catalog;
pub mod manifest;
pub mod wad_browse;
pub mod downloader;
