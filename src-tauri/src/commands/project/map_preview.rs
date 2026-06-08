//! Map preview: discover a map project's mapgeo+materials pair, parse the
//! geometry and material→texture links, decode textures, and open a separate
//! window that renders the map in 3D with live reload.
//!
//! See docs/superpowers/specs/2026-06-08-map-preview-design.md.
//!
//! The connection chain is deterministic:
//!   mapgeo Submesh.name == material name == StaticMaterialDef entry key
//!     -> samplerValues[ TextureName == "DiffuseTexture" ].texturePath
//!       -> .tex/.dds file on disk

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use ritoshark::bin::{Bin, BinValue};
use ritoshark::mapgeo::{ElementFormat, ElementName, MapGeometry};
use ritoshark::prelude::Parse as _;

// ============================================================================
// Variant / source discovery
// ============================================================================

/// A discovered mapgeo + materials-bin pair inside a map project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MapPreviewSource {
    /// Absolute path to the `.mapgeo` file.
    pub mapgeo: PathBuf,
    /// Absolute path to the sibling `.materials.bin` file.
    pub materials: PathBuf,
    /// Variant stem, e.g. "base_srx".
    pub variant: String,
}

/// Scan a directory for `<stem>.mapgeo` files and pair each with a sibling
/// `<stem>.materials.bin`. Returns all complete pairs, sorted by stem.
fn find_pairs_in_dir(dir: &Path) -> Vec<MapPreviewSource> {
    let mut pairs = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return pairs;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.ends_with(".mapgeo") {
            continue;
        }
        let stem = name.trim_end_matches(".mapgeo").to_string();
        let materials = dir.join(format!("{stem}.materials.bin"));
        if materials.exists() {
            pairs.push(MapPreviewSource {
                mapgeo: path.clone(),
                materials,
                variant: stem,
            });
        }
    }
    pairs.sort_by(|a, b| a.variant.cmp(&b.variant));
    pairs
}

/// Read `map_id` from a project's flint.json.
fn read_map_id(project_path: &Path) -> Result<String, String> {
    let flint = project_path.join("flint.json");
    let text =
        std::fs::read_to_string(&flint).map_err(|e| format!("Failed to read flint.json: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Invalid flint.json: {e}"))?;
    json.get("map_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "flint.json has no map_id (not a map project?)".to_string())
}

/// Discover the mapgeo + materials pair for a map project. Looks under every
/// `content/<layer>/Map*.wad.client/data/maps/mapgeometry/<map_id>/`.
pub fn discover_map_source(project_path: &Path) -> Result<MapPreviewSource, String> {
    let map_id = read_map_id(project_path)?;
    let content = project_path.join("content");
    let mut all_pairs: Vec<MapPreviewSource> = Vec::new();

    if let Ok(layers) = std::fs::read_dir(&content) {
        for layer in layers.flatten() {
            let wad_root = layer.path();
            if !wad_root.is_dir() {
                continue;
            }
            if let Ok(wads) = std::fs::read_dir(&wad_root) {
                for wad in wads.flatten() {
                    let dir = wad
                        .path()
                        .join("data")
                        .join("maps")
                        .join("mapgeometry")
                        .join(&map_id);
                    if dir.is_dir() {
                        all_pairs.extend(find_pairs_in_dir(&dir));
                    }
                }
            }
        }
    }

    all_pairs.sort_by(|a, b| a.variant.cmp(&b.variant));
    all_pairs
        .into_iter()
        .next()
        .ok_or_else(|| format!("No mapgeo+materials pair found for map '{map_id}' in this project"))
}

// ============================================================================
// Materials bin -> submesh-name -> diffuse-texture-path table
// ============================================================================

/// Map of submesh/material name -> diffuse texture path (as stored in the bin,
/// e.g. "ASSETS/Maps/.../foo.tex").
pub type MaterialTable = HashMap<String, String>;

/// FNV1a-32 of a field/class name (case-insensitive per the hashing rule).
fn h(name: &str) -> u32 {
    ritoshark::hash::fnv1a(name)
}

/// Pull a String field out of a field map by its (hashed) name.
fn get_string(fields: &IndexMap<u32, BinValue>, name: &str) -> Option<String> {
    match fields.get(&h(name)) {
        Some(BinValue::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// Build the submesh-name → diffuse-texture-path table from a materials bin.
pub fn build_material_table(materials_bin: &Path) -> Result<MaterialTable, String> {
    let bin = Bin::from_path(materials_bin)
        .map_err(|e| format!("Failed to parse materials bin: {:?}", e))?;

    let static_material_def = h("StaticMaterialDef");
    let mut table = MaterialTable::new();

    for entry in &bin.entries {
        if entry.class_hash != static_material_def {
            continue;
        }
        // The material's own name (== the mapgeo submesh name).
        let Some(mat_name) = get_string(&entry.fields, "name") else {
            continue;
        };

        // samplerValues: list of StaticMaterialShaderSamplerDef embeds.
        let Some(BinValue::List { items, .. }) = entry.fields.get(&h("samplerValues")) else {
            continue;
        };

        // League names the diffuse sampler several ways across kit pieces:
        // "DiffuseTexture", "Diffuse_Texture", "Diffuse_Color", "Main_Texture",
        // "Color_Texture". Match any of these (case-insensitive); if none of the
        // preferred names appear, fall back to the FIRST sampler's texturePath so
        // the submesh is textured rather than rendered as a magenta error. This
        // is what was leaving ~100 submeshes (water lilies, SRX kit pieces)
        // magenta/white: their diffuse sampler is "Diffuse_Texture", not
        // "DiffuseTexture".
        const DIFFUSE_NAMES: [&str; 5] = [
            "diffusetexture",
            "diffuse_texture",
            "diffuse_color",
            "main_texture",
            "color_texture",
        ];

        let mut chosen: Option<String> = None;
        let mut first_path: Option<String> = None;
        for item in items {
            let fields = match item {
                BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => fields,
                _ => continue,
            };
            let Some(tex_path) = get_string(fields, "texturePath") else {
                continue;
            };
            if first_path.is_none() {
                first_path = Some(tex_path.clone());
            }
            let sampler_name = get_string(fields, "TextureName")
                .unwrap_or_default()
                .to_lowercase();
            if DIFFUSE_NAMES.contains(&sampler_name.as_str()) {
                chosen = Some(tex_path);
                break;
            }
        }

        if let Some(path) = chosen.or(first_path) {
            table.insert(mat_name.clone(), path);
        }
    }

    Ok(table)
}

// ============================================================================
// Geometry decode
// ============================================================================

/// One submesh draw range, in the same shape the frontend meshBuilder expects.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SubmeshRange {
    pub name: String,
    pub start_vertex: u32,
    pub vertex_count: u32,
    pub start_index: u32,
    pub index_count: u32,
    /// MapModel.layer bitmask — the AUTHORITATIVE elemental-variant encoding.
    /// Each bit = one rift variant (0x01 base, 0x02 infernal, 0x04 mountain,
    /// 0x08 ocean, 0x10 cloud, 0x20 hextech, 0x40 chemtech). 0xff = shared
    /// (visible in all variants). This is far more reliable than parsing
    /// material names, which can't classify generically-named geometry.
    pub layer: u8,
}

/// Decoded, render-ready geometry: one global vertex pool + index list, plus
/// submesh ranges. Positions/uvs are flat f32; indices are u32. Normals are
/// computed in Babylon (mirrors the SKN path), so we don't emit them.
#[derive(Debug, Default)]
pub struct DecodedGeometry {
    pub positions: Vec<f32>, // len = vertex_count * 3
    pub uvs: Vec<f32>,       // len = vertex_count * 2
    pub indices: Vec<u32>,
    pub submeshes: Vec<SubmeshRange>,
    pub bbox_min: [f32; 3],
    pub bbox_max: [f32; 3],
}

fn read_f32x3(buf: &[u8], at: usize) -> [f32; 3] {
    [
        f32::from_le_bytes(buf[at..at + 4].try_into().unwrap()),
        f32::from_le_bytes(buf[at + 4..at + 8].try_into().unwrap()),
        f32::from_le_bytes(buf[at + 8..at + 12].try_into().unwrap()),
    ]
}
fn read_f32x2(buf: &[u8], at: usize) -> [f32; 2] {
    [
        f32::from_le_bytes(buf[at..at + 4].try_into().unwrap()),
        f32::from_le_bytes(buf[at + 4..at + 8].try_into().unwrap()),
    ]
}

/// Decode all models of a parsed mapgeo into a single geometry pool.
pub fn decode_geometry(geo: &MapGeometry) -> Result<DecodedGeometry, String> {
    let mut out = DecodedGeometry {
        bbox_min: [f32::MAX; 3],
        bbox_max: [f32::MIN; 3],
        ..Default::default()
    };

    for model in &geo.models {
        let desc = geo
            .vertex_descriptions
            .get(model.vertex_description_id as usize)
            .ok_or("vertex_description_id out of range")?;
        let stride = desc.vertex_size();

        // Byte offset of Position and Texcoord0 within a vertex.
        let mut pos_off: Option<usize> = None;
        let mut uv_off: Option<usize> = None;
        let mut running = 0usize;
        for el in &desc.elements {
            match el.name {
                ElementName::Position if el.format == ElementFormat::XyzFloat32 => {
                    pos_off = Some(running)
                }
                ElementName::Texcoord0 if el.format == ElementFormat::XyFloat32 => {
                    uv_off = Some(running)
                }
                _ => {}
            }
            running += el.format.byte_size();
        }
        let pos_off = pos_off.ok_or("model has no float Position attribute")?;

        let vbuf_id = *model
            .vertex_buffer_ids
            .first()
            .ok_or("model has no vertex buffer")? as usize;
        let vbuf = geo
            .vertex_buffers
            .get(vbuf_id)
            .ok_or("vertex_buffer_id out of range")?;
        let ibuf = geo
            .index_buffers
            .get(model.index_buffer_id as usize)
            .ok_or("index_buffer_id out of range")?;

        let base_vertex = (out.positions.len() / 3) as u32;
        let base_index = out.indices.len() as u32;

        for v in 0..model.vertex_count as usize {
            let vbase = v * stride;
            let p = read_f32x3(&vbuf.data, vbase + pos_off);
            for i in 0..3 {
                out.bbox_min[i] = out.bbox_min[i].min(p[i]);
                out.bbox_max[i] = out.bbox_max[i].max(p[i]);
            }
            out.positions.extend_from_slice(&p);
            let uv = match uv_off {
                Some(o) => read_f32x2(&vbuf.data, vbase + o),
                None => [0.0, 0.0],
            };
            out.uvs.extend_from_slice(&uv);
        }

        for &idx in &ibuf.indices {
            out.indices.push(base_vertex + idx as u32);
        }

        for sm in &model.submeshes {
            out.submeshes.push(SubmeshRange {
                name: sm.name.clone(),
                start_vertex: base_vertex + sm.min_vertex,
                vertex_count: sm.max_vertex.saturating_sub(sm.min_vertex) + 1,
                start_index: base_index + sm.index_start,
                index_count: sm.index_count,
                layer: model.layer,
            });
        }
    }

    if out.positions.is_empty() {
        out.bbox_min = [0.0; 3];
        out.bbox_max = [0.0; 3];
    }
    Ok(out)
}

// ============================================================================
// Tauri commands
// ============================================================================

#[derive(serde::Serialize)]
struct MapPreviewMeta {
    variant: String,
    vertex_count: u32,
    index_count: u32,
    submeshes: Vec<SubmeshRange>,
    /// submesh-name -> diffuse texture path (bin path; absent for some submeshes)
    materials: MaterialTable,
    bounding_box: [[f32; 3]; 2],
}

/// Parse a map project's geometry + material links and return a binary payload:
/// `[u32 meta_len][meta json][pad to 4][positions f32][uvs f32][indices u32]`.
/// Mirrors the wire format decoded by `src/lib/api/mapPreview.ts`.
#[tauri::command]
pub async fn load_map_preview(project_path: String) -> Result<tauri::ipc::Response, String> {
    let project = PathBuf::from(&project_path);
    let source = discover_map_source(&project)?;

    let bytes = std::fs::read(&source.mapgeo).map_err(|e| format!("Failed to read mapgeo: {e}"))?;
    let geo =
        MapGeometry::from_bytes(&bytes).map_err(|e| format!("Failed to parse mapgeo: {:?}", e))?;
    let decoded = decode_geometry(&geo)?;
    let materials = build_material_table(&source.materials)?;

    let meta = MapPreviewMeta {
        variant: source.variant,
        vertex_count: (decoded.positions.len() / 3) as u32,
        index_count: decoded.indices.len() as u32,
        submeshes: decoded.submeshes,
        materials,
        bounding_box: [decoded.bbox_min, decoded.bbox_max],
    };

    let meta_json = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(&(meta_json.len() as u32).to_le_bytes());
    out.extend_from_slice(&meta_json);
    while out.len() % 4 != 0 {
        out.push(0);
    }
    for f in &decoded.positions {
        out.extend_from_slice(&f.to_le_bytes());
    }
    for f in &decoded.uvs {
        out.extend_from_slice(&f.to_le_bytes());
    }
    for i in &decoded.indices {
        out.extend_from_slice(&i.to_le_bytes());
    }

    Ok(tauri::ipc::Response::new(out))
}

/// Decode one texture (referenced by a bin texturePath) to raw RGBA.
/// Payload: `[u32 width][u32 height][rgba bytes]`.
#[tauri::command]
pub async fn load_map_texture(
    project_path: String,
    texture_path: String,
) -> Result<tauri::ipc::Response, String> {
    let project = PathBuf::from(&project_path);
    // Resolve relative to the discovered materials bin so resolve_asset_path's
    // WAD-folder search has the right starting point.
    let source = discover_map_source(&project)?;
    let bin_dir = source
        .materials
        .parent()
        .ok_or("materials bin has no parent dir")?
        .to_string_lossy()
        .to_string();

    let resolved =
        crate::commands::mesh::resolve_asset_path(texture_path.clone(), bin_dir)
            .await
            .map_err(|e| format!("Could not resolve texture '{texture_path}': {e}"))?;

    let data =
        std::fs::read(&resolved).map_err(|e| format!("Failed to read texture '{resolved}': {e}"))?;
    let mut rgba = crate::commands::texture_convert::decode_full_rgba(&data)?;

    // Downscale for preview. Raw RGBA is the memory hog: a 2048² texture is 16 MB
    // and ~168 of them stay resident on the GPU for the whole session (~2.7 GB).
    // Cap the longest edge at PREVIEW_MAX_DIM: 1024 keeps detail sharp while
    // holding RAM to ~1/4 of full res (~680 MB). Many source textures are already
    // ≤1024 and won't downscale at all. Triangle filter is fast + good for diffuse.
    const PREVIEW_MAX_DIM: u32 = 1024;
    let (w, h) = rgba.dimensions();
    if w > PREVIEW_MAX_DIM || h > PREVIEW_MAX_DIM {
        let scale = PREVIEW_MAX_DIM as f32 / w.max(h) as f32;
        let nw = ((w as f32 * scale).round() as u32).max(1);
        let nh = ((h as f32 * scale).round() as u32).max(1);
        rgba = image::imageops::resize(&rgba, nw, nh, image::imageops::FilterType::Triangle);
    }

    // Payload: [u32 width][u32 height][rgba...]. Alpha handling is decided on
    // the frontend (alpha-test enabled for every material — verified safe: no
    // map texture is uniformly zero-alpha, so nothing vanishes).
    let (w, h) = rgba.dimensions();
    let mut out: Vec<u8> = Vec::with_capacity(8 + rgba.as_raw().len());
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(rgba.as_raw());
    Ok(tauri::ipc::Response::new(out))
}

/// Resolve a bin texture path (e.g. "ASSETS/.../foo.tex") to its real on-disk
/// path inside the open map project. Used by the preview's identify card for
/// Copy-path / Open-in-editor. Errors if the file can't be found.
#[tauri::command]
pub async fn resolve_map_texture_path(
    project_path: String,
    texture_path: String,
) -> Result<String, String> {
    let project = PathBuf::from(&project_path);
    let source = discover_map_source(&project)?;
    let bin_dir = source
        .materials
        .parent()
        .ok_or("materials bin has no parent dir")?
        .to_string_lossy()
        .to_string();
    crate::commands::mesh::resolve_asset_path(texture_path.clone(), bin_dir)
        .await
        .map_err(|e| format!("Could not resolve texture '{texture_path}': {e}"))
}

/// Percent-encode a path for embedding in a URL hash query. Keeps it dependency
/// free (urlencoding is not a direct dep). Encodes everything that isn't an
/// unreserved char; forward slashes are encoded too so the query is unambiguous.
fn encode_query_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Open (or focus) the separate map-preview window for a project.
#[tauri::command]
pub async fn open_map_preview_window(
    app: tauri::AppHandle,
    project_path: String,
) -> Result<(), String> {
    use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
    const LABEL: &str = "map-preview";

    // Already open: focus and tell it to load this project.
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_focus();
        let _ = win.emit("map-preview-load", project_path);
        return Ok(());
    }

    let url = format!(
        "index.html#map-preview?project={}",
        encode_query_component(&project_path)
    );

    // WebView2 on Windows throws 0x8007139F ("group or resource not in the
    // correct state") when a SECOND webview is created while the main window
    // uses custom `additionalBrowserArgs` and both share the default user-data
    // dir. The documented fix (tauri-apps/tauri#11144) is to give the new
    // window its OWN data_directory AND the SAME browser args as the main
    // window. The args here must match `additionalBrowserArgs` in
    // tauri.conf.json.
    const MAIN_BROWSER_ARGS: &str =
        "--disable-features=msSmartScreenProtection --disable-background-networking --disable-translate";
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("webview-map-preview");
    let _ = std::fs::create_dir_all(&data_dir);

    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App(url.into()))
        .title("Flint — Map Preview")
        .inner_size(1100.0, 720.0)
        .resizable(true)
        .additional_browser_args(MAIN_BROWSER_ARGS)
        .data_directory(data_dir)
        .build()
        .map_err(|e| format!("Failed to open map preview window: {e}"))?;

    Ok(())
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(path: &Path) {
        fs::write(path, b"x").unwrap();
    }

    #[test]
    fn find_pairs_matches_by_stem() {
        let tmp = std::env::temp_dir().join("flint_mp_test_pairs");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        touch(&tmp.join("base_srx.mapgeo"));
        touch(&tmp.join("base_srx.materials.bin"));
        touch(&tmp.join("lonely.mapgeo")); // no materials sibling -> ignored

        let pairs = find_pairs_in_dir(&tmp);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].variant, "base_srx");
        assert!(pairs[0].mapgeo.ends_with("base_srx.mapgeo"));
        assert!(pairs[0].materials.ends_with("base_srx.materials.bin"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_pairs_empty_when_none() {
        let tmp = std::env::temp_dir().join("flint_mp_test_empty");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        assert!(find_pairs_in_dir(&tmp).is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn discover_finds_pair_in_nested_layout() {
        let tmp = std::env::temp_dir().join("flint_mp_test_discover");
        let _ = fs::remove_dir_all(&tmp);
        let geo_dir = tmp
            .join("content")
            .join("base")
            .join("Map11.wad.client")
            .join("data")
            .join("maps")
            .join("mapgeometry")
            .join("map11");
        fs::create_dir_all(&geo_dir).unwrap();
        touch(&geo_dir.join("base_srx.mapgeo"));
        touch(&geo_dir.join("base_srx.materials.bin"));
        fs::write(
            tmp.join("flint.json"),
            br#"{ "kind": "map", "map_id": "map11" }"#,
        )
        .unwrap();

        let src = discover_map_source(&tmp).unwrap();
        assert_eq!(src.variant, "base_srx");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn material_table_extracts_diffuse() {
        use ritoshark::bin::{BinEntry, BinType};
        use ritoshark::prelude::Serialize as _;

        let mut sampler = IndexMap::new();
        sampler.insert(h("TextureName"), BinValue::String("DiffuseTexture".into()));
        sampler.insert(
            h("texturePath"),
            BinValue::String("ASSETS/Maps/Foo/bar.tex".into()),
        );

        let mut fields = IndexMap::new();
        fields.insert(h("name"), BinValue::String("Foo/Bar_MAT".into()));
        fields.insert(
            h("samplerValues"),
            BinValue::List {
                is_list2: true,
                item: BinType::Embed,
                items: vec![BinValue::Embed {
                    class: h("StaticMaterialShaderSamplerDef"),
                    fields: sampler,
                }],
            },
        );

        let bin = Bin {
            is_patch: false,
            patch_header: [0; 8],
            version: 3,
            linked: vec![],
            entries: vec![BinEntry {
                path_hash: 1,
                class_hash: h("StaticMaterialDef"),
                fields,
            }],
            patches: vec![],
        };

        let tmp = std::env::temp_dir().join("flint_mp_mat.bin");
        std::fs::write(&tmp, bin.to_bytes().unwrap()).unwrap();

        let table = build_material_table(&tmp).unwrap();
        assert_eq!(
            table.get("Foo/Bar_MAT").map(String::as_str),
            Some("ASSETS/Maps/Foo/bar.tex")
        );
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn decode_real_mapgeo_if_available() {
        // Opportunistic: only runs on a machine with the nightmap project.
        let p = home_dir().join(
            "AppData/Roaming/Flint/projects/nightmap/content/base/Map11.wad.client/data/maps/mapgeometry/map11/base_srx.mapgeo",
        );
        if !p.exists() {
            eprintln!("skip: real mapgeo not present at {}", p.display());
            return;
        }
        let bytes = std::fs::read(&p).unwrap();
        let geo = MapGeometry::from_bytes(&bytes).unwrap();
        let decoded = decode_geometry(&geo).unwrap();
        assert!(!decoded.positions.is_empty());
        assert_eq!(decoded.positions.len() % 3, 0);
        assert!(decoded.positions.iter().all(|f| f.is_finite()));
        assert!(!decoded.submeshes.is_empty());
        let verts = decoded.positions.len() / 3;
        let max_idx = decoded.indices.iter().copied().max().unwrap_or(0);
        assert!(
            (max_idx as usize) < verts,
            "index {max_idx} out of range for {verts} verts — decode bug"
        );
        eprintln!(
            "decoded {verts} verts, {} indices, {} submeshes, bbox size=({:.0},{:.0},{:.0})",
            decoded.indices.len(),
            decoded.submeshes.len(),
            decoded.bbox_max[0] - decoded.bbox_min[0],
            decoded.bbox_max[1] - decoded.bbox_min[1],
            decoded.bbox_max[2] - decoded.bbox_min[2],
        );

        // Verify submesh→material coverage on the real map: the vast majority
        // of submeshes must resolve to a texture. (A few effect/prototype
        // materials legitimately have no diffuse texture.)
        let bin_path = p.with_file_name("base_srx.materials.bin");
        let table = build_material_table(&bin_path).unwrap();
        let matched = decoded
            .submeshes
            .iter()
            .filter(|sm| table.contains_key(&sm.name))
            .count();
        eprintln!(
            "submesh->material: {matched}/{} matched ({} table entries)",
            decoded.submeshes.len(),
            table.len()
        );
        assert!(
            matched * 100 / decoded.submeshes.len() >= 90,
            "expected >=90% of submeshes to resolve a material, got {matched}/{}",
            decoded.submeshes.len()
        );

        // The per-submesh layer byte (the authoritative elemental encoding)
        // must be populated and varied (not all 0xff), or variant toggling can't
        // work.
        let distinct_layers: std::collections::BTreeSet<u8> =
            decoded.submeshes.iter().map(|s| s.layer).collect();
        eprintln!("distinct submesh layers: {distinct_layers:?}");
        assert!(
            distinct_layers.len() > 1,
            "expected multiple layer values (elemental variants), got {distinct_layers:?}"
        );
    }

    /// Does our .tex decode preserve the alpha channel? GIMP shows
    /// chaos_base_a_1bitalpha.tex with real transparency; Flint renders it black.
    /// Decode it here and dump the alpha histogram to find where alpha is lost.
    #[test]
    fn tex_alpha_is_preserved() {
        let f = home_dir().join(
            "AppData/Roaming/Flint/projects/nightmap/content/base/Map11.wad.client/assets/maps/kitpieces/srs/base/textures/chaos_base_a_1bitalpha.tex",
        );
        if !f.exists() {
            eprintln!("skip: tex not present at {}", f.display());
            return;
        }
        let bytes = std::fs::read(&f).unwrap();
        let rgba = crate::commands::texture_convert::decode_full_rgba(&bytes).unwrap();
        let total = (rgba.width() * rgba.height()) as usize;
        let mut a0 = 0usize; // alpha == 0
        let mut a255 = 0usize; // alpha == 255
        let mut amid = 0usize; // in-between
        for px in rgba.pixels() {
            match px.0[3] {
                0 => a0 += 1,
                255 => a255 += 1,
                _ => amid += 1,
            }
        }
        eprintln!(
            "ALPHA of chaos_base_a_1bitalpha ({}x{}): a0={a0} a255={a255} amid={amid} (total={total})",
            rgba.width(),
            rgba.height()
        );
        // If the decode preserved alpha, a 1bitalpha cutout MUST have many a0.
        assert!(
            a0 > total / 100,
            "expected transparent texels (a0) but got a0={a0}/{total} — alpha is being DROPPED in decode"
        );
    }

    fn home_dir() -> PathBuf {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_default()
    }
}
