//! In-memory edit ops for a `.skn` (and its sibling `.skl`).
//!
//! The session model mirrors `commands/wad/wad_edit.rs`: the parsed source is kept
//! pristine and never mutated, edits are staged as an op log, and every derived
//! state is a fresh fold of the whole log over the pristine parse. Undo/redo is a
//! cursor into the log, not an inverse-op stack — so there is no inverse to get
//! wrong and no drift after a long editing session.

use ritoshark::anim::Skeleton;
use ritoshark::math::{Aabb, Sphere, Vec3};
use ritoshark::mesh::{SkinnedMesh, SkinnedMeshRange, SkinnedMeshVertex};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// SKN indices are `u16`, so the merged vertex buffer can never exceed this.
pub const MAX_VERTICES: usize = u16::MAX as usize + 1;
/// `SkinnedMeshVertex::blend_indices` are `u8`, so the influence table caps here.
pub const MAX_INFLUENCES: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ModelEdit {
    #[serde(rename_all = "camelCase")]
    RenameSubmesh { index: usize, name: String },
    #[serde(rename_all = "camelCase")]
    DuplicateSubmesh { index: usize, name: String },
    #[serde(rename_all = "camelCase")]
    DeleteSubmesh { index: usize },
    #[serde(rename_all = "camelCase")]
    ReorderSubmesh { from: usize, to: usize },
    #[serde(rename_all = "camelCase")]
    PasteSubmesh {
        source_skn: PathBuf,
        source_index: usize,
        name: String,
    },
}

/// The result of folding an op log over the pristine parse.
#[derive(Debug)]
pub struct Derived {
    pub mesh: SkinnedMesh,
    pub skeleton: Option<Skeleton>,
    /// True when an op appended to `skeleton.influences`, meaning the `.skl`
    /// must be written alongside the `.skn`.
    pub skeleton_dirty: bool,
}

/// Fold `ops` over a clone of `pristine`. Every derived state is a fresh fold —
/// callers never mutate the pristine parse.
pub fn apply_ops(
    pristine: &SkinnedMesh,
    skeleton: Option<&Skeleton>,
    ops: &[ModelEdit],
) -> Result<Derived, String> {
    let mut mesh = pristine.clone();
    let mut skel = skeleton.cloned();
    let mut skeleton_dirty = false;

    for op in ops {
        match op {
            ModelEdit::RenameSubmesh { index, name } => rename_submesh(&mut mesh, *index, name)?,
            ModelEdit::DeleteSubmesh { index } => delete_submesh(&mut mesh, *index)?,
            ModelEdit::DuplicateSubmesh { index, name } => {
                duplicate_submesh(&mut mesh, *index, name)?
            }
            ModelEdit::ReorderSubmesh { .. } | ModelEdit::PasteSubmesh { .. } => {
                return Err("op not implemented yet".to_string())
            }
        }
    }

    let _ = (&mut skel, &mut skeleton_dirty);
    Ok(Derived { mesh, skeleton: skel, skeleton_dirty })
}

fn check_index(mesh: &SkinnedMesh, index: usize) -> Result<(), String> {
    if index >= mesh.ranges.len() {
        return Err(format!(
            "submesh index {index} out of range (mesh has {} submeshes)",
            mesh.ranges.len()
        ));
    }
    Ok(())
}

/// Reject a name that is blank or already taken by a *different* range.
/// Submesh names are the key the skin BIN references geometry by, so a
/// collision silently makes one of the two unreachable.
fn check_name(mesh: &SkinnedMesh, name: &str, allow_index: Option<usize>) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("submesh name cannot be empty".to_string());
    }
    for (i, range) in mesh.ranges.iter().enumerate() {
        if Some(i) == allow_index {
            continue;
        }
        if range.name.eq_ignore_ascii_case(name) {
            return Err(format!("a submesh named \"{name}\" already exists"));
        }
    }
    Ok(())
}

fn rename_submesh(mesh: &mut SkinnedMesh, index: usize, name: &str) -> Result<(), String> {
    check_index(mesh, index)?;
    check_name(mesh, name, Some(index))?;
    mesh.ranges[index].name = name.to_string();
    Ok(())
}

/// Recompute the AABB and bounding sphere over the current vertex buffer.
/// Any op that adds or removes vertices must call this — a stale box breaks
/// camera framing and the game's culling alike.
fn recompute_bounds(mesh: &mut SkinnedMesh) {
    if mesh.vertices.is_empty() {
        mesh.bounding_box = Aabb::new(Vec3::ZERO, Vec3::ZERO);
        mesh.bounding_sphere = Sphere::new(Vec3::ZERO, 0.0);
        return;
    }
    let mut min = Vec3::splat(f32::MAX);
    let mut max = Vec3::splat(f32::MIN);
    for v in &mesh.vertices {
        min = min.min(v.position);
        max = max.max(v.position);
    }
    mesh.bounding_box = Aabb::new(min, max);
    let center = (min + max) * 0.5;
    let radius = mesh
        .vertices
        .iter()
        .map(|v| (v.position - center).length())
        .fold(0.0f32, f32::max);
    mesh.bounding_sphere = Sphere::new(center, radius);
}

fn delete_submesh(mesh: &mut SkinnedMesh, index: usize) -> Result<(), String> {
    check_index(mesh, index)?;
    if mesh.ranges.len() == 1 {
        return Err("cannot delete the last submesh — a .skn needs at least one".to_string());
    }

    let range = mesh.ranges[index].clone();
    let v_start = range.vertex_start as usize;
    let v_count = range.vertex_count as usize;
    let i_start = range.index_start as usize;
    let i_count = range.index_count as usize;

    mesh.vertices.drain(v_start..v_start + v_count);
    mesh.indices.drain(i_start..i_start + i_count);
    mesh.ranges.remove(index);

    // Index VALUES are global vertex indices; every survivor above the removed
    // span slides down. Survivors never point into the removed span, because a
    // range's triangles only reference its own vertices.
    let shift = range.vertex_count as u16;
    for idx in &mut mesh.indices {
        if *idx >= range.vertex_start as u16 {
            *idx -= shift;
        }
    }

    for r in &mut mesh.ranges {
        if r.vertex_start > range.vertex_start {
            r.vertex_start -= range.vertex_count;
        }
        if r.index_start > range.index_start {
            r.index_start -= range.index_count;
        }
    }

    recompute_bounds(mesh);
    Ok(())
}

fn duplicate_submesh(mesh: &mut SkinnedMesh, index: usize, name: &str) -> Result<(), String> {
    check_index(mesh, index)?;
    check_name(mesh, name, None)?;

    let range = mesh.ranges[index].clone();
    let v_start = range.vertex_start as usize;
    let v_count = range.vertex_count as usize;
    let i_start = range.index_start as usize;
    let i_count = range.index_count as usize;

    let new_v_start = mesh.vertices.len();
    if new_v_start + v_count > MAX_VERTICES {
        return Err(format!(
            "duplicating \"{}\" would need {} vertices; a .skn stores u16 indices so it cannot exceed 65535",
            range.name,
            new_v_start + v_count
        ));
    }

    let copied: Vec<SkinnedMeshVertex> = mesh.vertices[v_start..v_start + v_count].to_vec();
    mesh.vertices.extend(copied);

    let new_i_start = mesh.indices.len();
    let rebased: Vec<u16> = mesh.indices[i_start..i_start + i_count]
        .iter()
        .map(|idx| idx - range.vertex_start as u16 + new_v_start as u16)
        .collect();
    mesh.indices.extend(rebased);

    mesh.ranges.push(SkinnedMeshRange::new(
        name,
        new_v_start as u32,
        v_count as u32,
        new_i_start as u32,
        i_count as u32,
    ));

    recompute_bounds(mesh);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ritoshark::mesh::SkinnedMeshVertexType;
    use ritoshark::prelude::{Parse, Serialize as RsSerialize};

    /// A 2-range mesh: range "Body" owns vertices 0..3 / indices 0..3, range
    /// "Cape" owns vertices 3..6 / indices 3..6. Indices are GLOBAL vertex
    /// indices, matching what the game and `meshBuilder.ts` expect.
    pub(super) fn fixture() -> SkinnedMesh {
        let vert = |x: f32, bone: u8| SkinnedMeshVertex {
            position: Vec3::new(x, 0.0, 0.0),
            blend_indices: [bone, 0, 0, 0],
            blend_weights: [1.0, 0.0, 0.0, 0.0],
            normal: Vec3::new(0.0, 1.0, 0.0),
            uv: ritoshark::math::Vec2::new(0.0, 0.0),
            color: None,
            tangent: None,
        };
        SkinnedMesh {
            major: 4,
            minor: 1,
            flags: 0,
            vertex_type: SkinnedMeshVertexType::Basic,
            bounding_box: Aabb::new(Vec3::new(0.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 0.0)),
            bounding_sphere: Sphere::new(Vec3::new(2.5, 0.0, 0.0), 2.5),
            ranges: vec![
                SkinnedMeshRange::new("Body", 0, 3, 0, 3),
                SkinnedMeshRange::new("Cape", 3, 3, 3, 3),
            ],
            indices: vec![0, 1, 2, 3, 4, 5],
            vertices: (0..6).map(|i| vert(i as f32, (i % 2) as u8)).collect(),
            trailing: vec![0u8; 12],
        }
    }

    #[test]
    fn empty_op_log_round_trips_byte_identically() {
        let mesh = fixture();
        let original = mesh.to_bytes().expect("fixture serializes");

        let derived = apply_ops(&mesh, None, &[]).expect("empty fold succeeds");
        let written = derived.mesh.to_bytes().expect("derived serializes");

        assert_eq!(original, written, "a zero-op fold must be byte-identical");
        // And it must still parse.
        SkinnedMesh::from_bytes(&written).expect("derived output re-parses");
    }

    #[test]
    fn rename_changes_only_the_named_range() {
        let mesh = fixture();
        let derived = apply_ops(
            &mesh,
            None,
            &[ModelEdit::RenameSubmesh { index: 1, name: "Wings".into() }],
        )
        .expect("rename succeeds");

        assert_eq!(derived.mesh.ranges[0].name, "Body");
        assert_eq!(derived.mesh.ranges[1].name, "Wings");
        assert_eq!(derived.mesh.vertices, mesh.vertices, "geometry untouched");
        assert_eq!(derived.mesh.indices, mesh.indices, "indices untouched");
        assert!(!derived.skeleton_dirty);
    }

    #[test]
    fn rename_out_of_range_is_an_error() {
        let mesh = fixture();
        let err = apply_ops(
            &mesh,
            None,
            &[ModelEdit::RenameSubmesh { index: 9, name: "Nope".into() }],
        )
        .expect_err("index 9 does not exist");
        assert!(err.contains("index 9"), "error names the bad index: {err}");
    }

    #[test]
    fn rename_to_a_duplicate_name_is_an_error() {
        let mesh = fixture();
        let err = apply_ops(
            &mesh,
            None,
            &[ModelEdit::RenameSubmesh { index: 1, name: "Body".into() }],
        )
        .expect_err("duplicate names are rejected");
        assert!(err.contains("Body"), "error names the collision: {err}");
    }

    #[test]
    fn rename_to_a_duplicate_name_differing_only_in_case_is_an_error() {
        let mesh = fixture();
        let err = apply_ops(
            &mesh,
            None,
            &[ModelEdit::RenameSubmesh { index: 1, name: "BODY".into() }],
        )
        .expect_err("case-insensitive duplicate names are rejected");
        assert!(err.contains("BODY"), "error names the collision: {err}");
    }

    #[test]
    fn rename_to_an_empty_name_is_an_error() {
        let mesh = fixture();
        let err = apply_ops(
            &mesh,
            None,
            &[ModelEdit::RenameSubmesh { index: 0, name: "  ".into() }],
        )
        .expect_err("blank names are rejected");
        assert!(err.to_lowercase().contains("empty"), "error explains why: {err}");
    }

    #[test]
    fn delete_compacts_buffers_and_reindexes_survivors() {
        let mesh = fixture();
        let derived = apply_ops(&mesh, None, &[ModelEdit::DeleteSubmesh { index: 0 }])
            .expect("delete succeeds");
        let out = derived.mesh;

        assert_eq!(out.ranges.len(), 1);
        assert_eq!(out.ranges[0].name, "Cape");
        // "Cape" moves to the front of both buffers.
        assert_eq!(out.ranges[0].vertex_start, 0);
        assert_eq!(out.ranges[0].index_start, 0);
        assert_eq!(out.vertices.len(), 3);
        // Global index values shift down by the 3 removed vertices.
        assert_eq!(out.indices, vec![0, 1, 2]);
        // And the result is a valid file.
        let bytes = {
            use ritoshark::prelude::Serialize as RsSerialize;
            out.to_bytes().expect("serializes")
        };
        SkinnedMesh::from_bytes(&bytes).expect("re-parses");
    }

    #[test]
    fn delete_recomputes_bounds_from_surviving_vertices() {
        let mesh = fixture();
        let derived = apply_ops(&mesh, None, &[ModelEdit::DeleteSubmesh { index: 0 }])
            .expect("delete succeeds");
        // Surviving vertices are x = 3, 4, 5.
        assert_eq!(derived.mesh.bounding_box.min.x, 3.0);
        assert_eq!(derived.mesh.bounding_box.max.x, 5.0);
    }

    #[test]
    fn delete_last_submesh_is_an_error() {
        let mut mesh = fixture();
        mesh.ranges.truncate(1);
        mesh.vertices.truncate(3);
        mesh.indices.truncate(3);
        let err = apply_ops(&mesh, None, &[ModelEdit::DeleteSubmesh { index: 0 }])
            .expect_err("cannot delete the only submesh");
        assert!(err.to_lowercase().contains("last"), "error explains why: {err}");
    }

    #[test]
    fn duplicate_appends_a_rebased_copy() {
        let mesh = fixture();
        let derived = apply_ops(
            &mesh,
            None,
            &[ModelEdit::DuplicateSubmesh { index: 0, name: "Body_copy".into() }],
        )
        .expect("duplicate succeeds");
        let out = derived.mesh;

        assert_eq!(out.ranges.len(), 3);
        let copy = &out.ranges[2];
        assert_eq!(copy.name, "Body_copy");
        assert_eq!(copy.vertex_start, 6);
        assert_eq!(copy.vertex_count, 3);
        assert_eq!(copy.index_start, 6);
        assert_eq!(copy.index_count, 3);
        assert_eq!(out.vertices.len(), 9);
        // The copy's indices point at the copy's own vertices, not the original's.
        assert_eq!(&out.indices[6..9], &[6, 7, 8]);
        // Original ranges are untouched.
        assert_eq!(out.ranges[0].vertex_start, 0);
        assert_eq!(out.ranges[1].vertex_start, 3);
    }

    #[test]
    fn duplicate_past_the_u16_index_limit_is_rejected() {
        let mut mesh = fixture();
        // Grow "Body" so a duplicate would cross 65_536 vertices.
        let filler = mesh.vertices[0];
        mesh.vertices = vec![filler; 40_000];
        mesh.indices = (0..40_000u32).map(|i| i as u16).collect();
        mesh.ranges = vec![SkinnedMeshRange::new("Body", 0, 40_000, 0, 40_000)];

        let err = apply_ops(
            &mesh,
            None,
            &[ModelEdit::DuplicateSubmesh { index: 0, name: "Body_copy".into() }],
        )
        .expect_err("80k vertices exceeds the u16 index space");
        assert!(err.contains("65535") || err.contains("65,535"), "error cites the limit: {err}");
    }
}
