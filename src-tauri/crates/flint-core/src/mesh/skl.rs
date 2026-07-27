//! SKL (Skeleton) parsing for bone hierarchy visualization.

use std::path::Path;

use ritoshark::anim::Skeleton;
use ritoshark::math::{Mat4, Vec3};
use ritoshark::prelude::Parse;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct BoneData {
    pub name: String,
    pub id: i16,
    pub parent_id: i16,
    /// Local translation relative to parent [x, y, z]
    pub local_translation: [f32; 3],
    /// Local rotation as quaternion [x, y, z, w]
    pub local_rotation: [f32; 4],
    /// Local scale [x, y, z]
    pub local_scale: [f32; 3],
    /// World position in bind pose (computed from inverted bind matrix) [x, y, z]
    pub world_position: [f32; 3],
    /// Inverse bind matrix for skinning (4x4, column-major). Transforms vertices
    /// from model space to bone-local space.
    pub inverse_bind_matrix: [[f32; 4]; 4],
}

#[derive(Debug, Serialize)]
pub struct SklData {
    pub name: String,
    pub asset_name: String,
    pub bones: Vec<BoneData>,
    /// Maps vertex bone indices to actual bone IDs: bone_indices[i] refers to
    /// influences[bone_indices[i]].
    pub influences: Vec<i16>,
}

pub fn parse_skl_file<P: AsRef<Path>>(path: P) -> anyhow::Result<SklData> {
    let data = std::fs::read(path.as_ref())?;

    let skeleton = Skeleton::from_bytes(&data)
        .map_err(|e| anyhow::anyhow!("Failed to parse SKL file: {:?}", e))?;

    let bones: Vec<BoneData> = skeleton
        .joints
        .iter()
        .map(|joint| {
            let translation = joint.local_translation;
            let rotation = joint.local_rotation;
            let scale = joint.local_scale;

            let inv_bind = joint.inverse_bind_transform();
            let bind_transform = inv_bind.inverse();

            let world_pos = bind_transform.w_axis.truncate();

            /* mirrorX the inverse bind matrix. Use RitoShark's glam re-export so
               every Mat4 here matches inv_bind's glam version (mixing 0.27/0.29
               is a type error). */
            let mirror = Mat4::from_scale(Vec3::new(-1.0, 1.0, 1.0));
            let mirrored_inv_bind = mirror * inv_bind * mirror;

            let inv_bind_arr = [
                [mirrored_inv_bind.x_axis.x, mirrored_inv_bind.x_axis.y, mirrored_inv_bind.x_axis.z, mirrored_inv_bind.x_axis.w],
                [mirrored_inv_bind.y_axis.x, mirrored_inv_bind.y_axis.y, mirrored_inv_bind.y_axis.z, mirrored_inv_bind.y_axis.w],
                [mirrored_inv_bind.z_axis.x, mirrored_inv_bind.z_axis.y, mirrored_inv_bind.z_axis.z, mirrored_inv_bind.z_axis.w],
                [mirrored_inv_bind.w_axis.x, mirrored_inv_bind.w_axis.y, mirrored_inv_bind.w_axis.z, mirrored_inv_bind.w_axis.w],
            ];

            BoneData {
                name: joint.name.clone(),
                id: joint.id,
                parent_id: joint.parent_id,
                local_translation: [-translation.x, translation.y, translation.z],
                local_rotation: [rotation.x, -rotation.y, -rotation.z, rotation.w],
                local_scale: [scale.x, scale.y, scale.z],
                world_position: [-world_pos.x, world_pos.y, world_pos.z],
                inverse_bind_matrix: inv_bind_arr,
            }
        })
        .collect();

    Ok(SklData {
        name: skeleton.name.clone(),
        asset_name: skeleton.asset.clone(),
        bones,
        influences: skeleton.influences.iter().map(|&i| i as i16).collect(),
    })
}
