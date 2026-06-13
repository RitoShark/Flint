//! Tauri command surface, grouped by domain.
//!
//! The directory tree mirrors the frontend `src/lib/api/` split. Each
//! sub-folder owns a related set of commands; this `mod.rs` re-exports every
//! leaf module at the top-level `commands::` namespace so the existing
//! `main.rs` `invoke_handler![commands::project::*, ...]` references keep
//! working without modification.

// Domain groups (the actual on-disk folders).
pub mod project;
pub mod wad;
pub mod assets;
pub mod bin;
pub mod audio;
pub mod league;
pub mod import_export;
pub mod platform;
pub mod editor;
pub mod system;

// Leaf-module re-exports — keeps `commands::map_project::...`,
// `commands::file::...`, `commands::external_apps::...`, etc. resolving
// exactly as they did before the reorg.
pub use project::{map_project, map_preview, map_tiles, project_watcher, checkpoint, compare, chroma};
pub use wad::{wad_edit, extract_hashes};
pub use assets::{file, texture_convert, format_converters, mesh};
pub use bin::bin_split;
pub use league::{champion, champion_schema, tft_schema, troybin_schema, hash, luabin_extract};
pub use import_export::{export, fantome_import, modpkg_import};
pub use platform::{external_apps, file_assoc, ltk_manager, settings, taskbar, updater};
pub use editor::{hud, fixer};
pub use system::{logging, dev};
