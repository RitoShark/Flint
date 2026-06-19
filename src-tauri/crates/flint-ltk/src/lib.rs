pub mod error;
pub mod audio;
pub mod bin;
pub mod wad;
pub mod wad_jade;
pub mod hash;
pub mod mesh;
pub mod champion;
pub mod league;
pub mod repath;
pub mod project;
pub mod map;
pub mod export;
pub mod checkpoint;
pub mod hud;
pub mod luabin;
pub mod troybin;
pub mod loadscreen_banner;
pub mod inibin_text;
pub mod stringtable;
pub mod manifest;
pub mod cdn;

// =============================================================================
// Re-exports for types the binary crate imports from LTK crates.
// =============================================================================

pub mod ltk_types {
    pub use ritoshark::bin::{Bin, BinEntry, BinType, BinValue};

    pub use ritoshark::hash::HashMapper;

    pub use ltk_mod_project::{ModProject, ModProjectAuthor, default_layers};

    pub use ltk_modpkg::Modpkg;
    pub use ltk_modpkg::builder::{ModpkgBuilder, ModpkgChunkBuilder, ModpkgLayerBuilder};
    pub use ltk_modpkg::{ModpkgMetadata, ModpkgAuthor};

    pub use glam::{Vec2, Vec4};
}

pub mod hematite {
    pub use hematite_core::context::FixContext;
    pub use hematite_core::detect::detect_issue;
    pub use hematite_core::detect::shader::ShaderValidator;
    pub use hematite_core::pipeline::apply_fixes;
    pub use hematite_core::traits::BinProvider;
    pub use hematite_ltk::bin_adapter::LtkBinProvider;
    pub use hematite_ltk::lmdb_hash_adapter::LmdbHashProvider;
    pub use hematite_ltk::wad_adapter::LtkWadProvider;
    pub use hematite_types::champion::{CharacterRelations, ChampionList};
    pub use hematite_types::config::FixConfig;
}

pub use heed;
