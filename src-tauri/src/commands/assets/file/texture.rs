use base64::{engine::general_purpose::STANDARD, Engine};
use ritoshark::prelude::*;
use ritoshark::tex::Texture;
use crate::core::ipc_trace;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecodedImage {
    /// Base64-encoded PNG data
    pub data: String,
    pub width: u32,
    pub height: u32,
    pub format: String,
    /// Any pixel with alpha < 255 in the decoded RGBA.
    #[serde(default)]
    pub has_alpha: bool,
}

/// Any pixel below full alpha — same scan the reference viewer uses to
/// decide alpha-test/blend vs opaque.
pub(crate) fn scan_has_alpha(rgba: &[u8]) -> bool {
    rgba.chunks_exact(4).any(|p| p[3] < 255)
}

pub(super) fn parse_texture_dimensions(data: &[u8]) -> Result<(u32, u32), String> {
    let texture = parse_texture_any(data)?;
    Ok((texture.width, texture.height))
}

/// Parse a DDS or TEX byte buffer into a RitoShark `Texture`.
///
/// RitoShark's `Texture` is one struct with two constructors; branch on the
/// 4-byte magic (`b"DDS "` → `from_dds_bytes`, otherwise TEX → `from_bytes`).
pub(super) fn parse_texture_any(data: &[u8]) -> Result<Texture, String> {
    if data.len() < 4 {
        return Err("Data too small to be a valid texture".to_string());
    }
    if &data[0..4] == b"DDS " {
        Texture::from_dds_bytes(data).map_err(|e| format!("Failed to parse texture: {:?}", e))
    } else {
        Texture::from_bytes(data).map_err(|e| format!("Failed to parse texture: {:?}", e))
    }
}

/// Synchronous DDS/TEX → (base64 PNG, has_alpha), callable from rayon
/// workers / other commands that need to decode many textures in parallel
/// without going back through the async tauri::command path. `has_alpha`
/// (any pixel with alpha < 255) drives the preview's alpha-test/blend
/// path.
pub fn decode_texture_file_sync_with_alpha(path: &Path) -> Result<(String, bool), String> {
    let data = fs::read(path).map_err(|e| format!("Failed to read texture file: {}", e))?;
    let decoded = decode_texture_bytes_impl(&data)?;
    Ok((decoded.data, decoded.has_alpha))
}

/// Shared decode logic: take raw DDS/TEX bytes and produce a base64-encoded PNG.
fn decode_texture_bytes_impl(data: &[u8]) -> Result<DecodedImage, String> {
    if data.len() < 4 {
        return Err("Data too small to be a valid texture".to_string());
    }

    let texture = parse_texture_any(data)?;

    let rgba_image = texture
        .decode_rgba()
        .map_err(|e| format!("Failed to decode texture: {:?}", e))?;

    let format = match &data[0..4] {
        [0x54, 0x45, 0x58, 0x00] => "TEX",
        [0x44, 0x44, 0x53, 0x20] => "DDS",
        _ => "Unknown",
    };

    // Use dimensions from the decoded buffer, not texture metadata (they can differ).
    let actual_width = rgba_image.width();
    let actual_height = rgba_image.height();
    let has_alpha = scan_has_alpha(rgba_image.as_raw());

    let mut png_data = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut png_data);
        encoder
            .write_image(rgba_image.as_raw(), actual_width, actual_height, image::ExtendedColorType::Rgba8)
            .map_err(|e| format!("Failed to encode PNG: {}", e))?;
    }

    Ok(DecodedImage {
        data: STANDARD.encode(&png_data),
        width: actual_width,
        height: actual_height,
        format: format.to_string(),
        has_alpha,
    })
}

/// Decode a DDS or TEX texture file to base64-encoded PNG.
#[tauri::command]
pub async fn decode_dds_to_png(path: String) -> Result<DecodedImage, String> {
    let _t = ipc_trace::enter("decode_dds_to_png");
    let data = fs::read(&path).map_err(|e| format!("Failed to read texture file: {}", e))?;
    decode_texture_bytes_impl(&data)
}

/// Decode raw DDS/TEX bytes (already in memory) to base64-encoded PNG.
#[tauri::command]
pub async fn decode_bytes_to_png(request: tauri::ipc::Request<'_>) -> Result<DecodedImage, String> {
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("decode_bytes_to_png expects raw bytes; got JSON body".into())
        }
    };
    decode_texture_bytes_impl(data)
}

/// Decode a DDS/TEX file to the shader-preview raw-RGBA payload:
/// `[u32 width][u32 height][u32 flags = 0][u32 reserved = 0]` then RGBA
/// rows. The 16-byte header (vs `decode_bytes_to_rgba`'s 8) is the layout
/// the translated-material texture upload consumes; flags stay 0 — the
/// consumer reads only width/height.
#[tauri::command]
pub async fn decode_texture_disk(path: String) -> Result<tauri::ipc::Response, String> {
    let _t = ipc_trace::enter("decode_texture_disk");
    let blob = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let data = fs::read(&path).map_err(|e| format!("read texture '{}': {}", path, e))?;
        let rgba = parse_texture_any(&data)?
            .decode_rgba()
            .map_err(|e| format!("Failed to decode texture: {:?}", e))?;
        let (width, height) = (rgba.width(), rgba.height());
        let pixels = rgba.into_raw();
        // bit 0 = has_alpha, matching the reference header convention.
        let flags: u32 = if scan_has_alpha(&pixels) { 1 } else { 0 };
        let mut buf = Vec::with_capacity(16 + pixels.len());
        buf.extend_from_slice(&width.to_le_bytes());
        buf.extend_from_slice(&height.to_le_bytes());
        buf.extend_from_slice(&flags.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes()); // reserved
        buf.extend_from_slice(&pixels);
        Ok(buf)
    })
    .await
    .map_err(|e| format!("decode task join failed: {e}"))??;
    Ok(tauri::ipc::Response::new(blob))
}

/// Decode raw DDS/TEX bytes to raw RGBA pixels for direct canvas rendering —
/// skips PNG encode, base64, and the browser's PNG decode entirely.
/// Response layout: `[u32 width][u32 height][width×height×4 RGBA bytes]`.
#[tauri::command]
pub async fn decode_bytes_to_rgba(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let _t = ipc_trace::enter("decode_bytes_to_rgba");
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("decode_bytes_to_rgba expects raw bytes; got JSON body".into())
        }
    };
    let rgba = parse_texture_any(data)?
        .decode_rgba()
        .map_err(|e| format!("Failed to decode texture: {:?}", e))?;

    let (width, height) = (rgba.width(), rgba.height());
    let pixels = rgba.into_raw();
    let mut buf = Vec::with_capacity(8 + pixels.len());
    buf.extend_from_slice(&width.to_le_bytes());
    buf.extend_from_slice(&height.to_le_bytes());
    buf.extend_from_slice(&pixels);
    Ok(tauri::ipc::Response::new(buf))
}

