use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HudData {
    #[serde(rename = "type")]
    pub hud_type: String,
    pub version: u32,
    pub linked: Vec<String>,
    pub entries: HashMap<String, HudEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HudEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub enabled: bool,
    #[serde(rename = "Layer")]
    pub layer: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<HudPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "TextureData")]
    pub texture_data: Option<TextureData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "Scene")]
    pub scene: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HudPosition {
    #[serde(rename = "UIRect")]
    pub ui_rect: UiRect,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "Anchors")]
    pub anchors: Option<Anchors>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiRect {
    pub position: Vec2,
    #[serde(rename = "Size")]
    pub size: Vec2,
    #[serde(rename = "SourceResolutionWidth")]
    pub source_resolution_width: u16,
    #[serde(rename = "SourceResolutionHeight")]
    pub source_resolution_height: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Anchors {
    #[serde(rename = "Anchor")]
    pub anchor: Vec2,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextureData {
    #[serde(rename = "mTextureName")]
    pub texture_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "mTextureUV")]
    pub texture_uv: Option<Vec4>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vec4 {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
}

pub fn parse_hud_file(content: &str) -> Result<HudData> {
    tracing::debug!("HUD file parsing called with {} bytes", content.len());

    Ok(HudData {
        hud_type: "PROP".to_string(),
        version: 1,
        linked: Vec::new(),
        entries: HashMap::new(),
    })
}

/// Serializes HUD data back to .ritobin, find-and-replacing positions in
/// `original_content` to preserve structure.
pub fn serialize_hud_file(data: &HudData, original_content: &str) -> Result<String> {
    let mut modified = original_content.to_string();

    for (key, entry) in &data.entries {
        if let Some(ref pos) = entry.position {
            let search_pattern = format!("#{}", key);

            if let Some(entry_start) = modified.find(&search_pattern) {
                let after_entry = &modified[entry_start..];

                if let Some(pos_idx) = after_entry.find("position: vec2 = {") {
                    let absolute_pos_idx = entry_start + pos_idx;

                    if let Some(line_end) = modified[absolute_pos_idx..].find('\n') {
                        let line = &modified[absolute_pos_idx..absolute_pos_idx + line_end];

                        let indent_len = line.len() - line.trim_start().len();
                        let indent = " ".repeat(indent_len);

                        let new_x = pos.ui_rect.position.x.round() as i32;
                        let new_y = pos.ui_rect.position.y.round() as i32;
                        let new_line = format!("{}position: vec2 = {{ {}, {} }}", indent, new_x, new_y);

                        let before = &modified[..absolute_pos_idx];
                        let after = &modified[absolute_pos_idx + line_end..];
                        modified = format!("{}{}{}", before, new_line, after);

                        tracing::debug!("Updated position for entry #{}", key);
                    }
                }
            }
        }
    }

    Ok(modified)
}
