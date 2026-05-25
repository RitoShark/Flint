//! League install introspection: detecting the install path, walking the
//! game/ tree for champion data, and the path-hash database that resolves
//! WAD chunk hashes back to filenames.

pub mod league;
pub mod champion;
pub mod champion_schema;
pub mod hash;

// Flatten so `commands::league::detect_league` keeps resolving as before.
pub use league::*;
