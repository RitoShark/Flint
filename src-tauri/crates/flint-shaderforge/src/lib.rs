//! Shader-preview module boundary. The real implementation lives in a
//! private overlay at `private/shaderforge` (not part of this repository);
//! without it — and without the `real` feature — the stub answers every
//! call with "shader preview unavailable" and the model preview keeps its
//! standard PBR/toon path.
//!
//! The allow list mirrors the overlay's own compile target: the mounted
//! code is vendored and never edited for style lints.

#![cfg_attr(
    feature = "real",
    allow(
        dead_code,
        unused_imports,
        unused_mut,
        clippy::doc_lazy_continuation,
        clippy::let_unit_value,
        clippy::manual_div_ceil,
        clippy::manual_pattern_char_comparison,
        clippy::manual_range_contains,
        clippy::needless_borrow,
        clippy::needless_lifetimes,
        clippy::needless_range_loop,
        clippy::new_without_default,
        clippy::ptr_arg,
        clippy::sliced_string_as_bytes,
        clippy::type_complexity,
        clippy::unnecessary_map_or
    )
)]

#[cfg(feature = "real")]
#[path = "../../../../private/shaderforge/rust/error.rs"]
mod error;
#[cfg(feature = "real")]
#[path = "../../../../private/shaderforge/rust/host_env.rs"]
mod host_env;
#[cfg(feature = "real")]
#[path = "../../../../private/shaderforge/rust/core/mod.rs"]
mod core;
#[cfg(feature = "real")]
#[path = "../../../../private/shaderforge/rust/commands.rs"]
mod commands;

#[cfg(feature = "real")]
pub use commands::{
    locate_shader_cache, map_env_disk, read_mapgeo_generic_materials_disk,
    read_mapgeo_water_materials_disk, read_skn_generic_materials_disk,
    read_skn_toon_materials_disk, resolve_map_assets_disk, shaderforge_mount_wad,
    shaderforge_unmount_wad, translate_material_shader, wad_map_env,
    wad_read_mapgeo_generic_materials, wad_read_mapgeo_water_materials,
    wad_read_skn_generic_materials, wad_resolve_assets,
};

#[cfg(feature = "real")]
pub fn init_host_env(config_dir: std::path::PathBuf, hash_dir: Option<std::path::PathBuf>) {
    host_env::set_host_env(host_env::HostEnv {
        config_dir: Some(config_dir),
        hash_dir,
        league_install: None,
    });
}

#[cfg(not(feature = "real"))]
mod stub;
#[cfg(not(feature = "real"))]
pub use stub::*;
