//! Animation BIN parsing and ANM file loading
//! Discovers animation BINs from skin dependencies and loads ANM files.

use std::fs;
use std::path::{Path, PathBuf};

use crate::bin::ltk_bridge;
use ltk_meta::PropertyValueEnum;
use ritoshark::anim::Animation;
// Only `Parse` is needed (for `Animation::from_bytes`); importing the whole prelude would also
// pull rs_io's `Serialize` trait into scope, which reads confusingly next to `serde::Serialize`.
use ritoshark::prelude::Parse;
use serde::Serialize;

/// Information about a single animation clip
#[derive(Debug, Clone, Serialize)]
pub struct AnimationClipInfo {
    /// Name/ID of the clip (from hash or derived from path)
    pub name: String,
    /// Track data name (e.g., "Default")
    pub track_name: Option<String>,
    /// Full path to the .anm file
    pub animation_path: String,
}

/// List of animations extracted from animation BIN file
#[derive(Debug, Clone, Serialize)]
pub struct AnimationList {
    /// All animation clips found
    pub clips: Vec<AnimationClipInfo>,
}

/// Extract animation BIN path from skin BIN's dependencies list.
/// Animation BINs are Type 2 (contain "/animations/" in path).
pub fn extract_animation_graph_path(skin_bin_path: &Path) -> Option<PathBuf> {
    tracing::debug!("Extracting animation BIN from dependencies: {}", skin_bin_path.display());
    
    // Read and parse the skin BIN file
    let data = fs::read(skin_bin_path).ok()?;
    let tree = ltk_bridge::read_bin(&data).ok()?;
    
    // Look through dependencies for animation BIN (Type 2)
    // Animation BINs have "/animations/" in their path
    tracing::debug!("Skin BIN has {} dependencies", tree.dependencies.len());
    
    for dep_path in &tree.dependencies {
        let normalized = dep_path.to_lowercase().replace('\\', "/");
        tracing::debug!("  Checking dependency: {}", dep_path);
        
        // Type 2: Animation BINs - in the animations folder
        if normalized.contains("/animations/") && normalized.ends_with(".bin") {
            tracing::debug!("Found animation BIN in dependencies: {}", dep_path);
            return resolve_animation_bin_from_reference(skin_bin_path, dep_path);
        }
    }
    
    tracing::debug!("No animation BIN found in skin BIN dependencies");
    None
}

/// Resolve an animation BIN reference path to an actual file path
/// 
/// Simple approach: skin BIN is at skins/skinX.bin, animation BIN is at animations/skinX.bin
/// Just go up one folder and look in animations/
fn resolve_animation_bin_from_reference(skin_bin_path: &Path, reference_path: &str) -> Option<PathBuf> {
    tracing::debug!("Resolving animation reference: {} from {}", reference_path, skin_bin_path.display());
    
    // Extract just the filename (e.g., "Skin20.bin")
    let filename = Path::new(reference_path).file_name()?.to_string_lossy().to_string();
    
    // skin_bin_path is like: .../data/characters/kayn/skins/skin20.bin
    // We want:               .../data/characters/kayn/animations/skin20.bin
    
    // Go up from skin BIN (skin20.bin -> skins -> kayn)
    let skins_folder = skin_bin_path.parent()?;  // .../skins
    let champion_folder = skins_folder.parent()?;  // .../kayn
    
    // Look for animations folder as sibling to skins
    let animations_folder = champion_folder.join("animations");
    let anim_bin_path = animations_folder.join(&filename);
    
    tracing::debug!("Looking for animation BIN at: {}", anim_bin_path.display());
    
    if anim_bin_path.exists() {
        tracing::debug!("Found animation BIN: {}", anim_bin_path.display());
        return Some(anim_bin_path);
    }
    
    // Try lowercase filename
    let filename_lower = filename.to_lowercase();
    let anim_bin_path_lower = animations_folder.join(&filename_lower);
    if anim_bin_path_lower.exists() {
        tracing::debug!("Found animation BIN (lowercase): {}", anim_bin_path_lower.display());
        return Some(anim_bin_path_lower);
    }
    
    tracing::debug!("Animation BIN not found at expected location");
    None
}

/// Find animation BIN for a skin.
/// First checks skin BIN dependencies, then falls back to directory search.
pub fn find_animation_bin(skn_path: &Path) -> Option<PathBuf> {
    tracing::debug!("Looking for animation BIN relative to: {}", skn_path.display());
    
    // NEW: Strategy 0 - Check skin BIN for animation graph reference
    // Import find_skin_bin from texture module
    if let Some(skin_bin_path) = crate::mesh::texture::find_skin_bin(skn_path) {
        tracing::debug!("Found skin BIN, checking for animation graph reference: {}", skin_bin_path.display());
        if let Some(anim_bin) = extract_animation_graph_path(&skin_bin_path) {
            tracing::debug!("Found animation BIN via skin BIN reference: {}", anim_bin.display());
            return Some(anim_bin);
        }
    }
    
    // Strategy 1: animation folder in same directory as SKN
    if let Some(skin_dir) = skn_path.parent() {
        let anim_dir = skin_dir.join("animation");
        tracing::debug!("Checking for animation dir at: {}", anim_dir.display());
        if anim_dir.exists() {
            for i in 0..20 {
                let bin_path = anim_dir.join(format!("skin{}.bin", i));
                if bin_path.exists() {
                    tracing::debug!("Found animation BIN: {}", bin_path.display());
                    return Some(bin_path);
                }
            }
            tracing::debug!("Animation dir exists but no skinX.bin found");
        }
        
        // Strategy 2: Parent directory
        if let Some(parent) = skin_dir.parent() {
            let anim_dir = parent.join("animation");
            tracing::debug!("Checking parent for animation dir at: {}", anim_dir.display());
            if anim_dir.exists() {
                for i in 0..20 {
                    let bin_path = anim_dir.join(format!("skin{}.bin", i));
                    if bin_path.exists() {
                        tracing::debug!("Found animation BIN in parent: {}", bin_path.display());
                        return Some(bin_path);
                    }
                }
            }
        }
    }
    
    // Strategy 3: Look for data/characters/{champion}/animations/ structure
    // Extract champion name from path (characters/ pattern or WAD folder name)
    let path_str = skn_path.to_string_lossy().to_lowercase();
    let components: Vec<&str> = path_str.split(&['/', '\\'][..]).collect();

    let champion_name: Option<String> = {
        // Try characters/{champion} pattern
        let mut found = None;
        for (i, part) in components.iter().enumerate() {
            if *part == "characters" && i + 1 < components.len() {
                found = Some(components[i + 1].to_string());
                break;
            }
        }
        // Try WAD folder name (e.g., "aurora.wad.client" → "aurora")
        if found.is_none() {
            for part in &components {
                if let Some(name) = part.strip_suffix(".wad.client")
                    .or_else(|| part.strip_suffix(".wad"))
                {
                    if !name.is_empty() {
                        found = Some(name.to_string());
                        break;
                    }
                }
            }
        }
        found
    };

    // Also extract skin folder (e.g., "skin11") for targeted lookup
    let skin_folder: Option<String> = {
        let mut found = None;
        for part in components.iter().rev() {
            if part.starts_with("skin") && part.len() > 4 && part[4..].chars().all(|c| c.is_ascii_digit()) {
                found = Some(part.to_string());
                break;
            }
        }
        found
    };

    if let Some(ref champion) = champion_name {
        // Search up for project root (skip WAD folders)
        let mut current = skn_path.parent();
        while let Some(dir) = current {
            let data_dir = dir.join("data");
            if data_dir.exists() && data_dir.is_dir() {
                let dir_name = dir.file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default();

                // Skip WAD folders, keep going up
                if dir_name.ends_with(".wad.client") || dir_name.ends_with(".wad") {
                    current = dir.parent();
                    continue;
                }

                let anim_dir = data_dir
                    .join("characters")
                    .join(champion)
                    .join("animations");

                // Try specific skin first (e.g., skin11.bin)
                if let Some(ref skin) = skin_folder {
                    let skin_anim = anim_dir.join(format!("{}.bin", skin));
                    if skin_anim.exists() {
                        tracing::debug!("Found animation BIN for {}: {}", skin, skin_anim.display());
                        return Some(skin_anim);
                    }
                }

                // Fall back to skin0.bin
                let skin0_anim = anim_dir.join("skin0.bin");
                if skin0_anim.exists() {
                    tracing::debug!("Found animation BIN (skin0): {}", skin0_anim.display());
                    return Some(skin0_anim);
                }
                break;
            }
            current = dir.parent();
        }
    }
    
    // Strategy 4: Search up for data/ folder
    let mut current = skn_path.parent();
    while let Some(dir) = current {
        let data_path = dir.join("data");
        if data_path.exists() {
            // Search for any animations/skin0.bin in data/characters/*/
            if let Ok(entries) = std::fs::read_dir(data_path.join("characters")) {
                for entry in entries.flatten() {
                    let anim_path = entry.path().join("animations").join("skin0.bin");
                    if anim_path.exists() {
                        tracing::debug!("Found animation BIN via data search: {}", anim_path.display());
                        return Some(anim_path);
                    }
                }
            }
            break; // Don't search further up once we found a data/ folder
        }
        current = dir.parent();
    }
    
    tracing::debug!("Animation BIN not found");
    None
}

/// Extract animation list from animation BIN file
/// 
/// Parses the BIN looking for AtomicClipData objects with mAnimationFilePath
pub fn extract_animation_list(bin_path: &Path) -> anyhow::Result<AnimationList> {
    let data = fs::read(bin_path)?;
    let tree = ltk_bridge::read_bin(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse animation BIN: {}", e))?;
    
    let mut clips = Vec::new();
    
    // Iterate through all objects to find AtomicClipData
    for (_path_hash, object) in &tree.objects {
        // Look through properties for embedded AnimationResourceData
        for (_name_hash, prop) in &object.properties {
            extract_animation_paths_from_value(&prop.value, &mut clips);
        }
    }
    
    Ok(AnimationList { clips })
}

/// Recursively extract animation paths from property values
fn extract_animation_paths_from_value(value: &PropertyValueEnum, clips: &mut Vec<AnimationClipInfo>) {
    match value {
        PropertyValueEnum::String(string_val) => {
            let s = &string_val.value;
            // Check if this is an animation path
            if s.to_lowercase().ends_with(".anm") {
                // Extract name from path
                let name = Path::new(s)
                    .file_stem()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Unknown".to_string());

                clips.push(AnimationClipInfo {
                    name,
                    track_name: None,
                    animation_path: s.clone(),
                });
            }
        }

        PropertyValueEnum::Embedded(embedded) => {
            for (_hash, prop) in &embedded.0.properties {
                extract_animation_paths_from_value(&prop.value, clips);
            }
        }

        PropertyValueEnum::Container(container) => {
            for item in container.clone().into_items() {
                extract_animation_paths_from_value(&item, clips);
            }
        }

        PropertyValueEnum::Struct(struct_val) => {
            for (_hash, prop) in &struct_val.properties {
                extract_animation_paths_from_value(&prop.value, clips);
            }
        }

        PropertyValueEnum::Optional(opt) => {
            if let Some(inner) = opt.clone().into_inner() {
                extract_animation_paths_from_value(&inner, clips);
            }
        }

        PropertyValueEnum::Map(map) => {
            for (_key, val) in map.entries() {
                extract_animation_paths_from_value(val, clips);
            }
        }

        _ => {}
    }
}

/// Resolve animation path relative to project directory
/// 
/// Animation paths from BIN are like: ASSETS/SirDexal/.../Animations/name.anm
/// Need to find the wad.client folder and resolve relative to it
pub fn resolve_animation_path(base_dir: &Path, anim_path: &str) -> Option<PathBuf> {
    tracing::debug!("Resolving animation path: {} from base {}", anim_path, base_dir.display());
    
    // The path from BIN starts with ASSETS/ - convert to lowercase assets/
    let normalized_path = anim_path
        .replace("ASSETS/", "assets/")
        .replace("ASSETS\\", "assets/")
        .replace('\\', "/");
    
    // Search up from base_dir to find a folder that contains "assets" subfolder
    let mut current = Some(base_dir);
    while let Some(dir) = current {
        // Check if this dir has an "assets" folder
        let assets_path = dir.join("assets");
        if assets_path.exists() {
            // Found it! Now try to resolve the path
            // The normalized_path is like "assets/SirDexal/..."
            let candidate = dir.join(&normalized_path);
            tracing::debug!("Checking candidate path: {}", candidate.display());
            if candidate.exists() {
                tracing::debug!("Found animation at: {}", candidate.display());
                return Some(candidate);
            }
            
            // Also try without the assets/ prefix since we already joined with assets folder
            let without_prefix = normalized_path.strip_prefix("assets/").unwrap_or(&normalized_path);
            let candidate2 = assets_path.join(without_prefix);
            tracing::debug!("Checking alternate path: {}", candidate2.display());
            if candidate2.exists() {
                tracing::debug!("Found animation at: {}", candidate2.display());
                return Some(candidate2);
            }
        }
        
        // Check if we're at a .wad folder (common project root)
        if let Some(name) = dir.file_name() {
            let name_str = name.to_string_lossy().to_lowercase();
            if name_str.contains(".wad") || name_str.contains("wad.client") {
                // This is the wad folder, assets should be directly under it
                let candidate = dir.join(&normalized_path);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
        
        current = dir.parent();
    }
    
    // Strategy 2: Try the full path as-is
    let full_path = PathBuf::from(anim_path);
    if full_path.exists() {
        return Some(full_path);
    }
    
    tracing::debug!("Animation file not found: {}", anim_path);
    None
}

#[derive(Debug, Clone, Serialize)]
pub struct BakedFrame {
    pub translation: [f32; 3],
    pub rotation: [f32; 4], // xyzw
    pub scale: [f32; 3],
}

#[derive(Debug, Clone, Serialize)]
pub struct BakedTrack {
    pub joint_hash: u32,
    pub frames: Vec<BakedFrame>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BakedAnimation {
    pub duration: f32,
    pub fps: f32,
    pub frame_count: u32,
    pub tracks: Vec<BakedTrack>,
}

/// Parse and bake an ANM file into a complete frame-by-frame animation object.
pub fn bake_animation_file<P: AsRef<Path>>(path: P) -> anyhow::Result<BakedAnimation> {
    let data = fs::read(path.as_ref())?;

    // RitoShark fully decodes the animation up front (uncompressed r3d2anmd v3/4/5 AND
    // compressed r3d2canm v1/2/3) and returns explicit per-joint, per-frame keyframes — no
    // separate `evaluate`/bake pass is needed. It returns Err for unsupported formats instead
    // of panicking, so the previous catch_unwind wrapper is gone.
    let animation = Animation::from_bytes(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse ANM file: {:?}", e))?;

    let fps = animation.fps;

    // RitoShark lays every track's frames out in global frame order, and every track in a given
    // file shares the same frame count. The frontend player (animationPlayer.ts) indexes
    // `track.frames[floor(time * fps)]`, so frame_count is that shared length and duration is the
    // time span those frames cover.
    let frame_count = animation
        .tracks
        .iter()
        .map(|t| t.frames.len())
        .max()
        .unwrap_or(0)
        .max(1);

    let frame_duration = if fps > 0.0 { 1.0 / fps } else { 0.0333 };
    // Duration spans the played frames: frame index runs 0..=frame_count-1, so the last sampled
    // time is (frame_count - 1) * frame_duration. Matches the frontend's `time * fps` indexing.
    let duration = (frame_count.saturating_sub(1)) as f32 * frame_duration;

    let tracks = animation
        .tracks
        .iter()
        .map(|track| {
            let frames = track
                .frames
                .iter()
                .map(|frame| {
                    // Apply the same X-mirror that skl.rs applies to skeleton joints
                    // (local_translation: [-x, y, z], local_rotation: [x, -y, -z, w]).
                    // Without this, animation frames are in raw League space while the
                    // skeleton bind pose is in mirrored space — causing deformation to
                    // twist/explode during playback.
                    BakedFrame {
                        translation: [
                            -frame.translation.x,
                            frame.translation.y,
                            frame.translation.z,
                        ],
                        rotation: [
                            frame.rotation.x,
                            -frame.rotation.y,
                            -frame.rotation.z,
                            frame.rotation.w,
                        ],
                        scale: [frame.scale.x, frame.scale.y, frame.scale.z],
                    }
                })
                .collect();
            BakedTrack {
                joint_hash: track.joint_hash,
                frames,
            }
        })
        .collect();

    Ok(BakedAnimation {
        duration,
        fps,
        frame_count: frame_count as u32,
        tracks,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_find_animation_bin() {
        // Test would require actual files
    }
}

