//! Shader-preview commands — thin wrappers over the `flint-shaderforge`
//! boundary crate. In the default (stub) build every call answers
//! "shader preview unavailable" and the model preview stays on its
//! PBR/toon path; the `shaderforge` feature swaps in the private overlay.
//! Results are type-erased to JSON so this file compiles identically
//! against both sides.

use std::collections::HashMap;

fn to_value<T: serde::Serialize>(v: T) -> Result<serde_json::Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn translate_material_shader(
    shader_cache_path: String,
    shader_link: Option<String>,
    shader_link_hash: Option<u32>,
    switches_on: Vec<String>,
    macros: HashMap<String, String>,
    real_textures: Vec<String>,
) -> Result<serde_json::Value, String> {
    flint_shaderforge::translate_material_shader(
        shader_cache_path,
        shader_link,
        shader_link_hash,
        switches_on,
        macros,
        real_textures,
    )
    .await
    .and_then(to_value)
}

#[tauri::command]
pub async fn locate_shader_cache(hint_path: Option<String>) -> Result<Option<String>, String> {
    flint_shaderforge::locate_shader_cache(hint_path).await
}

#[tauri::command]
pub async fn read_skn_generic_materials_disk(
    skn_path: String,
) -> Result<serde_json::Value, String> {
    flint_shaderforge::read_skn_generic_materials_disk(skn_path)
        .await
        .and_then(to_value)
}

#[tauri::command]
pub async fn wad_read_skn_generic_materials(
    id: u64,
    skn_path_hash_hex: String,
    chroma_id: Option<u32>,
    buffs_active: Option<bool>,
) -> Result<serde_json::Value, String> {
    flint_shaderforge::wad_read_skn_generic_materials(id, skn_path_hash_hex, chroma_id, buffs_active)
        .await
        .and_then(to_value)
}

#[tauri::command]
pub async fn read_mapgeo_generic_materials_disk(
    mapgeo_path: String,
    material_names: Vec<String>,
) -> Result<serde_json::Value, String> {
    flint_shaderforge::read_mapgeo_generic_materials_disk(mapgeo_path, material_names)
        .await
        .and_then(to_value)
}

#[tauri::command]
pub async fn wad_read_mapgeo_generic_materials(
    id: u64,
    mapgeo_wad_path: String,
    material_names: Vec<String>,
) -> Result<serde_json::Value, String> {
    flint_shaderforge::wad_read_mapgeo_generic_materials(id, mapgeo_wad_path, material_names)
        .await
        .and_then(to_value)
}

#[tauri::command]
pub async fn read_mapgeo_water_materials_disk(
    mapgeo_path: String,
    material_names: Vec<String>,
) -> Result<serde_json::Value, String> {
    flint_shaderforge::read_mapgeo_water_materials_disk(mapgeo_path, material_names)
        .await
        .and_then(to_value)
}

#[tauri::command]
pub async fn wad_read_mapgeo_water_materials(
    id: u64,
    mapgeo_wad_path: String,
    material_names: Vec<String>,
) -> Result<serde_json::Value, String> {
    flint_shaderforge::wad_read_mapgeo_water_materials(id, mapgeo_wad_path, material_names)
        .await
        .and_then(to_value)
}

#[tauri::command]
pub async fn map_env_disk(mapgeo_path: String) -> Result<serde_json::Value, String> {
    flint_shaderforge::map_env_disk(mapgeo_path).await.and_then(to_value)
}

#[tauri::command]
pub async fn wad_map_env(id: u64, mapgeo_wad_path: String) -> Result<serde_json::Value, String> {
    flint_shaderforge::wad_map_env(id, mapgeo_wad_path)
        .await
        .and_then(to_value)
}

#[tauri::command]
pub async fn resolve_map_assets_disk(
    mapgeo_path: String,
    asset_paths: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    flint_shaderforge::resolve_map_assets_disk(mapgeo_path, asset_paths).await
}

#[tauri::command]
pub async fn wad_resolve_assets(
    id: u64,
    asset_paths: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    flint_shaderforge::wad_resolve_assets(id, asset_paths).await
}

#[tauri::command]
pub async fn read_skn_toon_materials_disk(
    skn_path: String,
) -> Result<serde_json::Value, String> {
    flint_shaderforge::read_skn_toon_materials_disk(skn_path)
        .await
        .and_then(to_value)
}

#[tauri::command]
pub async fn shaderforge_mount_wad(path: String) -> Result<u64, String> {
    flint_shaderforge::shaderforge_mount_wad(path).await
}

#[tauri::command]
pub async fn shaderforge_unmount_wad(id: u64) -> Result<bool, String> {
    flint_shaderforge::shaderforge_unmount_wad(id).await
}
