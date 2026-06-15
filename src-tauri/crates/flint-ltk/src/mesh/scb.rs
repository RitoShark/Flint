//! SCB/SCO (Static Mesh) parsing
//!
//! Uses RitoShark's `rs_mesh` crate for parsing SCB (binary) and SCO (ASCII) files.

use std::io::Cursor;
use std::path::Path;

use ritoshark::math::Vec3;
use ritoshark::mesh::StaticMesh;
use serde::Serialize;

use std::collections::HashMap;

#[derive(Debug, Serialize)]
pub struct ScbMeshData {
    pub name: String,
    pub materials: Vec<String>,
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub uvs: Vec<[f32; 2]>,
    pub indices: Vec<u32>,
    /// [min, max] where each is [x, y, z]
    pub bounding_box: [[f32; 3]; 2],
    /// material_name -> (start_index, index_count)
    pub material_ranges: HashMap<String, (u32, u32)>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub material_data: HashMap<String, super::skn::MaterialData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texture_warning: Option<String>,
}

pub fn parse_scb_file<P: AsRef<Path>>(path: P) -> anyhow::Result<ScbMeshData> {
    let path_ref = path.as_ref();
    let data = std::fs::read(path_ref)?;

    let is_ascii = path_ref.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("sco"))
        .unwrap_or(false);

    let mesh = if is_ascii {
        tracing::debug!("Parsing SCO (ASCII) file: {}", path_ref.display());
        let text = std::str::from_utf8(&data)
            .map_err(|e| anyhow::anyhow!("SCO file is not valid UTF-8: {:?}", e))?;
        StaticMesh::from_sco_str(text)
            .map_err(|e| anyhow::anyhow!("Failed to parse SCO file: {:?}", e))?
    } else {
        tracing::debug!("Parsing SCB (binary) file: {}", path_ref.display());
        let mut reader = Cursor::new(&data);
        StaticMesh::from_scb_reader(&mut reader)
            .map_err(|e| anyhow::anyhow!("Failed to parse SCB file: {:?}", e))?
    };

    tracing::debug!("Static mesh parsed: {} vertices, {} faces", mesh.positions().len(), mesh.faces().len());

    /* mirrorX (negate X) to convert League's left-handed coords to Babylon's
       right-handed, matching skn.rs; buildSknMeshes does NOT swap winding. */
    let vertices: Vec<Vec3> = mesh
        .positions()
        .iter()
        .map(|v| Vec3::new(-v.x, v.y, v.z))
        .collect();
    let faces = mesh.faces();

    // Non-indexed geometry since each face has unique UVs.
    let mut positions: Vec<[f32; 3]> = Vec::new();
    let mut normals: Vec<[f32; 3]> = Vec::new();
    let mut uvs: Vec<[f32; 2]> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut materials: Vec<String> = Vec::new();
    let mut material_ranges: HashMap<String, (u32, u32)> = HashMap::new();

    let mut current_material: Option<String> = None;
    let mut material_start_idx: u32 = 0;

    let mut min = Vec3::splat(f32::MAX);
    let mut max = Vec3::splat(f32::MIN);

    for v in &vertices {
        min = min.min(*v);
        max = max.max(*v);
    }

    /* An empty mesh leaves min/max inverted; collapse to a zero box so the
       frontend camera framing never sees a negative/NaN span. */
    if vertices.is_empty() {
        min = Vec3::ZERO;
        max = Vec3::ZERO;
    }

    for face in faces {
        let v0_idx = face.indices[0] as usize;
        let v1_idx = face.indices[1] as usize;
        let v2_idx = face.indices[2] as usize;

        let v0 = vertices.get(v0_idx).copied().unwrap_or(Vec3::ZERO);
        let v1 = vertices.get(v1_idx).copied().unwrap_or(Vec3::ZERO);
        let v2 = vertices.get(v2_idx).copied().unwrap_or(Vec3::ZERO);

        let edge1 = v1 - v0;
        let edge2 = v2 - v0;
        let normal = edge1.cross(edge2).normalize_or_zero();
        let normal_arr = [normal.x, normal.y, normal.z];

        /* rs_mesh yields an empty material name for unnamed SCB materials; the
           frontend keys visibility on the name, so default to a stable non-empty
           string. */
        let face_material = {
            let m = face.material.clone();
            if m.is_empty() { "Mesh".to_string() } else { m }
        };
        if current_material.as_ref() != Some(&face_material) {
            if let Some(mat) = current_material.take() {
                let end_idx = indices.len() as u32;
                material_ranges.insert(mat, (material_start_idx, end_idx - material_start_idx));
            }

            if !materials.contains(&face_material) {
                materials.push(face_material.clone());
            }
            current_material = Some(face_material);
            material_start_idx = indices.len() as u32;
        }

        let base_idx = positions.len() as u32;

        positions.push([v0.x, v0.y, v0.z]);
        positions.push([v1.x, v1.y, v1.z]);
        positions.push([v2.x, v2.y, v2.z]);

        normals.push(normal_arr);
        normals.push(normal_arr);
        normals.push(normal_arr);

        uvs.push([face.uvs[0].x, face.uvs[0].y]);
        uvs.push([face.uvs[1].x, face.uvs[1].y]);
        uvs.push([face.uvs[2].x, face.uvs[2].y]);

        indices.push(base_idx);
        indices.push(base_idx + 1);
        indices.push(base_idx + 2);
    }

    if let Some(mat) = current_material {
        let end_idx = indices.len() as u32;
        material_ranges.insert(mat, (material_start_idx, end_idx - material_start_idx));
    }

    let bounding_box = [
        [min.x, min.y, min.z],
        [max.x, max.y, max.z],
    ];

    Ok(ScbMeshData {
        name: mesh.name().to_string(),
        materials,
        positions,
        normals,
        uvs,
        indices,
        bounding_box,
        material_ranges,
        material_data: HashMap::new(),
        texture_warning: None,
    })
}
