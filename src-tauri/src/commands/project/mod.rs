//! Project lifecycle and related per-project ops: open/save/layer
//! management, history checkpoints, original-file comparison, chroma
//! porting, and the LTK Manager / preview watcher integration.

pub mod project;
pub mod map_project;
pub mod project_watcher;
pub mod checkpoint;
pub mod compare;
pub mod chroma;

// Flatten so `commands::project::create_project` keeps resolving as before —
// the file `project.rs` was previously at the top level of `commands/`.
pub use project::*;
