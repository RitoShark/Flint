//! Project-local hash resolution.
//!
//! Sits above `bin` and `hash`: scans a project's BIN files for the asset
//! hashes they reference, then answers lookups from that overlay before
//! falling back to the shared LMDB dictionaries.

pub mod bin_refs;
#[allow(clippy::module_inception)]
pub mod overlay;
pub mod resolver;

pub use overlay::{build_overlay, collect_bin_asset_refs, collect_disk_paths, ProjectHashOverlay};
pub use resolver::HashResolver;
