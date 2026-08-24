//! Locating the BIN that describes a mesh, plus the shapes its textures come back in.
//!
//! The texture mapping itself is read off the parsed tree in [`crate::mesh::materials`].
//! This module used to carry a second implementation of it over printed ritobin text —
//! that is gone, along with the thirteen patterns it scanned with.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
pub struct MaterialProperties {
    pub texture_path: String,

    /// UV scale (tiling) - [scaleU, scaleV]. From paramValue "UVScaleAndOffset" vec4[0,1].
    pub uv_scale: Option<[f32; 2]>,

    /// UV offset (shift) - [offsetU, offsetV]. From paramValue "UVScaleAndOffset" vec4[2,3].
    pub uv_offset: Option<[f32; 2]>,

    /// Flipbook texture atlas size - [columns, rows]. From paramValue "FlipbookSize" vec4[0,1].
    pub flipbook_size: Option<[u32; 2]>,

    /// From paramValue "FrameIndex" vec4[0].
    pub flipbook_frame: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct TextureMapping {
    pub default_texture: Option<String>,

    /// Key = submesh/material name.
    pub material_properties: HashMap<String, MaterialProperties>,

    pub static_materials: Vec<String>,
}

/// True when `dir` is a Flint project root (holds one of the project marker
/// files). Directory walks that look for a `data/` tree MUST stop here —
/// anything above the project (AppData, the user's home, drive root) can
/// contain an unrelated `data\` folder that hijacks root resolution. That
/// breakage is machine-dependent: the same project works on one PC and shows
/// magenta/no-texture meshes on another.
pub fn is_flint_project_root(dir: &Path) -> bool {
    dir.join("mod.config.json").exists()
        || dir.join("flint.json").exists()
        || dir.join("project.json").exists()
}

/// Walks up from the mesh path to find a directory containing `data/`, then
/// searches `data/characters/{champion}/skins/`.
pub fn find_skin_bin(skn_path: &Path) -> Option<PathBuf> {
    tracing::debug!("Looking for skin BIN relative to: {}", skn_path.display());

    let champion_name = extract_champion_name(skn_path);
    let skin_folder = extract_skin_folder_from_path(skn_path);

    tracing::debug!("Extracted: champion={:?}, skin_folder={:?}", champion_name, skin_folder);

    let champion_name = champion_name?;

    if let Some(root) = find_project_root_from_path(skn_path) {
        tracing::debug!("Project root: {}", root.display());

        let skins_dir = root
            .join("data")
            .join("characters")
            .join(&champion_name)
            .join("skins");

        if let Some(found) = search_skins_dir(&skins_dir, skin_folder.as_deref()) {
            return Some(found);
        }
        tracing::warn!(
            "skin BIN lookup miss: champion='{}' skin_folder={:?} root='{}' skins_dir exists={} — trying content search",
            champion_name, skin_folder, root.display(), skins_dir.is_dir()
        );

        /* Ported mods often live under a CUSTOM character folder (e.g.
           `data/characters/missfortune_skin69/...`) that doesn't match the
           champion derived from the WAD name, so the derived skins dir misses.
           Fall back to a content search: the skin BIN always embeds the mesh
           path (`simpleSkin`), so find the BIN that mentions the mesh filename. */
        if let Some(found) = find_bin_referencing_mesh(&root.join("data"), skn_path) {
            tracing::debug!("Found skin BIN via content search: {}", found.display());
            return Some(found);
        }
    }

    tracing::warn!("skin BIN not found for: {}", skn_path.display());
    None
}

/// Scan `.bin` files under `data_dir` for one whose raw bytes contain the mesh
/// filename (BIN strings are plain UTF-8, so no parse is needed). Prefers
/// concat BINs, then BINs under a `skins/` folder, then any match.
fn find_bin_referencing_mesh(data_dir: &Path, mesh_path: &Path) -> Option<PathBuf> {
    const MAX_FILES: usize = 512;
    const MAX_BIN_SIZE: u64 = 64 * 1024 * 1024;

    let needle = mesh_path.file_name()?.to_string_lossy().to_lowercase();
    let needle = needle.as_bytes();
    if needle.is_empty() {
        return None;
    }

    let mut stack = vec![data_dir.to_path_buf()];
    let mut scanned = 0usize;
    let mut fallback: Option<PathBuf> = None;

    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("bin")) != Some(true) {
                continue;
            }
            if scanned >= MAX_FILES {
                return fallback;
            }
            scanned += 1;
            if entry.metadata().map(|m| m.len() > MAX_BIN_SIZE).unwrap_or(true) {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else { continue };
            if !contains_ignore_ascii_case(&bytes, needle) {
                continue;
            }

            let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            if name.contains("concat") {
                return Some(path);
            }
            let in_skins = |p: &Path| p.parent()
                .map(|d| d.to_string_lossy().to_lowercase().replace('\\', "/").contains("/skins"))
                .unwrap_or(false);
            let take = match &fallback {
                None => true,
                // Upgrade a non-skins fallback to a skins-folder match.
                Some(existing) => in_skins(&path) && !in_skins(existing),
            };
            if take {
                fallback = Some(path);
            }
        }
    }

    fallback
}

/// Case-insensitive (ASCII) byte-substring search.
fn contains_ignore_ascii_case(haystack: &[u8], needle_lower: &[u8]) -> bool {
    if needle_lower.is_empty() || haystack.len() < needle_lower.len() {
        return false;
    }
    let first = needle_lower[0];
    haystack.windows(needle_lower.len()).any(|w| {
        w[0].to_ascii_lowercase() == first && w.eq_ignore_ascii_case(needle_lower)
    })
}

fn extract_champion_name(path: &Path) -> Option<String> {
    let path_str = path.to_string_lossy().to_lowercase();
    let components: Vec<&str> = path_str.split(&['/', '\\'][..]).collect();

    for (i, part) in components.iter().enumerate() {
        if *part == "characters" && i + 1 < components.len() {
            return Some(components[i + 1].to_string());
        }
    }

    for part in &components {
        if let Some(name) = part.strip_suffix(".wad.client")
            .or_else(|| part.strip_suffix(".wad"))
        {
            if !name.is_empty() {
                tracing::debug!("Extracted champion from WAD folder: {}", name);
                return Some(name.to_string());
            }
        }
    }

    for (i, part) in components.iter().enumerate() {
        if (*part == "base" || *part == "skins") && i > 0 {
            let potential = components[i - 1];
            if !potential.is_empty()
                && potential != "assets"
                && potential != "data"
                && !potential.contains("wad")
            {
                return Some(potential.to_string());
            }
        }
    }

    if let Some(file_name) = path.file_stem() {
        let name = file_name.to_string_lossy().to_lowercase();
        if !name.starts_with("skin") && name != "base" && !name.is_empty() && !name.contains('.') {
            tracing::debug!("Using filename as champion name: {}", name);
            return Some(name);
        }
    }

    None
}

/// Maps a `base` folder to `skin0`.
fn extract_skin_folder_from_path(path: &Path) -> Option<String> {
    let path_str = path.to_string_lossy().to_lowercase();
    let components: Vec<&str> = path_str.split(&['/', '\\'][..]).collect();

    for (i, part) in components.iter().enumerate() {
        if *part == "skins" && i + 1 < components.len() {
            let next = components[i + 1];
            if next.starts_with("skin") {
                return Some(next.to_string());
            } else if next == "base" {
                return Some("skin0".to_string());
            }
        }
    }

    for part in components.iter().rev() {
        if part.starts_with("skin") && part.len() > 4 && part[4..].chars().all(|c| c.is_ascii_digit()) {
            return Some(part.to_string());
        }
    }

    None
}

/// Walks up until a directory with a `data/` subdirectory is found, skipping
/// `.wad.client` / `.wad` folders (extracted WAD content, not the project root).
/// The walk NEVER goes above the Flint project root (see
/// [`is_flint_project_root`]) — a stray `data\` dir in AppData / the user's
/// home would otherwise win over the correct WAD-folder fallback.
fn find_project_root_from_path(file_path: &Path) -> Option<PathBuf> {
    let mut current = file_path.parent()?;
    let mut best: Option<PathBuf> = None;

    for _ in 0..15 {
        let data_dir = current.join("data");
        if data_dir.exists() && data_dir.is_dir() {
            let dir_name = current.file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            if dir_name.ends_with(".wad.client") || dir_name.ends_with(".wad") {
                tracing::debug!("Skipping WAD folder as project root: {}", current.display());
                if best.is_none() {
                    best = Some(current.to_path_buf());
                }
            } else {
                tracing::debug!("Found project root (has data/): {}", current.display());
                return Some(current.to_path_buf());
            }
        }
        if is_flint_project_root(current) {
            break;
        }
        current = match current.parent() {
            Some(p) => p,
            None => break,
        };
    }

    if let Some(ref fallback) = best {
        tracing::debug!("Using WAD folder as fallback project root: {}", fallback.display());
    }
    best
}

fn search_skins_dir(skins_dir: &Path, skin_folder: Option<&str>) -> Option<PathBuf> {
    if !skins_dir.exists() {
        return None;
    }

    // *Concat.bin (pre-merged) takes priority.
    if let Ok(entries) = std::fs::read_dir(skins_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.contains("concat") && name.ends_with(".bin") {
                tracing::debug!("Found concat BIN: {}", entry.path().display());
                return Some(entry.path());
            }
        }
    }

    if let Some(skin) = skin_folder {
        let nested = skins_dir.join(skin).join(format!("{}.bin", skin));
        if nested.exists() {
            tracing::debug!("Found nested skin BIN: {}", nested.display());
            return Some(nested);
        }
        let flat = skins_dir.join(format!("{}.bin", skin));
        if flat.exists() {
            tracing::debug!("Found flat skin BIN: {}", flat.display());
            return Some(flat);
        }
    }

    let skin0 = skins_dir.join("skin0.bin");
    if skin0.exists() {
        tracing::debug!("Found fallback skin0.bin");
        return Some(skin0);
    }

    if let Ok(entries) = std::fs::read_dir(skins_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("bin") {
                tracing::debug!("Found fallback BIN: {}", path.display());
                return Some(path);
            }
        }
    }

    None
}

/// True if the path has a `/skin{digit}/` component and is not in a shared folder.
///
/// Scanned rather than matched: it runs once per sampler per material, and the pattern
/// form allocated a lowercased copy of the path just to look for `/skin<digits>/` in it.
pub(crate) fn is_project_specific_texture(path: &str) -> bool {
    let bytes = path.as_bytes();
    let in_skin_folder = bytes.windows(5).enumerate().any(|(i, w)| {
        if !w.eq_ignore_ascii_case(b"/skin") {
            return false;
        }
        let start = i + 5;
        let end = start + bytes[start..].iter().take_while(|b| b.is_ascii_digit()).count();
        end > start && bytes.get(end) == Some(&b'/')
    });

    in_skin_folder && !contains_ignore_ascii_case(bytes, b"/shared/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stray_data_dir_above_project_does_not_hijack_root() {
        // Reproduces the machine-dependent "skin BIN not found" (works on one
        // PC, magenta textures on another): an unrelated `data/` dir ABOVE the
        // project (AppData, user home, ...) used to win over the WAD folder.
        let tmp = std::env::temp_dir().join(format!("flint_texture_hijack_{}", std::process::id()));
        // The hijacker: <tmp>/data (sibling of projects/, like %APPDATA%/Flint/data).
        std::fs::create_dir_all(tmp.join("data")).unwrap();

        let proj = tmp.join("projects/uwu");
        let wad = proj.join("content/base/missfortune.wad.client");
        let skins = wad.join("data/characters/missfortune/skins");
        std::fs::create_dir_all(&skins).unwrap();
        std::fs::write(proj.join("mod.config.json"), b"{}").unwrap();
        let bin_path = skins.join("skin69.bin");
        std::fs::write(&bin_path, b"PROP...").unwrap();

        let mesh_dir = wad.join("assets/guisai/uwu");
        std::fs::create_dir_all(&mesh_dir).unwrap();
        let mesh = mesh_dir.join("missfortune_skin69.skins_missfortune_skin69.skn");
        std::fs::write(&mesh, b"skn").unwrap();

        let found = find_skin_bin(&mesh);
        assert_eq!(found, Some(bin_path));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn content_search_finds_bin_under_custom_character_folder() {
        let tmp = std::env::temp_dir().join(format!("flint_texture_test_{}", std::process::id()));
        let skins = tmp.join("data/characters/missfortune_skin69/skins");
        std::fs::create_dir_all(&skins).unwrap();

        // BIN mentioning the mesh filename (mixed case, as BIN strings often are).
        let bin_path = skins.join("root.bin");
        std::fs::write(&bin_path, b"PROP...ASSETS/GuiSai/uwu/MissFortune_Skin69.Skins_MissFortune_Skin69.skn...").unwrap();
        // Decoy BIN that doesn't reference the mesh.
        std::fs::write(tmp.join("data/characters/missfortune_skin69/other.bin"), b"PROP...nothing...").unwrap();

        let mesh = tmp.join("assets/guisai/uwu/missfortune_skin69.skins_missfortune_skin69.skn");
        let found = find_bin_referencing_mesh(&tmp.join("data"), &mesh);
        assert_eq!(found, Some(bin_path));

        std::fs::remove_dir_all(&tmp).ok();
    }
}
