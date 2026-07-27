//! Commands for the animation mask weight editor.
//!
//! `mWeightList` is positionally indexed against the SKL's joint order, so a
//! weight list and a bone list of different lengths cannot be paired safely.

use crate::core::ipc_trace;
use flint_core::bin::{read_bin, write_bin, MaskEntry};
use flint_core::mesh::skl::{parse_skl_file, BoneData};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JointWeight {
    /// Index into `mWeightList` — always present, this is the real identity.
    pub index: usize,
    /// Joint name, or `None` when the lists could not be paired safely.
    pub name: Option<String>,
    /// Parent's index, for rendering the hierarchy. `None` for roots.
    pub parent_index: Option<usize>,
    pub weight: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskView {
    pub key: u32,
    pub joints: Vec<JointWeight>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskDocument {
    pub masks: Vec<MaskView>,
    /// True when the weight lists and the skeleton disagree in length. The UI
    /// must show index-only labels and warn rather than guess at names.
    pub joint_count_mismatch: bool,
    /// How many joints the SKL actually has, for the warning text.
    pub skeleton_joint_count: usize,
}

/// Pair weights with joint names, or refuse to if the lengths disagree.
///
/// Returns `(rows, mismatched)`. On mismatch every weight is still returned and
/// still editable — only the names are withheld, because index `i` no longer
/// provably refers to bone `i`.
pub fn pair_with_joints(weights: &[f32], bones: &[BoneData]) -> (Vec<JointWeight>, bool) {
    let mismatched = weights.len() != bones.len();

    let rows = weights
        .iter()
        .enumerate()
        .map(|(index, &weight)| {
            let bone = if mismatched { None } else { bones.get(index) };
            JointWeight {
                index,
                name: bone.map(|b| b.name.clone()),
                parent_index: bone.and_then(|b| usize::try_from(b.parent_id).ok()),
                weight,
            }
        })
        .collect();

    (rows, mismatched)
}

#[tauri::command]
pub async fn read_animation_masks(
    bin_path: String,
    skl_path: String,
) -> Result<MaskDocument, String> {
    let _t = ipc_trace::enter("read_animation_masks");

    let bytes = std::fs::read(&bin_path).map_err(|e| format!("Failed to read {}: {}", bin_path, e))?;
    let bin = read_bin(&bytes).map_err(|e| format!("Failed to parse BIN: {}", e))?;
    let masks = flint_core::bin::read_masks(&bin);

    let skl = parse_skl_file(&skl_path)
        .map_err(|e| format!("Failed to parse SKL {}: {}", skl_path, e))?;

    let mut mismatch = false;
    let views = masks
        .iter()
        .map(|m| {
            let (joints, m2) = pair_with_joints(&m.weights, &skl.bones);
            mismatch |= m2;
            MaskView { key: m.key, joints }
        })
        .collect();

    Ok(MaskDocument {
        masks: views,
        joint_count_mismatch: mismatch,
        skeleton_joint_count: skl.bones.len(),
    })
}

#[tauri::command]
pub async fn save_animation_masks(
    bin_path: String,
    masks: Vec<MaskView>,
) -> Result<usize, String> {
    let _t = ipc_trace::enter("save_animation_masks");

    let bytes = std::fs::read(&bin_path).map_err(|e| format!("Failed to read {}: {}", bin_path, e))?;
    let mut bin = read_bin(&bytes).map_err(|e| format!("Failed to parse BIN: {}", e))?;

    let edits: Vec<MaskEntry> = masks
        .iter()
        .map(|m| MaskEntry {
            key: m.key,
            id: None,
            weights: m.joints.iter().map(|j| j.weight).collect(),
        })
        .collect();

    let written = flint_core::bin::write_masks(&mut bin, &edits)?;

    let out = write_bin(&bin).map_err(|e| format!("Failed to serialize BIN: {}", e))?;
    std::fs::write(&bin_path, out).map_err(|e| format!("Failed to write {}: {}", bin_path, e))?;

    tracing::info!("Wrote {} mask(s) to {}", written, bin_path);
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flint_core::mesh::skl::BoneData;

    fn bone(name: &str, id: i16, parent_id: i16) -> BoneData {
        BoneData {
            name: name.to_string(),
            id,
            parent_id,
            local_translation: [0.0; 3],
            local_rotation: [0.0, 0.0, 0.0, 1.0],
            local_scale: [1.0; 3],
            world_position: [0.0; 3],
            // Nested, not flat — `[[f32; 4]; 4]`.
            inverse_bind_matrix: [[0.0; 4]; 4],
        }
    }

    #[test]
    fn matching_lengths_pair_weights_to_joint_names() {
        let bones = vec![bone("Root", 0, -1), bone("Spine", 1, 0)];
        let (rows, mismatched) = pair_with_joints(&[1.0, 0.25], &bones);

        assert!(!mismatched);
        assert_eq!(rows[0].name.as_deref(), Some("Root"));
        assert_eq!(rows[0].weight, 1.0);
        assert_eq!(rows[0].parent_index, None);
        assert_eq!(rows[1].name.as_deref(), Some("Spine"));
        assert_eq!(rows[1].parent_index, Some(0));
    }

    #[test]
    fn a_length_mismatch_falls_back_to_index_only_labels() {
        // Exactly the broken state sborf repairs. Showing joint names here
        // would attach the wrong name to every weight past the divergence.
        let bones = vec![bone("Root", 0, -1)];
        let (rows, mismatched) = pair_with_joints(&[1.0, 0.5, 0.25], &bones);

        assert!(mismatched);
        assert_eq!(rows.len(), 3, "every weight must still be editable");
        assert!(rows.iter().all(|r| r.name.is_none()));
    }

    #[test]
    fn fewer_weights_than_joints_is_also_a_mismatch() {
        let bones = vec![bone("Root", 0, -1), bone("Spine", 1, 0)];
        let (rows, mismatched) = pair_with_joints(&[1.0], &bones);

        assert!(mismatched);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].name.is_none());
    }
}
