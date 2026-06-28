//! SKN (Simple Skin) mesh parsing.

use std::path::Path;

use ritoshark::mesh::{SkinnedMesh, SkinnedMeshRange};
use ritoshark::prelude::Parse;
use serde::Serialize;

use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
pub struct MaterialRange {
    pub name: String,
    pub start_index: i32,
    pub index_count: i32,
    pub start_vertex: i32,
    pub vertex_count: i32,
}

impl From<&SkinnedMeshRange> for MaterialRange {
    fn from(range: &SkinnedMeshRange) -> Self {
        Self {
            name: range.name.clone(),
            start_index: range.index_start as i32,
            index_count: range.index_count as i32,
            start_vertex: range.vertex_start as i32,
            vertex_count: range.vertex_count as i32,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MaterialData {
    /// Base64-encoded PNG texture data
    pub texture: String,
    /// UV scale (tiling) - [scaleU, scaleV]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uv_scale: Option<[f32; 2]>,
    /// UV offset (shift) - [offsetU, offsetV]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uv_offset: Option<[f32; 2]>,
    /// Flipbook texture atlas size - [columns, rows]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flipbook_size: Option<[u32; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flipbook_frame: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct SknMeshData {
    pub materials: Vec<MaterialRange>,
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub uvs: Vec<[f32; 2]>,
    pub indices: Vec<u16>,
    /// [min, max] where each is [x, y, z]
    pub bounding_box: [[f32; 3]; 2],
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub textures: HashMap<String, String>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub material_data: HashMap<String, MaterialData>,
    /// 4 weights per vertex [w0, w1, w2, w3], summing to 1.0.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bone_weights: Vec<[f32; 4]>,
    /// 4 bone indices per vertex [i0, i1, i2, i3] into the skeleton.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bone_indices: Vec<[u8; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texture_warning: Option<String>,
}


pub fn parse_skn_file<P: AsRef<Path>>(path: P) -> anyhow::Result<SknMeshData> {
    let data = std::fs::read(path.as_ref())?;

    let mesh = SkinnedMesh::from_bytes(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse SKN file: {:?}", e))?;

    let materials: Vec<MaterialRange> = mesh.ranges()
        .iter()
        .map(MaterialRange::from)
        .collect();

    /* mirrorX: negate X (League's left-hand coords); normals negate Y and Z;
       UVs kept raw (top-left origin). */
    let vertices = mesh.vertices();

    let positions: Vec<[f32; 3]> = vertices
        .iter()
        .map(|v| [-v.position.x, v.position.y, v.position.z])
        .collect();

    let normals: Vec<[f32; 3]> = vertices
        .iter()
        .map(|v| [v.normal.x, -v.normal.y, -v.normal.z])
        .collect();

    let uvs: Vec<[f32; 2]> = vertices
        .iter()
        .map(|v| [v.uv.x, v.uv.y])
        .collect();

    let indices: Vec<u16> = mesh.indices().to_vec();

    /* Recompute the AABB from the TRANSFORMED positions (X negated above) rather
       than trusting `mesh.bounding_box`. The stored box is in League's
       un-mirrored space, so reusing it puts the camera target on the wrong side
       of the mesh; worse, Blender-exported SKNs (e.g. via the Aventurine tool)
       frequently carry a zeroed/garbage box, which collapses camera framing so
       you can't zoom or pan out. Mirrors scb.rs. */
    let mut bb_min = [f32::MAX; 3];
    let mut bb_max = [f32::MIN; 3];
    for p in &positions {
        for i in 0..3 {
            if p[i] < bb_min[i] {
                bb_min[i] = p[i];
            }
            if p[i] > bb_max[i] {
                bb_max[i] = p[i];
            }
        }
    }
    if positions.is_empty() {
        bb_min = [0.0; 3];
        bb_max = [0.0; 3];
    }
    let bounding_box = [bb_min, bb_max];

    let bone_weights: Vec<[f32; 4]> = vertices
        .iter()
        .map(|v| v.blend_weights)
        .collect();

    let bone_indices: Vec<[u8; 4]> = vertices
        .iter()
        .map(|v| v.blend_indices)
        .collect();

    Ok(SknMeshData {
        materials,
        positions,
        normals,
        uvs,
        indices,
        bounding_box,
        textures: HashMap::new(),
        material_data: HashMap::new(),
        bone_weights,
        bone_indices,
        texture_warning: None,
    })
}
