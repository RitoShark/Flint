//! Same surface as the private module, every entry point unavailable.
//! Keep the fn set and signatures in lockstep with the real overlay's
//! command layer — the wrappers in `src/commands/editor/shaderforge.rs`
//! compile against whichever side the feature selects.

use std::collections::HashMap;

const UNAVAILABLE: &str = "shader preview unavailable";

pub fn init_host_env(_config_dir: std::path::PathBuf, _hash_dir: Option<std::path::PathBuf>) {}

pub async fn translate_material_shader(
    _shader_cache_path: String,
    _shader_link: Option<String>,
    _shader_link_hash: Option<u32>,
    _switches_on: Vec<String>,
    _macros: HashMap<String, String>,
    _real_textures: Vec<String>,
) -> Result<serde_json::Value, String> {
    Err(UNAVAILABLE.into())
}

pub async fn locate_shader_cache(_hint_path: Option<String>) -> Result<Option<String>, String> {
    Err(UNAVAILABLE.into())
}

pub async fn read_skn_generic_materials_disk(
    _skn_path: String,
) -> Result<serde_json::Value, String> {
    Err(UNAVAILABLE.into())
}

pub async fn wad_read_skn_generic_materials(
    _id: u64,
    _skn_path_hash_hex: String,
    _chroma_id: Option<u32>,
    _buffs_active: Option<bool>,
) -> Result<serde_json::Value, String> {
    Err(UNAVAILABLE.into())
}

pub async fn read_mapgeo_generic_materials_disk(
    _mapgeo_path: String,
    _material_names: Vec<String>,
) -> Result<serde_json::Value, String> {
    Err(UNAVAILABLE.into())
}

pub async fn wad_read_mapgeo_generic_materials(
    _id: u64,
    _mapgeo_wad_path: String,
    _material_names: Vec<String>,
) -> Result<serde_json::Value, String> {
    Err(UNAVAILABLE.into())
}

pub async fn read_mapgeo_water_materials_disk(
    _mapgeo_path: String,
    _material_names: Vec<String>,
) -> Result<serde_json::Value, String> {
    Err(UNAVAILABLE.into())
}

pub async fn wad_read_mapgeo_water_materials(
    _id: u64,
    _mapgeo_wad_path: String,
    _material_names: Vec<String>,
) -> Result<serde_json::Value, String> {
    Err(UNAVAILABLE.into())
}

pub async fn map_env_disk(_mapgeo_path: String) -> Result<serde_json::Value, String> {
    Err(UNAVAILABLE.into())
}

pub async fn wad_map_env(
    _id: u64,
    _mapgeo_wad_path: String,
) -> Result<serde_json::Value, String> {
    Err(UNAVAILABLE.into())
}

pub async fn resolve_map_assets_disk(
    _mapgeo_path: String,
    _asset_paths: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    Err(UNAVAILABLE.into())
}

pub async fn wad_resolve_assets(
    _id: u64,
    _asset_paths: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    Err(UNAVAILABLE.into())
}

pub async fn read_skn_toon_materials_disk(
    _skn_path: String,
) -> Result<serde_json::Value, String> {
    Err(UNAVAILABLE.into())
}

pub async fn shaderforge_mount_wad(_path: String) -> Result<u64, String> {
    Err(UNAVAILABLE.into())
}

pub async fn shaderforge_unmount_wad(_id: u64) -> Result<bool, String> {
    Err(UNAVAILABLE.into())
}
