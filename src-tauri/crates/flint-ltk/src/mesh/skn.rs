//! SKN (Simple Skin) mesh parsing
//!
//! Parses League of Legends skinned mesh files (.skn) and extracts:
//! - Vertex positions, normals, and UVs
//! - Index buffer for triangles
//! - Material ranges for per-material visibility control
//! - Bone weights and indices for skeletal animation skinning

use std::path::Path;

use ritoshark::mesh::{SkinnedMesh, SkinnedMeshRange};
use ritoshark::prelude::Parse; // brings `SkinnedMesh::from_bytes`
use serde::Serialize;

use std::collections::HashMap;

/// Material range data for frontend consumption
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

/// Material data including texture and UV parameters for frontend consumption
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
    /// Current flipbook frame index
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flipbook_frame: Option<f32>,
}

/// Complete mesh data serializable to JSON for frontend
#[derive(Debug, Serialize)]
pub struct SknMeshData {
    /// Material ranges for visibility control
    pub materials: Vec<MaterialRange>,
    /// Vertex positions as [x, y, z] arrays
    pub positions: Vec<[f32; 3]>,
    /// Vertex normals as [x, y, z] arrays
    pub normals: Vec<[f32; 3]>,
    /// Texture coordinates as [u, v] arrays
    pub uvs: Vec<[f32; 2]>,
    /// Triangle indices
    pub indices: Vec<u16>,
    /// Bounding box as [min, max] where each is [x, y, z]
    pub bounding_box: [[f32; 3]; 2],
    /// Per-submesh textures as base64 PNG data (DEPRECATED - use material_data)
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub textures: HashMap<String, String>,
    /// Per-material data including textures AND UV transform parameters
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub material_data: HashMap<String, MaterialData>,
    /// Bone weights for skinning - 4 weights per vertex [w0, w1, w2, w3]
    /// Weights should sum to 1.0 for proper skinning
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bone_weights: Vec<[f32; 4]>,
    /// Bone indices for skinning - 4 bone indices per vertex [i0, i1, i2, i3]
    /// Each index refers to a bone in the skeleton
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bone_indices: Vec<[u8; 4]>,
    /// Texture loading warning message (e.g., ".ritobin cache not found")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texture_warning: Option<String>,
}


/// Parse an SKN file and extract mesh data for 3D rendering
pub fn parse_skn_file<P: AsRef<Path>>(path: P) -> anyhow::Result<SknMeshData> {
    let data = std::fs::read(path.as_ref())?;

    let mesh = SkinnedMesh::from_bytes(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse SKN file: {:?}", e))?;

    // Extract materials (per-material spans into the shared vertex/index buffers)
    let materials: Vec<MaterialRange> = mesh.ranges()
        .iter()
        .map(MaterialRange::from)
        .collect();

    // RitoShark exposes a single `Vec<SkinnedMeshVertex>` rather than LTK's typed
    // accessor buffer; read the attributes straight off each vertex.
    //
    // Apply mirrorX transformation: negate X to convert from League's left-hand
    // coordinate system. Normals negate Y and Z. UVs are kept raw (top-left
    // origin, confirmed by ltmao's uvee.py).
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

    // SKN index buffer is u16.
    let indices: Vec<u16> = mesh.indices().to_vec();

    // Get bounding box
    let aabb = mesh.bounding_box;
    let bounding_box = [
        [aabb.min.x, aabb.min.y, aabb.min.z],
        [aabb.max.x, aabb.max.y, aabb.max.z],
    ];

    // Extract bone weights for skinning - 4 influences per vertex.
    let bone_weights: Vec<[f32; 4]> = vertices
        .iter()
        .map(|v| v.blend_weights)
        .collect();

    // Extract bone indices for skinning - 4 bone indices per vertex.
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
        textures: HashMap::new(), // DEPRECATED - use material_data
        material_data: HashMap::new(), // Material data loaded separately by command
        bone_weights,
        bone_indices,
        texture_warning: None, // Set by command if texture discovery fails
    })
}

// TODO: Add SKL (Skeleton) parsing once the skeleton reader is wired in here.
// This would add:
// - Bone hierarchy (parent-child relationships)
// - Bone transforms (position, rotation, scale)
// - Vertex bone weights and indices
//
// The skeleton would be rendered as lines connecting bone positions,
// overlaid on the mesh preview.
