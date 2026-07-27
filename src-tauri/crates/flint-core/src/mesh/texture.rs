//! Texture resolution from BIN files: parses skin0.bin to extract texture
//! mappings for SKN materials.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use regex::Regex;

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

/// Parse Ritobin text to extract texture mappings: skinMeshProperties (default
/// texture), materialOverride blocks, and StaticMaterialDef blocks.
///
/// A material linked by hash resolves against a StaticMaterialDef emitted by
/// name via the FNV1a-32 bridge. `0xd1f16cee` below is the FNV1a-32 of the
/// lowercased def path:
///
/// ```
/// let ritobin = r#"
/// skinMeshProperties: embed = SkinMeshDataProperties {
///     materialOverride: list[embed] = {
///         SkinMeshDataProperties_MaterialOverride {
///             material: link = 0xd1f16cee
///             submesh: string = "Body"
///         }
///     }
/// }
/// "Characters/Aatrox/Skins/Skin0/Materials/Body" = StaticMaterialDef {
///     samplerValues: list2[embed] = {
///         StaticMaterialShaderSamplerDef {
///             textureName: string = "Diffuse_Texture"
///             texturePath: string = "ASSETS/Characters/Aatrox/Skins/Skin0/Body.tex"
///         }
///     }
/// }
/// "#;
/// let m = flint_core::mesh::texture::extract_texture_mapping_from_text(ritobin).unwrap();
/// assert_eq!(
///     m.material_properties.get("Body").map(|p| p.texture_path.as_str()),
///     Some("ASSETS/Characters/Aatrox/Skins/Skin0/Body.tex"),
/// );
/// ```
#[allow(clippy::regex_creation_in_loops)]
pub fn extract_texture_mapping_from_text(content: &str) -> anyhow::Result<TextureMapping> {
    let mut mapping = TextureMapping::default();

    let skin_mesh_header_regex = Regex::new(r"skinMeshProperties:\s*embed\s*=\s*(?:SkinMeshDataProperties\s*)?").unwrap();

    if let Some(header_match) = skin_mesh_header_regex.find(content) {
        if let Some(properties_block) = extract_braced_block(content, header_match.end() - 1) {
            tracing::debug!("Found skinMeshProperties block ({} chars)", properties_block.len());

            // Core props = everything before materialOverride, to avoid matching inside the list.
            let core_props = if let Some(idx) = properties_block.find("materialOverride:") {
                &properties_block[..idx]
            } else {
                &properties_block
            };

            let texture_regex = Regex::new(r#"texture:\s*string\s*=\s*"([^"]+)""#).unwrap();
            if let Some(tex_captures) = texture_regex.captures(core_props) {
                let tex_path = tex_captures.get(1).unwrap().as_str().to_string();
                if !tex_path.is_empty() {
                    tracing::debug!("Default texture: {}", tex_path);
                    mapping.default_texture = Some(tex_path);
                }
            } else {
                let mat_link_regex = Regex::new(r#"(?i)material:\s*link\s*=\s*"([^"]+)""#).unwrap();
                if let Some(mat_captures) = mat_link_regex.captures(core_props) {
                    let mat_path = mat_captures.get(1).unwrap().as_str().to_string();
                    tracing::debug!("Found global material link: {}", mat_path);
                    if let Some(props) = resolve_material_texture(content, &mat_path) {
                        tracing::debug!("Resolved global material to: {}", props.texture_path);
                        mapping.default_texture = Some(props.texture_path);
                    }
                } else {
                    let mat_hash_regex = Regex::new(r#"(?i)material:\s*link\s*=\s*(0x[0-9a-fA-F]+)"#).unwrap();
                    if let Some(hash_match) = mat_hash_regex.captures(core_props) {
                        let mat_hash = hash_match.get(1).unwrap().as_str();
                        tracing::debug!("Found global material hash: {}", mat_hash);
                        if let Some(props) = resolve_material_texture_by_hash(content, mat_hash) {
                            tracing::debug!("Resolved global material hash to: {}", props.texture_path);
                            mapping.default_texture = Some(props.texture_path);
                        }
                    }
                }
            }
            
            let override_header_regex = Regex::new(r"materialOverride:\s*list\[embed\]\s*=\s*").unwrap();

            if let Some(override_match) = override_header_regex.find(&properties_block) {
                if let Some(list_content) = extract_braced_block(&properties_block, override_match.end() - 1) {
                    tracing::debug!("Found materialOverride list ({} chars)", list_content.len());

                    let parts: Vec<&str> = list_content.split("SkinMeshDataProperties_MaterialOverride").collect();

                    for (idx, part) in parts.iter().enumerate() {
                        let submesh_regex = Regex::new(r#"(?i)submesh:\s*string\s*=\s*"([^"]+)""#).unwrap();
                        if let Some(sub_captures) = submesh_regex.captures(part) {
                            let submesh_name = sub_captures.get(1).unwrap().as_str().to_string();
                            tracing::debug!("Found materialOverride[{}]: submesh='{}'", idx, submesh_name);

                            let tex_regex = Regex::new(r#"texture:\s*string\s*=\s*"([^"]+)""#).unwrap();
                            if let Some(tex_match) = tex_regex.captures(part) {
                                let tex_path = tex_match.get(1).unwrap().as_str().to_string();
                                tracing::debug!("  -> Direct texture: {}", tex_path);
                                let props = MaterialProperties {
                                    texture_path: tex_path,
                                    ..Default::default()
                                };
                                mapping.material_properties.insert(submesh_name.clone(), props);
                                continue;
                            }

                            let mat_link_regex = Regex::new(r#"(?i)material:\s*link\s*=\s*"([^"]+)""#).unwrap();
                            if let Some(mat_match) = mat_link_regex.captures(part) {
                                let mat_path = mat_match.get(1).unwrap().as_str().to_string();
                                tracing::debug!("  -> Material link (string): {}", mat_path);

                                if let Some(props) = resolve_material_texture(content, &mat_path) {
                                    tracing::debug!("  -> RESOLVED to: {}", props.texture_path);
                                    mapping.material_properties.insert(submesh_name.clone(), props);
                                } else {
                                    tracing::warn!("  -> FAILED to resolve material link!");
                                    mapping.static_materials.push(format!("Link: {} -> {}", submesh_name, mat_path));
                                }
                                continue;
                            }

                            let mat_hash_regex = Regex::new(r#"(?i)material:\s*link\s*=\s*(0x[0-9a-fA-F]+)"#).unwrap();
                            if let Some(hash_match) = mat_hash_regex.captures(part) {
                                let mat_hash = hash_match.get(1).unwrap().as_str();
                                tracing::debug!("  -> Material link (hash): {}", mat_hash);

                                if let Some(props) = resolve_material_texture_by_hash(content, mat_hash) {
                                    tracing::debug!("  -> RESOLVED to: {}", props.texture_path);
                                    mapping.material_properties.insert(submesh_name.clone(), props);
                                } else {
                                    tracing::warn!("  -> FAILED to resolve material hash!");
                                    mapping.static_materials.push(format!("Hash: {} -> {}", submesh_name, mat_hash));
                                }
                                continue;
                            }
                            
                            tracing::warn!("  -> No texture or material link found for submesh");
                        }
                    }
                }
            }
        }
    }
    
    tracing::debug!("Final material_properties count: {}", mapping.material_properties.len());
    Ok(mapping)
}

pub fn lookup_material_texture_by_name(ritobin_content: &str, material_name: &str) -> Option<MaterialProperties> {
    tracing::debug!("🔎 Looking up StaticMaterialDef for material: '{}'", material_name);

    if ritobin_content.contains(material_name) {
        tracing::debug!("  ✓ Material name '{}' found in content", material_name);
    } else {
        tracing::debug!("  ✗ Material name '{}' NOT FOUND in content at all!", material_name);
        return None;
    }

    let extract_props = |block: &str| -> Option<MaterialProperties> {
        if let Some(texture_path) = extract_diffuse_texture_from_block(block) {
            let (uv_scale, uv_offset, flipbook_size, flipbook_frame) = extract_param_values(block);
            Some(MaterialProperties {
                texture_path,
                uv_scale,
                uv_offset,
                flipbook_size,
                flipbook_frame,
            })
        } else {
            tracing::warn!("  ✗ Could not extract texture from block");
            None
        }
    };

    let exact_pattern = format!(r#""{}"\s*=\s*StaticMaterialDef\s*"#, regex::escape(material_name));
    tracing::debug!("  Strategy 1: Trying exact match pattern");
    if let Ok(regex) = Regex::new(&exact_pattern) {
        if let Some(mat) = regex.find(ritobin_content) {
            tracing::debug!("  ✓ Found exact StaticMaterialDef match at position {}", mat.start());
            if let Some(block) = extract_braced_block(ritobin_content, mat.end() - 1) {
                tracing::debug!("  ✓ Extracted block ({} chars)", block.len());
                if let Some(props) = extract_props(&block) {
                    tracing::debug!("  ✅ SUCCESS: Resolved '{}' to texture: {}", material_name, props.texture_path);
                    return Some(props);
                }
            }
        } else {
            tracing::debug!("  ✗ Strategy 1 failed - no exact match");
        }
    }

    tracing::debug!("  Strategy 2: Trying path-ending match");
    let ends_with_pattern = format!(r#""[^"]*/{}"[^=]*=\s*StaticMaterialDef\s*"#, regex::escape(material_name));
    if let Ok(regex) = Regex::new(&ends_with_pattern) {
        if let Some(mat) = regex.find(ritobin_content) {
            tracing::debug!("  ✓ Found path-ending StaticMaterialDef match at position {}", mat.start());
            if let Some(block) = extract_braced_block(ritobin_content, mat.end() - 1) {
                tracing::debug!("  ✓ Extracted block ({} chars)", block.len());
                if let Some(props) = extract_props(&block) {
                    tracing::debug!("  ✅ SUCCESS: Resolved '{}' to texture: {}", material_name, props.texture_path);
                    return Some(props);
                }
            }
        } else {
            tracing::debug!("  ✗ Strategy 2 failed - no path-ending match");
        }
    }

    tracing::debug!("  Strategy 3: Trying partial match");
    let contains_pattern = format!(r#""[^"]*{}[^"]*"\s*=\s*StaticMaterialDef\s*"#, regex::escape(material_name));
    if let Ok(regex) = Regex::new(&contains_pattern) {
        if let Some(mat) = regex.find(ritobin_content) {
            tracing::debug!("  ✓ Found partial StaticMaterialDef match at position {}", mat.start());
            if let Some(block) = extract_braced_block(ritobin_content, mat.end() - 1) {
                tracing::debug!("  ✓ Extracted block ({} chars)", block.len());
                if let Some(props) = extract_props(&block) {
                    tracing::debug!("  ✅ SUCCESS: Resolved '{}' to texture: {}", material_name, props.texture_path);
                    return Some(props);
                }
            }
        } else {
            tracing::debug!("  ✗ Strategy 3 failed - no partial match");
        }
    }

    tracing::debug!("  Strategy 4: Trying case-insensitive match");
    let lower_name = material_name.to_lowercase();
    let case_insensitive_pattern = format!(r#"(?i)"[^"]*{}[^"]*"\s*=\s*StaticMaterialDef\s*"#, regex::escape(&lower_name));
    if let Ok(regex) = Regex::new(&case_insensitive_pattern) {
        if let Some(mat) = regex.find(ritobin_content) {
            tracing::debug!("  ✓ Found case-insensitive StaticMaterialDef match at position {}", mat.start());
            if let Some(block) = extract_braced_block(ritobin_content, mat.end() - 1) {
                tracing::debug!("  ✓ Extracted block ({} chars)", block.len());
                if let Some(props) = extract_props(&block) {
                    tracing::debug!("  ✅ SUCCESS: Resolved '{}' to texture: {}", material_name, props.texture_path);
                    return Some(props);
                }
            }
        } else {
            tracing::debug!("  ✗ Strategy 4 failed - no case-insensitive match");
        }
    }

    tracing::debug!("  ❌ FAILED: No StaticMaterialDef found for material '{}' using any strategy", material_name);
    None
}

/// Parses UVScaleAndOffset (scaleU, scaleV, offsetU, offsetV), FlipbookSize
/// (cols, rows), and FrameIndex (index) from a StaticMaterialDef's paramValues.
#[allow(clippy::type_complexity, clippy::regex_creation_in_loops)]
fn extract_param_values(material_block: &str) -> (Option<[f32; 2]>, Option<[f32; 2]>, Option<[u32; 2]>, Option<f32>) {
    let mut uv_scale: Option<[f32; 2]> = None;
    let mut uv_offset: Option<[f32; 2]> = None;
    let mut flipbook_size: Option<[u32; 2]> = None;
    let mut flipbook_frame: Option<f32> = None;

    let param_regex = match Regex::new(r"(?i)paramValues:\s*list2?\[embed\]\s*=\s*") {
        Ok(r) => r,
        Err(_) => return (None, None, None, None),
    };

    let param_match = match param_regex.find(material_block) {
        Some(m) => m,
        None => return (None, None, None, None),
    };

    if let Some(param_block) = extract_braced_block(material_block, param_match.end() - 1) {
        let params: Vec<&str> = param_block.split("StaticMaterialShaderParamDef").collect();

        for param in params {
            let name_regex = match Regex::new(r#"name:\s*string\s*=\s*"([^"]+)""#) {
                Ok(r) => r,
                Err(_) => continue,
            };

            if let Some(name_match) = name_regex.captures(param) {
                let param_name = match name_match.get(1) {
                    Some(m) => m.as_str(),
                    None => continue,
                };

                let value_regex = match Regex::new(r"value:\s*vec4\s*=\s*\{\s*([^}]+)\s*\}") {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                
                if let Some(value_match) = value_regex.captures(param) {
                    let values_str = match value_match.get(1) {
                        Some(m) => m.as_str(),
                        None => continue,
                    };
                    
                    let values: Vec<f32> = values_str
                        .split(',')
                        .filter_map(|s| s.trim().parse::<f32>().ok())
                        .collect();
                    
                    match param_name {
                        "UVScaleAndOffset" if values.len() >= 4 => {
                            uv_scale = Some([values[0], values[1]]);
                            uv_offset = Some([values[2], values[3]]);
                            tracing::debug!("Found UVScaleAndOffset: scale=[{}, {}], offset=[{}, {}]", 
                                values[0], values[1], values[2], values[3]);
                        }
                        "FlipbookSize" if values.len() >= 2 => {
                            flipbook_size = Some([values[0] as u32, values[1] as u32]);
                            tracing::debug!("Found FlipbookSize: [{}, {}]", values[0], values[1]);
                        }
                        "FrameIndex" if !values.is_empty() => {
                            flipbook_frame = Some(values[0]);
                            tracing::debug!("Found FrameIndex: {}", values[0]);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    
    (uv_scale, uv_offset, flipbook_size, flipbook_frame)
}

fn resolve_material_texture(content: &str, material_path: &str) -> Option<MaterialProperties> {
    tracing::debug!("🔍 Resolving material link: '{}'", material_path);

    let material_name_lower = material_path.to_lowercase();
    if content.to_lowercase().contains(&material_name_lower) {
        tracing::debug!("  ✓ Material name FOUND in content (case-insensitive)");
    } else {
        tracing::warn!("  ✗ Material name NOT FOUND anywhere in content");
        if let Some(last_part) = material_path.split('/').next_back() {
            if content.to_lowercase().contains(&last_part.to_lowercase()) {
                tracing::debug!("  ✓ Last part '{}' found in content", last_part);
            } else {
                tracing::warn!("  ✗ Even last part '{}' not found", last_part);
            }
        }
        return None;
    }

    let material_def_count = content.matches("StaticMaterialDef").count();
    tracing::debug!("  📊 Total StaticMaterialDef blocks in content: {}", material_def_count);

    let escaped_path = regex::escape(material_path);

    let patterns = [
        format!(r#""{}"\s*=\s*StaticMaterialDef"#, escaped_path),
        format!(r#"(?i)"{}"\s*=\s*StaticMaterialDef"#, escaped_path),
        format!(r#""[^"]*{}"\s*=\s*StaticMaterialDef"#, regex::escape(material_path.split('/').next_back().unwrap_or(material_path))),
    ];

    for (i, def_pattern) in patterns.iter().enumerate() {
        tracing::debug!("Trying pattern #{}: {}", i + 1, def_pattern);

        let def_regex = match Regex::new(def_pattern) {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("Invalid regex pattern: {}", e);
                continue;
            }
        };

        if let Some(def_match) = def_regex.find(content) {
            tracing::debug!("✓ Found StaticMaterialDef at position {} using pattern #{}", def_match.start(), i + 1);

            if let Some(block) = extract_braced_block(content, def_match.end() - 1) {
                tracing::debug!("Extracted block ({} chars)", block.len());

                if let Some(texture_path) = extract_diffuse_texture_from_block(&block) {
                    tracing::debug!("Found texture: {}", texture_path);

                    let (uv_scale, uv_offset, flipbook_size, flipbook_frame) = extract_param_values(&block);

                    let props = MaterialProperties {
                        texture_path,
                        uv_scale,
                        uv_offset,
                        flipbook_size,
                        flipbook_frame,
                    };

                    tracing::debug!("SUCCESS: '{}' resolved with transforms using pattern #{}", material_path, i + 1);
                    return Some(props);
                } else {
                    tracing::warn!("FAILED: Could not find diffuse texture in StaticMaterialDef block");
                    let preview: String = block.chars().take(500).collect();
                    tracing::debug!("Block preview: {}", preview);
                }
            } else {
                tracing::warn!("Failed to extract braced block after StaticMaterialDef header");
            }
        }
    }

    /* Fallback bridge: the definition may be emitted under a raw `0xHASH`
       header even though the link references it by string path. Hash the link
       path (FNV1a-32, lowercased) and retry against the hash-form header. */
    let target = fnv1a32_lower(material_path);
    if let Some(props) = resolve_material_texture_by_hash(content, &format!("0x{:08x}", target)) {
        tracing::debug!("Resolved material '{}' via hash-form bridge 0x{:08x}", material_path, target);
        return Some(props);
    }

    tracing::error!("FAILED ALL STRATEGIES for material: '{}'", material_path);
    None
}

fn resolve_material_texture_by_hash(content: &str, hash: &str) -> Option<MaterialProperties> {
    tracing::debug!("Resolving material link (hash): {}", hash);

    let pattern = format!(r"(?i){}\s*=\s*StaticMaterialDef\s*", regex::escape(hash));
    let regex = Regex::new(&pattern).ok()?;

    if let Some(mat) = regex.find(content) {
        tracing::debug!("Found StaticMaterialDef for hash {} at position {}", hash, mat.start());

        if let Some(block) = extract_braced_block(content, mat.end() - 1) {
            if let Some(props) = material_props_from_block(&block) {
                return Some(props);
            }
        }
    }

    /* Fallback bridge: the StaticMaterialDef may be emitted under its resolved
       path name (`"Characters/..." = StaticMaterialDef`) instead of the raw
       `0xHASH` header. BIN object-path keys are FNV1a-32 of the lowercased
       path, so bridge by hashing every named header and matching the link. */
    if let Some(target) = parse_hex_u32(hash) {
        if let Some(props) = resolve_material_by_name_hash(content, target) {
            tracing::debug!("Resolved material hash {} via named-def FNV1a bridge", hash);
            return Some(props);
        }
    }

    tracing::debug!("Failed to resolve material hash: {}", hash);
    None
}

fn parse_hex_u32(s: &str) -> Option<u32> {
    let trimmed = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    u32::from_str_radix(trimmed, 16).ok()
}

/// FNV1a-32 over the lowercased bytes of `s` — the hash League/ritobin use
/// for BIN object-path keys and object links.
fn fnv1a32_lower(s: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        let b = if b.is_ascii_uppercase() { b + 32 } else { b };
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Returns `None` if the block has no diffuse sampler.
fn material_props_from_block(block: &str) -> Option<MaterialProperties> {
    let texture_path = extract_diffuse_texture_from_block(block)?;
    let (uv_scale, uv_offset, flipbook_size, flipbook_frame) = extract_param_values(block);
    Some(MaterialProperties {
        texture_path,
        uv_scale,
        uv_offset,
        flipbook_size,
        flipbook_frame,
    })
}

/// Scan every `"name" = StaticMaterialDef` header and return the diffuse
/// `MaterialProperties` of the one whose lowercased name hashes (FNV1a-32)
/// to `target`. Bridges a hash-form material link to a name-form definition.
fn resolve_material_by_name_hash(content: &str, target: u32) -> Option<MaterialProperties> {
    let header_regex = Regex::new(r#""([^"]+)"\s*=\s*StaticMaterialDef\s*"#).ok()?;
    for cap in header_regex.captures_iter(content) {
        let name = cap.get(1)?.as_str();
        if fnv1a32_lower(name) != target {
            continue;
        }
        let m = cap.get(0)?;
        if let Some(block) = extract_braced_block(content, m.end().saturating_sub(1)) {
            if let Some(props) = material_props_from_block(&block) {
                return Some(props);
            }
        }
    }
    None
}

/// `start_after` should point to (or before) the opening `{`.
///
/// `pub(crate)` so `mesh::animation` can reuse it to isolate a single
/// `skinMeshProperties` embed (see `extract_skeleton_from_skin_mesh_properties`).
pub(crate) fn extract_braced_block(content: &str, start_after: usize) -> Option<String> {
    let bytes = content.as_bytes();
    let mut brace_count = 0;
    let mut block_start = None;

    for (i, &ch) in bytes[start_after..].iter().enumerate() {
        let actual_idx = start_after + i;
        if ch == b'{' {
            if block_start.is_none() {
                block_start = Some(actual_idx + 1);
            }
            brace_count += 1;
        } else if ch == b'}' {
            brace_count -= 1;
            if brace_count == 0 {
                if let Some(start) = block_start {
                    let block = content[start..actual_idx].to_string();
                    tracing::trace!("Extracted block ({} chars)", block.len());
                    return Some(block);
                }
            }
        }
    }
    
    tracing::warn!("Failed to find matching closing brace");
    None
}

/// True if the path has a `/skin{digit}/` component and is not in a shared folder.
fn is_project_specific_texture(path: &str) -> bool {
    let lower = path.to_lowercase();

    let skin_folder_regex = Regex::new(r"/skin\d+/").unwrap();
    if !skin_folder_regex.is_match(&lower) {
        return false;
    }

    if lower.contains("/shared/") {
        return false;
    }

    true
}

/// Looks for common diffuse texture names in samplerValues, with fallback to
/// the first sampler. Prefers project-specific (`/skin{digit}/`) paths.
#[allow(clippy::regex_creation_in_loops)]
fn extract_diffuse_texture_from_block(block: &str) -> Option<String> {
    tracing::debug!("  📝 Extracting diffuse texture from block ({} chars)", block.len());

    let sampler_regex = Regex::new(r"(?i)samplerValues:\s*list2?\[embed\]\s*=\s*").ok()?;
    let sampler_match = sampler_regex.find(block);

    if sampler_match.is_none() {
        tracing::debug!("  ✗ No samplerValues found in block");
        return None;
    }

    let sampler_match = sampler_match?;
    tracing::debug!("  ✓ Found samplerValues at position {}", sampler_match.start());

    if let Some(sampler_block) = extract_braced_block(block, sampler_match.end() - 1) {
        tracing::debug!("  ✓ Extracted samplerValues block ({} chars)", sampler_block.len());

        let samplers: Vec<&str> = sampler_block.split("StaticMaterialShaderSamplerDef").collect();
        tracing::debug!("  📊 Found {} StaticMaterialShaderSamplerDef blocks", samplers.len().saturating_sub(1));

        // Priority 1: Main_Texture with project-specific path.
        tracing::debug!("  🔍 Priority 1: Looking for Main_Texture with project-specific path");
        for (i, sampler) in samplers.iter().enumerate() {
            if i == 0 { continue; }

            let lower_sampler = sampler.to_lowercase();
            if lower_sampler.contains("texturename") && lower_sampler.contains("main_texture") {
                tracing::debug!("  ✓ Found Main_Texture sampler #{}", i);

                let path_regex = Regex::new(r#"texturePath:\s*string\s*=\s*"([^"]+)""#).ok()?;
                if let Some(path_match) = path_regex.captures(sampler) {
                    let texture_path = path_match.get(1).unwrap().as_str().to_string();

                    if is_project_specific_texture(&texture_path) {
                        tracing::debug!("  ✅ MAIN_TEXTURE (project-specific): {}", texture_path);
                        return Some(texture_path);
                    } else {
                        tracing::debug!("  ⏭️ Main_Texture is generic/shared: {}", texture_path);
                    }
                }
            }
        }

        // Priority 2: Diffuse_Texture with project-specific path.
        tracing::debug!("  🔍 Priority 2: Looking for Diffuse_Texture with project-specific path");
        for (i, sampler) in samplers.iter().enumerate() {
            if i == 0 { continue; }

            let lower_sampler = sampler.to_lowercase();
            if lower_sampler.contains("texturename") && lower_sampler.contains("diffuse") {
                tracing::debug!("  ✓ Found Diffuse_Texture sampler #{}", i);

                let path_regex = Regex::new(r#"texturePath:\s*string\s*=\s*"([^"]+)""#).ok()?;
                if let Some(path_match) = path_regex.captures(sampler) {
                    let texture_path = path_match.get(1).unwrap().as_str().to_string();

                    if is_project_specific_texture(&texture_path) {
                        tracing::debug!("  ✅ DIFFUSE_TEXTURE (project-specific): {}", texture_path);
                        return Some(texture_path);
                    } else {
                        tracing::debug!("  ⏭️ Diffuse_Texture is generic/shared: {}", texture_path);
                    }
                }
            }
        }

        // Priority 3: any texture with a project-specific path.
        tracing::debug!("  🔍 Priority 3: Looking for ANY texture with project-specific path");
        for (i, sampler) in samplers.iter().enumerate() {
            if i == 0 { continue; }

            let path_regex = Regex::new(r#"texturePath:\s*string\s*=\s*"([^"]+)""#).ok()?;
            if let Some(path_match) = path_regex.captures(sampler) {
                let texture_path = path_match.get(1).unwrap().as_str().to_string();
                let lower_path = texture_path.to_lowercase();

                if lower_path.contains("normal") || lower_path.contains("_nm") ||
                   lower_path.contains("mask") || lower_path.contains("noise") ||
                   lower_path.contains("ramp") || lower_path.contains("matcap") ||
                   lower_path.contains("outline") || lower_path.contains("fresnel") {
                    continue;
                }

                if is_project_specific_texture(&texture_path) {
                    tracing::debug!("  ✅ PROJECT TEXTURE #{}: {}", i, texture_path);
                    return Some(texture_path);
                }
            }
        }

        // Priority 4: Main_Texture even if generic.
        tracing::debug!("  🔍 Priority 4: Fallback to Main_Texture (even if generic)");
        for (i, sampler) in samplers.iter().enumerate() {
            if i == 0 { continue; }

            let lower_sampler = sampler.to_lowercase();
            if lower_sampler.contains("texturename") && lower_sampler.contains("main_texture") {
                let path_regex = Regex::new(r#"texturePath:\s*string\s*=\s*"([^"]+)""#).ok()?;
                if let Some(path_match) = path_regex.captures(sampler) {
                    let texture_path = path_match.get(1).unwrap().as_str().to_string();
                    tracing::debug!("  ⚠️ Using Main_Texture as fallback: {}", texture_path);
                    return Some(texture_path);
                }
            }
        }

        // Priority 5: Diffuse_Texture even if generic.
        tracing::debug!("  🔍 Priority 5: Fallback to Diffuse_Texture (even if generic)");
        for (i, sampler) in samplers.iter().enumerate() {
            if i == 0 { continue; }

            let lower_sampler = sampler.to_lowercase();
            if lower_sampler.contains("texturename") && lower_sampler.contains("diffuse") {
                let path_regex = Regex::new(r#"texturePath:\s*string\s*=\s*"([^"]+)""#).ok()?;
                if let Some(path_match) = path_regex.captures(sampler) {
                    let texture_path = path_match.get(1).unwrap().as_str().to_string();
                    tracing::debug!("  ⚠️ Using Diffuse_Texture as fallback: {}", texture_path);
                    return Some(texture_path);
                }
            }
        }

        // Priority 6: first valid texture.
        tracing::debug!("  🔍 Priority 6: Last resort - first valid texture");
        for (i, sampler) in samplers.iter().enumerate() {
            if i == 0 { continue; }

            let path_regex = Regex::new(r#"texturePath:\s*string\s*=\s*"([^"]+)""#).ok()?;
            if let Some(path_match) = path_regex.captures(sampler) {
                let texture_path = path_match.get(1).unwrap().as_str().to_string();
                let lower_path = texture_path.to_lowercase();

                if !lower_path.contains("normal") &&
                   !lower_path.contains("_nm") &&
                   !lower_path.contains("mask") &&
                   !lower_path.contains("noise") &&
                   !lower_path.contains("ramp") &&
                   !lower_path.contains("matcap") &&
                   !lower_path.contains("outline") &&
                   !lower_path.contains("fresnel") {
                    tracing::debug!("  ⚠️ Last resort fallback: {}", texture_path);
                    return Some(texture_path);
                }
            }
        }
    } else {
        tracing::debug!("  ✗ Failed to extract samplerValues block");
    }

    tracing::debug!("  ❌ No diffuse texture found in block");
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_texture_mapping_complex() {
        let ritobin_content = r#"
        skinMeshProperties: embed = SkinMeshDataProperties {
            skeleton: string = "ASSETS/Characters/Test/Skins/Skin0/Test.skl"
            simpleSkin: string = "ASSETS/Characters/Test/Skins/Skin0/Test.skn"
            texture: string = "ASSETS/Characters/Test/Skins/Skin0/Test_Base_TX_CM.tex"
            materialOverride: list[embed] = {
                SkinMeshDataProperties_MaterialOverride {
                    texture: string = "ASSETS/Characters/Test/Skins/Skin0/Direct_Override.tex"
                    submesh: string = "DirectMesh"
                }
                SkinMeshDataProperties_MaterialOverride {
                    material: link = "Characters/Test/Skins/Skin0/Materials/LinkedMat"
                    submesh: string = "LinkedMesh"
                }
            }
        }
        
        "Characters/Test/Skins/Skin0/Materials/LinkedMat" = StaticMaterialDef {
            name: string = "Characters/Test/Skins/Skin0/Materials/LinkedMat"
            samplerValues: list2[embed] = {
                StaticMaterialShaderSamplerDef {
                    textureName: string = "Diffuse_Color"
                    texturePath: string = "ASSETS/Characters/Test/Skins/Skin0/Resolved_Linked.tex"
                    addressU: u32 = 1
                    addressV: u32 = 1
                }
                StaticMaterialShaderSamplerDef {
                    textureName: string = "Normal_Map"
                    texturePath: string = "ASSETS/Characters/Test/Skins/Skin0/Resolved_Normal.tex"
                }
            }
        }
        "#;
        
        let mapping = extract_texture_mapping_from_text(ritobin_content).unwrap();

        assert_eq!(mapping.default_texture, Some("ASSETS/Characters/Test/Skins/Skin0/Test_Base_TX_CM.tex".to_string()));

        assert_eq!(mapping.material_properties.get("DirectMesh").map(|p| &p.texture_path), Some(&"ASSETS/Characters/Test/Skins/Skin0/Direct_Override.tex".to_string()));
        assert_eq!(mapping.material_properties.get("LinkedMesh").map(|p| &p.texture_path), Some(&"ASSETS/Characters/Test/Skins/Skin0/Resolved_Linked.tex".to_string()));
    }

    #[test]
    fn test_extract_texture_mapping_simple() {
        let ritobin_content = r#"
        skinMeshProperties: embed = SkinMeshDataProperties {
            texture: string = "ASSETS/Simple.tex"
        }
        "#;
        
        let mapping = extract_texture_mapping_from_text(ritobin_content).unwrap();
        assert_eq!(mapping.default_texture, Some("ASSETS/Simple.tex".to_string()));
        assert!(mapping.material_properties.is_empty());
    }

    #[test]
    fn test_extract_texture_mapping_hex_hash() {
        let ritobin_content = r#"
        skinMeshProperties: embed = SkinMeshDataProperties {
            texture: string = "ASSETS/Characters/Test/Skins/Skin0/Default.tex"
            materialOverride: list[embed] = {
                SkinMeshDataProperties_MaterialOverride {
                    material: link = 0xABCDEF12
                    submesh: string = "HashedMesh"
                }
            }
        }
        
        0xABCDEF12 = StaticMaterialDef {
            name: string = "HashedMaterial"
            samplerValues: list2[embed] = {
                StaticMaterialShaderSamplerDef {
                    textureName: string = "Diffuse_Color"
                    texturePath: string = "ASSETS/Characters/Test/Skins/Skin0/Hashed_Resolved.tex"
                    addressU: u32 = 1
                    addressV: u32 = 1
                }
            }
        }
        "#;
        
        let mapping = extract_texture_mapping_from_text(ritobin_content).unwrap();

        assert_eq!(
            mapping.material_properties.get("HashedMesh").map(|p| &p.texture_path),
            Some(&"ASSETS/Characters/Test/Skins/Skin0/Hashed_Resolved.tex".to_string())
        );
        assert!(mapping.static_materials.is_empty());
    }

    #[test]
    fn test_hash_link_resolves_named_def_via_bridge() {
        let mat_path = "Characters/Test/Skins/Skin0/Materials/Bridged";
        let hash = fnv1a32_lower(mat_path);
        let content = format!(
            r#"
        skinMeshProperties: embed = SkinMeshDataProperties {{
            texture: string = "ASSETS/Default.tex"
            materialOverride: list[embed] = {{
                SkinMeshDataProperties_MaterialOverride {{
                    material: link = 0x{hash:08x}
                    submesh: string = "BridgedMesh"
                }}
            }}
        }}

        "{mat_path}" = StaticMaterialDef {{
            samplerValues: list2[embed] = {{
                StaticMaterialShaderSamplerDef {{
                    textureName: string = "Diffuse_Color"
                    texturePath: string = "ASSETS/Characters/Test/Skins/Skin0/Bridged.tex"
                }}
            }}
        }}
        "#
        );

        let mapping = extract_texture_mapping_from_text(&content).unwrap();
        assert_eq!(
            mapping
                .material_properties
                .get("BridgedMesh")
                .map(|p| p.texture_path.as_str()),
            Some("ASSETS/Characters/Test/Skins/Skin0/Bridged.tex"),
        );
        assert!(mapping.static_materials.is_empty());
    }

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

    #[test]
    fn test_extract_braced_block() {
        let content = r#"outer { inner { nested } more } end"#;
        let block = extract_braced_block(content, 5).unwrap();
        assert_eq!(block.trim(), "inner { nested } more");
    }
}

