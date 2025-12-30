//! Mesh commands for SKN/SKL/SCB file parsing
//! 
//! Provides Tauri commands for reading 3D mesh data from League files.

use std::path::Path;
use std::collections::HashMap;

use crate::core::mesh::skn::{parse_skn_file, SknMeshData};
use crate::core::mesh::scb::{parse_scb_file, ScbMeshData};
use crate::core::mesh::texture::{find_skin_bin, extract_texture_mapping, lookup_material_texture_by_name};
use crate::commands::file::decode_dds_to_png;

/// Read and parse an SCB (Static Mesh Binary) file
/// 
/// Returns mesh data including vertices, normals, UVs, indices, and materials
/// for 3D rendering in the frontend.
#[tauri::command]
pub async fn read_scb_mesh(path: String) -> Result<ScbMeshData, String> {
    tracing::debug!("Reading SCB mesh: {}", path);
    
    parse_scb_file(&path)
        .map_err(|e| {
            tracing::error!("Failed to parse SCB file {}: {}", path, e);
            format!("Failed to parse SCB file: {}", e)
        })
}

/// Read and parse an SKN (Simple Skin) mesh file
/// 
/// Returns mesh data including vertices, normals, UVs, indices, materials,
/// and decoded textures for 3D rendering in the frontend.
#[tauri::command]
pub async fn read_skn_mesh(path: String) -> Result<SknMeshData, String> {
    tracing::info!("Reading SKN mesh: {}", path);
    
    let skn_path = Path::new(&path);
    
    // Parse the SKN file
    let mut mesh_data = parse_skn_file(&path)
        .map_err(|e| {
            tracing::error!("Failed to parse SKN file {}: {}", path, e);
            format!("Failed to parse SKN file: {}", e)
        })?;
    
    tracing::info!("SKN parsed successfully. Materials: {:?}", 
        mesh_data.materials.iter().map(|m| &m.name).collect::<Vec<_>>());
    
    // Try to find and parse skin0.bin for texture mappings
    if let Some(bin_path) = find_skin_bin(skn_path) {
        tracing::info!("Found skin0.bin: {}", bin_path.display());
        
        match extract_texture_mapping(&bin_path) {
            Ok(texture_mapping) => {
                tracing::info!(
                    "Extracted texture mapping: default={:?}, overrides={:?}", 
                    texture_mapping.default_texture,
                    texture_mapping.material_overrides.keys().collect::<Vec<_>>()
                );
                
                // Get the project/skin directory for resolving texture paths
                let base_dir = skn_path.parent().unwrap_or(Path::new("."));
                tracing::debug!("Base dir for texture resolution: {}", base_dir.display());
                
                // Collect all texture paths to load (deduplicate by path to avoid loading same texture multiple times)
                let mut texture_tasks: Vec<(String, std::path::PathBuf)> = Vec::new();
                let mut path_to_materials: HashMap<String, Vec<String>> = HashMap::new();
                
                for material in &mesh_data.materials {
                    let material_name = &material.name;
                    
                    // Strategy 1: Direct match in material_overrides
                    let texture_path = texture_mapping.material_overrides
                        .get(material_name)
                        .cloned()
                        // Strategy 2: Strip "mesh_" prefix from SKN material name
                        .or_else(|| {
                            if material_name.starts_with("mesh_") {
                                let stripped = &material_name[5..];
                                texture_mapping.material_overrides.get(stripped).cloned()
                            } else {
                                None
                            }
                        })
                        // Strategy 3: Add "mesh_" prefix to SKN material name
                        .or_else(|| {
                            texture_mapping.material_overrides.get(&format!("mesh_{}", material_name)).cloned()
                        })
                        // Strategy 4: Case-insensitive match in material_overrides
                        .or_else(|| {
                            let lower_name = material_name.to_lowercase();
                            texture_mapping.material_overrides.iter()
                                .find(|(k, _)| k.to_lowercase() == lower_name)
                                .map(|(_, v)| v.clone())
                        })
                        // Strategy 5: Case-insensitive with "mesh_" prefix stripping
                        .or_else(|| {
                            let lower_name = material_name.to_lowercase();
                            let stripped = if lower_name.starts_with("mesh_") {
                                &lower_name[5..]
                            } else {
                                &lower_name
                            };
                            texture_mapping.material_overrides.iter()
                                .find(|(k, _)| k.to_lowercase() == stripped)
                                .map(|(_, v)| v.clone())
                        })
                        // Strategy 6: Search for StaticMaterialDef matching this material name
                        .or_else(|| {
                            tracing::debug!("Trying StaticMaterialDef lookup for: {}", material_name);
                            lookup_material_texture_by_name(&texture_mapping.ritobin_content, material_name)
                        })
                        // Strategy 7: Try StaticMaterialDef lookup with stripped name
                        .or_else(|| {
                            if material_name.starts_with("mesh_") {
                                let stripped = &material_name[5..];
                                tracing::debug!("Trying StaticMaterialDef lookup for stripped name: {}", stripped);
                                lookup_material_texture_by_name(&texture_mapping.ritobin_content, stripped)
                            } else {
                                None
                            }
                        })
                        // Strategy 8: Fallback to default texture
                        .or_else(|| texture_mapping.default_texture.clone());
                    
                    if let Some(tex_path) = texture_path {
                        tracing::debug!("Material '{}' resolved to texture: {}", material_name, tex_path);
                        
                        // Try to resolve texture path
                        if let Some(resolved) = resolve_texture_path(base_dir, &tex_path) {
                            let path_key = resolved.to_string_lossy().to_string();
                            
                            // Track which materials use this texture path
                            path_to_materials.entry(path_key.clone())
                                .or_default()
                                .push(material_name.clone());
                            
                            // Only add to load list if not already queued
                            if !texture_tasks.iter().any(|(_, p)| p == &resolved) {
                                texture_tasks.push((path_key, resolved));
                            }
                        } else {
                            tracing::warn!("Texture file not found for '{}': {}", material_name, tex_path);
                        }
                    } else {
                        tracing::warn!("No texture resolved for material: {}", material_name);
                    }
                }
                
                tracing::info!("Loading {} unique textures in parallel...", texture_tasks.len());
                let start_time = std::time::Instant::now();
                
                // Load all textures in parallel
                let load_futures: Vec<_> = texture_tasks.into_iter()
                    .map(|(path_key, resolved_path)| {
                        let path_str = resolved_path.to_string_lossy().to_string();
                        async move {
                            match decode_dds_to_png(path_str.clone()).await {
                                Ok(decoded) => Some((path_key, decoded.data)),
                                Err(e) => {
                                    tracing::warn!("Failed to decode texture {}: {}", path_str, e);
                                    None
                                }
                            }
                        }
                    })
                    .collect();
                
                let results = futures::future::join_all(load_futures).await;
                
                // Build textures map - assign each decoded texture to all materials that use it
                let mut textures: HashMap<String, String> = HashMap::new();
                for result in results.into_iter().flatten() {
                    let (path_key, data) = result;
                    if let Some(material_names) = path_to_materials.get(&path_key) {
                        for mat_name in material_names {
                            textures.insert(mat_name.clone(), data.clone());
                        }
                    }
                }
                
                let elapsed = start_time.elapsed();
                tracing::info!("Loaded {} textures in {:.2}s", textures.len(), elapsed.as_secs_f32());
                mesh_data.textures = textures;
                
                // Log static material TODOs
                if !texture_mapping.static_materials.is_empty() {
                    tracing::info!(
                        "Unresolved material references: {:?}",
                        texture_mapping.static_materials
                    );
                }
            }
            Err(e) => {
                tracing::warn!("Failed to extract texture mapping from skin0.bin: {}", e);
            }
        }
    } else {
        tracing::warn!("No skin0.bin found for texture mapping (searched from {})", skn_path.display());
    }
    
    Ok(mesh_data)
}

/// Resolve a texture path relative to the project directory
/// 
/// Tries multiple strategies:
/// 1. Extract filename and look in base_dir
/// 2. Try the full ASSETS/ path relative to project root
fn resolve_texture_path(base_dir: &Path, texture_path: &str) -> Option<std::path::PathBuf> {
    // Strategy 1: Just use the filename in the same directory as SKN
    let filename = Path::new(texture_path)
        .file_name()?
        .to_string_lossy();
    
    let same_dir_path = base_dir.join(filename.as_ref());
    if same_dir_path.exists() {
        return Some(same_dir_path);
    }
    
    // Strategy 2: Try the path as-is (might be repathed)
    let texture_path_buf = std::path::PathBuf::from(texture_path);
    if texture_path_buf.exists() {
        return Some(texture_path_buf);
    }
    
    // Strategy 3: Try stripping ASSETS/ prefix and resolving from base_dir parent
    let normalized = texture_path
        .trim_start_matches("ASSETS/")
        .trim_start_matches("assets/");
    
    // Go up to find project root (look for parent directories)
    let mut search_dir = base_dir.to_path_buf();
    for _ in 0..5 {
        let candidate = search_dir.join(normalized);
        if candidate.exists() {
            return Some(candidate);
        }
        
        if let Some(parent) = search_dir.parent() {
            search_dir = parent.to_path_buf();
        } else {
            break;
        }
    }
    
    None
}

use crate::core::mesh::skl::{parse_skl_file, SklData};

/// Read and parse an SKL (Skeleton) file
/// 
/// Returns skeleton data including bone hierarchy with names, parent IDs,
/// and local transforms for visualization and animation.
#[tauri::command]
pub async fn read_skl_skeleton(path: String) -> Result<SklData, String> {
    tracing::debug!("Reading SKL skeleton: {}", path);
    
    parse_skl_file(&path)
        .map_err(|e| {
            tracing::error!("Failed to parse SKL file {}: {}", path, e);
            format!("Failed to parse SKL file: {}", e)
        })
}

use crate::core::mesh::animation::{
    find_animation_bin, extract_animation_list, parse_animation_file, 
    resolve_animation_path, evaluate_animation_at,
    AnimationList, AnimationData, AnimationPose,
};

/// Get list of available animations for a model
/// 
/// Parses the animation BIN file to extract AtomicClipData animation paths
#[tauri::command]
pub async fn read_animation_list(skn_path: String) -> Result<AnimationList, String> {
    tracing::debug!("Reading animation list for: {}", skn_path);
    
    let skn_path = std::path::Path::new(&skn_path);
    
    // Find animation BIN file
    let bin_path = find_animation_bin(skn_path)
        .ok_or_else(|| "Animation BIN file not found".to_string())?;
    
    tracing::debug!("Found animation BIN: {}", bin_path.display());
    
    extract_animation_list(&bin_path)
        .map_err(|e| {
            tracing::error!("Failed to extract animation list: {}", e);
            format!("Failed to extract animation list: {}", e)
        })
}

/// Read and parse an ANM animation file
#[tauri::command]
pub async fn read_animation(path: String, base_path: Option<String>) -> Result<AnimationData, String> {
    tracing::debug!("Reading animation: {}", path);
    
    // Try to resolve the animation path
    let resolved_path = if let Some(base) = base_path {
        let base_dir = std::path::Path::new(&base).parent().unwrap_or(std::path::Path::new("."));
        resolve_animation_path(base_dir, &path)
    } else {
        Some(std::path::PathBuf::from(&path))
    };
    
    let anim_path = resolved_path
        .ok_or_else(|| format!("Could not resolve animation path: {}", path))?;
    
    if !anim_path.exists() {
        return Err(format!("Animation file not found: {}", anim_path.display()));
    }
    
    parse_animation_file(&anim_path)
        .map_err(|e| {
            tracing::error!("Failed to parse animation {}: {}", anim_path.display(), e);
            format!("Failed to parse animation: {}", e)
        })
}

/// Evaluate animation at a specific time to get joint poses
/// 
/// Returns a map of joint hash → (rotation, translation, scale) for all joints.
#[tauri::command]
pub async fn evaluate_animation(
    path: String, 
    base_path: Option<String>, 
    time: f32
) -> Result<AnimationPose, String> {
    tracing::debug!("Evaluating animation at time {}: {}", time, path);
    
    // Resolve the animation path
    let resolved_path = if let Some(base) = base_path {
        let base_dir = std::path::Path::new(&base)
            .parent()
            .unwrap_or(std::path::Path::new("."));
        resolve_animation_path(base_dir, &path)
    } else {
        Some(std::path::PathBuf::from(&path))
    };
    
    let anim_path = resolved_path
        .ok_or_else(|| format!("Could not resolve animation path: {}", path))?;
    
    if !anim_path.exists() {
        return Err(format!("Animation file not found: {}", anim_path.display()));
    }
    
    evaluate_animation_at(&anim_path, time)
        .map_err(|e| {
            tracing::error!("Failed to evaluate animation {}: {}", anim_path.display(), e);
            format!("Failed to evaluate animation: {}", e)
        })
}
