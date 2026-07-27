//! Project lifecycle and related per-project ops: open/save/layer
//! management, history checkpoints, original-file comparison, chroma
//! porting, and the LTK Manager / preview watcher integration.

#[allow(clippy::module_inception)]
pub mod project;
pub mod loadscreen;
pub mod tree;
pub mod layers;
pub mod map_project;
pub mod map_preview;
pub mod map_tiles;
pub mod thumbnail_window;
pub mod project_watcher;
pub mod checkpoint;
pub mod compare;
pub mod chroma;
pub mod hash_overlay;

pub use project::*;
pub use loadscreen::*;
pub use tree::*;
pub use layers::*;
