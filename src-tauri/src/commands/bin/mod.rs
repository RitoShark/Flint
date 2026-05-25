//! BIN file format: ritobin / JSON conversion, schema parsing, and the
//! split / organize-vfx commands that restructure BIN files into VFX
//! sidecars.

pub mod bin;
pub mod bin_split;

// Flatten so `commands::bin::convert_bin_to_text` keeps resolving as before.
pub use bin::*;
