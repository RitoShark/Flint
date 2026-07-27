#[allow(clippy::module_inception)]
pub mod project;
pub mod index;
pub mod discover;

pub use project::{create_project, open_project, register_in_index, save_project, FlintMetadata, Project, ProjectKind};
pub use index::{
    index_path, read_index, remove as remove_from_index,
    remove_by_path as remove_from_index_by_path, upsert as upsert_index,
    write_index, ProjectIndex, ProjectIndexEntry,
};
pub use discover::{discover_projects, ProjectListing};
