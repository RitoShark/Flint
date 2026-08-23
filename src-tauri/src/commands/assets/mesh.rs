//! Mesh commands for SKN/SKL/SCB file parsing.

use std::path::Path;
use std::collections::HashMap;
use std::sync::Arc;

use crate::core::ipc_trace;
use flint_core::mesh::discovery::find_project_root;
use flint_core::mesh::ritobin::{find_concat_ritobin_text, find_linked_bin_ritobin_text, find_ritobin_text};
use flint_core::mesh::skn::{parse_skn_file, SknMeshData};
use flint_core::mesh::scb::{parse_scb_file, ScbMeshData};
use flint_core::mesh::texture::MaterialProperties;
use crate::commands::file::decode_texture_file_sync_with_alpha;

/// Synchronous decode wrapper for use inside rayon `par_iter` blocks.
/// Returns (base64 PNG, has_alpha).
fn decode_texture_blocking(path: &Path) -> Result<(String, bool), String> {
    decode_texture_file_sync_with_alpha(path)
}

/// Read and parse an SCB (Static Mesh Binary) file. Returns the mesh in a
/// packed binary wire format (see `flint_core::mesh::wire`).
#[tauri::command]
pub async fn read_scb_mesh(path: String) -> Result<tauri::ipc::Response, String> {
    let mesh = read_scb_mesh_inner(path).await?;
    tracing::debug!(
        "[mesh-wire] SCB '{}': {} verts, {} idx, {} mats={:?} ranges={:?} mat_data_keys={:?} bbox={:?}",
        mesh.name,
        mesh.positions.len(),
        mesh.indices.len(),
        mesh.materials.len(),
        mesh.materials,
        mesh.material_ranges,
        mesh.material_data.keys().collect::<Vec<_>>(),
        mesh.bounding_box
    );
    let buf = flint_core::mesh::wire::encode_scb_binary(&mesh)?;
    Ok(tauri::ipc::Response::new(buf))
}

async fn read_scb_mesh_inner(path: String) -> Result<ScbMeshData, String> {
    let _t = ipc_trace::enter("read_scb_mesh");
    tracing::debug!("🗿 Reading SCB/SCO mesh: {}", path);

    let scb_path = Path::new(&path);

    let mut mesh_data = parse_scb_file(&path)
        .map_err(|e| {
            tracing::error!("Failed to parse SCB file {}: {}", path, e);
            format!("Failed to parse SCB file: {}", e)
        })?;

    tracing::debug!("✓ SCB parsed successfully. Materials: {:?}", mesh_data.materials);

    let ritobin_text = find_ritobin_text(scb_path);

    if let Some(bin_text) = ritobin_text {
        tracing::debug!("📄 Loaded ritobin text ({} bytes) for SCB texture lookup", bin_text.len());

        let concat_text = find_concat_ritobin_text(scb_path);
        let combined_text = if let Some(concat) = concat_text {
            tracing::debug!("📄 Also loaded concat ritobin ({} bytes)", concat.len());

            let material_def_pattern = regex::Regex::new(r#""([^"]+)"\s*=\s*StaticMaterialDef"#).unwrap();
            let concat_materials: Vec<String> = material_def_pattern
                .captures_iter(&concat)
                .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
                .collect();
            tracing::debug!("📋 Concat BIN contains {} StaticMaterialDef definitions:", concat_materials.len());
            for (i, mat) in concat_materials.iter().enumerate() {
                tracing::debug!("  {}. {}", i + 1, mat);
            }

            format!("{}\n\n{}", bin_text, concat)
        } else {
            tracing::warn!("No concat BIN found - using main BIN only");
            bin_text
        };

        // Also fold in any bins referenced through the skin BIN's `linked` header — shared
        // material defs frequently live there rather than in the skin/concat BIN.
        let combined_text = match find_linked_bin_ritobin_text(scb_path) {
            Some(linked) => {
                tracing::debug!("📄 Also merged linked-bin ritobin ({} bytes)", linked.len());
                format!("{}{}", combined_text, linked)
            }
            None => combined_text,
        };

        use flint_core::mesh::texture::extract_texture_mapping_from_text;

        let texture_mapping = match extract_texture_mapping_from_text(&combined_text) {
            Ok(mapping) => mapping,
            Err(e) => {
                tracing::warn!("Failed to extract texture mapping from ritobin: {}", e);
                mesh_data.texture_warning = Some(format!("Failed to parse texture mapping: {}", e));
                return Ok(mesh_data);
            }
        };

        let material_props = &texture_mapping.material_properties;
        let default_tex = &texture_mapping.default_texture;

        tracing::debug!("Extracted {} material mappings, default={:?}",
            material_props.len(),
            default_tex.as_deref().unwrap_or("none"));

        let base_dir = scb_path.parent().unwrap_or(Path::new("."));
        let mut material_props_map: HashMap<String, MaterialProperties> = HashMap::new();
        let mut texture_tasks: Vec<(String, std::path::PathBuf)> = Vec::new();

        for material_name in &mesh_data.materials {
            let mat_props = material_props.get(material_name).cloned()
                .or_else(|| {
                    default_tex.as_ref().map(|tex| MaterialProperties {
                        texture_path: tex.clone(),
                        ..Default::default()
                    })
                });

            if let Some(props) = mat_props {
                tracing::debug!("🎨 SCB Material '{}' → TEXTURE: '{}'", material_name, props.texture_path);
                material_props_map.insert(material_name.clone(), props.clone());

                        if let Some(resolved) = resolve_texture_path(base_dir, &props.texture_path) {
                            let path_key = resolved.to_string_lossy().to_string();
                            if !texture_tasks.iter().any(|(pk, _)| pk == &path_key) {
                                texture_tasks.push((path_key, resolved));
                            }
                        } else {
                            tracing::warn!("Texture file not found: {}", props.texture_path);
                        }
                    } else {
                        tracing::warn!("✗ No texture resolved for SCB material: {}", material_name);
                    }
                }

                tracing::debug!("⬇ Loading {} unique textures for SCB...", texture_tasks.len());
                let start_time = std::time::Instant::now();

                // Blocking CPU decode runs on rayon so textures decode in parallel.
                let results = tokio::task::spawn_blocking(move || {
                    use rayon::prelude::*;
                    texture_tasks
                        .into_par_iter()
                        .map(|(path_key, resolved_path)| {
                            match decode_texture_blocking(&resolved_path) {
                                Ok(data) => Some((path_key, data)),
                                Err(e) => {
                                    tracing::warn!("Failed to decode {}: {}", resolved_path.display(), e);
                                    None
                                }
                            }
                        })
                        .collect::<Vec<_>>()
                })
                .await
                .unwrap_or_default();

                let mut decoded_textures: HashMap<String, (String, bool)> = HashMap::new();
                for result in results.into_iter().flatten() {
                    decoded_textures.insert(result.0, result.1);
                }

                use flint_core::mesh::skn::MaterialData;
                let mut material_data: HashMap<String, MaterialData> = HashMap::new();

                for (material_name, props) in material_props_map {
                    if let Some(resolved) = resolve_texture_path(base_dir, &props.texture_path) {
                        let path_key = resolved.to_string_lossy().to_string();
                        if let Some((texture_data, has_alpha)) = decoded_textures.get(&path_key) {
                            material_data.insert(material_name, MaterialData {
                                texture: texture_data.clone(),
                                uv_scale: props.uv_scale,
                                uv_offset: props.uv_offset,
                                flipbook_size: props.flipbook_size,
                                flipbook_frame: props.flipbook_frame,
                                has_alpha: *has_alpha,
                            });
                        }
                    }
                }

                let elapsed = start_time.elapsed();
                tracing::debug!("Loaded {} textures for SCB mesh in {:.2}s", material_data.len(), elapsed.as_secs_f32());
                mesh_data.material_data = material_data;
    } else {
        tracing::warn!("No .ritobin cache found and could not create one for SCB texture mapping");
        mesh_data.texture_warning = Some(
            "Could not find or create texture cache. The associated BIN file may be missing or in an unsupported location.".to_string()
        );
    }

    Ok(mesh_data)
}

/// Find ritobin text content for a mesh file.
///
/// Tries multiple strategies:
/// 1. Find the .bin file via find_skin_bin or find_scb_bin, then check for .ritobin cache
/// 2. If cache doesn't exist, automatically create it from the BIN file
/// 3. Search directly for .ritobin files in the data/characters/{champion}/skins/ tree
/// packed binary wire format (see `flint_core::mesh::wire`).
#[tauri::command]
pub async fn read_skn_mesh(path: String) -> Result<tauri::ipc::Response, String> {
    let _guard = skn_lock(&path).await;
    let mesh = read_skn_mesh_inner(path).await?;
    tracing::debug!(
        "[mesh-wire] SKN: {} verts, {} idx, {} mats, {} bone_idx, {} bone_wt, bbox={:?}",
        mesh.positions.len(),
        mesh.indices.len(),
        mesh.materials.len(),
        mesh.bone_indices.len(),
        mesh.bone_weights.len(),
        mesh.bounding_box
    );
    let buf = flint_core::mesh::wire::encode_skn_binary(&mesh)?;
    Ok(tauri::ipc::Response::new(buf))
}

/// Per-path lock so two viewers opening the same mesh at once do the work once.
///
/// The preview panel and the thumbnail studio can both mount on the same selection, and
/// every bin the mesh reaches gets rendered and scanned per call. Serialised, the second
/// caller finds the render caches warm instead of repeating a few hundred milliseconds of
/// text work.
static SKN_INFLIGHT: std::sync::OnceLock<dashmap::DashMap<String, Arc<tokio::sync::Mutex<()>>>> =
    std::sync::OnceLock::new();

async fn skn_lock(path: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let map = SKN_INFLIGHT.get_or_init(dashmap::DashMap::new);
    let lock = {
        let entry = map
            .entry(path.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())));
        Arc::clone(&*entry)
    };
    lock.lock_owned().await
}

async fn read_skn_mesh_inner(path: String) -> Result<SknMeshData, String> {
    let _t = ipc_trace::enter("read_skn_mesh");
    tracing::debug!("🎨 Reading SKN mesh: {}", path);

    let skn_path = Path::new(&path);

    let mut mesh_data = parse_skn_file(&path)
        .map_err(|e| {
            tracing::error!("Failed to parse SKN file {}: {}", path, e);
            format!("Failed to parse SKN file: {}", e)
        })?;

    tracing::debug!("✓ SKN parsed successfully. Materials: {:?}",
        mesh_data.materials.iter().map(|m| &m.name).collect::<Vec<_>>());

    let ritobin_text = find_ritobin_text(skn_path);

    if let Some(bin_text) = ritobin_text {
        tracing::debug!("📄 Loaded ritobin text ({} bytes) for SKN texture lookup", bin_text.len());

        let concat_text = find_concat_ritobin_text(skn_path);
        let combined_text = if let Some(concat) = concat_text {
            tracing::debug!("📄 Also loaded concat ritobin ({} bytes)", concat.len());

            let material_def_pattern = regex::Regex::new(r#""([^"]+)"\s*=\s*StaticMaterialDef"#).unwrap();
            let concat_materials: Vec<String> = material_def_pattern
                .captures_iter(&concat)
                .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
                .collect();
            tracing::debug!("📋 Concat BIN contains {} StaticMaterialDef definitions:", concat_materials.len());
            for (i, mat) in concat_materials.iter().enumerate() {
                tracing::debug!("  {}. {}", i + 1, mat);
            }

            format!("{}\n\n{}", bin_text, concat)
        } else {
            tracing::warn!("No concat BIN found - using main BIN only");
            bin_text
        };

        // Also fold in any bins referenced through the skin BIN's `linked` header — shared
        // material defs frequently live there rather than in the skin/concat BIN.
        let combined_text = match find_linked_bin_ritobin_text(skn_path) {
            Some(linked) => {
                tracing::debug!("📄 Also merged linked-bin ritobin ({} bytes)", linked.len());
                format!("{}{}", combined_text, linked)
            }
            None => combined_text,
        };

        use flint_core::mesh::texture::extract_texture_mapping_from_text;

        let texture_mapping = match extract_texture_mapping_from_text(&combined_text) {
            Ok(mapping) => mapping,
            Err(e) => {
                tracing::warn!("Failed to extract texture mapping from ritobin: {}", e);
                mesh_data.texture_warning = Some(format!("Failed to parse texture mapping: {}", e));
                return Ok(mesh_data);
            }
        };

        let material_props = &texture_mapping.material_properties;
        let default_tex = &texture_mapping.default_texture;

        tracing::debug!("Extracted {} material mappings, default={:?}",
            material_props.len(),
            default_tex.as_deref().unwrap_or("none"));

        let base_dir = skn_path.parent().unwrap_or(Path::new("."));
        let mut material_props_map: HashMap<String, MaterialProperties> = HashMap::new();
        let mut texture_tasks: Vec<(String, std::path::PathBuf)> = Vec::new();

        for material in &mesh_data.materials {
            let material_name = &material.name;

            let mat_props = material_props.get(material_name).cloned()
                .or_else(|| {
                    tracing::debug!("  Material '{}' not in override list, searching for StaticMaterialDef...", material_name);
                    use flint_core::mesh::texture::lookup_material_texture_by_name;
                    lookup_material_texture_by_name(&combined_text, material_name)
                })
                .or_else(|| {
                    tracing::warn!("  Material '{}' not found anywhere, using default texture", material_name);
                    default_tex.as_ref().map(|tex| MaterialProperties {
                        texture_path: tex.clone(),
                        ..Default::default()
                    })
                });

            if let Some(props) = mat_props {
                tracing::debug!("🎨 Material '{}' → TEXTURE: '{}'",
                    material_name, props.texture_path);

                material_props_map.insert(material_name.clone(), props.clone());

                        if let Some(resolved) = resolve_texture_path(base_dir, &props.texture_path) {
                            let path_key = resolved.to_string_lossy().to_string();
                            if !texture_tasks.iter().any(|(pk, _)| pk == &path_key) {
                                texture_tasks.push((path_key, resolved));
                            }
                        } else {
                            tracing::warn!("Texture file not found: {}", props.texture_path);
                        }
                    } else {
                        tracing::warn!("✗ No texture resolved for material: {}", material_name);
                    }
                }

                tracing::debug!("⬇ Loading {} unique textures...", texture_tasks.len());
                let start_time = std::time::Instant::now();

                // Blocking CPU decode runs on rayon so textures decode in parallel.
                let results = tokio::task::spawn_blocking(move || {
                    use rayon::prelude::*;
                    texture_tasks
                        .into_par_iter()
                        .map(|(path_key, resolved_path)| {
                            match decode_texture_blocking(&resolved_path) {
                                Ok(data) => Some((path_key, data)),
                                Err(e) => {
                                    tracing::warn!("Failed to decode {}: {}", resolved_path.display(), e);
                                    None
                                }
                            }
                        })
                        .collect::<Vec<_>>()
                })
                .await
                .unwrap_or_default();

                let mut decoded_textures: HashMap<String, (String, bool)> = HashMap::new();
                for result in results.into_iter().flatten() {
                    decoded_textures.insert(result.0, result.1);
                }

                use flint_core::mesh::skn::MaterialData;
                let mut material_data: HashMap<String, MaterialData> = HashMap::new();

                for (material_name, props) in material_props_map {
                    if let Some(resolved) = resolve_texture_path(base_dir, &props.texture_path) {
                        let path_key = resolved.to_string_lossy().to_string();
                        if let Some((texture_data, has_alpha)) = decoded_textures.get(&path_key) {
                            material_data.insert(material_name, MaterialData {
                                texture: texture_data.clone(),
                                uv_scale: props.uv_scale,
                                uv_offset: props.uv_offset,
                                flipbook_size: props.flipbook_size,
                                flipbook_frame: props.flipbook_frame,
                                has_alpha: *has_alpha,
                            });
                        }
                    }
                }

                let elapsed = start_time.elapsed();
                tracing::debug!("Loaded {} textures for SKN mesh in {:.2}s", material_data.len(), elapsed.as_secs_f32());
                mesh_data.material_data = material_data;
    } else {
        tracing::warn!("No .ritobin cache found and could not create one for SKN texture mapping");
        mesh_data.texture_warning = Some(
            "Could not find or create texture cache. The associated BIN file may be missing or in an unsupported location.".to_string()
        );
    }

    Ok(mesh_data)
}

/// Resolve a texture path relative to the project directory
/// 
/// Tries multiple strategies:
/// 1. Extract filename and look in base_dir
/// 2. Try the full ASSETS/ path relative to project root
/// 3. Search in WAD folders (base/*.wad.client/assets/)
fn resolve_texture_path(base_dir: &Path, texture_path: &str) -> Option<std::path::PathBuf> {
    // Strategy 1: filename in the same directory as the SKN.
    let filename = Path::new(texture_path)
        .file_name()?
        .to_string_lossy();

    let same_dir_path = base_dir.join(filename.as_ref());
    if same_dir_path.exists() {
        return Some(same_dir_path);
    }

    // Strategy 2: path as-is (might be repathed).
    let texture_path_buf = std::path::PathBuf::from(texture_path);
    if texture_path_buf.exists() {
        return Some(texture_path_buf);
    }

    // Strategy 3: strip ASSETS/ prefix and resolve walking up from base_dir.
    let normalized = texture_path
        .trim_start_matches("ASSETS/")
        .trim_start_matches("assets/");

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

/// Resolve an asset path (from BIN file) to an actual file path
///
/// `bin_path` can be a file or directory — used as the starting point for search.
/// Searches: same directory, WAD folders, extracted folders, parent walk-up.
#[tauri::command]
pub async fn resolve_asset_path(
    asset_path: String,
    bin_path: String
) -> Result<String, String> {
    tracing::debug!("Resolving asset path: {} relative to {}", asset_path, bin_path);

    let bin_path_ref = std::path::Path::new(&bin_path);
    let base_dir = if bin_path_ref.is_dir() {
        bin_path_ref.to_path_buf()
    } else {
        bin_path_ref.parent().unwrap_or(Path::new(".")).to_path_buf()
    };

    let normalized: String = asset_path.replace('/', std::path::MAIN_SEPARATOR_STR);
    let stripped = normalized
        .trim_start_matches("ASSETS\\")
        .trim_start_matches("ASSETS/")
        .trim_start_matches("assets\\")
        .trim_start_matches("assets/");

    let filename = Path::new(&asset_path).file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    // Strategy 1: Same directory as the BIN file
    let same_dir = base_dir.join(&filename);
    if same_dir.exists() {
        tracing::debug!("Found in same directory: {}", same_dir.display());
        return Ok(same_dir.to_string_lossy().to_string());
    }

    let project_root = find_project_root(&base_dir);

    // Strategy 2: WAD folders under the project root.
    if let Some(ref root) = project_root {
        let base_folder = root.join("base");
        if let Some(found) = search_wad_folders(&base_folder, stripped) {
            return Ok(found);
        }

        let content_base = root.join("content").join("base");
        if let Some(found) = search_wad_folders(&content_base, stripped) {
            return Ok(found);
        }
    }

    // Strategy 3: Walk up from base_dir looking for a `base/` folder with WADs.
    let mut current = base_dir.clone();
    for _ in 0..15 {
        let base_folder = current.join("base");
        if base_folder.exists() {
            if let Some(found) = search_wad_folders(&base_folder, stripped) {
                return Ok(found);
            }
        }

        let extracted = current.join("extracted").join("ASSETS").join(stripped);
        if extracted.exists() {
            tracing::debug!("Found in extracted: {}", extracted.display());
            return Ok(extracted.to_string_lossy().to_string());
        }

        let assets_direct = current.join("assets").join(stripped);
        if assets_direct.exists() {
            tracing::debug!("Found in assets/: {}", assets_direct.display());
            return Ok(assets_direct.to_string_lossy().to_string());
        }

        let candidate = current.join(stripped);
        if candidate.exists() {
            tracing::debug!("Found in parent: {}", candidate.display());
            return Ok(candidate.to_string_lossy().to_string());
        }

        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }

    // Strategy 4: path as-is (might be absolute).
    let as_is = std::path::PathBuf::from(&asset_path);
    if as_is.exists() {
        return Ok(as_is.to_string_lossy().to_string());
    }

    let search_root = project_root.as_deref()
        .unwrap_or(base_dir.as_path());
    Err(format!("Asset not found: {} (searched from {})", asset_path, search_root.display()))
}

/// Search WAD folders (base/*.wad.client/assets/) for a stripped asset path
fn search_wad_folders(base_folder: &Path, stripped: &str) -> Option<String> {
    if !base_folder.exists() {
        return None;
    }

    let entries = std::fs::read_dir(base_folder).ok()?;
    for entry in entries.filter_map(|e| e.ok()) {
        let wad_name = entry.file_name().to_string_lossy().to_lowercase();
        if wad_name.ends_with(".wad.client") || wad_name.ends_with(".wad") {
            let wad_asset = entry.path().join("assets").join(stripped);
            if wad_asset.exists() {
                tracing::debug!("Found in WAD {}: {}", wad_name, wad_asset.display());
                return Some(wad_asset.to_string_lossy().to_string());
            }

            let lower_asset = entry.path().join("assets").join(stripped.to_lowercase());
            if lower_asset.exists() {
                tracing::debug!("Found in WAD {} (lowercase): {}", wad_name, lower_asset.display());
                return Some(lower_asset.to_string_lossy().to_string());
            }
        }
    }

    None
}

use flint_core::mesh::skl::{parse_skl_file, SklData};

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

use flint_core::mesh::animation::{
    find_animation_bin, extract_animation_list,
    resolve_animation_path, resolve_skn_for_anm,
    AnimationList, BakedAnimation,
};

/// Get list of available animations for a model
/// 
/// Parses the animation BIN file to extract AtomicClipData animation paths
#[tauri::command]
pub async fn read_animation_list(skn_path: String) -> Result<AnimationList, String> {
    tracing::debug!("Reading animation list for: {}", skn_path);
    
    let skn_path = std::path::Path::new(&skn_path);

    let bin_path = find_animation_bin(skn_path)
        .ok_or_else(|| "Animation BIN file not found".to_string())?;

    tracing::debug!("Found animation BIN: {}", bin_path.display());

    let mut list = extract_animation_list(&bin_path)
        .map_err(|e| {
            tracing::error!("Failed to extract animation list: {}", e);
            format!("Failed to extract animation list: {}", e)
        })?;

    // Attach the static submesh baseline + gear forms from the skin BIN (non-fatal if not
    // found) — one read/parse serves both.
    if let Some(skin_bin) = flint_core::mesh::texture::find_skin_bin(skn_path) {
        if let Ok(data) = std::fs::read(&skin_bin) {
            if let Ok(tree) = flint_core::bin::codec::read_bin(&data) {
                let initial = flint_core::mesh::submesh_visibility::parse_initial_hidden(&tree);
                list.initial_hide = initial.hide;
                list.initial_shadow_hide = initial.shadow_hide;
                // Gears shared between skins get hoisted into a linked `<Champ>_Skins_*.bin`;
                // the closure only runs when a gear link misses inside the skin BIN itself.
                list.forms = flint_core::mesh::submesh_visibility::parse_skin_forms(&tree, || {
                    flint_core::mesh::ritobin::read_linked_bin_trees(skn_path, &skin_bin, &tree)
                });
            }
        }
    }

    Ok(list)
}

/// One `.anm` file found by `list_anm_folder`. Naming/labelling is done on the
/// frontend (`animFolder.ts`), which is where the collision rules are tested.
#[derive(serde::Serialize)]
pub struct AnmFileEntry {
    pub file_name: String,
    pub path: String,
}

/// List the `.anm` files in a manually-picked folder.
///
/// The normal clip list is derived from the skin BIN's animation graph. That
/// derivation needs a graph it can resolve; ported/custom projects often have
/// the `.anm` files on disk with no reachable graph, which leaves the artist
/// with an empty Clip dropdown. This command backs the manual folder override:
/// point it at an `animations/` folder and every `.anm` in it becomes
/// selectable. `read_animation` already bakes a standalone `.anm` from an
/// absolute path, so nothing else is needed to play them.
///
/// Non-recursive on purpose — League keeps a skin's clips in one flat folder,
/// and recursing would pull in unrelated skins' animations.
#[tauri::command]
pub async fn list_anm_folder(dir: String) -> Result<Vec<AnmFileEntry>, String> {
    tracing::debug!("Listing .anm folder: {}", dir);

    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read animation folder: {}", e))?;

    let mut out: Vec<AnmFileEntry> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_anm = path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("anm"))
            .unwrap_or(false);
        if !is_anm {
            continue;
        }
        let Some(file_name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        out.push(AnmFileEntry {
            file_name,
            path: path.to_string_lossy().to_string(),
        });
    }

    tracing::debug!("Found {} .anm files in {}", out.len(), dir);
    Ok(out)
}

/// Read and parse an ANM animation file and bake it
#[tauri::command]
pub async fn read_animation(path: String, base_path: Option<String>) -> Result<BakedAnimation, String> {
    tracing::debug!("Reading and baking animation: {}", path);

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
    
    flint_core::mesh::animation::bake_animation_file(&anim_path)
        .map_err(|e| {
            tracing::error!("Failed to bake animation {}: {}", anim_path.display(), e);
            format!("Failed to parse and bake animation: {}", e)
        })
}

#[derive(serde::Serialize)]
pub struct AnmSkinResolution {
    pub skn_path: String,
    pub anm_asset_path: String,
}

/// Resolve which `.skn` a standalone `.anm` should play on, via the skin BIN's
/// `simpleSkin` field. Used when an `.anm` is opened directly in the preview.
#[tauri::command]
pub async fn resolve_anm_skin(anm_path: String) -> Result<AnmSkinResolution, String> {
    let anm = std::path::Path::new(&anm_path);
    let skn = resolve_skn_for_anm(anm).map_err(|e| e.to_string())?;
    Ok(AnmSkinResolution {
        skn_path: skn.to_string_lossy().to_string(),
        // Pass the ANM's own path back so the frontend can match it in the clip list.
        anm_asset_path: anm_path,
    })
}


/// Submesh (material-range) names of a `.skn`, for the BIN editor's
/// `Submesh: string = "..."` picker.
///
/// Deliberately NOT `read_skn_mesh`: that decodes every vertex, index and
/// texture to hand back megabytes of geometry, when all this needs is the
/// range names.
#[tauri::command]
pub async fn read_skn_submesh_names(skn_path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        use ritoshark::prelude::Parse;
        let data = std::fs::read(&skn_path)
            .map_err(|e| format!("Failed to read '{}': {}", skn_path, e))?;
        let mesh = ritoshark::mesh::SkinnedMesh::from_bytes(&data)
            .map_err(|e| format!("Failed to parse SKN '{}': {:?}", skn_path, e))?;
        Ok(mesh.ranges().iter().map(|r| r.name.clone()).collect())
    })
    .await
    .map_err(|e| format!("SKN submesh task failed: {}", e))?
}
