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

use flint_core::mesh::materials::BinIndex;
use flint_core::project::FlintMetadata;
use indexmap::IndexMap;
use ritoshark::bin::{Bin, BinValue};
use ritoshark::mapgeo::{ElementName, MapGeometry, MapModel};
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
    let meta: FlintMetadata =
        serde_json::from_str(&text).map_err(|e| format!("Invalid flint.json: {e}"))?;
    meta.normalized()
        .source
        .map_id
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

/// One material's diffuse texture and how its sampler addresses it.
///
/// LANDMINE: `addressU`/`addressV` are Riot's AUTHORED enum, not D3D's — 0 WRAP,
/// 1 CLAMP, 2 MIRROR, 3 BORDER. Over half of League's map materials bins author
/// them, and every authored value is non-default, so treating a missing field and
/// a present one alike renders thousands of samplers as WRAP.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MapMaterial {
    /// Texture path as stored in the bin, e.g. "ASSETS/Maps/.../foo.tex".
    pub path: String,
    pub address_u: u32,
    pub address_v: u32,
    /// Authored `TintColor.rgb`. The engine's albedo is `texture * TintColor * 2`,
    /// so 0.5 is neutral. Foliage depends on it: brush cards bind one shared neutral
    /// texture and get their whole per-map colour from here.
    pub tint_color: Option<[f32; 3]>,
    /// `blendEnable` with an authored blend factor: genuine translucency (water,
    /// tarps, nets), as opposed to a texture that merely carries an alpha channel.
    pub translucent: bool,
    /// Authored `AlphaTestValue.x`, the cutout threshold.
    pub alpha_test: Option<f32>,
}

/// Map of submesh/material name -> its diffuse texture.
pub type MaterialTable = HashMap<String, MapMaterial>;

/// FNV1a-32 of a field/class name (case-insensitive per the hashing rule).
fn h(name: &str) -> u32 {
    ritoshark::hash::fnv1a(name)
}

/// Pull an integer field out of a field map by its (hashed) name.
fn get_u32(fields: &IndexMap<u32, BinValue>, name: &str) -> Option<u32> {
    match fields.get(&h(name)) {
        Some(BinValue::U32(v)) => Some(*v),
        Some(BinValue::I32(v)) => Some(*v as u32),
        Some(BinValue::U8(v)) => Some(*v as u32),
        Some(BinValue::U16(v)) => Some(*v as u32),
        _ => None,
    }
}

/// Pull a String field out of a field map by its (hashed) name.
fn get_string(fields: &IndexMap<u32, BinValue>, name: &str) -> Option<String> {
    match fields.get(&h(name)) {
        Some(BinValue::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// The embedded/pointer field map of a container item.
fn item_fields(value: &BinValue) -> Option<&IndexMap<u32, BinValue>> {
    match value {
        BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => Some(fields),
        _ => None,
    }
}

/// The items of a list-shaped field.
fn list_items<'a>(
    fields: &'a IndexMap<u32, BinValue>,
    name: &str,
) -> Option<&'a Vec<BinValue>> {
    match fields.get(&h(name)) {
        Some(BinValue::List { items, .. }) => Some(items),
        _ => None,
    }
}

/// A named `paramValues` entry's vec4.
fn param_vec4(fields: &IndexMap<u32, BinValue>, param: &str) -> Option<[f32; 4]> {
    let wanted = h(param);
    for item in list_items(fields, "paramValues")? {
        let Some(props) = item_fields(item) else { continue };
        let Some(name) = get_string(props, "name") else { continue };
        if h(&name) != wanted {
            continue;
        }
        return match props.get(&h("value")) {
            Some(BinValue::Vec4(v)) => Some(*v),
            Some(BinValue::Vec3(v)) => Some([v[0], v[1], v[2], 0.0]),
            Some(BinValue::F32(v)) => Some([*v, 0.0, 0.0, 0.0]),
            _ => None,
        };
    }
    None
}

/// Whether the material's main pass alpha-BLENDS. `blendEnable` alone is not enough:
/// authoring either colour factor is the intent, and materials that set neither are
/// opaque cutouts however much alpha their texture carries.
fn is_translucent(fields: &IndexMap<u32, BinValue>) -> bool {
    let Some(techniques) = list_items(fields, "techniques") else {
        return false;
    };
    fn pass_of(tech: &BinValue) -> Option<&IndexMap<u32, BinValue>> {
        let tprops = item_fields(tech)?;
        for pass in list_items(tprops, "passes")? {
            let pprops = item_fields(pass)?;
            if pprops.contains_key(&h("shader")) {
                return Some(pprops);
            }
        }
        None
    }
    let normal = techniques.iter().find(|t| {
        item_fields(t)
            .and_then(|p| get_string(p, "name"))
            .map(|n| n.eq_ignore_ascii_case("normal"))
            .unwrap_or(false)
    });
    let pass = normal
        .and_then(pass_of)
        .or_else(|| techniques.iter().find_map(pass_of));
    let Some(pass) = pass else { return false };
    let enabled = matches!(pass.get(&h("blendEnable")), Some(BinValue::Bool(true)));
    let factored = pass.contains_key(&h("srcColorBlendFactor"))
        || pass.contains_key(&h("dstColorBlendFactor"));
    enabled && factored
}

/// Build the submesh-name → diffuse-texture-path table from a materials bin.
pub fn build_material_table(materials_bin: &Path) -> Result<MaterialTable, String> {
    let bin = Bin::from_path(materials_bin)
        .map_err(|e| format!("Failed to parse materials bin: {:?}", e))?;
    let names = flint_core::bin::name_table(&bin, materials_bin);
    let index = BinIndex::new([(&bin, names)]);

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

        let Some(BinValue::List { items, .. }) = entry.fields.get(&h("samplerValues")) else {
            continue;
        };

        const DIFFUSE_NAMES: [&str; 5] = [
            "diffusetexture",
            "diffuse_texture",
            "diffuse_color",
            "main_texture",
            "color_texture",
        ];

        let mut chosen: Option<MapMaterial> = None;
        let mut fuzzy: Option<MapMaterial> = None;
        let mut first_path: Option<MapMaterial> = None;
        for item in items {
            let fields = match item {
                BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => fields,
                _ => continue,
            };
            let Some(tex_path) = fields.get(&h("texturePath")).and_then(|v| index.asset_path(v))
            else {
                continue;
            };
            let material = MapMaterial {
                path: tex_path,
                address_u: get_u32(fields, "addressU").unwrap_or(0),
                address_v: get_u32(fields, "addressV").unwrap_or(0),
                tint_color: param_vec4(&entry.fields, "TintColor")
                    .map(|v| [v[0], v[1], v[2]]),
                translucent: is_translucent(&entry.fields),
                alpha_test: param_vec4(&entry.fields, "AlphaTestValue").map(|v| v[0]),
            };
            if first_path.is_none() {
                first_path = Some(material.clone());
            }
            let sampler_name = get_string(fields, "TextureName")
                .unwrap_or_default()
                .to_lowercase();
            if DIFFUSE_NAMES.contains(&sampler_name.as_str()) {
                chosen = Some(material);
                break;
            }
            if fuzzy.is_none()
                && (sampler_name.contains("diffuse")
                    || sampler_name.contains("albedo")
                    || sampler_name.contains("basecolor"))
            {
                fuzzy = Some(material);
            }
        }

        if let Some(material) = chosen.or(fuzzy).or(first_path) {
            table.insert(mat_name.clone(), material);
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
    /// The baked-light atlas this submesh's MODEL samples, lowercased, or empty.
    /// Every League map surface is lit by one of these; without it a mesh renders
    /// as flat albedo, which is what "textured in jade, flat colour here" means.
    pub lightmap: String,
    /// MapModel.layer bitmask — the AUTHORITATIVE elemental-variant encoding.
    /// Each bit = one rift variant (0x01 base, 0x02 infernal, 0x04 mountain,
    /// 0x08 ocean, 0x10 cloud, 0x20 hextech, 0x40 chemtech). 0xff = shared
    /// (visible in all variants). This is far more reliable than parsing
    /// material names, which can't classify generically-named geometry.
    pub layer: u8,
}

/// Decoded, render-ready geometry: one global vertex pool + index list, plus
/// submesh ranges. Positions/normals/uvs are flat f32; indices are u32.
#[derive(Debug, Default)]
pub struct DecodedGeometry {
    pub positions: Vec<f32>, // len = vertex_count * 3
    /// Authored normals. The terrain shader dots these against the sun direction;
    /// a model without them cannot take the lit path.
    pub normals: Vec<f32>, // len = vertex_count * 3
    pub uvs: Vec<f32>,     // len = vertex_count * 2
    /// Lightmap UVs, with each model's own `baked_light` scale and bias already
    /// applied, so the frontend uploads them as UV2 and needs no per-mesh uniform.
    pub uvs2: Vec<f32>, // len = vertex_count * 2
    pub indices: Vec<u32>,
    pub submeshes: Vec<SubmeshRange>,
    pub bbox_min: [f32; 3],
    pub bbox_max: [f32; 3],
}


/// Runtime lighting constants for one map mode, out of the `MapContainer` in the
/// sibling `*.materials.bin`. These are the uniforms `Shaders/StaticMesh/DefaultEnv_Flat`
/// reads: without them terrain renders as raw albedo, far brighter and flatter than the
/// game (Riot ships `lightMapColorScale` 2 on modern maps).
#[derive(Debug, Clone, serde::Serialize)]
pub struct MapEnv {
    /// `sunColor.rgb * SunIntensityScale`, already multiplied out.
    pub sun_color: [f32; 3],
    /// Direction TO the sun, normalized.
    pub sun_direction: [f32; 3],
    pub lightmap_scale: f32,
    pub fog_color: [f32; 3],
    pub fog_alt_color: [f32; 3],
    /// Height fog: clear at world Y `.0`, fully fogged at `.1`.
    pub fog_start_end: [f32; 2],
}

impl Default for MapEnv {
    fn default() -> Self {
        Self {
            sun_color: [1.0, 1.0, 1.0],
            sun_direction: [0.0, 1.0, 0.0],
            lightmap_scale: 1.0,
            fog_color: [1.0, 1.0, 1.0],
            fog_alt_color: [1.0, 1.0, 1.0],
            fog_start_end: [0.0, -100_000.0],
        }
    }
}

fn f32_field(fields: &IndexMap<u32, BinValue>, name: u32) -> Option<f32> {
    match fields.get(&name) {
        Some(BinValue::F32(v)) => Some(*v),
        _ => None,
    }
}

fn vec2_field(fields: &IndexMap<u32, BinValue>, name: u32) -> Option<[f32; 2]> {
    match fields.get(&name) {
        Some(BinValue::Vec2(v)) => Some(*v),
        _ => None,
    }
}

fn vec3_field(fields: &IndexMap<u32, BinValue>, name: u32) -> Option<[f32; 3]> {
    match fields.get(&name) {
        Some(BinValue::Vec3(v)) => Some(*v),
        Some(BinValue::Vec4(v)) => Some([v[0], v[1], v[2]]),
        _ => None,
    }
}

fn apply_sun_fields(env: &mut MapEnv, intensity: &mut f32, fields: &IndexMap<u32, BinValue>) {
    if let Some(v) = vec3_field(fields, h("sunColor")) {
        env.sun_color = v;
    }
    if let Some(v) = f32_field(fields, h("SunIntensityScale")) {
        *intensity = v;
    }
    if let Some(v) = vec3_field(fields, h("sunDirection")) {
        env.sun_direction = v;
    }
    if let Some(v) = f32_field(fields, h("lightMapColorScale")) {
        env.lightmap_scale = v;
    }
    if let Some(v) = vec3_field(fields, h("fogColor")) {
        env.fog_color = v;
    }
    if let Some(v) = vec3_field(fields, h("fogAlternateColor")) {
        env.fog_alt_color = v;
    }
    if let Some(v) = vec2_field(fields, h("fogStartAndEnd")) {
        env.fog_start_end = v;
    }
}

/// Parse the sun / lightmap / fog constants a map mode authors. `MapSunProperties` on
/// the `MapContainer` is the base; an Arena-style `MapLightingVolume` placed over the
/// play area overrides it, and the LARGEST such volume is the gameplay box.
pub fn read_map_env(bin: &Bin) -> MapEnv {
    let mut env = MapEnv::default();
    let mut intensity = 1.0f32;

    'container: for entry in &bin.entries {
        if entry.class_hash != h("MapContainer") {
            continue;
        }
        let Some(BinValue::List { items, .. }) = entry.fields.get(&h("components")) else {
            continue;
        };
        for comp in items {
            let BinValue::Pointer { class, fields } = comp else {
                continue;
            };
            if *class != h("MapSunProperties") {
                continue;
            }
            apply_sun_fields(&mut env, &mut intensity, fields);
            break 'container;
        }
    }

    let mut best: Option<(f32, &IndexMap<u32, BinValue>)> = None;
    for entry in &bin.entries {
        if entry.class_hash != h("MapPlaceableContainer") {
            continue;
        }
        let Some(BinValue::Map { entries, .. }) = entry.fields.get(&h("items")) else {
            continue;
        };
        for (_, v) in entries {
            let BinValue::Pointer { class, fields } = v else {
                continue;
            };
            if *class != h("MapLightingVolume") {
                continue;
            }
            if vec3_field(fields, h("sunDirection")).is_none()
                && vec3_field(fields, h("sunColor")).is_none()
            {
                continue;
            }
            let size = match fields.get(&h("transform")) {
                Some(BinValue::Mtx44(m)) => {
                    let row = |i: usize| {
                        (m[i * 4] * m[i * 4]
                            + m[i * 4 + 1] * m[i * 4 + 1]
                            + m[i * 4 + 2] * m[i * 4 + 2])
                            .sqrt()
                    };
                    row(0) * row(1) * row(2)
                }
                _ => 0.0,
            };
            if best.map(|(s, _)| size > s).unwrap_or(true) {
                best = Some((size, fields));
            }
        }
    }
    if let Some((_, fields)) = best {
        apply_sun_fields(&mut env, &mut intensity, fields);
    }

    for c in &mut env.sun_color {
        *c *= intensity;
    }
    // Authors ship unnormalized directions; the shader dots against it raw.
    let d = env.sun_direction;
    let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
    if len > 1e-6 {
        env.sun_direction = [d[0] / len, d[1] / len, d[2] / len];
    }
    env
}

/// Read one vertex attribute for every vertex of a model, as `components` floats each.
///
/// LANDMINE: a mapgeo model owns SEVERAL vertex buffers and each has its OWN layout,
/// consecutive from `vertex_description_id`. Riot routinely puts Position in the first
/// and Texcoord0 / Texcoord7 / Normal in a later one, so reading only the first buffer
/// silently yields (0, 0) UVs — a whole submesh sampling a single texel, which reads as
/// "untextured, just coloured". `read_attribute` also decodes the packed formats, which
/// a hand-rolled float-only reader skips the same way.
fn model_attribute(
    geo: &MapGeometry,
    model: &MapModel,
    name: ElementName,
    components: usize,
) -> Option<Vec<f32>> {
    let vertex_count = model.vertex_count as usize;
    let first = model.vertex_description_id as usize;
    for (slot, &buffer_id) in model.vertex_buffer_ids.iter().enumerate() {
        let Some(desc) = geo.vertex_descriptions.get(first + slot) else {
            continue;
        };
        let Some(buffer) = usize::try_from(buffer_id)
            .ok()
            .and_then(|id| geo.vertex_buffers.get(id))
        else {
            continue;
        };
        let values = match desc.read_attribute(&buffer.data, name, vertex_count) {
            Ok(Some(values)) => values,
            _ => continue,
        };
        let got = desc
            .element(name)
            .map(|(_, format)| format.component_count())
            .unwrap_or(components);
        if got == components {
            return Some(values);
        }
        let keep = got.min(components);
        let mut out = vec![0.0; vertex_count * components];
        for (i, chunk) in values.chunks_exact(got).enumerate() {
            out[i * components..i * components + keep].copy_from_slice(&chunk[..keep]);
        }
        return Some(out);
    }
    None
}

/// Decode all models of a parsed mapgeo into a single geometry pool.
pub fn decode_geometry(geo: &MapGeometry) -> Result<DecodedGeometry, String> {
    let mut out = DecodedGeometry {
        bbox_min: [f32::MAX; 3],
        bbox_max: [f32::MIN; 3],
        ..Default::default()
    };

    // One pass to size the pools. A real map runs to millions of vertices, and letting
    // four Vecs of that size grow by doubling is most of this function's cost.
    let total_verts: usize = geo.models.iter().map(|m| m.vertex_count as usize).sum();
    let total_indices: usize = geo.models.iter().map(|m| m.index_count as usize).sum();
    out.positions.reserve(total_verts * 3);
    out.normals.reserve(total_verts * 3);
    out.uvs.reserve(total_verts * 2);
    out.uvs2.reserve(total_verts * 2);
    out.indices.reserve(total_indices);
    out.submeshes
        .reserve(geo.models.iter().map(|m| m.submeshes.len()).sum());

    for model in &geo.models {
        let vertex_count = model.vertex_count as usize;
        let positions = model_attribute(geo, model, ElementName::Position, 3)
            .ok_or("model has no Position attribute")?;
        let normals = model_attribute(geo, model, ElementName::Normal, 3);
        let uvs = model_attribute(geo, model, ElementName::Texcoord0, 2);
        let lm_uvs = model_attribute(geo, model, ElementName::Texcoord7, 2);
        let ibuf = geo
            .index_buffers
            .get(model.index_buffer_id as usize)
            .ok_or("index_buffer_id out of range")?;

        // The instance matrix, applied as glam lays it out (column-major, `M * v`).
        // Identity on every model of the maps measured so far, but the file carries
        // one per model and a placed instance is free to use it.
        let m = model.transform.to_cols_array();
        let base_vertex = (out.positions.len() / 3) as u32;
        let base_index = out.indices.len() as u32;

        for v in 0..vertex_count {
            let (x, y, z) = (positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
            let p = [
                x * m[0] + y * m[4] + z * m[8] + m[12],
                x * m[1] + y * m[5] + z * m[9] + m[13],
                x * m[2] + y * m[6] + z * m[10] + m[14],
            ];
            for (i, &pi) in p.iter().enumerate() {
                out.bbox_min[i] = out.bbox_min[i].min(pi);
                out.bbox_max[i] = out.bbox_max[i].max(pi);
            }
            out.positions.extend_from_slice(&p);

            // The 3x3 alone for normals; the shader normalizes, so scale is harmless.
            let n = match &normals {
                Some(src) => {
                    let (x, y, z) = (src[v * 3], src[v * 3 + 1], src[v * 3 + 2]);
                    [
                        x * m[0] + y * m[4] + z * m[8],
                        x * m[1] + y * m[5] + z * m[9],
                        x * m[2] + y * m[6] + z * m[10],
                    ]
                }
                None => [0.0, 1.0, 0.0],
            };
            out.normals.extend_from_slice(&n);

            let uv = match &uvs {
                Some(src) => [src[v * 2], src[v * 2 + 1]],
                None => [0.0, 0.0],
            };
            out.uvs.extend_from_slice(&uv);

            // lmUV = texcoord7 * scale + offset, exactly the transform the model
            // declares. Baking it here keeps the frontend free of per-mesh uniforms.
            let lm = match &lm_uvs {
                Some(src) => [
                    src[v * 2] * model.baked_light.scale.x + model.baked_light.offset.x,
                    src[v * 2 + 1] * model.baked_light.scale.y + model.baked_light.offset.y,
                ],
                None => [0.0, 0.0],
            };
            out.uvs2.extend_from_slice(&lm);
        }

        let index_count = (model.index_count as usize).min(ibuf.indices.len());
        for &idx in &ibuf.indices[..index_count] {
            out.indices.push(base_vertex + idx as u32);
        }

        // A model missing either attribute cannot take the lit path, so it declares
        // no atlas and stays on the flat fallback.
        let lightmap = if lm_uvs.is_some() && normals.is_some() {
            model.baked_light.path.to_ascii_lowercase()
        } else {
            String::new()
        };
        for sm in &model.submeshes {
            out.submeshes.push(SubmeshRange {
                name: sm.name.clone(),
                lightmap: lightmap.clone(),
                start_vertex: base_vertex + sm.min_vertex,
                vertex_count: sm.max_vertex.saturating_sub(sm.min_vertex) + 1,
                start_index: base_index + sm.index_start,
                index_count: sm.index_count,
                layer: model.layer,
            });
        }
        // A model with no submesh list still has geometry; draw it whole rather than
        // dropping it, under its own name (which resolves to no material).
        if model.submeshes.is_empty() && index_count > 0 {
            out.submeshes.push(SubmeshRange {
                name: model.name.clone(),
                lightmap,
                start_vertex: base_vertex,
                vertex_count: vertex_count as u32,
                start_index: base_index,
                index_count: index_count as u32,
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
    /// Sun / lightmap / fog constants the terrain shader needs.
    env: MapEnv,
    bounding_box: [[f32; 3]; 2],
}

/// Parse a map project's geometry + material links and return a binary payload:
/// `[u32 meta_len][meta json][pad to 4][positions f32][uvs f32][indices u32]`.
/// Mirrors the wire format decoded by `src/lib/api/mapPreview.ts`.
#[tauri::command]
pub async fn load_map_preview(project_path: String) -> Result<tauri::ipc::Response, String> {
    let project = PathBuf::from(&project_path);
    let source = discover_map_source(&project)?;

    let started = std::time::Instant::now();
    let bytes = std::fs::read(&source.mapgeo).map_err(|e| format!("Failed to read mapgeo: {e}"))?;
    let geo =
        MapGeometry::from_bytes(&bytes).map_err(|e| format!("Failed to parse mapgeo: {:?}", e))?;
    let parsed_at = std::time::Instant::now();
    let decoded = decode_geometry(&geo)?;
    let decoded_at = std::time::Instant::now();
    let env = Bin::from_path(&source.materials)
        .map(|bin| read_map_env(&bin))
        .unwrap_or_default();
    let materials = build_material_table(&source.materials)?;

    let meta = MapPreviewMeta {
        variant: source.variant,
        vertex_count: (decoded.positions.len() / 3) as u32,
        index_count: decoded.indices.len() as u32,
        submeshes: decoded.submeshes,
        materials,
        env,
        bounding_box: [decoded.bbox_min, decoded.bbox_max],
    };

    let meta_json = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    // Sized up front: this buffer runs to tens of MB on a real map, and growing it by
    // doubling copies the whole thing about as many bytes again as it ends up holding.
    let body = (decoded.positions.len()
        + decoded.normals.len()
        + decoded.uvs.len()
        + decoded.uvs2.len()
        + decoded.indices.len())
        * 4;
    let mut out: Vec<u8> = Vec::with_capacity(8 + meta_json.len() + body);
    out.extend_from_slice(&(meta_json.len() as u32).to_le_bytes());
    out.extend_from_slice(&meta_json);
    while !out.len().is_multiple_of(4) {
        out.push(0);
    }
    for f in &decoded.positions {
        out.extend_from_slice(&f.to_le_bytes());
    }
    for f in &decoded.normals {
        out.extend_from_slice(&f.to_le_bytes());
    }
    for f in &decoded.uvs {
        out.extend_from_slice(&f.to_le_bytes());
    }
    for f in &decoded.uvs2 {
        out.extend_from_slice(&f.to_le_bytes());
    }
    for i in &decoded.indices {
        out.extend_from_slice(&i.to_le_bytes());
    }

    tracing::debug!(
        "[TIMING] map geometry: read+parse {:?}, decode {:?}, {} verts / {} tris, {:.1} MB",
        parsed_at.duration_since(started),
        decoded_at.elapsed(),
        decoded.positions.len() / 3,
        decoded.indices.len() / 3,
        out.len() as f64 / 1_048_576.0
    );
    Ok(tauri::ipc::Response::new(out))
}

// ============================================================================
// Texture batch - compressed blocks straight to the GPU
// ============================================================================

const FLAG_HAS_ALPHA: u32 = 1;

/// LANDMINE: a TEX stores its mip chain SMALLEST FIRST, so the full-resolution mip is
/// the LAST `mip_size(w, h)` bytes of the payload. That one fact is what lets this skip
/// `Texture::from_bytes` entirely, and with it `derive_mip_count`, which disagrees with
/// the file on 81 of the 3499 mipmapped block-compressed textures in the owner's
/// projects and fails those outright. Slicing from the end works on all 5983 measured:
/// every mipmapped payload holds at least one top mip, every flat one is exactly one.
fn tex_mip_layout(
    format: ritoshark::tex::TexFormat,
    w: u32,
    h: u32,
    payload: usize,
) -> Vec<(usize, usize)> {
    let top = format.mip_size(w, h);
    if payload < top {
        return Vec::new();
    }
    let mut sizes = Vec::new();
    let mut total = 0usize;
    for level in 0..16u32 {
        let size = format.mip_size((w >> level).max(1), (h >> level).max(1));
        total += size;
        sizes.push(size);
        if total == payload {
            let mut offset = payload;
            return sizes
                .iter()
                .map(|size| {
                    offset -= size;
                    (offset, *size)
                })
                .collect();
        }
        if total > payload {
            break;
        }
    }
    vec![(payload - top, top)]
}

/// The legacy DDS FourCC for a block format, or None for anything needing the DX10
/// extension. Only these go to the GPU as blocks; everything else is decoded.
fn legacy_fourcc(format: ritoshark::tex::TexFormat) -> Option<[u8; 4]> {
    use ritoshark::tex::TexFormat as F;
    match format {
        F::Bc1 | F::Bc1Alt => Some(*b"DXT1"),
        F::Bc3 => Some(*b"DXT5"),
        _ => None,
    }
}

/// Repackage a TEX's already-compressed blocks as a DDS, copying the payload verbatim.
/// No decode and no re-encode: the GPU decompresses, and the wire payload stays the
/// compressed size instead of `w * h * 4`.
fn tex_as_dds(data: &[u8]) -> Option<(Vec<u8>, bool)> {
    use ritoshark::tex::TexFormat;
    if data.len() < 12 || data[..4] != [b'T', b'E', b'X', 0] {
        return None;
    }
    let width = u16::from_le_bytes([data[4], data[5]]) as u32;
    let height = u16::from_le_bytes([data[6], data[7]]) as u32;
    let format = TexFormat::from_u8(data[9])?;
    let fourcc = legacy_fourcc(format)?;
    let payload = &data[12..];
    let mips = tex_mip_layout(format, width, height, payload.len());
    let (_, top_size) = *mips.first()?;

    let mut out = Vec::with_capacity(128 + payload.len());
    out.extend_from_slice(b"DDS ");
    let mut header = [0u32; 31];
    header[0] = 124;
    header[1] = 0x1 | 0x2 | 0x4 | 0x1000 | 0x8_0000 | if mips.len() > 1 { 0x2_0000 } else { 0 };
    header[2] = height;
    header[3] = width;
    header[4] = top_size as u32;
    header[6] = mips.len() as u32;
    header[18] = 32;
    header[19] = 0x4;
    header[20] = u32::from_le_bytes(fourcc);
    header[26] = 0x1000 | if mips.len() > 1 { 0x40_0000 | 0x8 } else { 0 };
    for word in header {
        out.extend_from_slice(&word.to_le_bytes());
    }
    for (offset, size) in &mips {
        out.extend_from_slice(&payload[*offset..*offset + *size]);
    }
    Some((out, matches!(format, TexFormat::Bc3)))
}

enum MapTexturePayload {
    Missing,
    Dds { bytes: Vec<u8>, has_alpha: bool },
    Rgba { width: u32, height: u32, bytes: Vec<u8> },
}

fn encode_map_texture(path: &Path, prefer_compressed: bool) -> MapTexturePayload {
    let Ok(data) = std::fs::read(path) else {
        return MapTexturePayload::Missing;
    };
    if prefer_compressed {
        if data.starts_with(b"DDS ") {
            return MapTexturePayload::Dds { bytes: data, has_alpha: true };
        }
        if let Some((bytes, has_alpha)) = tex_as_dds(&data) {
            return MapTexturePayload::Dds { bytes, has_alpha };
        }
    }
    match crate::commands::texture_convert::decode_full_rgba(&data) {
        Ok(rgba) => {
            let (width, height) = rgba.dimensions();
            MapTexturePayload::Rgba { width, height, bytes: rgba.into_raw() }
        }
        Err(_) => MapTexturePayload::Missing,
    }
}

/// Load every texture a map variant needs in ONE call.
///
/// Payload: `[u32 count]` then per entry, in request order:
///   kind 0 -> `[u32 0]`
///   kind 1 -> `[u32 1][u32 flags][u32 len][dds bytes]`
///   kind 2 -> `[u32 2][u32 w][u32 h][u32 flags][u32 len][rgba bytes]`
#[tauri::command]
pub async fn load_map_textures(
    project_path: String,
    texture_paths: Vec<String>,
    prefer_compressed: bool,
) -> Result<tauri::ipc::Response, String> {
    let project = PathBuf::from(&project_path);
    // ONCE for the whole batch. This used to run per texture, re-reading flint.json
    // and re-scanning every content layer for each one.
    let source = discover_map_source(&project)?;
    let bin_dir = source
        .materials
        .parent()
        .ok_or("materials bin has no parent dir")?
        .to_string_lossy()
        .to_string();

    let mut resolved: Vec<Option<PathBuf>> = Vec::with_capacity(texture_paths.len());
    for texture_path in &texture_paths {
        resolved.push(
            crate::commands::mesh::resolve_asset_path(texture_path.clone(), bin_dir.clone())
                .await
                .ok()
                .map(PathBuf::from),
        );
    }

    let started = std::time::Instant::now();
    let count = texture_paths.len();
    let out = tokio::task::spawn_blocking(move || {
        use rayon::prelude::*;
        let entries: Vec<Vec<u8>> = resolved
            .par_iter()
            .map(|path| {
                let mut entry = Vec::new();
                let payload = match path {
                    Some(path) => encode_map_texture(path, prefer_compressed),
                    None => MapTexturePayload::Missing,
                };
                match payload {
                    MapTexturePayload::Missing => entry.extend_from_slice(&0u32.to_le_bytes()),
                    MapTexturePayload::Dds { bytes, has_alpha } => {
                        entry.extend_from_slice(&1u32.to_le_bytes());
                        entry.extend_from_slice(
                            &(if has_alpha { FLAG_HAS_ALPHA } else { 0 }).to_le_bytes(),
                        );
                        entry.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                        entry.extend_from_slice(&bytes);
                    }
                    MapTexturePayload::Rgba { width, height, bytes } => {
                        entry.extend_from_slice(&2u32.to_le_bytes());
                        entry.extend_from_slice(&width.to_le_bytes());
                        entry.extend_from_slice(&height.to_le_bytes());
                        entry.extend_from_slice(&FLAG_HAS_ALPHA.to_le_bytes());
                        entry.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                        entry.extend_from_slice(&bytes);
                    }
                }
                entry
            })
            .collect();

        let mut out = Vec::with_capacity(4 + entries.iter().map(|e| e.len()).sum::<usize>());
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for entry in entries {
            out.extend_from_slice(&entry);
        }
        out
    })
    .await
    .map_err(|e| format!("texture batch panicked: {e}"))?;

    tracing::debug!(
        "[TIMING] map textures: {} in {:?}, {:.1} MB on the wire",
        count,
        started.elapsed(),
        out.len() as f64 / 1_048_576.0
    );
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

    // Keep textures at FULL resolution (2048) so painting edits/saves are 1:1
    // with the original .tex; downscaling would save painted textures at reduced res.
    const PREVIEW_MAX_DIM: u32 = 2048;
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
            br#"{ "schema": 2, "pid": "54739f0e", "kind": "map",
                  "source": { "map_id": "map11", "variant": "base_srx" },
                  "extract": {},
                  "created_at": "2026-01-01T00:00:00Z",
                  "modified_at": "2026-01-01T00:00:00Z" }"#,
        )
        .unwrap();

        let src = discover_map_source(&tmp).unwrap();
        assert_eq!(src.variant, "base_srx");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_map_id_accepts_schema_1_top_level() {
        let tmp = std::env::temp_dir().join("flint_mp_test_schema1");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("flint.json"),
            br#"{ "schema": 1, "pid": "54739f0e", "kind": "map", "map_id": "map11",
                  "created_at": "2026-01-01T00:00:00Z",
                  "modified_at": "2026-01-01T00:00:00Z" }"#,
        )
        .unwrap();

        assert_eq!(read_map_id(&tmp).unwrap(), "map11");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A TEX holds its chain smallest-first, so the top mip is the LAST slice. Getting
    /// this backwards uploads a 1x1 thumbnail as the full-size surface.
    #[test]
    fn mip_layout_puts_the_full_size_mip_first_and_covers_the_payload() {
        use ritoshark::tex::TexFormat;
        let (w, h) = (64u32, 32u32);
        let fmt = TexFormat::Bc1;
        // A whole chain: levels 0..=6 for a 64x32 surface.
        let payload: usize = (0..=6)
            .map(|l| fmt.mip_size((w >> l).max(1), (h >> l).max(1)))
            .sum();

        let mips = tex_mip_layout(fmt, w, h, payload);
        assert_eq!(mips.len(), 7);
        assert_eq!(mips[0].1, fmt.mip_size(w, h), "first slice is the top mip");
        // Descending, contiguous, and exactly filling the payload.
        let mut covered = 0usize;
        for (i, (offset, size)) in mips.iter().enumerate() {
            covered += size;
            if i > 0 {
                assert!(*size <= mips[i - 1].1, "mips descend in size");
            }
            assert!(offset + size <= payload, "slice stays in the payload");
        }
        assert_eq!(covered, payload);
        // The top mip is the tail of the file.
        assert_eq!(mips[0].0 + mips[0].1, payload);
    }

    /// The remaining `rs_tex` mip defect must not reach this path: a payload whose
    /// length matches no whole chain still has to yield a usable top mip.
    #[test]
    fn a_payload_matching_no_whole_chain_still_yields_the_top_mip() {
        use ritoshark::tex::TexFormat;
        let (w, h) = (64u32, 4u32);
        let fmt = TexFormat::Bc3;
        let top = fmt.mip_size(w, h);
        // 400 bytes is a real shape from the owner's projects that no chain explains.
        let mips = tex_mip_layout(fmt, w, h, 400);
        assert_eq!(mips.len(), 1);
        assert_eq!(mips[0].1, top);
        assert_eq!(mips[0].0 + mips[0].1, 400, "taken from the END of the payload");
    }

    #[test]
    fn tex_as_dds_writes_a_legacy_header_and_copies_the_blocks() {
        use ritoshark::tex::TexFormat;
        let (w, h) = (8u32, 8u32);
        let fmt = TexFormat::Bc3;
        let top = fmt.mip_size(w, h);

        let mut tex = vec![b'T', b'E', b'X', 0];
        tex.extend_from_slice(&(w as u16).to_le_bytes());
        tex.extend_from_slice(&(h as u16).to_le_bytes());
        tex.push(0);
        tex.push(12); // Bc3
        tex.push(0);
        tex.push(0); // no mipmaps
        let blocks: Vec<u8> = (0..top).map(|i| (i % 251) as u8).collect();
        tex.extend_from_slice(&blocks);

        let (dds, has_alpha) = tex_as_dds(&tex).expect("bc3 is a legacy fourcc");
        assert!(has_alpha, "BC3 carries alpha");
        assert_eq!(&dds[..4], b"DDS ");
        assert_eq!(u32::from_le_bytes(dds[4..8].try_into().unwrap()), 124);
        assert_eq!(u32::from_le_bytes(dds[12..16].try_into().unwrap()), h);
        assert_eq!(u32::from_le_bytes(dds[16..20].try_into().unwrap()), w);
        assert_eq!(u32::from_le_bytes(dds[28..32].try_into().unwrap()), 1, "mip count");
        assert_eq!(&dds[84..88], b"DXT5");
        // The payload is copied, not re-encoded.
        assert_eq!(dds.len(), 128 + top);
        assert_eq!(&dds[128..], &blocks[..]);
    }

    /// BC7 has no legacy FourCC, so it must fall through to the RGBA path rather than
    /// emitting a DX10 header.
    #[test]
    fn a_format_without_a_legacy_fourcc_is_refused() {
        use ritoshark::tex::TexFormat;
        assert!(legacy_fourcc(TexFormat::Bc7).is_none());
        assert!(legacy_fourcc(TexFormat::Bgra8).is_none());
        assert_eq!(legacy_fourcc(TexFormat::Bc1), Some(*b"DXT1"));
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
        sampler.insert(h("addressU"), BinValue::U32(1));
        sampler.insert(h("addressV"), BinValue::U32(2));

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
            trailing: vec![],
        };

        let tmp = std::env::temp_dir().join("flint_mp_mat.bin");
        std::fs::write(&tmp, bin.to_bytes().unwrap()).unwrap();

        let table = build_material_table(&tmp).unwrap();
        let material = table.get("Foo/Bar_MAT").expect("material in table");
        assert_eq!(material.path, "ASSETS/Maps/Foo/bar.tex");
        // Authored modes travel; they are the difference between a tiling
        // surface and a clamped one, and over half of Riot's map materials
        // bins set them.
        assert_eq!(material.address_u, 1);
        assert_eq!(material.address_v, 2);
        let _ = std::fs::remove_file(&tmp);
    }

    /// A sampler that authors no addressing means WRAP, which is enum 0.
    #[test]
    fn material_without_authored_addressing_defaults_to_wrap() {
        use ritoshark::bin::{BinEntry, BinType};
        use ritoshark::prelude::Serialize as _;

        let mut sampler = IndexMap::new();
        sampler.insert(h("TextureName"), BinValue::String("DiffuseTexture".into()));
        sampler.insert(
            h("texturePath"),
            BinValue::String("ASSETS/Maps/Foo/plain.tex".into()),
        );

        let mut fields = IndexMap::new();
        fields.insert(h("name"), BinValue::String("Plain_MAT".into()));
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
            trailing: vec![],
        };

        let tmp = std::env::temp_dir().join("flint_mp_mat_plain.bin");
        std::fs::write(&tmp, bin.to_bytes().unwrap()).unwrap();

        let table = build_material_table(&tmp).unwrap();
        let material = table.get("Plain_MAT").expect("material in table");
        assert_eq!(material.address_u, 0);
        assert_eq!(material.address_v, 0);
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
        let mut a0 = 0usize;
        let mut a255 = 0usize;
        let mut amid = 0usize;
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

    /// A mapgeo model owns several vertex buffers, each with its own layout. Reading
    /// only the first is the bug this pins: Texcoord0 and Texcoord7 live in a later
    /// buffer on most models, and losing them renders whole submeshes untextured.
    #[test]
    fn every_model_resolves_its_uvs_across_all_vertex_buffers() {
        let p = home_dir().join(
            "AppData/Roaming/Flint/projects/teasat/content/base/Map12.wad.client/data/maps/mapgeometry/map12/bilgewater.mapgeo",
        );
        if !p.exists() {
            eprintln!("skip: real mapgeo not present at {}", p.display());
            return;
        }
        let bytes = std::fs::read(&p).unwrap();
        let geo = MapGeometry::from_bytes(&bytes).unwrap();

        let mut multi_buffer = 0usize;
        let mut uv_from_later_buffer = 0usize;
        let mut no_uv = 0usize;
        for model in &geo.models {
            if model.vertex_buffer_ids.len() > 1 {
                multi_buffer += 1;
            }
            let first = model.vertex_description_id as usize;
            let in_first = geo
                .vertex_descriptions
                .get(first)
                .and_then(|d| d.element(ElementName::Texcoord0))
                .is_some();
            match model_attribute(&geo, model, ElementName::Texcoord0, 2) {
                Some(_) if !in_first => uv_from_later_buffer += 1,
                Some(_) => {}
                None => no_uv += 1,
            }
        }
        eprintln!(
            "{} models, {multi_buffer} with several vertex buffers, {uv_from_later_buffer} whose UVs live past the first, {no_uv} with none",
            geo.models.len(),
        );
        assert_eq!(no_uv, 0, "every model on a real map carries Texcoord0");

        let decoded = decode_geometry(&geo).unwrap();
        let zero_uv = decoded
            .uvs
            .chunks_exact(2)
            .filter(|uv| uv[0] == 0.0 && uv[1] == 0.0)
            .count();
        let verts = decoded.positions.len() / 3;
        assert!(
            zero_uv * 20 < verts,
            "{zero_uv} of {verts} vertices sit at UV (0,0) — attributes are being dropped"
        );
    }

    fn home_dir() -> PathBuf {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_default()
    }
}
