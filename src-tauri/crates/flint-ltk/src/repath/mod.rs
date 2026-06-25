//! Repathing: prefixes asset paths with `ASSETS/{creator}/{project}` to prevent
//! conflicts between mods.

pub mod refather;
pub mod organizer;
pub mod rename;
pub mod path_variants;
pub mod unhash;

pub use organizer::{organize_project, OrganizerConfig};
pub use rename::{rename_project_asset_prefix, RenameResult};
