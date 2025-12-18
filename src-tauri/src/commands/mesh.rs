//! Mesh commands for SKN/SKL/SCB file parsing
//! 
//! Provides Tauri commands for reading 3D mesh data from League files.

use std::path::Path;
use std::collections::HashMap;

use crate::core::mesh::skn::{parse_skn_file, SknMeshData};
use crate::core::mesh::scb::{parse_scb_file, ScbMeshData};
use crate::core::mesh::texture::{find_skin_bin, extract_texture_mapping};
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
    tracing::debug!("Reading SKN mesh: {}", path);
    
    let skn_path = Path::new(&path);
    
    // Parse the SKN file
    let mut mesh_data = parse_skn_file(&path)
        .map_err(|e| {
            tracing::error!("Failed to parse SKN file {}: {}", path, e);
            format!("Failed to parse SKN file: {}", e)
        })?;
    
    // Try to find and parse skin0.bin for texture mappings
    if let Some(bin_path) = find_skin_bin(skn_path) {
        tracing::debug!("Found skin0.bin: {}", bin_path.display());
        
        match extract_texture_mapping(&bin_path) {
            Ok(texture_mapping) => {
                tracing::debug!(
                    "Extracted texture mapping: default={:?}, overrides={}", 
                    texture_mapping.default_texture,
                    texture_mapping.material_overrides.len()
                );
                
                // Get the project/skin directory for resolving texture paths
                let base_dir = skn_path.parent().unwrap_or(Path::new("."));
                
                // Load textures for each material
                let mut textures: HashMap<String, String> = HashMap::new();
                
                for material in &mesh_data.materials {
                    let material_name = &material.name;
                    
                    // Check for material-specific override first
                    let texture_path = texture_mapping.material_overrides
                        .get(material_name)
                        .cloned()
                        .or_else(|| texture_mapping.default_texture.clone());
                    
                    if let Some(tex_path) = texture_path {
                        // Try to resolve texture path
                        let resolved_path = resolve_texture_path(base_dir, &tex_path);
                        
                        if let Some(resolved) = resolved_path {
                            // Decode the texture to base64 PNG
                            match decode_dds_to_png(resolved.to_string_lossy().to_string()).await {
                                Ok(decoded) => {
                                    textures.insert(material_name.clone(), decoded.data);
                                    tracing::debug!("Loaded texture for {}: {}x{}", material_name, decoded.width, decoded.height);
                                }
                                Err(e) => {
                                    tracing::warn!("Failed to decode texture for {}: {}", material_name, e);
                                }
                            }
                        } else {
                            tracing::debug!("Texture not found for {}: {}", material_name, tex_path);
                        }
                    }
                }
                
                mesh_data.textures = textures;
                
                // Log static material TODOs
                if !texture_mapping.static_materials.is_empty() {
                    tracing::debug!(
                        "TODO: {} static material references need implementation: {:?}",
                        texture_mapping.static_materials.len(),
                        texture_mapping.static_materials
                    );
                }
            }
            Err(e) => {
                tracing::warn!("Failed to extract texture mapping from skin0.bin: {}", e);
            }
        }
    } else {
        tracing::debug!("No skin0.bin found for texture mapping");
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
    find_animation_bin, extract_animation_list, parse_animation_file, resolve_animation_path,
    AnimationList, AnimationData,
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
