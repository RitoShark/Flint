//! Binary wire format for SKN/SCB mesh data sent to the frontend.
//!
//! The default JSON-tuple shape (`Vec<[f32; 3]>` etc.) was the worst IPC
//! offender in the app: a 30K-vertex SKN serialized to ~5 MB of JSON arrays
//! that the JS side then had to parse + flatten before handing to Three.js.
//! Three.js consumes raw `Float32Array` / `Uint16Array` buffers natively, so
//! we send those directly.
//!
//! Layout (all little-endian):
//!
//! ```text
//! [u32 meta_json_len]
//! [meta_json_bytes utf-8]
//! [pad to 4-byte boundary]
//! [vertex_count × 3 × f32]   positions
//! [vertex_count × 3 × f32]   normals
//! [vertex_count × 2 × f32]   uvs
//! [index_count × index_bytes] indices    // 2 bytes for SKN (u16), 4 for SCB (u32)
//! [vertex_count × 4 × f32]   bone_weights  // SKN only, when has_bones=true
//! [vertex_count × 4 × u8]    bone_indices  // SKN only, when has_bones=true
//! ```
//!
//! The metadata JSON object contains everything that isn't a big vertex
//! buffer — material ranges, textures (still base64 PNG strings, deliberately
//! kept in JSON because they're already opaque), and the section sizes the
//! decoder needs to slice the buffer.

use serde::Serialize;
use std::collections::HashMap;

use super::scb::ScbMeshData;
use super::skn::{MaterialData, MaterialRange, SknMeshData};

/// Metadata header for SKN binary payloads.
#[derive(Serialize)]
pub struct SknHeader<'a> {
    pub kind: &'static str,
    pub materials: &'a [MaterialRange],
    pub bounding_box: [[f32; 3]; 2],
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub textures: &'a HashMap<String, String>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub material_data: &'a HashMap<String, MaterialData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texture_warning: &'a Option<String>,
    pub vertex_count: u32,
    pub index_count: u32,
    pub index_bits: u8, // 16 for SKN
    pub has_bones: bool,
}

/// Metadata header for SCB binary payloads.
#[derive(Serialize)]
pub struct ScbHeader<'a> {
    pub kind: &'static str,
    pub name: &'a str,
    pub materials: &'a [String],
    pub bounding_box: [[f32; 3]; 2],
    pub material_ranges: &'a HashMap<String, (u32, u32)>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub material_data: &'a HashMap<String, MaterialData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texture_warning: &'a Option<String>,
    pub vertex_count: u32,
    pub index_count: u32,
    pub index_bits: u8, // 32 for SCB
}

fn align_to_4(buf: &mut Vec<u8>) {
    while !buf.len().is_multiple_of(4) {
        buf.push(0);
    }
}

/// Reinterpret a slice of `[T; N]` as raw bytes — safe for `Copy` POD types.
fn slice_as_bytes<T: Copy>(slice: &[T]) -> &[u8] {
    let byte_len = std::mem::size_of_val(slice);
    // SAFETY: `T: Copy` and we're just reading the same memory as `u8`.
    // Lifetime is tied to the input slice, no aliasing concerns.
    unsafe { std::slice::from_raw_parts(slice.as_ptr() as *const u8, byte_len) }
}

/// Pack an SKN mesh into the binary wire format documented above.
pub fn encode_skn_binary(mesh: &SknMeshData) -> Result<Vec<u8>, String> {
    let vertex_count = mesh.positions.len() as u32;
    let index_count = mesh.indices.len() as u32;
    let has_bones = !mesh.bone_weights.is_empty() && !mesh.bone_indices.is_empty();

    // Sanity: all per-vertex buffers should agree on length, otherwise the JS
    // decoder will read garbage. Drop the optional ones if they don't match;
    // the renderer treats them as "no skinning" which matches existing UX for
    // non-skinned SKNs.
    let bones_ok = has_bones
        && mesh.bone_weights.len() as u32 == vertex_count
        && mesh.bone_indices.len() as u32 == vertex_count;

    let header = SknHeader {
        kind: "skn",
        materials: &mesh.materials,
        bounding_box: mesh.bounding_box,
        textures: &mesh.textures,
        material_data: &mesh.material_data,
        texture_warning: &mesh.texture_warning,
        vertex_count,
        index_count,
        index_bits: 16,
        has_bones: bones_ok,
    };
    let meta = serde_json::to_vec(&header).map_err(|e| format!("SKN meta serialize: {e}"))?;

    // Capacity pre-calc keeps allocations to one. Off-by-a-few from the pad
    // is fine — Vec::reserve_exact takes the hit anyway.
    let pos_bytes = (vertex_count as usize) * 12;
    let nrm_bytes = pos_bytes;
    let uv_bytes = (vertex_count as usize) * 8;
    let idx_bytes = (index_count as usize) * 2;
    let bw_bytes = if bones_ok { (vertex_count as usize) * 16 } else { 0 };
    let bi_bytes = if bones_ok { (vertex_count as usize) * 4 } else { 0 };
    let cap = 4 + meta.len() + 3 + pos_bytes + nrm_bytes + uv_bytes + idx_bytes + bw_bytes + bi_bytes;
    let mut buf: Vec<u8> = Vec::with_capacity(cap);

    buf.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    buf.extend_from_slice(&meta);
    align_to_4(&mut buf);

    buf.extend_from_slice(slice_as_bytes(&mesh.positions));
    buf.extend_from_slice(slice_as_bytes(&mesh.normals));
    buf.extend_from_slice(slice_as_bytes(&mesh.uvs));
    buf.extend_from_slice(slice_as_bytes(&mesh.indices));

    if bones_ok {
        buf.extend_from_slice(slice_as_bytes(&mesh.bone_weights));
        buf.extend_from_slice(slice_as_bytes(&mesh.bone_indices));
    }

    Ok(buf)
}

/// Pack an SCB mesh into the binary wire format documented above.
pub fn encode_scb_binary(mesh: &ScbMeshData) -> Result<Vec<u8>, String> {
    let vertex_count = mesh.positions.len() as u32;
    let index_count = mesh.indices.len() as u32;

    let header = ScbHeader {
        kind: "scb",
        name: &mesh.name,
        materials: &mesh.materials,
        bounding_box: mesh.bounding_box,
        material_ranges: &mesh.material_ranges,
        material_data: &mesh.material_data,
        texture_warning: &mesh.texture_warning,
        vertex_count,
        index_count,
        index_bits: 32,
    };
    let meta = serde_json::to_vec(&header).map_err(|e| format!("SCB meta serialize: {e}"))?;

    let pos_bytes = (vertex_count as usize) * 12;
    let nrm_bytes = pos_bytes;
    let uv_bytes = (vertex_count as usize) * 8;
    let idx_bytes = (index_count as usize) * 4;
    let cap = 4 + meta.len() + 3 + pos_bytes + nrm_bytes + uv_bytes + idx_bytes;
    let mut buf: Vec<u8> = Vec::with_capacity(cap);

    buf.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    buf.extend_from_slice(&meta);
    align_to_4(&mut buf);

    buf.extend_from_slice(slice_as_bytes(&mesh.positions));
    buf.extend_from_slice(slice_as_bytes(&mesh.normals));
    buf.extend_from_slice(slice_as_bytes(&mesh.uvs));
    buf.extend_from_slice(slice_as_bytes(&mesh.indices));

    Ok(buf)
}
