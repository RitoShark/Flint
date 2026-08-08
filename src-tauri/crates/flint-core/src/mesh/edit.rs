use ritoshark::anim::Skeleton;
use ritoshark::math::{Aabb, Sphere, Vec3};
use ritoshark::mesh::{SkinnedMesh, SkinnedMeshRange, SkinnedMeshVertex};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// SKN indices are u16 (65,535 cap).
pub const MAX_VERTICES: usize = u16::MAX as usize + 1;
// blend_indices are u8 (256 influence cap).
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
    #[serde(rename_all = "camelCase")]
    RenameJoint { index: usize, name: String },
    #[serde(rename_all = "camelCase")]
    PaintWeights { entries: Vec<WeightEntry> },
}

// Carries joint IDS, not influence-table slots: a slot number is only meaningful against one
// version of the .skl, and painting can append influences mid-log.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeightEntry {
    pub vertex: u32,
    pub joints: Vec<u16>,
    pub weights: Vec<f32>,
}

#[derive(Debug)]
pub struct Derived {
    pub mesh: SkinnedMesh,
    pub skeleton: Option<Skeleton>,
    pub skeleton_dirty: bool,
}

pub fn apply_ops(
    pristine: &SkinnedMesh,
    skeleton: Option<&Skeleton>,
    ops: &[ModelEdit],
    resolve: &dyn Fn(&Path) -> Result<PasteSource, String>,
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
            ModelEdit::ReorderSubmesh { from, to } => reorder_submesh(&mut mesh, *from, *to)?,
            ModelEdit::PasteSubmesh { source_skn, source_index, name } => {
                let source = resolve(source_skn)?;
                paste_submesh(
                    &mut mesh,
                    &mut skel,
                    &mut skeleton_dirty,
                    &source,
                    *source_index,
                    name,
                )?
            }
            ModelEdit::RenameJoint { index, name } => {
                rename_joint(&mut skel, &mut skeleton_dirty, *index, name)?
            }
            ModelEdit::PaintWeights { entries } => {
                paint_weights(&mut mesh, &mut skel, &mut skeleton_dirty, entries)?
            }
        }
    }

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

// Submesh names are the key the skin BIN references geometry by, so a collision silently makes one of the two unreachable.
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

// Any op that adds/removes vertices must call this, or camera framing and the game's culling break.
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

    // Index values are global vertex indices, not range-local — survivors above the removed span must shift down.
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

fn reorder_submesh(mesh: &mut SkinnedMesh, from: usize, to: usize) -> Result<(), String> {
    check_index(mesh, from)?;
    check_index(mesh, to)?;
    if from == to {
        return Ok(());
    }
    let range = mesh.ranges.remove(from);
    mesh.ranges.insert(to, range);
    Ok(())
}

// Root joints are refused — external clips/rigs assume their name never changes. Propagation to .anm/BIN happens at save time (mesh::joint_rename), not here.
fn rename_joint(
    skeleton: &mut Option<Skeleton>,
    skeleton_dirty: &mut bool,
    index: usize,
    name: &str,
) -> Result<(), String> {
    let skel = skeleton
        .as_mut()
        .ok_or_else(|| "this .skn has no skeleton to rename joints on".to_string())?;

    if index >= skel.joints.len() {
        return Err(format!(
            "joint index {index} out of range (skeleton has {} joints)",
            skel.joints.len()
        ));
    }

    if skel.joints[index].parent_id == -1 {
        return Err(format!(
            "\"{}\" is a root joint and cannot be renamed — renaming a root breaks rig identity",
            skel.joints[index].name
        ));
    }

    if name.trim().is_empty() {
        return Err("joint name cannot be empty".to_string());
    }
    for (i, joint) in skel.joints.iter().enumerate() {
        if i != index && joint.name.eq_ignore_ascii_case(name) {
            return Err(format!("a joint named \"{name}\" already exists"));
        }
    }

    skel.joints[index].name = name.to_string();
    skel.joints[index].hash = ritoshark::hash::elf_lower(name);
    *skeleton_dirty = true;
    Ok(())
}

const MIN_WEIGHT: f32 = 1e-4;

fn influence_slot_for_joint(skel: &mut Skeleton, joint_id: u16) -> Result<u8, String> {
    if !skel.joints.iter().any(|j| j.id == joint_id as i16) {
        return Err(format!("this skeleton has no joint with id {joint_id}"));
    }
    if let Some(pos) = skel.influences.iter().position(|&i| i == joint_id) {
        return Ok(pos as u8);
    }
    if skel.influences.len() >= MAX_INFLUENCES {
        return Err(format!(
            "this skin already binds {MAX_INFLUENCES} bones; blend indices are u8 so no more can be painted in"
        ));
    }
    skel.influences.push(joint_id);
    Ok((skel.influences.len() - 1) as u8)
}

fn paint_weights(
    mesh: &mut SkinnedMesh,
    skeleton: &mut Option<Skeleton>,
    skeleton_dirty: &mut bool,
    entries: &[WeightEntry],
) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    let skel = skeleton.as_mut().ok_or_else(|| {
        "this .skn has no sibling .skl, so vertex weights cannot be edited".to_string()
    })?;
    let influences_before = skel.influences.len();

    for entry in entries {
        let vi = entry.vertex as usize;
        if vi >= mesh.vertices.len() {
            return Err(format!(
                "vertex index {vi} out of range (mesh has {} vertices)",
                mesh.vertices.len()
            ));
        }
        if entry.joints.len() != entry.weights.len() {
            return Err(format!(
                "vertex {vi}: {} joints but {} weights",
                entry.joints.len(),
                entry.weights.len()
            ));
        }

        let mut pairs: Vec<(u16, f32)> = entry
            .joints
            .iter()
            .copied()
            .zip(entry.weights.iter().copied())
            .filter(|(_, w)| w.is_finite() && *w > MIN_WEIGHT)
            .collect();
        for i in 1..pairs.len() {
            if pairs[..i].iter().any(|(j, _)| *j == pairs[i].0) {
                return Err(format!("vertex {vi} lists joint {} twice", pairs[i].0));
            }
        }
        pairs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        pairs.truncate(4);
        if pairs.is_empty() {
            return Err(format!(
                "vertex {vi} would be left unweighted — every vertex must keep at least one bone"
            ));
        }

        let total: f32 = pairs.iter().map(|(_, w)| *w).sum();
        let mut blend_indices = [0u8; 4];
        let mut blend_weights = [0.0f32; 4];
        for (slot, (joint_id, w)) in pairs.iter().enumerate() {
            blend_indices[slot] = influence_slot_for_joint(skel, *joint_id)?;
            blend_weights[slot] = w / total;
        }
        // pairs is sorted descending, so parking the rounding drift on slot 0 can never make it negative.
        let sum: f32 = blend_weights.iter().sum();
        blend_weights[0] += 1.0 - sum;

        mesh.vertices[vi].blend_indices = blend_indices;
        mesh.vertices[vi].blend_weights = blend_weights;
    }

    if skel.influences.len() != influences_before {
        *skeleton_dirty = true;
    }
    Ok(())
}

pub struct PasteSource {
    pub mesh: SkinnedMesh,
    pub skeleton: Option<Skeleton>,
}

pub fn load_paste_source(path: &Path) -> Result<PasteSource, String> {
    use ritoshark::prelude::Parse;
    let bytes = std::fs::read(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let mesh = SkinnedMesh::from_bytes(&bytes)
        .map_err(|e| format!("parsing {}: {e:?}", path.display()))?;
    let skl_path = path.with_extension("skl");
    let skeleton = std::fs::read(&skl_path)
        .ok()
        .and_then(|b| Skeleton::from_bytes(&b).ok());
    Ok(PasteSource { mesh, skeleton })
}

fn remap_influence(
    src_skel: &Skeleton,
    dest_skel: &mut Skeleton,
    src_influence_idx: u8,
) -> Result<u8, String> {
    let src_joint_id = *src_skel
        .influences
        .get(src_influence_idx as usize)
        .ok_or_else(|| {
            format!("source influence index {src_influence_idx} is outside its skeleton's table")
        })?;
    let src_name = src_skel
        .joints
        .iter()
        .find(|j| j.id == src_joint_id as i16)
        .map(|j| j.name.as_str())
        .ok_or_else(|| format!("source skeleton has no joint with id {src_joint_id}"))?;

    let dest_joint_id = dest_skel
        .joints
        .iter()
        .find(|j| j.name.eq_ignore_ascii_case(src_name))
        .map(|j| j.id)
        .ok_or_else(|| {
            format!("this skin's skeleton has no joint named \"{src_name}\" — the pasted geometry is rigged to bones this rig does not have")
        })?;

    if let Some(pos) = dest_skel.influences.iter().position(|&i| i as i16 == dest_joint_id) {
        return Ok(pos as u8);
    }

    if dest_skel.influences.len() >= MAX_INFLUENCES {
        return Err(format!(
            "this skin already binds {MAX_INFLUENCES} bones; blend indices are u8 so \"{src_name}\" cannot be added"
        ));
    }
    dest_skel.influences.push(dest_joint_id as u16);
    Ok((dest_skel.influences.len() - 1) as u8)
}

fn paste_submesh(
    mesh: &mut SkinnedMesh,
    skeleton: &mut Option<Skeleton>,
    skeleton_dirty: &mut bool,
    source: &PasteSource,
    source_index: usize,
    name: &str,
) -> Result<(), String> {
    check_name(mesh, name, None)?;

    let range = source
        .mesh
        .ranges
        .get(source_index)
        .ok_or_else(|| format!("source submesh index {source_index} does not exist"))?
        .clone();

    let v_start = range.vertex_start as usize;
    let v_count = range.vertex_count as usize;
    let i_start = range.index_start as usize;
    let i_count = range.index_count as usize;

    let new_v_start = mesh.vertices.len();
    if new_v_start + v_count > MAX_VERTICES {
        return Err(format!(
            "pasting \"{}\" would need {} vertices; a .skn stores u16 indices so it cannot exceed 65535",
            range.name,
            new_v_start + v_count
        ));
    }

    let mut copied: Vec<SkinnedMeshVertex> =
        source.mesh.vertices[v_start..v_start + v_count].to_vec();

    // Zero-weight blend_indices slots must be zeroed unconditionally (even without a remap) — they can carry a stale raw index from the source skeleton's influence table.
    for v in &mut copied {
        for slot in 0..4 {
            if v.blend_weights[slot] <= 0.0 {
                v.blend_indices[slot] = 0;
            }
        }
    }

    let needs_remap = copied
        .iter()
        .any(|v| v.blend_weights.iter().any(|w| *w > 0.0));

    if needs_remap {
        let src_skel = source.skeleton.as_ref().ok_or_else(|| {
            "the source .skn has no sibling .skl, so its bone bindings cannot be translated"
                .to_string()
        })?;
        let dest_skel = skeleton.as_mut().ok_or_else(|| {
            "this .skn has no sibling .skl, so pasted geometry cannot be re-bound to its skeleton"
                .to_string()
        })?;
        let before = dest_skel.influences.len();
        for v in &mut copied {
            for slot in 0..4 {
                if v.blend_weights[slot] <= 0.0 {
                    continue;
                }
                v.blend_indices[slot] = remap_influence(src_skel, dest_skel, v.blend_indices[slot])?;
            }
        }
        if dest_skel.influences.len() != before {
            *skeleton_dirty = true;
        }
    }

    mesh.vertices.extend(copied);

    let new_i_start = mesh.indices.len();
    let rebased: Vec<u16> = source.mesh.indices[i_start..i_start + i_count]
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

// `ops[..cursor]` is the active prefix; everything from `cursor` on is the redo tail.
#[derive(Debug, Default, Clone)]
pub struct OpLog {
    ops: Vec<ModelEdit>,
    cursor: usize,
}

impl OpLog {
    pub fn push(&mut self, op: ModelEdit) {
        self.ops.truncate(self.cursor);
        self.ops.push(op);
        self.cursor = self.ops.len();
    }

    pub fn undo(&mut self) -> bool {
        if self.cursor == 0 {
            return false;
        }
        self.cursor -= 1;
        true
    }

    pub fn redo(&mut self) -> bool {
        if self.cursor >= self.ops.len() {
            return false;
        }
        self.cursor += 1;
        true
    }

    pub fn active(&self) -> &[ModelEdit] {
        &self.ops[..self.cursor]
    }

    pub fn can_undo(&self) -> bool {
        self.cursor > 0
    }

    pub fn can_redo(&self) -> bool {
        self.cursor < self.ops.len()
    }

    pub fn is_dirty(&self) -> bool {
        self.cursor > 0
    }

    pub fn clear(&mut self) {
        self.ops.clear();
        self.cursor = 0;
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmeshInfo {
    pub name: String,
    pub vertex_count: u32,
    pub index_count: u32,
    pub vertex_start: u32,
    pub index_start: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub submeshes: Vec<SubmeshInfo>,
    pub vertex_count: u32,
    pub index_count: u32,
    pub influence_count: u32,
    // The DERIVED table, not the on-disk one — a paste or a paint can append to it mid-log, and
    // blend indices in the derived mesh are slots into this exact vector.
    pub influences: Vec<u16>,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
}

// Deliberately carries no geometry — buffers travel only through derive_model_mesh's binary payload.
pub fn summarize(derived: &Derived, log: &OpLog) -> ModelSummary {
    ModelSummary {
        submeshes: derived
            .mesh
            .ranges
            .iter()
            .map(|r| SubmeshInfo {
                name: r.name.clone(),
                vertex_count: r.vertex_count,
                index_count: r.index_count,
                vertex_start: r.vertex_start,
                index_start: r.index_start,
            })
            .collect(),
        vertex_count: derived.mesh.vertices.len() as u32,
        index_count: derived.mesh.indices.len() as u32,
        influence_count: derived
            .skeleton
            .as_ref()
            .map(|s| s.influences.len() as u32)
            .unwrap_or(0),
        influences: derived
            .skeleton
            .as_ref()
            .map(|s| s.influences.clone())
            .unwrap_or_default(),
        dirty: log.is_dirty(),
        can_undo: log.can_undo(),
        can_redo: log.can_redo(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ritoshark::mesh::SkinnedMeshVertexType;
    use ritoshark::prelude::{Parse, Serialize as RsSerialize};

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

        let derived = apply_ops(&mesh, None, &[], &no_paste).expect("empty fold succeeds");
        let written = derived.mesh.to_bytes().expect("derived serializes");

        assert_eq!(original, written, "a zero-op fold must be byte-identical");
        SkinnedMesh::from_bytes(&written).expect("derived output re-parses");
    }

    #[test]
    fn rename_changes_only_the_named_range() {
        let mesh = fixture();
        let derived = apply_ops(
            &mesh,
            None,
            &[ModelEdit::RenameSubmesh { index: 1, name: "Wings".into() }],
            &no_paste,
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
            &no_paste,
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
            &no_paste,
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
            &no_paste,
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
            &no_paste,
        )
        .expect_err("blank names are rejected");
        assert!(err.to_lowercase().contains("empty"), "error explains why: {err}");
    }

    #[test]
    fn delete_compacts_buffers_and_reindexes_survivors() {
        let mesh = fixture();
        let derived = apply_ops(&mesh, None, &[ModelEdit::DeleteSubmesh { index: 0 }], &no_paste)
            .expect("delete succeeds");
        let out = derived.mesh;

        assert_eq!(out.ranges.len(), 1);
        assert_eq!(out.ranges[0].name, "Cape");
        assert_eq!(out.ranges[0].vertex_start, 0);
        assert_eq!(out.ranges[0].index_start, 0);
        assert_eq!(out.vertices.len(), 3);
        assert_eq!(out.indices, vec![0, 1, 2]);
        let bytes = {
            use ritoshark::prelude::Serialize as RsSerialize;
            out.to_bytes().expect("serializes")
        };
        SkinnedMesh::from_bytes(&bytes).expect("re-parses");
    }

    #[test]
    fn delete_recomputes_bounds_from_surviving_vertices() {
        let mesh = fixture();
        let derived = apply_ops(&mesh, None, &[ModelEdit::DeleteSubmesh { index: 0 }], &no_paste)
            .expect("delete succeeds");
        assert_eq!(derived.mesh.bounding_box.min.x, 3.0);
        assert_eq!(derived.mesh.bounding_box.max.x, 5.0);
    }

    #[test]
    fn delete_last_submesh_is_an_error() {
        let mut mesh = fixture();
        mesh.ranges.truncate(1);
        mesh.vertices.truncate(3);
        mesh.indices.truncate(3);
        let err = apply_ops(&mesh, None, &[ModelEdit::DeleteSubmesh { index: 0 }], &no_paste)
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
            &no_paste,
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
        assert_eq!(&out.indices[6..9], &[6, 7, 8]);
        assert_eq!(out.ranges[0].vertex_start, 0);
        assert_eq!(out.ranges[1].vertex_start, 3);
    }

    #[test]
    fn duplicate_past_the_u16_index_limit_is_rejected() {
        let mut mesh = fixture();
        let filler = mesh.vertices[0];
        mesh.vertices = vec![filler; 40_000];
        mesh.indices = (0..40_000u32).map(|i| i as u16).collect();
        mesh.ranges = vec![SkinnedMeshRange::new("Body", 0, 40_000, 0, 40_000)];

        let err = apply_ops(
            &mesh,
            None,
            &[ModelEdit::DuplicateSubmesh { index: 0, name: "Body_copy".into() }],
            &no_paste,
        )
        .expect_err("80k vertices exceeds the u16 index space");
        assert!(err.contains("65535") || err.contains("65,535"), "error cites the limit: {err}");
    }

    #[test]
    fn reorder_permutes_ranges_without_touching_buffers() {
        let mesh = fixture();
        let derived = apply_ops(&mesh, None, &[ModelEdit::ReorderSubmesh { from: 0, to: 1 }], &no_paste)
            .expect("reorder succeeds");
        let out = derived.mesh;

        assert_eq!(out.ranges[0].name, "Cape");
        assert_eq!(out.ranges[1].name, "Body");
        assert_eq!(out.ranges[0].vertex_start, 3);
        assert_eq!(out.ranges[1].vertex_start, 0);
        assert_eq!(out.vertices, mesh.vertices);
        assert_eq!(out.indices, mesh.indices);
    }

    #[test]
    fn reorder_out_of_range_is_an_error() {
        let mesh = fixture();
        assert!(apply_ops(&mesh, None, &[ModelEdit::ReorderSubmesh { from: 0, to: 7 }], &no_paste).is_err());
        assert!(apply_ops(&mesh, None, &[ModelEdit::ReorderSubmesh { from: 7, to: 0 }], &no_paste).is_err());
    }

    #[test]
    fn rename_joint_updates_name_and_hash() {
        let skel = skeleton_with_parents(&[("Root", 0, -1), ("Spine", 1, 0)], &[]);
        let derived = apply_ops(
            &fixture(),
            Some(&skel),
            &[ModelEdit::RenameJoint { index: 1, name: "Spine2".into() }],
            &no_paste,
        )
        .expect("rename succeeds");

        let out = derived.skeleton.expect("skeleton present");
        assert_eq!(out.joints[1].name, "Spine2");
        assert_eq!(out.joints[1].hash, ritoshark::hash::elf_lower("Spine2"));
        assert_eq!(out.joints[0].name, "Root");
        assert!(derived.skeleton_dirty, "the .skl must be written");
    }

    #[test]
    fn rename_joint_on_a_root_is_rejected() {
        let skel = skeleton_with_parents(&[("Root", 0, -1), ("Spine", 1, 0)], &[]);
        let err = apply_ops(
            &fixture(),
            Some(&skel),
            &[ModelEdit::RenameJoint { index: 0, name: "NewRoot".into() }],
            &no_paste,
        )
        .expect_err("root joints cannot be renamed");
        assert!(err.to_lowercase().contains("root"), "error names the reason: {err}");
    }

    #[test]
    fn rename_joint_out_of_range_is_an_error() {
        let skel = skeleton_with_parents(&[("Root", 0, -1)], &[]);
        let err = apply_ops(
            &fixture(),
            Some(&skel),
            &[ModelEdit::RenameJoint { index: 9, name: "Nope".into() }],
            &no_paste,
        )
        .expect_err("index 9 does not exist");
        assert!(err.contains("index 9"), "error names the bad index: {err}");
    }

    #[test]
    fn rename_joint_to_a_duplicate_name_is_an_error() {
        let skel = skeleton_with_parents(&[("Root", 0, -1), ("Spine", 1, 0), ("Arm", 2, 1)], &[]);
        let err = apply_ops(
            &fixture(),
            Some(&skel),
            &[ModelEdit::RenameJoint { index: 2, name: "Spine".into() }],
            &no_paste,
        )
        .expect_err("duplicate joint names are rejected");
        assert!(err.contains("Spine"), "error names the collision: {err}");
    }

    #[test]
    fn rename_joint_to_an_empty_name_is_an_error() {
        let skel = skeleton_with_parents(&[("Root", 0, -1), ("Spine", 1, 0)], &[]);
        let err = apply_ops(
            &fixture(),
            Some(&skel),
            &[ModelEdit::RenameJoint { index: 1, name: "  ".into() }],
            &no_paste,
        )
        .expect_err("blank names are rejected");
        assert!(err.to_lowercase().contains("empty"), "error explains why: {err}");
    }

    #[test]
    fn rename_joint_without_a_skeleton_is_an_error() {
        let err = apply_ops(
            &fixture(),
            None,
            &[ModelEdit::RenameJoint { index: 0, name: "X".into() }],
            &no_paste,
        )
        .expect_err("no skeleton to rename joints on");
        assert!(err.to_lowercase().contains("skeleton"), "error explains why: {err}");
    }

    use std::path::Path;

    pub(super) fn no_paste(_p: &Path) -> Result<PasteSource, String> {
        Err("no paste source in this test".to_string())
    }

    fn joint(name: &str, id: i16) -> ritoshark::anim::Joint {
        ritoshark::anim::Joint {
            name: name.to_string(),
            flags: 0,
            id,
            parent_id: -1,
            radius: 2.1,
            hash: ritoshark::hash::elf_lower(name),
            local_translation: Vec3::ZERO,
            local_scale: Vec3::ONE,
            local_rotation: ritoshark::math::Quat::IDENTITY,
            inverse_bind_translation: Vec3::ZERO,
            inverse_bind_scale: Vec3::ONE,
            inverse_bind_rotation: ritoshark::math::Quat::IDENTITY,
        }
    }

    fn skeleton_with_parents(entries: &[(&str, i16, i16)], influences: &[u16]) -> Skeleton {
        Skeleton {
            flags: 0,
            name: "test".into(),
            asset: "test".into(),
            joints: entries
                .iter()
                .map(|(name, id, parent_id)| {
                    let mut j = joint(name, *id);
                    j.parent_id = *parent_id;
                    j
                })
                .collect(),
            influences: influences.to_vec(),
        }
    }

    fn skeleton_with(names: &[&str], influences: &[u16]) -> Skeleton {
        Skeleton {
            flags: 0,
            name: "test".into(),
            asset: "test".into(),
            joints: names.iter().enumerate().map(|(i, n)| joint(n, i as i16)).collect(),
            influences: influences.to_vec(),
        }
    }

    #[test]
    fn paste_remaps_influence_indices_by_joint_name() {
        let dest_skel = skeleton_with(&["Root", "Spine", "Arm"], &[0, 1]);
        let src_skel = skeleton_with(&["Spine", "Root"], &[0]);

        let mut src_mesh = fixture();
        src_mesh.ranges = vec![SkinnedMeshRange::new("Horns", 0, 3, 0, 3)];
        src_mesh.vertices.truncate(3);
        src_mesh.indices = vec![0, 1, 2];
        for v in &mut src_mesh.vertices {
            v.blend_indices = [0, 0, 0, 0];
        }

        let resolve = move |_p: &Path| {
            Ok(PasteSource { mesh: src_mesh.clone(), skeleton: Some(src_skel.clone()) })
        };

        let derived = apply_ops(
            &fixture(),
            Some(&dest_skel),
            &[ModelEdit::PasteSubmesh {
                source_skn: PathBuf::from("other.skn"),
                source_index: 0,
                name: "Horns".into(),
            }],
            &resolve,
        )
        .expect("paste succeeds");

        let pasted = derived.mesh.ranges.last().expect("range appended");
        assert_eq!(pasted.name, "Horns");
        assert_eq!(pasted.vertex_start, 6);
        let first = derived.mesh.vertices[6];
        assert_eq!(first.blend_indices[0], 1, "remapped through joint NAME, not raw index");
        assert!(!derived.skeleton_dirty, "no new influence was needed");
    }

    #[test]
    fn paste_appends_a_missing_influence_and_marks_the_skeleton_dirty() {
        let dest_skel = skeleton_with(&["Root", "Spine", "Arm"], &[0, 1]);
        let src_skel = skeleton_with(&["Arm"], &[0]);

        let mut src_mesh = fixture();
        src_mesh.ranges = vec![SkinnedMeshRange::new("Claw", 0, 3, 0, 3)];
        src_mesh.vertices.truncate(3);
        src_mesh.indices = vec![0, 1, 2];
        for v in &mut src_mesh.vertices {
            v.blend_indices = [0, 0, 0, 0];
        }

        let resolve = move |_p: &Path| {
            Ok(PasteSource { mesh: src_mesh.clone(), skeleton: Some(src_skel.clone()) })
        };

        let derived = apply_ops(
            &fixture(),
            Some(&dest_skel),
            &[ModelEdit::PasteSubmesh {
                source_skn: PathBuf::from("other.skn"),
                source_index: 0,
                name: "Claw".into(),
            }],
            &resolve,
        )
        .expect("paste succeeds");

        let skel = derived.skeleton.expect("skeleton present");
        assert_eq!(skel.influences, vec![0, 1, 2], "Arm (joint id 2) appended");
        assert_eq!(derived.mesh.vertices[6].blend_indices[0], 2, "points at the new slot");
        assert!(derived.skeleton_dirty, "the .skl must be written");
        assert_eq!(skel.joints.len(), 3);
        assert_eq!(skel.joints[2].name, "Arm");
    }

    #[test]
    fn paste_fails_when_a_source_joint_is_absent_from_the_destination() {
        let dest_skel = skeleton_with(&["Root", "Spine"], &[0, 1]);
        let src_skel = skeleton_with(&["Tentacle"], &[0]);

        let mut src_mesh = fixture();
        src_mesh.ranges = vec![SkinnedMeshRange::new("Tent", 0, 3, 0, 3)];
        src_mesh.vertices.truncate(3);
        src_mesh.indices = vec![0, 1, 2];
        for v in &mut src_mesh.vertices {
            v.blend_indices = [0, 0, 0, 0];
        }

        let resolve = move |_p: &Path| {
            Ok(PasteSource { mesh: src_mesh.clone(), skeleton: Some(src_skel.clone()) })
        };

        let err = apply_ops(
            &fixture(),
            Some(&dest_skel),
            &[ModelEdit::PasteSubmesh {
                source_skn: PathBuf::from("other.skn"),
                source_index: 0,
                name: "Tent".into(),
            }],
            &resolve,
        )
        .expect_err("Tentacle has no home in the destination rig");
        assert!(err.contains("Tentacle"), "error names the missing joint: {err}");
    }

    #[test]
    fn paste_without_a_destination_skeleton_is_an_error() {
        let src_skel = skeleton_with(&["Root"], &[0]);
        let mut src_mesh = fixture();
        src_mesh.ranges = vec![SkinnedMeshRange::new("X", 0, 3, 0, 3)];
        src_mesh.vertices.truncate(3);
        src_mesh.indices = vec![0, 1, 2];

        let resolve = move |_p: &Path| {
            Ok(PasteSource { mesh: src_mesh.clone(), skeleton: Some(src_skel.clone()) })
        };

        let err = apply_ops(
            &fixture(),
            None,
            &[ModelEdit::PasteSubmesh {
                source_skn: PathBuf::from("other.skn"),
                source_index: 0,
                name: "X".into(),
            }],
            &resolve,
        )
        .expect_err("cannot remap without a destination rig");
        assert!(err.to_lowercase().contains("skeleton"), "error explains why: {err}");
    }

    #[test]
    fn paste_past_the_256_influence_limit_is_rejected() {
        let names: Vec<String> = (0..257).map(|i| format!("J{i}")).collect();
        let name_refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
        let influences: Vec<u16> = (0..256).collect();
        let dest_skel = skeleton_with(&name_refs, &influences);

        let src_skel = skeleton_with(&["J256"], &[0]);

        let mut src_mesh = fixture();
        src_mesh.ranges = vec![SkinnedMeshRange::new("Extra", 0, 3, 0, 3)];
        src_mesh.vertices.truncate(3);
        src_mesh.indices = vec![0, 1, 2];
        for v in &mut src_mesh.vertices {
            v.blend_indices = [0, 0, 0, 0];
        }

        let resolve = move |_p: &Path| {
            Ok(PasteSource { mesh: src_mesh.clone(), skeleton: Some(src_skel.clone()) })
        };

        let err = apply_ops(
            &fixture(),
            Some(&dest_skel),
            &[ModelEdit::PasteSubmesh {
                source_skn: PathBuf::from("other.skn"),
                source_index: 0,
                name: "Extra".into(),
            }],
            &resolve,
        )
        .expect_err("a 257th distinct influence exceeds the u8 blend-index limit");
        assert!(err.contains("256"), "error cites the limit: {err}");
    }

    #[test]
    fn paste_past_the_u16_vertex_limit_is_rejected() {
        let filler = fixture().vertices[0];
        let mesh = SkinnedMesh {
            vertices: vec![filler; 65_534],
            indices: (0..65_534u32).map(|i| i as u16).collect(),
            ranges: vec![SkinnedMeshRange::new("Body", 0, 65_534, 0, 65_534)],
            ..fixture()
        };

        let mut src_mesh = fixture();
        src_mesh.ranges = vec![SkinnedMeshRange::new("Extra", 0, 3, 0, 3)];
        src_mesh.vertices.truncate(3);
        src_mesh.indices = vec![0, 1, 2];
        for v in &mut src_mesh.vertices {
            v.blend_weights = [0.0, 0.0, 0.0, 0.0];
        }

        let resolve =
            move |_p: &Path| Ok(PasteSource { mesh: src_mesh.clone(), skeleton: None });

        let err = apply_ops(
            &mesh,
            None,
            &[ModelEdit::PasteSubmesh {
                source_skn: PathBuf::from("other.skn"),
                source_index: 0,
                name: "Extra".into(),
            }],
            &resolve,
        )
        .expect_err("65_534 + 3 exceeds the u16 index space");
        assert!(err.contains("65535") || err.contains("65,535"), "error cites the limit: {err}");
    }

    fn paint(vertex: u32, pairs: &[(u16, f32)]) -> ModelEdit {
        ModelEdit::PaintWeights {
            entries: vec![WeightEntry {
                vertex,
                joints: pairs.iter().map(|(j, _)| *j).collect(),
                weights: pairs.iter().map(|(_, w)| *w).collect(),
            }],
        }
    }

    #[test]
    fn paint_normalizes_and_writes_influence_slots() {
        let skel = skeleton_with(&["Root", "Spine", "Arm"], &[0, 1, 2]);
        let derived = apply_ops(&fixture(), Some(&skel), &[paint(0, &[(2, 3.0), (1, 1.0)])], &no_paste)
            .expect("paint succeeds");

        let v = derived.mesh.vertices[0];
        assert_eq!(v.blend_indices, [2, 1, 0, 0], "sorted by weight, mapped to slots");
        assert!((v.blend_weights[0] - 0.75).abs() < 1e-5, "got {:?}", v.blend_weights);
        assert!((v.blend_weights[1] - 0.25).abs() < 1e-5, "got {:?}", v.blend_weights);
        assert_eq!(v.blend_weights[2], 0.0);
        assert_eq!(v.blend_weights[3], 0.0);
        assert!((v.blend_weights.iter().sum::<f32>() - 1.0).abs() < 1e-6, "slots must sum to 1");
        assert!(!derived.skeleton_dirty, "no influence was appended");
    }

    #[test]
    fn paint_appends_an_unbound_joint_to_the_influence_table() {
        let skel = skeleton_with(&["Root", "Spine", "Arm"], &[0, 1]);
        let derived = apply_ops(&fixture(), Some(&skel), &[paint(3, &[(2, 1.0)])], &no_paste)
            .expect("paint succeeds");

        let out = derived.skeleton.expect("skeleton present");
        assert_eq!(out.influences, vec![0, 1, 2], "Arm appended");
        assert_eq!(derived.mesh.vertices[3].blend_indices[0], 2, "points at the new slot");
        assert!(derived.skeleton_dirty, "the .skl must be written");
    }

    #[test]
    fn paint_drops_negligible_weights_and_keeps_the_top_four() {
        let names = ["Root", "A", "B", "C", "D", "E"];
        let skel = skeleton_with(&names, &[0, 1, 2, 3, 4, 5]);
        let derived = apply_ops(
            &fixture(),
            Some(&skel),
            &[paint(0, &[(1, 0.5), (2, 0.4), (3, 0.3), (4, 0.2), (5, 0.1), (0, 1e-9)])],
            &no_paste,
        )
        .expect("paint succeeds");

        let v = derived.mesh.vertices[0];
        assert_eq!(v.blend_indices, [1, 2, 3, 4], "the four heaviest survive, in weight order");
        assert!((v.blend_weights.iter().sum::<f32>() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn paint_that_would_unweight_a_vertex_is_rejected() {
        let skel = skeleton_with(&["Root", "Spine"], &[0, 1]);
        let err = apply_ops(&fixture(), Some(&skel), &[paint(0, &[(1, 0.0)])], &no_paste)
            .expect_err("a vertex cannot end up with no bone");
        assert!(err.to_lowercase().contains("unweighted"), "error explains why: {err}");
    }

    #[test]
    fn paint_on_a_joint_the_skeleton_does_not_have_is_rejected() {
        let skel = skeleton_with(&["Root", "Spine"], &[0, 1]);
        let err = apply_ops(&fixture(), Some(&skel), &[paint(0, &[(77, 1.0)])], &no_paste)
            .expect_err("joint 77 does not exist");
        assert!(err.contains("77"), "error names the joint: {err}");
    }

    #[test]
    fn paint_out_of_range_vertex_is_rejected() {
        let skel = skeleton_with(&["Root", "Spine"], &[0, 1]);
        let err = apply_ops(&fixture(), Some(&skel), &[paint(999, &[(1, 1.0)])], &no_paste)
            .expect_err("vertex 999 does not exist");
        assert!(err.contains("999"), "error names the bad index: {err}");
    }

    #[test]
    fn paint_past_the_256_influence_limit_is_rejected() {
        let names: Vec<String> = (0..257).map(|i| format!("J{i}")).collect();
        let name_refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
        let influences: Vec<u16> = (0..256).collect();
        let skel = skeleton_with(&name_refs, &influences);

        let err = apply_ops(&fixture(), Some(&skel), &[paint(0, &[(256, 1.0)])], &no_paste)
            .expect_err("a 257th distinct influence exceeds the u8 blend-index limit");
        assert!(err.contains("256"), "error cites the limit: {err}");
    }

    #[test]
    fn paint_without_a_skeleton_is_an_error() {
        let err = apply_ops(&fixture(), None, &[paint(0, &[(1, 1.0)])], &no_paste)
            .expect_err("no skeleton to bind weights against");
        assert!(err.to_lowercase().contains("skl"), "error explains why: {err}");
    }

    #[test]
    fn painting_the_same_vertex_twice_keeps_only_the_later_stroke() {
        let skel = skeleton_with(&["Root", "Spine", "Arm"], &[0, 1, 2]);
        let derived = apply_ops(
            &fixture(),
            Some(&skel),
            &[paint(0, &[(1, 1.0)]), paint(0, &[(2, 1.0)])],
            &no_paste,
        )
        .expect("both strokes fold");
        assert_eq!(derived.mesh.vertices[0].blend_indices[0], 2);
        assert_eq!(derived.mesh.vertices[0].blend_weights[0], 1.0);
    }

    #[test]
    fn a_painted_mesh_round_trips_through_the_file_format() {
        let skel = skeleton_with(&["Root", "Spine", "Arm"], &[0, 1, 2]);
        let derived = apply_ops(&fixture(), Some(&skel), &[paint(2, &[(1, 0.6), (2, 0.4)])], &no_paste)
            .expect("paint succeeds");
        let bytes = derived.mesh.to_bytes().expect("serializes");
        let reparsed = SkinnedMesh::from_bytes(&bytes).expect("re-parses");
        assert_eq!(reparsed.vertices[2].blend_indices, derived.mesh.vertices[2].blend_indices);
    }

    #[test]
    fn summary_reports_the_derived_influence_table() {
        let skel = skeleton_with(&["Root", "Spine", "Arm"], &[0, 1]);
        let mut log = OpLog::default();
        log.push(paint(0, &[(2, 1.0)]));
        let derived = apply_ops(&fixture(), Some(&skel), log.active(), &no_paste).expect("folds");
        let summary = summarize(&derived, &log);
        assert_eq!(summary.influences, vec![0, 1, 2]);
        assert_eq!(summary.influence_count, 3);
    }

    #[test]
    fn staging_after_undo_truncates_the_redo_tail() {
        let mut log = OpLog::default();
        log.push(ModelEdit::RenameSubmesh { index: 0, name: "A".into() });
        log.push(ModelEdit::RenameSubmesh { index: 0, name: "B".into() });
        assert!(log.undo());
        assert!(log.can_redo());

        log.push(ModelEdit::RenameSubmesh { index: 0, name: "C".into() });
        assert!(!log.can_redo(), "the stale redo tail is gone");
        assert_eq!(log.active().len(), 2);

        let derived = apply_ops(&fixture(), None, log.active(), &no_paste).expect("folds");
        assert_eq!(derived.mesh.ranges[0].name, "C");
    }

    #[test]
    fn undo_then_redo_restores_the_same_state() {
        let mut log = OpLog::default();
        log.push(ModelEdit::RenameSubmesh { index: 0, name: "A".into() });
        log.push(ModelEdit::DuplicateSubmesh { index: 0, name: "A_copy".into() });
        log.push(ModelEdit::RenameSubmesh { index: 1, name: "Z".into() });

        assert!(log.undo());
        assert!(log.undo());
        assert!(log.redo());
        assert_eq!(log.active().len(), 2);

        let derived = apply_ops(&fixture(), None, log.active(), &no_paste).expect("folds");
        assert_eq!(derived.mesh.ranges[0].name, "A");
        assert_eq!(derived.mesh.ranges.len(), 3);
    }

    #[test]
    fn undo_at_the_start_and_redo_at_the_end_are_no_ops() {
        let mut log = OpLog::default();
        assert!(!log.undo());
        assert!(!log.redo());
        log.push(ModelEdit::RenameSubmesh { index: 0, name: "A".into() });
        assert!(!log.redo());
        assert!(log.undo());
        assert!(!log.undo());
    }

    #[test]
    fn summary_reports_ranges_counts_and_flags() {
        let mut log = OpLog::default();
        log.push(ModelEdit::RenameSubmesh { index: 1, name: "Wings".into() });
        let derived = apply_ops(&fixture(), None, log.active(), &no_paste).expect("folds");
        let summary = summarize(&derived, &log);

        assert_eq!(summary.submeshes.len(), 2);
        assert_eq!(summary.submeshes[1].name, "Wings");
        assert_eq!(summary.submeshes[1].vertex_count, 3);
        assert_eq!(summary.vertex_count, 6);
        assert_eq!(summary.index_count, 6);
        assert!(summary.dirty);
        assert!(summary.can_undo);
        assert!(!summary.can_redo);
    }

    #[test]
    fn a_cleared_log_is_not_dirty() {
        let mut log = OpLog::default();
        log.push(ModelEdit::RenameSubmesh { index: 0, name: "A".into() });
        log.clear();
        assert!(!log.is_dirty());
        assert!(!log.can_undo());
        assert!(log.active().is_empty());
    }

    #[test]
    fn model_summary_serializes_with_camel_case_keys() {
        let summary = ModelSummary {
            submeshes: vec![SubmeshInfo {
                name: "Body".into(),
                vertex_count: 10,
                index_count: 30,
                vertex_start: 0,
                index_start: 0,
            }],
            vertex_count: 10,
            index_count: 30,
            influence_count: 2,
            influences: vec![0, 1],
            dirty: true,
            can_undo: true,
            can_redo: false,
        };

        let json = serde_json::to_value(&summary).expect("serializes");
        let obj = json.as_object().expect("is an object");

        assert!(obj.contains_key("submeshes"), "top-level key 'submeshes' must be camelCase");
        assert!(obj.contains_key("vertexCount"), "top-level key 'vertexCount' must be camelCase");
        assert!(obj.contains_key("indexCount"), "top-level key 'indexCount' must be camelCase");
        assert!(obj.contains_key("influenceCount"), "top-level key 'influenceCount' must be camelCase");
        assert!(obj.contains_key("dirty"), "top-level key 'dirty' must be present");
        assert!(obj.contains_key("canUndo"), "top-level key 'canUndo' must be camelCase");
        assert!(obj.contains_key("canRedo"), "top-level key 'canRedo' must be camelCase");

        assert!(!obj.contains_key("vertex_count"), "snake_case 'vertex_count' must not exist");
        assert!(!obj.contains_key("index_count"), "snake_case 'index_count' must not exist");
        assert!(!obj.contains_key("influence_count"), "snake_case 'influence_count' must not exist");
        assert!(!obj.contains_key("can_undo"), "snake_case 'can_undo' must not exist");
        assert!(!obj.contains_key("can_redo"), "snake_case 'can_redo' must not exist");

        let submeshes = obj
            .get("submeshes")
            .and_then(|v| v.as_array())
            .expect("submeshes is an array");
        assert_eq!(submeshes.len(), 1);
        let submesh_obj = submeshes[0].as_object().expect("submesh is an object");

        assert!(submesh_obj.contains_key("name"), "submesh key 'name' must be present");
        assert!(submesh_obj.contains_key("vertexCount"), "submesh key 'vertexCount' must be camelCase");
        assert!(submesh_obj.contains_key("indexCount"), "submesh key 'indexCount' must be camelCase");
        assert!(submesh_obj.contains_key("vertexStart"), "submesh key 'vertexStart' must be camelCase");
        assert!(submesh_obj.contains_key("indexStart"), "submesh key 'indexStart' must be camelCase");

        assert!(!submesh_obj.contains_key("vertex_count"), "snake_case 'vertex_count' must not exist in submesh");
        assert!(!submesh_obj.contains_key("index_count"), "snake_case 'index_count' must not exist in submesh");
        assert!(!submesh_obj.contains_key("vertex_start"), "snake_case 'vertex_start' must not exist in submesh");
        assert!(!submesh_obj.contains_key("index_start"), "snake_case 'index_start' must not exist in submesh");
    }
}
