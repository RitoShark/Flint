//! Texture resolution from BIN files
//! 
//! Parses skin0.bin to extract texture mappings for SKN materials.
//! Supports SkinMeshDataProperties with texture and materialOverride fields.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::core::bin::ltk_bridge;
use ltk_meta::{BinTree, PropertyValueEnum};
use serde::Serialize;

/// Texture mapping extracted from BIN file
#[derive(Debug, Clone, Serialize, Default)]
pub struct TextureMapping {
    /// Default texture path for meshes without specific override
    pub default_texture: Option<String>,
    /// Per-submesh texture overrides (submesh name → texture path)
    pub material_overrides: HashMap<String, String>,
    /// Static material references that couldn't be resolved (TODO: implement)
    pub static_materials: Vec<String>,
}

/// Find skin0.bin relative to an SKN file
/// 
/// Looks for skin0.bin in multiple locations:
/// 1. Same directory as SKN
/// 2. Parent directories
/// 3. data/characters/{champion}/skins/ structure (for refathered projects)
pub fn find_skin_bin(skn_path: &Path) -> Option<PathBuf> {
    tracing::debug!("Looking for skin0.bin relative to: {}", skn_path.display());
    
    // Strategy 1: Same directory as SKN
    if let Some(parent) = skn_path.parent() {
        let bin_path = parent.join("skin0.bin");
        tracing::debug!("Checking for skin0.bin at: {}", bin_path.display());
        if bin_path.exists() {
            tracing::debug!("Found skin0.bin!");
            return Some(bin_path);
        }
        
        // Strategy 2: Parent directory
        if let Some(grandparent) = parent.parent() {
            let bin_path = grandparent.join("skin0.bin");
            tracing::debug!("Checking parent dir for skin0.bin at: {}", bin_path.display());
            if bin_path.exists() {
                tracing::debug!("Found skin0.bin in parent!");
                return Some(bin_path);
            }
        }
    }
    
    // Strategy 3: Look for data/ folder structure
    // If SKN is in assets/.../characters/{champion}/skins/{skin}/
    // Then look for data/characters/{champion}/skins/skin0.bin
    let path_str = skn_path.to_string_lossy().to_lowercase();
    if let Some(assets_idx) = path_str.find("assets") {
        // Try to find project root (parent of assets/)
        let path_parts: Vec<&str> = skn_path.to_str()?.split(&['/', '\\'][..]).collect();
        
        for (i, part) in path_parts.iter().enumerate() {
            if part.to_lowercase() == "assets" || part.to_lowercase().contains("assets") {
                // Found assets folder, look for data folder at same level
                let project_root: PathBuf = path_parts[..i].iter().collect();
                
                // Try to extract champion name from path
                // Path like: .../characters/aatrox/skins/...
                if let Some(char_idx) = path_str.find("characters") {
                    let after_char = &path_str[char_idx + "characters/".len()..];
                    if let Some(slash_idx) = after_char.find(&['/', '\\'][..]) {
                        let champion = &after_char[..slash_idx];
                        
                        // Construct data path
                        let data_path = project_root
                            .join("data")
                            .join("characters")
                            .join(champion)
                            .join("skins")
                            .join("skin0.bin");
                        
                        tracing::debug!("Checking data path: {}", data_path.display());
                        if data_path.exists() {
                            tracing::debug!("Found skin0.bin in data folder!");
                            return Some(data_path);
                        }
                    }
                }
                break;
            }
        }
    }
    
    // Strategy 4: Search up for content/ folder and look for data/ sibling
    let mut current = skn_path.parent();
    while let Some(dir) = current {
        let dir_name = dir.file_name().map(|n| n.to_string_lossy().to_lowercase());
        
        // Check if we're at content level or project root
        if dir_name.as_ref().map(|n| n.contains("content") || n.contains("wad")).unwrap_or(false) {
            // Look for data folder here
            let data_path = dir.join("data");
            if data_path.exists() {
                // Search for any skin0.bin in data/characters/*/skins/
                if let Ok(entries) = std::fs::read_dir(data_path.join("characters")) {
                    for entry in entries.flatten() {
                        let skins_path = entry.path().join("skins").join("skin0.bin");
                        if skins_path.exists() {
                            tracing::debug!("Found skin0.bin via data search: {}", skins_path.display());
                            return Some(skins_path);
                        }
                    }
                }
            }
        }
        current = dir.parent();
    }
    
    tracing::debug!("skin0.bin not found");
    None
}

/// Extract texture mappings from a skin0.bin file
/// 
/// Parses the BIN and looks for SkinMeshDataProperties entries that contain:
/// - texture: default texture path
/// - materialOverride: list of submesh → texture mappings
pub fn extract_texture_mapping(bin_path: &Path) -> anyhow::Result<TextureMapping> {
    let data = fs::read(bin_path)?;
    let tree = ltk_bridge::read_bin(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse BIN: {}", e))?;
    
    extract_texture_mapping_from_tree(&tree)
}

/// Extract texture mappings from a parsed BinTree
fn extract_texture_mapping_from_tree(tree: &BinTree) -> anyhow::Result<TextureMapping> {
    let mut mapping = TextureMapping::default();
    
    // Iterate through all objects to find texture info
    for (_path_hash, object) in &tree.objects {
        // Look through all properties in this object
        for (_name_hash, prop) in &object.properties {
            // Recurse into the property value to find textures
            extract_from_value(&prop.value, &mut mapping);
        }
    }
    
    Ok(mapping)
}

/// Extract texture info from a property value (recursive)
fn extract_from_value(value: &PropertyValueEnum, mapping: &mut TextureMapping) {
    match value {
        // String values might be texture paths
        PropertyValueEnum::String(string_val) => {
            let s = &string_val.0;
            let lower = s.to_lowercase();
            if (lower.ends_with(".tex") || lower.ends_with(".dds")) && mapping.default_texture.is_none() {
                mapping.default_texture = Some(s.clone());
            }
        }
        
        // Embedded structures might contain textures or material overrides
        PropertyValueEnum::Embedded(embedded) => {
            // EmbeddedValue wraps StructValue which has properties
            for (_hash, prop) in &embedded.0.properties {
                extract_from_value(&prop.value, mapping);
            }
        }
        
        // Containers (lists) might be materialOverride list
        PropertyValueEnum::Container(container) => {
            for item in &container.items {
                // Check if this is a material override embed
                if let PropertyValueEnum::Embedded(embed) = item {
                    extract_material_override(&embed.0.properties, mapping);
                }
                // Also recurse into items
                extract_from_value(item, mapping);
            }
        }
        
        // Struct values also have properties
        PropertyValueEnum::Struct(struct_val) => {
            for (_hash, prop) in &struct_val.properties {
                extract_from_value(&prop.value, mapping);
            }
        }
        
        // Optional values might contain embedded data
        PropertyValueEnum::Optional(opt) => {
            if let Some(inner) = &opt.value {
                extract_from_value(inner, mapping);
            }
        }
        
        // Other value types don't contain texture info
        _ => {}
    }
}

/// Extract a material override entry (submesh → texture)
fn extract_material_override(props: &HashMap<u32, ltk_meta::BinProperty>, mapping: &mut TextureMapping) {
    let mut submesh: Option<String> = None;
    let mut texture: Option<String> = None;
    let mut material: Option<String> = None;
    
    for (_hash, prop) in props {
        if let PropertyValueEnum::String(string_val) = &prop.value {
            let s = &string_val.0;
            let lower = s.to_lowercase();
            if lower.ends_with(".tex") || lower.ends_with(".dds") {
                texture = Some(s.clone());
            } else if lower.ends_with(".bin") {
                // This is a static material reference (TODO)
                material = Some(s.clone());
            } else if !s.is_empty() && submesh.is_none() {
                // Likely the submesh name (first non-path string)
                submesh = Some(s.clone());
            }
        }
    }
    
    // If we found both submesh and texture, add to mapping
    if let (Some(mesh), Some(tex)) = (submesh.clone(), texture) {
        mapping.material_overrides.insert(mesh, tex);
    }
    
    // If we found a material reference instead of texture, track it for TODO
    if let (Some(mesh), Some(mat)) = (submesh, material) {
        mapping.static_materials.push(format!("{}: {}", mesh, mat));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_skin_bin_same_dir() {
        // Test would require actual files
    }
}
