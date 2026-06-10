//! Repathing module for modifying asset paths in BIN files
//!
//! This module implements the "bumpath" algorithm that prefixes asset paths
//! with a unique identifier (ASSETS/{creator}/{project}) to prevent conflicts between mods.
//!
//! The module is organized as follows:
//! - `refather`: Core path modification logic
//! - `organizer`: High-level orchestrator that coordinates concat and repath operations

pub mod refather;
pub mod organizer;
pub mod rename;

pub use organizer::{organize_project, OrganizerConfig};
pub use rename::{rename_project_asset_prefix, RenameResult};
