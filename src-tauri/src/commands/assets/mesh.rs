//! Mesh commands for SKN/SKL/SCB file parsing
//! 
//! Provides Tauri commands for reading 3D mesh data from League files.

use std::path::Path;
use std::collections::HashMap;

use crate::core::ipc_trace;
use flint_ltk::mesh::skn::{parse_skn_file, SknMeshData};
use flint_ltk::mesh::scb::{parse_scb_file, ScbMeshData};
use flint_ltk::mesh::texture::{find_skin_bin, MaterialProperties};
use crate::commands::file::decode_texture_file_sync;

/// Synchronous decode wrapper for use inside rayon `par_iter` blocks.
fn decode_texture_blocking(path: &Path) -> Result<String, String> {
    decode_texture_file_sync(path)
}

/// Read and parse an SCB (Static Mesh Binary) file.
///
/// Returns the mesh in a packed binary wire format (see
/// `flint_ltk::mesh::wire`). Vertex/index buffers travel as raw bytes so the
/// frontend can hand them straight to `THREE.BufferAttribute` without paying
/// the JSON-array round trip — a 30K-vertex mesh used to push ~3-5 MB of
/// `[[x,y,z], …]` JSON; now it's the underlying ~600 KB of f32 bytes.
#[tauri::command]
pub async fn read_scb_mesh(path: String) -> Result<tauri::ipc::Response, String> {
    let mesh = read_scb_mesh_inner(path).await?;
    tracing::info!(
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
    let buf = flint_ltk::mesh::wire::encode_scb_binary(&mesh)?;
    Ok(tauri::ipc::Response::new(buf))
}

async fn read_scb_mesh_inner(path: String) -> Result<ScbMeshData, String> {
    let _t = ipc_trace::enter("read_scb_mesh");
    tracing::debug!("🗿 Reading SCB/SCO mesh: {}", path);

    let scb_path = Path::new(&path);

    // Parse the SCB/SCO file
    let mut mesh_data = parse_scb_file(&path)
        .map_err(|e| {
            tracing::error!("Failed to parse SCB file {}: {}", path, e);
            format!("Failed to parse SCB file: {}", e)
        })?;

    tracing::debug!("✓ SCB parsed successfully. Materials: {:?}", mesh_data.materials);

    // Try to find .ritobin text for texture discovery
    let ritobin_text = find_ritobin_text(scb_path);

    if let Some(bin_text) = ritobin_text {
        tracing::debug!("📄 Loaded ritobin text ({} bytes) for SCB texture lookup", bin_text.len());

        // Also load concat BIN ritobin for additional material definitions
        let concat_text = find_concat_ritobin_text(scb_path);
        let combined_text = if let Some(concat) = concat_text {
            tracing::debug!("📄 Also loaded concat ritobin ({} bytes)", concat.len());

            // DEBUG: List all StaticMaterialDef definitions in concat
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

        use flint_ltk::mesh::texture::extract_texture_mapping_from_text;

        // Extract all texture mappings from combined ritobin text (main + concat)
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

        // Look up texture for each material
        for material_name in &mesh_data.materials {
            // Try direct lookup, then fallback to default
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

                // Load textures in parallel
                tracing::debug!("⬇ Loading {} unique textures for SCB...", texture_tasks.len());
                let start_time = std::time::Instant::now();

                // `decode_dds_to_png` is an `async` Tauri command but its body is
                // fully blocking CPU work — `join_all` on a single tokio task ran
                // them serially (4× 150ms ≈ 600ms in the SKN preview log). Push
                // them onto rayon so they actually run in parallel across cores.
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

                let mut decoded_textures: HashMap<String, String> = HashMap::new();
                for result in results.into_iter().flatten() {
                    decoded_textures.insert(result.0, result.1);
                }

                use flint_ltk::mesh::skn::MaterialData;
                let mut material_data: HashMap<String, MaterialData> = HashMap::new();

                for (material_name, props) in material_props_map {
                    if let Some(resolved) = resolve_texture_path(base_dir, &props.texture_path) {
                        let path_key = resolved.to_string_lossy().to_string();
                        if let Some(texture_data) = decoded_textures.get(&path_key) {
                            material_data.insert(material_name, MaterialData {
                                texture: texture_data.clone(),
                                uv_scale: props.uv_scale,
                                uv_offset: props.uv_offset,
                                flipbook_size: props.flipbook_size,
                                flipbook_frame: props.flipbook_frame,
                            });
                        }
                    }
                }

                let elapsed = start_time.elapsed();
                tracing::info!("Loaded {} textures for SCB mesh in {:.2}s", material_data.len(), elapsed.as_secs_f32());
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
fn find_ritobin_text(mesh_path: &Path) -> Option<String> {
    // Strategy 1: Find .bin via standard lookups, then check .ritobin cache
    let bin_finders: [fn(&Path) -> Option<std::path::PathBuf>; 2] = [
        |p| find_skin_bin(p),
        |p| find_scb_bin(p),
    ];

    for finder in &bin_finders {
        if let Some(bin_path) = finder(mesh_path) {
            let ritobin_path = std::path::PathBuf::from(format!("{}.ritobin", bin_path.display()));

            // Check if cache exists
            if ritobin_path.exists() {
                if let Ok(text) = std::fs::read_to_string(&ritobin_path) {
                    tracing::debug!("✓ Found .ritobin cache next to BIN: {}", ritobin_path.display());
                    return Some(text);
                }
            }

            // Cache doesn't exist - try to create it automatically
            tracing::debug!("Creating .ritobin cache from BIN: {}", bin_path.display());
            match create_ritobin_cache(&bin_path, &ritobin_path) {
                Ok(text) => {
                    tracing::debug!("Created .ritobin cache: {}", ritobin_path.display());
                    return Some(text);
                }
                Err(e) => {
                    tracing::warn!("Failed to create .ritobin cache: {}", e);
                }
            }
        }
    }

    // Strategy 2: Search for .ritobin files directly in the data/ tree
    if let Some(character_folder) = extract_character_folder(mesh_path) {
        if let Some(root) = find_project_root(mesh_path) {
            let skins_dir = root
                .join("data")
                .join("characters")
                .join(&character_folder)
                .join("skins");

            if skins_dir.exists() {
                if let Some(text) = find_ritobin_in_dir(&skins_dir) {
                    return Some(text);
                }
            }
        }
    }

    None
}

/// Find concat BIN ritobin text for additional material definitions
///
/// Concat BINs contain merged material definitions that may not be in the main skin BIN
fn find_concat_ritobin_text(mesh_path: &Path) -> Option<String> {
    tracing::debug!("🔎 Looking for concat BIN for: {}", mesh_path.display());

    // Find project root and character folder
    let root = find_project_root(mesh_path)?;
    tracing::debug!("  Project root: {}", root.display());

    let character_folder = extract_character_folder(mesh_path)?;
    tracing::debug!("  Character folder: {}", character_folder);

    // Search in multiple locations:
    // 1. data/characters/{champion}/skins/ (standard location)
    // 2. data/ (after refathering, concat might be here)
    let search_dirs = vec![
        root.join("data").join("characters").join(&character_folder).join("skins"),
        root.join("data"),
    ];

    for search_dir in search_dirs {
        tracing::debug!("  Searching in: {}", search_dir.display());

        if !search_dir.exists() {
            tracing::debug!("    Directory doesn't exist, skipping");
            continue;
        }

        // Look for concat BIN files (they typically have "concat" or "Concat" in the name)
        if let Ok(entries) = std::fs::read_dir(&search_dir) {
            let files: Vec<_> = entries.filter_map(|e| e.ok()).collect();
            tracing::debug!("    Found {} files", files.len());

            for entry in &files {
                let path = entry.path();
                let name = path.file_name()?.to_string_lossy().to_lowercase();

                // Check if this is a concat BIN
                if name.contains("concat") && name.ends_with(".bin") {
                    tracing::debug!("  ✓ Found concat BIN: {}", path.display());

                    // Check for existing .ritobin cache
                    let ritobin_path = std::path::PathBuf::from(format!("{}.ritobin", path.display()));
                    if ritobin_path.exists() {
                        if let Ok(text) = std::fs::read_to_string(&ritobin_path) {
                            tracing::debug!("  ✓ Loaded concat ritobin cache: {}", ritobin_path.display());
                            return Some(text);
                        }
                    }

                    // Create cache if it doesn't exist
                    tracing::debug!("  Creating ritobin cache for concat BIN...");
                    if let Ok(text) = create_ritobin_cache(&path, &ritobin_path) {
                        tracing::debug!("  ✓ Created concat ritobin cache: {}", ritobin_path.display());
                        return Some(text);
                    } else {
                        tracing::debug!("  ✗ Failed to create concat ritobin cache");
                    }
                }
            }
        }
    }

    tracing::debug!("  ✗ No concat BIN found in any location");
    None
}

/// Create a .ritobin cache file from a BIN file
///
/// Reads the BIN file, converts it to text using cached hashes, and writes to .ritobin
pub fn create_ritobin_cache(bin_path: &Path, ritobin_path: &Path) -> anyhow::Result<String> {
    use flint_ltk::bin::ltk_bridge;

    tracing::debug!("Reading BIN file: {}", bin_path.display());

    // Read BIN file bytes
    let data = std::fs::read(bin_path)
        .map_err(|e| anyhow::anyhow!("Failed to read BIN file: {}", e))?;

    // Parse BIN to tree structure
    let tree = ltk_bridge::read_bin(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse BIN file: {}", e))?;

    // Convert tree to text using cached hashes
    let text = ltk_bridge::tree_to_text_cached(&tree)
        .map_err(|e| anyhow::anyhow!("Failed to convert BIN to text: {}", e))?;

    // Write cache file
    std::fs::write(ritobin_path, &text)
        .map_err(|e| anyhow::anyhow!("Failed to write .ritobin cache: {}", e))?;

    tracing::debug!("Wrote {} bytes to {}", text.len(), ritobin_path.display());

    Ok(text)
}

/// Recursively search a directory for .ritobin files, preferring Concat.bin.ritobin
fn find_ritobin_in_dir(dir: &Path) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut fallback: Option<std::path::PathBuf> = None;

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_lowercase();

        if path.is_dir() {
            // Recurse into skin subdirectories
            if let Some(text) = find_ritobin_in_dir(&path) {
                return Some(text);
            }
        } else if name.ends_with(".bin.ritobin") {
            // Prefer Concat
            if name.contains("concat") {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    tracing::debug!("✓ Found concat .ritobin directly: {}", path.display());
                    return Some(text);
                }
            } else if fallback.is_none() {
                fallback = Some(path);
            }
        }
    }

    // Use non-concat .ritobin if no concat found
    if let Some(fb_path) = fallback {
        if let Ok(text) = std::fs::read_to_string(&fb_path) {
            tracing::debug!("✓ Found .ritobin directly: {}", fb_path.display());
            return Some(text);
        }
    }

    None
}

/// Read and parse an SKN (Simple Skin) mesh file.
///
/// Returns the mesh in a packed binary wire format (see
/// `flint_ltk::mesh::wire`). Vertex/index buffers travel as raw bytes so the
/// frontend can hand them straight to `THREE.BufferAttribute` without paying
/// the JSON-array round trip.
#[tauri::command]
pub async fn read_skn_mesh(path: String) -> Result<tauri::ipc::Response, String> {
    let mesh = read_skn_mesh_inner(path).await?;
    tracing::info!(
        "[mesh-wire] SKN: {} verts, {} idx, {} mats, {} bone_idx, {} bone_wt, bbox={:?}",
        mesh.positions.len(),
        mesh.indices.len(),
        mesh.materials.len(),
        mesh.bone_indices.len(),
        mesh.bone_weights.len(),
        mesh.bounding_box
    );
    let buf = flint_ltk::mesh::wire::encode_skn_binary(&mesh)?;
    Ok(tauri::ipc::Response::new(buf))
}

async fn read_skn_mesh_inner(path: String) -> Result<SknMeshData, String> {
    let _t = ipc_trace::enter("read_skn_mesh");
    tracing::debug!("🎨 Reading SKN mesh: {}", path);

    let skn_path = Path::new(&path);

    // Parse the SKN file
    let mut mesh_data = parse_skn_file(&path)
        .map_err(|e| {
            tracing::error!("Failed to parse SKN file {}: {}", path, e);
            format!("Failed to parse SKN file: {}", e)
        })?;

    tracing::debug!("✓ SKN parsed successfully. Materials: {:?}",
        mesh_data.materials.iter().map(|m| &m.name).collect::<Vec<_>>());

    // Try to find .ritobin text for texture discovery
    let ritobin_text = find_ritobin_text(skn_path);

    if let Some(bin_text) = ritobin_text {
        tracing::debug!("📄 Loaded ritobin text ({} bytes) for SKN texture lookup", bin_text.len());

        // Also load concat BIN ritobin for additional material definitions
        let concat_text = find_concat_ritobin_text(skn_path);
        let combined_text = if let Some(concat) = concat_text {
            tracing::debug!("📄 Also loaded concat ritobin ({} bytes)", concat.len());

            // DEBUG: List all StaticMaterialDef definitions in concat
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

        use flint_ltk::mesh::texture::extract_texture_mapping_from_text;

        // Extract all texture mappings from combined ritobin text (main + concat)
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

        // Look up texture for each material
        for material in &mesh_data.materials {
            let material_name = &material.name;

            // Try direct lookup from materialOverride list
            let mat_props = material_props.get(material_name).cloned()
                .or_else(|| {
                    // If not in override list, search for StaticMaterialDef by material name
                    tracing::debug!("  Material '{}' not in override list, searching for StaticMaterialDef...", material_name);
                    use flint_ltk::mesh::texture::lookup_material_texture_by_name;
                    lookup_material_texture_by_name(&combined_text, material_name)
                })
                .or_else(|| {
                    // Last resort: use default texture
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

                // Load textures in parallel
                tracing::debug!("⬇ Loading {} unique textures...", texture_tasks.len());
                let start_time = std::time::Instant::now();

                // `decode_dds_to_png` is an `async` Tauri command but its body is
                // fully blocking CPU work — `join_all` on a single tokio task ran
                // them serially (4× 150ms ≈ 600ms in the SKN preview log). Push
                // them onto rayon so they actually run in parallel across cores.
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

                let mut decoded_textures: HashMap<String, String> = HashMap::new();
                for result in results.into_iter().flatten() {
                    decoded_textures.insert(result.0, result.1);
                }

                use flint_ltk::mesh::skn::MaterialData;
                let mut material_data: HashMap<String, MaterialData> = HashMap::new();

                for (material_name, props) in material_props_map {
                    if let Some(resolved) = resolve_texture_path(base_dir, &props.texture_path) {
                        let path_key = resolved.to_string_lossy().to_string();
                        if let Some(texture_data) = decoded_textures.get(&path_key) {
                            material_data.insert(material_name, MaterialData {
                                texture: texture_data.clone(),
                                uv_scale: props.uv_scale,
                                uv_offset: props.uv_offset,
                                flipbook_size: props.flipbook_size,
                                flipbook_frame: props.flipbook_frame,
                            });
                        }
                    }
                }

                let elapsed = start_time.elapsed();
                tracing::info!("Loaded {} textures for SKN mesh in {:.2}s", material_data.len(), elapsed.as_secs_f32());
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
    // bin_path might be a file or a directory — handle both
    let base_dir = if bin_path_ref.is_dir() {
        bin_path_ref.to_path_buf()
    } else {
        bin_path_ref.parent().unwrap_or(Path::new(".")).to_path_buf()
    };

    // Normalize the asset path (convert forward slashes, remove ASSETS/ prefix)
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

    // Find project root (directory containing `data/`) — smarter root detection
    let project_root = find_project_root(&base_dir);

    // Strategy 2: Search in WAD folders from project root
    if let Some(ref root) = project_root {
        // Search base/*.wad.client/assets/
        let base_folder = root.join("base");
        if let Some(found) = search_wad_folders(&base_folder, stripped) {
            return Ok(found);
        }

        // Also try content/base/ if project has that structure
        let content_base = root.join("content").join("base");
        if let Some(found) = search_wad_folders(&content_base, stripped) {
            return Ok(found);
        }
    }

    // Strategy 3: Walk up from base_dir looking for `base/` folder with WADs
    let mut current = base_dir.clone();
    for _ in 0..15 {
        let base_folder = current.join("base");
        if base_folder.exists() {
            if let Some(found) = search_wad_folders(&base_folder, stripped) {
                return Ok(found);
            }
        }

        // Check for extracted/ folder
        let extracted = current.join("extracted").join("ASSETS").join(stripped);
        if extracted.exists() {
            tracing::debug!("Found in extracted: {}", extracted.display());
            return Ok(extracted.to_string_lossy().to_string());
        }

        // Also check assets/ folder directly (might be inside a WAD extraction)
        let assets_direct = current.join("assets").join(stripped);
        if assets_direct.exists() {
            tracing::debug!("Found in assets/: {}", assets_direct.display());
            return Ok(assets_direct.to_string_lossy().to_string());
        }

        // Try full path relative to current
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

    // Strategy 4: Try path as-is (might be an absolute path)
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
            // Check with original casing
            let wad_asset = entry.path().join("assets").join(stripped);
            if wad_asset.exists() {
                tracing::debug!("Found in WAD {}: {}", wad_name, wad_asset.display());
                return Some(wad_asset.to_string_lossy().to_string());
            }

            // Check with lowercase
            let lower_asset = entry.path().join("assets").join(stripped.to_lowercase());
            if lower_asset.exists() {
                tracing::debug!("Found in WAD {} (lowercase): {}", wad_name, lower_asset.display());
                return Some(lower_asset.to_string_lossy().to_string());
            }
        }
    }

    None
}

use flint_ltk::mesh::skl::{parse_skl_file, SklData};

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

use flint_ltk::mesh::animation::{
    find_animation_bin, extract_animation_list, 
    resolve_animation_path,
    AnimationList, BakedAnimation,
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

/// Read and parse an ANM animation file and bake it
#[tauri::command]
pub async fn read_animation(path: String, base_path: Option<String>) -> Result<BakedAnimation, String> {
    tracing::debug!("Reading and baking animation: {}", path);
    
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
    
    flint_ltk::mesh::animation::bake_animation_file(&anim_path)
        .map_err(|e| {
            tracing::error!("Failed to bake animation {}: {}", anim_path.display(), e);
            format!("Failed to parse and bake animation: {}", e)
        })
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Extract character folder name from a file path
///
/// Tries multiple strategies: characters/ pattern, WAD folder name, path structure, filename.
fn extract_character_folder(file_path: &Path) -> Option<String> {
    let path_str = file_path.to_string_lossy().to_lowercase();
    let components: Vec<&str> = path_str.split(&['/', '\\'][..]).collect();

    // Strategy 1: Look for "characters/{name}" pattern
    for (i, part) in components.iter().enumerate() {
        if part == &"characters" && i + 1 < components.len() {
            return Some(components[i + 1].to_string());
        }
    }

    // Strategy 2: Extract from WAD folder name (e.g., "aurora.wad.client" → "aurora")
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

    // Strategy 3: Look for pattern like "/{name}/base/{name}.skn" or "/{name}/skins/"
    for (i, part) in components.iter().enumerate() {
        if (part == &"base" || part == &"skins") && i > 0 {
            let potential_name = components[i - 1];
            if !potential_name.is_empty() &&
               potential_name != "assets" &&
               potential_name != "data" &&
               !potential_name.contains("wad") {
                tracing::debug!("Extracted champion name from path structure: {}", potential_name);
                return Some(potential_name.to_string());
            }
        }
    }

    // Strategy 4: Extract from filename (skip generic/compound names) — last resort
    if let Some(file_name) = file_path.file_stem() {
        let name = file_name.to_string_lossy().to_lowercase();
        if !name.starts_with("skin") && name != "base" && !name.is_empty() && !name.contains('.') {
            tracing::debug!("Extracted champion name from filename: {}", name);
            return Some(name);
        }
    }

    None
}

/// Find BIN file associated with an SCB/SCO static mesh
///
/// Searches for .bin or .bin.ritobin files using smart root detection:
/// walks up from the mesh path to find a directory containing `data/`.
fn find_scb_bin(scb_path: &Path) -> Option<std::path::PathBuf> {
    tracing::debug!("Looking for BIN relative to SCB: {}", scb_path.display());

    let character_folder = extract_character_folder(scb_path)?;

    // Extract skin folder from path (e.g., "skin0", "skin20")
    let skin_folder = extract_skin_folder(scb_path);
    tracing::debug!("SCB BIN lookup: champion={}, skin={:?}", character_folder, skin_folder);

    // Find project root by walking up to find a directory with `data/` child
    let project_root = find_project_root(scb_path)?;
    tracing::debug!("Project root: {}", project_root.display());

    let skins_dir = project_root
        .join("data")
        .join("characters")
        .join(&character_folder)
        .join("skins");

    search_skins_dir_for_bin(&skins_dir, skin_folder.as_deref())
}

/// Extract skin folder name from a path (e.g., "skin0", "skin20", "base" → "skin0")
fn extract_skin_folder(path: &Path) -> Option<String> {
    let path_str = path.to_string_lossy().to_lowercase();
    let components: Vec<&str> = path_str.split(&['/', '\\'][..]).collect();

    // Strategy 1: Look for skins/{skinN} pattern
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

    // Strategy 2: Look for any directory component matching "skinN" pattern
    // (handles WAD-extracted paths like .../skin11/champion.skn)
    for part in components.iter().rev() {
        if part.starts_with("skin") && part.len() > 4 && part[4..].chars().all(|c| c.is_ascii_digit()) {
            return Some(part.to_string());
        }
    }

    None
}

/// Find the project root by walking up the directory tree until we find
/// a directory that contains a `data/` subdirectory.
///
/// Skips `.wad.client` / `.wad` folders — those are extracted WAD content,
/// not the actual project root.
fn find_project_root(file_path: &Path) -> Option<std::path::PathBuf> {
    let mut current = file_path.parent()?;
    let mut best: Option<std::path::PathBuf> = None;

    for _ in 0..15 {
        let data_dir = current.join("data");
        if data_dir.exists() && data_dir.is_dir() {
            let dir_name = current.file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            // Skip WAD folders — keep searching upward for the real project root
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
        current = match current.parent() {
            Some(p) => p,
            None => break,
        };
    }

    // Fall back to WAD folder if no better root found
    if let Some(ref fallback) = best {
        tracing::debug!("Using WAD folder as fallback project root: {}", fallback.display());
    }
    best
}

/// Search a skins directory for BIN files, trying multiple strategies.
/// Returns the best match: Concat.bin > skinN.bin > skin0.bin > any .bin
fn search_skins_dir_for_bin(skins_dir: &Path, skin_folder: Option<&str>) -> Option<std::path::PathBuf> {
    if !skins_dir.exists() {
        tracing::debug!("Skins directory does not exist: {}", skins_dir.display());
        return None;
    }

    // Strategy 1: Look for *Concat.bin (highest priority — pre-merged)
    if let Ok(entries) = std::fs::read_dir(skins_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.contains("concat") && name.ends_with(".bin") {
                tracing::debug!("Found concat BIN: {}", entry.path().display());
                return Some(entry.path());
            }
        }
    }

    // Strategy 2: Look in skinN/ subfolder if we know the skin
    if let Some(skin) = skin_folder {
        // skin0/skin0.bin
        let nested = skins_dir.join(skin).join(format!("{}.bin", skin));
        if nested.exists() {
            tracing::debug!("Found nested skin BIN: {}", nested.display());
            return Some(nested);
        }
        // skin0.bin directly in skins/
        let flat = skins_dir.join(format!("{}.bin", skin));
        if flat.exists() {
            tracing::debug!("Found flat skin BIN: {}", flat.display());
            return Some(flat);
        }
    }

    // Strategy 3: Fallback to skin0.bin
    let skin0 = skins_dir.join("skin0.bin");
    if skin0.exists() {
        tracing::debug!("Found fallback skin0.bin: {}", skin0.display());
        return Some(skin0);
    }

    // Strategy 4: Any .bin file in skins/
    if let Ok(entries) = std::fs::read_dir(skins_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("bin") {
                tracing::debug!("Found fallback BIN: {}", path.display());
                return Some(path);
            }
        }
    }

    tracing::debug!("No BIN found in skins dir: {}", skins_dir.display());
    None
}
