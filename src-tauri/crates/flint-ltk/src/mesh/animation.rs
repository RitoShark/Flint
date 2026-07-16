//! Animation BIN parsing and ANM file loading

use std::fs;
use std::path::{Path, PathBuf};

use crate::bin::ltk_bridge;
use ritoshark::bin::BinValue;
use ritoshark::anim::Animation;
use ritoshark::prelude::Parse;
use serde::Serialize;

use crate::mesh::submesh_visibility::SubmeshVisEvent;

#[derive(Debug, Clone, Serialize)]
pub struct AnimationClipInfo {
    pub name: String,
    pub track_name: Option<String>,
    pub animation_path: String,
    /// Submesh-visibility events for this clip, sorted by `start_frame`. Empty when the clip
    /// has none.
    #[serde(default)]
    pub events: Vec<SubmeshVisEvent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnimationList {
    pub clips: Vec<AnimationClipInfo>,
    /// Submesh names hidden at load (from the skin BIN's `initialSubmeshToHide`).
    #[serde(default)]
    pub initial_hide: Vec<String>,
    /// Submesh names excluded from the shadow pass at load
    /// (`initialSubmeshShadowsToHide`).
    #[serde(default)]
    pub initial_shadow_hide: Vec<String>,
}

pub fn extract_animation_graph_path(skin_bin_path: &Path) -> Option<PathBuf> {
    tracing::debug!("Extracting animation BIN from dependencies: {}", skin_bin_path.display());

    let data = fs::read(skin_bin_path).ok()?;
    let tree = ltk_bridge::read_bin(&data).ok()?;

    tracing::debug!("Skin BIN has {} linked files", tree.linked.len());

    for dep_path in &tree.linked {
        let normalized = dep_path.to_lowercase().replace('\\', "/");
        tracing::debug!("  Checking dependency: {}", dep_path);

        if normalized.contains("/animations/") && normalized.ends_with(".bin") {
            tracing::debug!("Found animation BIN in dependencies: {}", dep_path);
            return resolve_animation_bin_from_reference(skin_bin_path, dep_path);
        }
    }
    
    tracing::debug!("No animation BIN found in skin BIN dependencies");
    None
}

fn resolve_animation_bin_from_reference(skin_bin_path: &Path, reference_path: &str) -> Option<PathBuf> {
    tracing::debug!("Resolving animation reference: {} from {}", reference_path, skin_bin_path.display());

    let filename = Path::new(reference_path).file_name()?.to_string_lossy().to_string();

    let skins_folder = skin_bin_path.parent()?;
    let champion_folder = skins_folder.parent()?;

    let animations_folder = champion_folder.join("animations");
    let anim_bin_path = animations_folder.join(&filename);

    tracing::debug!("Looking for animation BIN at: {}", anim_bin_path.display());

    if anim_bin_path.exists() {
        tracing::debug!("Found animation BIN: {}", anim_bin_path.display());
        return Some(anim_bin_path);
    }

    let filename_lower = filename.to_lowercase();
    let anim_bin_path_lower = animations_folder.join(&filename_lower);
    if anim_bin_path_lower.exists() {
        tracing::debug!("Found animation BIN (lowercase): {}", anim_bin_path_lower.display());
        return Some(anim_bin_path_lower);
    }
    
    tracing::debug!("Animation BIN not found at expected location");
    None
}

pub fn find_animation_bin(skn_path: &Path) -> Option<PathBuf> {
    tracing::debug!("Looking for animation BIN relative to: {}", skn_path.display());

    if let Some(skin_bin_path) = crate::mesh::texture::find_skin_bin(skn_path) {
        tracing::debug!("Found skin BIN, checking for animation graph reference: {}", skin_bin_path.display());
        if let Some(anim_bin) = extract_animation_graph_path(&skin_bin_path) {
            tracing::debug!("Found animation BIN via skin BIN reference: {}", anim_bin.display());
            return Some(anim_bin);
        }
    }
    
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
    
    let path_str = skn_path.to_string_lossy().to_lowercase();
    let components: Vec<&str> = path_str.split(&['/', '\\'][..]).collect();

    let champion_name: Option<String> = {
        let mut found = None;
        for (i, part) in components.iter().enumerate() {
            if *part == "characters" && i + 1 < components.len() {
                found = Some(components[i + 1].to_string());
                break;
            }
        }
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
        let mut current = skn_path.parent();
        while let Some(dir) = current {
            let data_dir = dir.join("data");
            if data_dir.exists() && data_dir.is_dir() {
                // NOTE: WAD folders are checked too — in Flint projects the
                // extracted `.wad.client` folder IS where the `data/` tree
                // lives (the old skip-and-continue here meant the champion
                // loop never looked inside it and kept walking toward
                // AppData / the user's home, where a stray `data\` dir gave
                // machine-dependent misses).
                let anim_dir = data_dir
                    .join("characters")
                    .join(champion)
                    .join("animations");

                if let Some(ref skin) = skin_folder {
                    let skin_anim = anim_dir.join(format!("{}.bin", skin));
                    if skin_anim.exists() {
                        tracing::debug!("Found animation BIN for {}: {}", skin, skin_anim.display());
                        return Some(skin_anim);
                    }
                }

                let skin0_anim = anim_dir.join("skin0.bin");
                if skin0_anim.exists() {
                    tracing::debug!("Found animation BIN (skin0): {}", skin0_anim.display());
                    return Some(skin0_anim);
                }
            }
            // Stop at the Flint project boundary — never scan above it.
            if crate::mesh::texture::is_flint_project_root(dir) {
                break;
            }
            current = dir.parent();
        }
    }

    let mut current = skn_path.parent();
    while let Some(dir) = current {
        let data_path = dir.join("data");
        if data_path.exists() {
            if let Ok(entries) = std::fs::read_dir(data_path.join("characters")) {
                for entry in entries.flatten() {
                    let anim_path = entry.path().join("animations").join("skin0.bin");
                    if anim_path.exists() {
                        tracing::debug!("Found animation BIN via data search: {}", anim_path.display());
                        return Some(anim_path);
                    }
                }
            }
        }
        if crate::mesh::texture::is_flint_project_root(dir) {
            break;
        }
        current = dir.parent();
    }

    tracing::debug!("Animation BIN not found");
    None
}

pub fn extract_animation_list(bin_path: &Path) -> anyhow::Result<AnimationList> {
    let data = fs::read(bin_path)?;
    let tree = ltk_bridge::read_bin(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse animation BIN: {}", e))?;

    let mut clips = Vec::new();

    for entry in &tree.entries {
        for value in entry.fields.values() {
            extract_animation_paths_from_value(value, &mut clips);
        }
    }

    // Attach per-clip submesh-visibility events, keyed by clip name (the `.anm` stem).
    let mut events = crate::mesh::submesh_visibility::parse_clip_visibility_events(&tree);
    for clip in &mut clips {
        if let Some(ev) = events.remove(&clip.name) {
            clip.events = ev;
        }
    }

    Ok(AnimationList {
        clips,
        initial_hide: Vec::new(),
        initial_shadow_hide: Vec::new(),
    })
}

fn extract_animation_paths_from_value(value: &BinValue, clips: &mut Vec<AnimationClipInfo>) {
    match value {
        BinValue::String(s) => {
            if s.to_lowercase().ends_with(".anm") {
                let name = Path::new(s)
                    .file_stem()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Unknown".to_string());

                clips.push(AnimationClipInfo {
                    name,
                    track_name: None,
                    animation_path: s.clone(),
                    events: Vec::new(),
                });
            }
        }

        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for val in fields.values() {
                extract_animation_paths_from_value(val, clips);
            }
        }

        BinValue::List { items, .. } => {
            for item in items {
                extract_animation_paths_from_value(item, clips);
            }
        }

        BinValue::Option { value: Some(inner), .. } => {
            extract_animation_paths_from_value(inner, clips);
        }

        BinValue::Map { entries, .. } => {
            for (key, val) in entries {
                extract_animation_paths_from_value(key, clips);
                extract_animation_paths_from_value(val, clips);
            }
        }

        _ => {}
    }
}

pub fn resolve_animation_path(base_dir: &Path, anim_path: &str) -> Option<PathBuf> {
    tracing::debug!("Resolving animation path: {} from base {}", anim_path, base_dir.display());

    let normalized_path = anim_path
        .replace("ASSETS/", "assets/")
        .replace("ASSETS\\", "assets/")
        .replace('\\', "/");

    let mut current = Some(base_dir);
    while let Some(dir) = current {
        let assets_path = dir.join("assets");
        if assets_path.exists() {
            let candidate = dir.join(&normalized_path);
            tracing::debug!("Checking candidate path: {}", candidate.display());
            if candidate.exists() {
                tracing::debug!("Found animation at: {}", candidate.display());
                return Some(candidate);
            }

            let without_prefix = normalized_path.strip_prefix("assets/").unwrap_or(&normalized_path);
            let candidate2 = assets_path.join(without_prefix);
            tracing::debug!("Checking alternate path: {}", candidate2.display());
            if candidate2.exists() {
                tracing::debug!("Found animation at: {}", candidate2.display());
                return Some(candidate2);
            }
        }

        if let Some(name) = dir.file_name() {
            let name_str = name.to_string_lossy().to_lowercase();
            if name_str.contains(".wad") || name_str.contains("wad.client") {
                let candidate = dir.join(&normalized_path);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }

        current = dir.parent();
    }

    let full_path = PathBuf::from(anim_path);
    if full_path.exists() {
        return Some(full_path);
    }
    
    tracing::debug!("Animation file not found: {}", anim_path);
    None
}

/// Pull the `simpleSkin` asset path out of a skin BIN's ritobin text, if present.
pub fn extract_simple_skin_from_text(content: &str) -> Option<String> {
    let re = regex::Regex::new(r#"(?i)simpleSkin:\s*string\s*=\s*"([^"]+)""#).ok()?;
    re.captures(content)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .filter(|s| !s.is_empty())
}

/// Given a standalone `.anm` path, find the skin BIN that references it, read its
/// `simpleSkin`, and resolve that to a `.skn` file on disk.
pub fn resolve_skn_for_anm(anm_path: &Path) -> anyhow::Result<PathBuf> {
    // 1. Locate the skin BIN near the ANM. `find_animation_bin` walks the same
    //    directory structure; the skin BIN is found first via find_skin_bin.
    let bin_path = crate::mesh::texture::find_skin_bin(anm_path)
        .or_else(|| find_animation_bin(anm_path))
        .ok_or_else(|| anyhow::anyhow!("No skin BIN found near {}", anm_path.display()))?;

    // 2. Parse the BIN to a tree, render ritobin text, and pull simpleSkin.
    //    `ltk_bridge::read_bin` -> `Bin`; `converter::bin_to_text(&Bin)` -> text.
    let data = fs::read(&bin_path)
        .map_err(|e| anyhow::anyhow!("Failed to read BIN {}: {}", bin_path.display(), e))?;
    let tree = ltk_bridge::read_bin(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse BIN: {}", e))?;
    let text = crate::bin::converter::bin_to_text(&tree)
        .map_err(|e| anyhow::anyhow!("Failed to convert BIN to text: {}", e))?;
    let simple_skin = extract_simple_skin_from_text(&text)
        .ok_or_else(|| anyhow::anyhow!("BIN {} has no simpleSkin field", bin_path.display()))?;

    // 3. Resolve the asset path to a real .skn on disk (generic asset resolver).
    let base_dir = anm_path.parent().unwrap_or_else(|| Path::new("."));
    resolve_animation_path(base_dir, &simple_skin)
        .filter(|p| p.exists())
        .ok_or_else(|| anyhow::anyhow!("Could not resolve simpleSkin '{}' to a file on disk", simple_skin))
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

pub fn bake_animation_file<P: AsRef<Path>>(path: P) -> anyhow::Result<BakedAnimation> {
    let data = fs::read(path.as_ref())?;

    let animation = Animation::from_bytes(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse ANM file: {:?}", e))?;

    let fps = animation.fps;

    let frame_count = animation
        .tracks
        .iter()
        .map(|t| t.frames.len())
        .max()
        .unwrap_or(0)
        .max(1);

    let frame_duration = if fps > 0.0 { 1.0 / fps } else { 0.0333 };
    let duration = (frame_count.saturating_sub(1)) as f32 * frame_duration;

    let tracks = animation
        .tracks
        .iter()
        .map(|track| {
            let frames = track
                .frames
                .iter()
                .map(|frame| {
                    /* X-mirror to match skl.rs joint transforms (translation [-x,y,z],
                       rotation [x,-y,-z,w]); skeleton bind pose is in mirrored space. */
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
    use super::*;

    #[test]
    fn test_find_animation_bin() {
    }

    #[test]
    fn reads_simple_skin_from_bin_text() {
        let text = r#"
        skinMeshProperties: embed = SkinMeshDataProperties {
            simpleSkin: string = "ASSETS/Characters/Test/Skins/Skin0/Test.skn"
            texture: string = "ASSETS/Characters/Test/Skins/Skin0/Test.tex"
        }
        "#;
        assert_eq!(
            extract_simple_skin_from_text(text).as_deref(),
            Some("ASSETS/Characters/Test/Skins/Skin0/Test.skn"),
        );
    }

    #[test]
    fn missing_simple_skin_returns_none() {
        let text = r#"skinMeshProperties: embed = SkinMeshDataProperties { }"#;
        assert!(extract_simple_skin_from_text(text).is_none());
    }
}

