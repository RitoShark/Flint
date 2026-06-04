// flint-ltk: League Toolkit abstraction layer for Flint

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

// =============================================================================
// Re-exports: Types that commands import directly from LTK crates.
// Commands should import these from `flint_ltk::ltk_types::` instead.
// =============================================================================

/// LTK types re-exported for the Flint binary crate
pub mod ltk_types {
    // ltk_meta core types (renamed in 0.4: BinTree→Bin, BinTreeObject→BinObject, BinPropertyKind→PropertyKind)
    pub use ltk_meta::{Bin, BinObject, BinProperty, PropertyKind, PropertyValueEnum};

    // Value types module (use values::String to avoid shadowing std::string::String)
    pub use ltk_meta::property::values;
    pub use ltk_meta::property::values::{
        Bool, I8, U8, I16, U16, I32, U32, I64, U64, F32,
        Vector2, Vector3, Vector4, Matrix44,
        Color, Hash, ObjectLink, BitBool, WadChunkLink,
        Struct, Embedded, Container, UnorderedContainer, Optional, Map,
    };

    // ltk_ritobin (used by commands/dev.rs, bin_roundtrip_test.rs)
    pub use ltk_ritobin::{HashProvider, HashMapProvider, write_with_hashes};

    // ltk_mod_project (used by commands/export.rs, commands/ltk_manager.rs)
    pub use ltk_mod_project::{ModProject, ModProjectAuthor, default_layers};

    // ltk_file (used by commands/file.rs)
    pub use ltk_file::LeagueFileKind;

    // ltk_texture: MIGRATED to ritoshark::tex (Phase 1) — re-export removed.

    // ltk_modpkg (used by commands/modpkg_import.rs, commands/export.rs)
    pub use ltk_modpkg::Modpkg;
    pub use ltk_modpkg::builder::{ModpkgBuilder, ModpkgChunkBuilder, ModpkgLayerBuilder};
    pub use ltk_modpkg::{ModpkgMetadata, ModpkgAuthor};

    // league-toolkit WAD builders (used by commands/export.rs)
    pub use league_toolkit::wad::{WadBuilder, WadChunkBuilder, WadBuilderError};
    // WAD chunk type — needed by commands/wad.rs to express its `Vec<WadChunk>`
    // result type when implementing the byte-encoder trait. The `flint_ltk::wad`
    // module's `WadChunk` re-export above is private; this one is public for
    // the binary crate.
    pub use league_toolkit::wad::WadChunk;

    // glam (used by commands/project.rs)
    pub use glam::{Vec2, Vec4};
}

/// Hematite types re-exported for the Flint binary crate (commands/fixer.rs)
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

/// Re-export heed for state.rs (Arc<heed::Env>)
pub use heed;
