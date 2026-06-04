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
    // BIN core types — MIGRATED to RitoShark's rs_bin (Plan 2). The flat `BinValue`
    // replaces ltk_meta's `PropertyValueEnum` + typed sub-enums; `BinEntry` replaces
    // `BinObject`/`BinProperty`; `BinType` replaces `PropertyKind`.
    pub use ritoshark::bin::{Bin, BinEntry, BinType, BinValue};

    // Hash-name resolution for the ritobin text form (replaces ltk_ritobin's
    // HashProvider/HashMapProvider/write_with_hashes — see flint_ltk::bin::ltk_bridge).
    pub use ritoshark::hash::HashMapper;

    // ltk_mod_project (used by commands/export.rs, commands/ltk_manager.rs)
    pub use ltk_mod_project::{ModProject, ModProjectAuthor, default_layers};

    // ltk_file: MIGRATED to ritoshark::file (Phase 4) — re-export removed.
    // (commands/file.rs now uses ritoshark::file::detect; the extractor's
    // remaining LeagueFileKind use goes through the league_toolkit umbrella.)

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
