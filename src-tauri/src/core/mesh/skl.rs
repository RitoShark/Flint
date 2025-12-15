//! SKL (Skeleton) parsing for bone hierarchy visualization
//!
//! Uses ltk_anim::RigResource to parse League skeleton files (.skl)

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use ltk_anim::RigResource;
use serde::Serialize;

/// Bone data for a single joint in the skeleton
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
}

/// Complete skeleton data serializable to JSON for frontend
#[derive(Debug, Serialize)]
pub struct SklData {
    pub name: String,
    pub asset_name: String,
    pub bones: Vec<BoneData>,
}

/// Parse an SKL file and extract skeleton data
pub fn parse_skl_file<P: AsRef<Path>>(path: P) -> anyhow::Result<SklData> {
    let file = File::open(path.as_ref())?;
    let mut reader = BufReader::new(file);
    
    let rig = RigResource::from_reader(&mut reader)
        .map_err(|e| anyhow::anyhow!("Failed to parse SKL file: {:?}", e))?;
    
    // Extract bone data from joints
    let bones: Vec<BoneData> = rig.joints()
        .iter()
        .map(|joint| {
            let translation = joint.local_translation();
            let rotation = joint.local_rotation();
            let scale = joint.local_scale();
            
            // Get the inverse bind transform and invert it to get the actual bind transform
            // The bind transform's translation is the world position in bind pose
            let inv_bind = joint.inverse_bind_transform();
            let bind_transform = inv_bind.inverse();
            
            // Extract world position from the bind transform (translation is in 4th column)
            // glam Mat4 stores in column-major order
            let world_pos = bind_transform.w_axis.truncate();
            
            BoneData {
                name: joint.name().to_string(),
                id: joint.id(),
                parent_id: joint.parent_id(),
                local_translation: [translation.x, translation.y, translation.z],
                local_rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
                local_scale: [scale.x, scale.y, scale.z],
                world_position: [world_pos.x, world_pos.y, world_pos.z],
            }
        })
        .collect();
    
    Ok(SklData {
        name: rig.name().to_string(),
        asset_name: rig.asset_name().to_string(),
        bones,
    })
}


