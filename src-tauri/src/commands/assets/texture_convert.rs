//! TEX ↔ DDS bidirectional converters.
//!
//! Both directions go RGBA-roundtrip:
//!   TEX → decode top mipmap to RGBA → encode as DDS (BC1/BC3 matched
//!         from the source TEX format) → write `<basename>.dds` alongside.
//!   DDS → decode top mipmap to RGBA → encode as TEX (format matched from
//!         the source DDS FourCC) → write `<basename>.tex` alongside.
//!
//! Mipmaps are disabled in both output paths — League rejects partial mip
//! chains.
//!
//! Both commands return the absolute path of the new file and never delete
//! the source.

use ritoshark::prelude::*;
use ritoshark::prelude::Serialize as _;
use ritoshark::tex::{TexFormat, Texture};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use crate::core::ipc_trace;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionResult {
    /// Absolute path to the file that was written.
    pub output_path: String,
    /// Width of the decoded top mipmap.
    pub width: u32,
    /// Height of the decoded top mipmap.
    pub height: u32,
    /// Human-readable description of the encode format selected (e.g. "BC3 (DXT5)").
    pub format: String,
}

/// Decode any DDS or TEX file and return its top mipmap as an RGBA image at its
/// real size. Every writer downstream pads to the block grid itself, so cropping
/// to a multiple of 4 here would only shrink the texture and shift its UVs.
fn decode_texture_rgba(data: &[u8]) -> Result<(image::RgbaImage, Texture), String> {
    if data.len() < 4 {
        return Err("File too small to be a valid texture".into());
    }
    // Branch on the 4-byte magic (TEX = b"TEX\0", DDS = b"DDS ").
    let texture = if &data[0..4] == b"DDS " {
        Texture::from_dds_bytes(data)
            .map_err(|e| format!("Failed to parse texture: {:?}", e))?
    } else {
        Texture::from_bytes(data)
            .map_err(|e| format!("Failed to parse texture: {:?}", e))?
    };

    let rgba = texture
        .decode_rgba()
        .map_err(|e| format!("Failed to decode top mipmap: {:?}", e))?;

    Ok((rgba, texture))
}

/// Decode a DDS or TEX file's top mipmap to full RGBA with NO block-boundary
/// crop (the map preview uploads pixels straight to a RawTexture, where the
/// multiple-of-4 crop would shift UVs).
pub(crate) fn decode_full_rgba(data: &[u8]) -> Result<image::RgbaImage, String> {
    if data.len() < 4 {
        return Err("File too small to be a valid texture".into());
    }
    let texture = if &data[0..4] == b"DDS " {
        Texture::from_dds_bytes(data).map_err(|e| format!("Failed to parse texture: {:?}", e))?
    } else {
        Texture::from_bytes(data).map_err(|e| format!("Failed to parse texture: {:?}", e))?
    };
    texture
        .decode_rgba()
        .map_err(|e| format!("Failed to decode top mipmap: {:?}", e))
}

/// Encode RGBA pixels as a DDS in `format`, falling back to BC3 for anything a DDS
/// can't carry. Returns the bytes and a human-readable format label.
///
/// Only BC1, BC3 and BGRA8 have a legacy pixel format. BC5 and BC7 exist solely under
/// the DX10 extension — a FourCC and a 20-byte header the game's D3D9-era loader can't
/// read, so such a file crashes the client — and so get BC3 here instead.
fn encode_dds(
    rgba: &image::RgbaImage,
    format: TexFormat,
) -> Result<(Vec<u8>, &'static str), String> {
    let (bytes, label) = match format {
        TexFormat::Bc1 | TexFormat::Bc1Alt => {
            (ritoshark::tex::write_dds_bytes_bc(rgba, TexFormat::Bc1), "BC1 (DXT1)")
        }
        TexFormat::Bc3 => (ritoshark::tex::write_dds_bytes_bc(rgba, TexFormat::Bc3), "BC3 (DXT5)"),
        TexFormat::Bgra8 => (ritoshark::tex::write_dds_bytes(rgba), "BGRA8"),
        _ => (
            ritoshark::tex::write_dds_bytes_bc(rgba, TexFormat::Bc3),
            "BC3 (fallback)",
        ),
    };
    Ok((
        bytes.map_err(|e| format!("Failed to encode DDS: {:?}", e))?,
        label,
    ))
}

/// Convert a TEX file to a sibling .dds.
///
/// Format selection: the source `Texture::format` is written back as itself when a
/// DDS can carry it. BC5 and BC7 can't be, and fall through to BC3 — the output is
/// valid, loadable by the client, and preserves alpha.
#[tauri::command]
pub async fn convert_tex_to_dds(path: String) -> Result<ConversionResult, String> {
    let _t = ipc_trace::enter("convert_tex_to_dds");
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("File not found: {}", path));
    }

    let data = fs::read(&src).map_err(|e| format!("Failed to read file: {}", e))?;
    if data.len() < 4 || &data[0..4] != b"TEX\0" {
        return Err("Not a TEX file (magic 'TEX\\0' missing)".into());
    }

    let (rgba, texture) = decode_texture_rgba(&data)?;

    let (dds_bytes, label) = encode_dds(&rgba, texture.format)?;

    let out_path = src.with_extension("dds");
    fs::write(&out_path, &dds_bytes).map_err(|e| format!("Failed to write DDS: {}", e))?;

    Ok(ConversionResult {
        output_path: out_path.to_string_lossy().into_owned(),
        width: rgba.width(),
        height: rgba.height(),
        format: label.to_string(),
    })
}

/// Convert a DDS file to a sibling .tex.
///
/// Format selection: ddsfile's FourCC is matched to the closest
/// `ritoshark::tex::TexFormat`. Unknown FourCCs default to BC3 (the
/// safest common denominator for skin textures).
#[tauri::command]
pub async fn convert_dds_to_tex(path: String) -> Result<ConversionResult, String> {
    let _t = ipc_trace::enter("convert_dds_to_tex");
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("File not found: {}", path));
    }

    let data = fs::read(&src).map_err(|e| format!("Failed to read file: {}", e))?;
    if data.len() < 4 || &data[0..4] != b"DDS " {
        return Err("Not a DDS file (magic 'DDS ' missing)".into());
    }

    let (rgba, _) = decode_texture_rgba(&data)?;

    // The FourCC picks the matching TEX format; the RGBA buffer alone doesn't carry it.
    let mut cursor = Cursor::new(&data);
    let dds = ddsfile::Dds::read(&mut cursor)
        .map_err(|e| format!("Failed to parse DDS header: {}", e))?;

    let (tex_format, label) = if let Some(fourcc) = dds.header.spf.fourcc {
        if fourcc.0 == u32::from_le_bytes(*b"DXT1") {
            (TexFormat::Bc1, "BC1 (DXT1)")
        } else if fourcc.0 == u32::from_le_bytes(*b"DXT5") {
            (TexFormat::Bc3, "BC3 (DXT5)")
        } else {
            (TexFormat::Bc3, "BC3 (default)")
        }
    } else {
        (TexFormat::Bgra8, "RGBA8")
    };

    // Texture::encode handles only block-compressed formats; build Bgra8 directly.
    let new_tex = match tex_format {
        TexFormat::Bgra8 => Texture::from_rgba_bgra8(&rgba),
        _ => Texture::encode(&rgba, tex_format, false)
            .map_err(|e| format!("Failed to encode TEX: {:?}", e))?,
    };

    // Header byte 8: 0x01 for BC1/BC3 (Riot's pattern), 0x00 for RGBA8.
    let mut tex_bytes: Vec<u8> = new_tex
        .to_bytes()
        .map_err(|e| format!("Failed to encode TEX to buffer: {:?}", e))?;
    if tex_bytes.len() >= 9 {
        tex_bytes[8] = match tex_format {
            TexFormat::Bc1 | TexFormat::Bc3 => 0x01,
            _ => 0x00,
        };
    }

    let out_path = src.with_extension("tex");
    fs::write(&out_path, &tex_bytes).map_err(|e| format!("Failed to write TEX: {}", e))?;

    Ok(ConversionResult {
        output_path: out_path.to_string_lossy().into_owned(),
        width: rgba.width(),
        height: rgba.height(),
        format: label.to_string(),
    })
}

/// Decode a PNG (or any format `image` reads) into RGBA clamped to multiples of
/// 4, ready for a block-compressed encoder.
fn png_to_clamped_rgba(data: &[u8]) -> Result<image::RgbaImage, String> {
    let img = image::load_from_memory(data)
        .map_err(|e| format!("Failed to decode image: {}", e))?;
    let mut rgba = img.to_rgba8();

    let (w, h) = rgba.dimensions();
    if w < 4 || h < 4 {
        return Err(format!(
            "Image is {w}×{h}; block-compressed textures need at least 4×4"
        ));
    }
    // BC1/BC3 encode in 4×4 blocks — anything else makes the encoder panic or
    // silently truncate, so crop down to the block boundary like the TEX/DDS
    // decode path does.
    let cw = (w / 4) * 4;
    let ch = (h / 4) * 4;
    if cw != w || ch != h {
        rgba = image::imageops::crop_imm(&rgba, 0, 0, cw, ch).to_image();
    }
    Ok(rgba)
}

/// True when any pixel is not fully opaque. BC1 carries at most 1-bit alpha, so
/// a texture with real transparency has to go to BC3.
fn has_alpha(rgba: &image::RgbaImage) -> bool {
    rgba.pixels().any(|p| p.0[3] != 255)
}

/// Which TEX format a PNG should encode to, by name, defaulting on alpha.
fn tex_format_from_name(name: Option<&str>, rgba: &image::RgbaImage) -> (TexFormat, &'static str) {
    match name.map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("bc1") | Some("dxt1") => (TexFormat::Bc1, "BC1 (DXT1)"),
        Some("bc3") | Some("dxt5") => (TexFormat::Bc3, "BC3 (DXT5)"),
        Some("rgba8") | Some("bgra8") => (TexFormat::Bgra8, "RGBA8"),
        // Unspecified: BC3 keeps transparency, BC1 is half the size without it.
        _ if has_alpha(rgba) => (TexFormat::Bc3, "BC3 (DXT5, alpha detected)"),
        _ => (TexFormat::Bc1, "BC1 (DXT1, no alpha)"),
    }
}

/// Convert a PNG to a sibling `.tex`.
///
/// `format` picks the encoding (`bc1`/`dxt1`, `bc3`/`dxt5`, `rgba8`); omit it to
/// choose by whether the image actually has transparency.
#[tauri::command]
pub async fn convert_png_to_tex(
    path: String,
    format: Option<String>,
) -> Result<ConversionResult, String> {
    let _t = ipc_trace::enter("convert_png_to_tex");
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("File not found: {}", path));
    }

    let data = fs::read(&src).map_err(|e| format!("Failed to read file: {}", e))?;
    let rgba = png_to_clamped_rgba(&data)?;
    let (tex_format, label) = tex_format_from_name(format.as_deref(), &rgba);

    let new_tex = match tex_format {
        // Texture::encode handles only block-compressed formats.
        TexFormat::Bgra8 => Texture::from_rgba_bgra8(&rgba),
        _ => Texture::encode(&rgba, tex_format, false)
            .map_err(|e| format!("Failed to encode TEX: {:?}", e))?,
    };

    let mut tex_bytes: Vec<u8> = new_tex
        .to_bytes()
        .map_err(|e| format!("Failed to encode TEX to buffer: {:?}", e))?;
    // Header byte 8: 0x01 for BC1/BC3 (Riot's pattern), 0x00 for RGBA8.
    if tex_bytes.len() >= 9 {
        tex_bytes[8] = match tex_format {
            TexFormat::Bc1 | TexFormat::Bc3 => 0x01,
            _ => 0x00,
        };
    }

    let out_path = src.with_extension("tex");
    fs::write(&out_path, &tex_bytes).map_err(|e| format!("Failed to write TEX: {}", e))?;

    Ok(ConversionResult {
        output_path: out_path.to_string_lossy().into_owned(),
        width: rgba.width(),
        height: rgba.height(),
        format: label.to_string(),
    })
}

/// Convert a PNG to a sibling `.dds`. Same format selection as `convert_png_to_tex`.
#[tauri::command]
pub async fn convert_png_to_dds(
    path: String,
    format: Option<String>,
) -> Result<ConversionResult, String> {
    let _t = ipc_trace::enter("convert_png_to_dds");
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("File not found: {}", path));
    }

    let data = fs::read(&src).map_err(|e| format!("Failed to read file: {}", e))?;
    let rgba = png_to_clamped_rgba(&data)?;
    let (tex_format, label) = tex_format_from_name(format.as_deref(), &rgba);

    let texture = match tex_format {
        TexFormat::Bgra8 => Texture::from_rgba_bgra8(&rgba),
        _ => Texture::encode(&rgba, tex_format, false)
            .map_err(|e| format!("Failed to encode texture: {:?}", e))?,
    };

    let dds_bytes = texture
        .to_dds_bytes()
        .map_err(|e| format!("Failed to encode DDS: {:?}", e))?;

    let out_path = src.with_extension("dds");
    fs::write(&out_path, &dds_bytes).map_err(|e| format!("Failed to write DDS: {}", e))?;

    Ok(ConversionResult {
        output_path: out_path.to_string_lossy().into_owned(),
        width: rgba.width(),
        height: rgba.height(),
        format: label.to_string(),
    })
}

/// In-memory PNG → TEX, for converting bytes that never touch disk (a chunk
/// pulled from a WAD, a paste). Body must be raw (use `invokeRaw`).
#[tauri::command]
pub async fn convert_png_bytes_to_tex(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let _t = ipc_trace::enter("convert_png_bytes_to_tex");
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("convert_png_bytes_to_tex expects a raw body".into()),
    };
    let format = request
        .headers()
        .get("tex-format")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let rgba = png_to_clamped_rgba(&data)?;
    let (tex_format, _) = tex_format_from_name(format.as_deref(), &rgba);

    let texture = match tex_format {
        TexFormat::Bgra8 => Texture::from_rgba_bgra8(&rgba),
        _ => Texture::encode(&rgba, tex_format, false)
            .map_err(|e| format!("Failed to encode TEX: {:?}", e))?,
    };
    let mut tex_bytes: Vec<u8> = texture
        .to_bytes()
        .map_err(|e| format!("Failed to encode TEX to buffer: {:?}", e))?;
    if tex_bytes.len() >= 9 {
        tex_bytes[8] = match tex_format {
            TexFormat::Bc1 | TexFormat::Bc3 => 0x01,
            _ => 0x00,
        };
    }
    Ok(tauri::ipc::Response::new(tex_bytes))
}

/// Convert a TEX or DDS file to PNG (alongside the source). Useful for
/// quickly grabbing a viewable copy without rounding through the preview
/// pane. Returns the new file path so the caller can show it in Explorer.
#[tauri::command]
pub async fn convert_texture_to_png(path: String) -> Result<ConversionResult, String> {
    let _t = ipc_trace::enter("convert_texture_to_png");
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("File not found: {}", path));
    }

    let data = fs::read(&src).map_err(|e| format!("Failed to read file: {}", e))?;
    let (rgba, _) = decode_texture_rgba(&data)?;

    let out_path = src.with_extension("png");
    let mut png_bytes = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        encoder
            .write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| format!("Failed to encode PNG: {}", e))?;
    }
    fs::write(&out_path, &png_bytes).map_err(|e| format!("Failed to write PNG: {}", e))?;

    Ok(ConversionResult {
        output_path: out_path.to_string_lossy().into_owned(),
        width: rgba.width(),
        height: rgba.height(),
        format: "PNG (RGBA8)".to_string(),
    })
}

/// In-memory variant: take raw bytes, return raw bytes. The frontend uses
/// this when converting a chunk it pulled from a WAD without ever touching
/// disk. Body must be raw (use `invokeRaw`).
#[tauri::command]
pub async fn convert_tex_bytes_to_dds(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let _t = ipc_trace::enter("convert_tex_bytes_to_dds");
    let data: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("convert_tex_bytes_to_dds expects raw bytes".into())
        }
    };
    if data.len() < 4 || &data[0..4] != b"TEX\0" {
        return Err("Not a TEX file".into());
    }

    let (rgba, texture) = decode_texture_rgba(data)?;
    let (dds_bytes, _) = encode_dds(&rgba, texture.format)?;
    Ok(tauri::ipc::Response::new(dds_bytes))
}

/// Reverse of `convert_tex_bytes_to_dds`. Same raw-body contract.
#[tauri::command]
pub async fn convert_dds_bytes_to_tex(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let _t = ipc_trace::enter("convert_dds_bytes_to_tex");
    let data: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("convert_dds_bytes_to_tex expects raw bytes".into())
        }
    };
    if data.len() < 4 || &data[0..4] != b"DDS " {
        return Err("Not a DDS file".into());
    }

    let (rgba, _) = decode_texture_rgba(data)?;

    let mut cursor = Cursor::new(data);
    let dds = ddsfile::Dds::read(&mut cursor)
        .map_err(|e| format!("Failed to parse DDS header: {}", e))?;

    let tex_format = if let Some(fourcc) = dds.header.spf.fourcc {
        if fourcc.0 == u32::from_le_bytes(*b"DXT1") {
            TexFormat::Bc1
        } else {
            TexFormat::Bc3
        }
    } else {
        TexFormat::Bgra8
    };

    // Texture::encode handles only block-compressed formats; build Bgra8 directly.
    let new_tex = match tex_format {
        TexFormat::Bgra8 => Texture::from_rgba_bgra8(&rgba),
        _ => Texture::encode(&rgba, tex_format, false)
            .map_err(|e| format!("Failed to encode TEX: {:?}", e))?,
    };

    let mut buf: Vec<u8> = new_tex
        .to_bytes()
        .map_err(|e| format!("Failed to serialize TEX: {:?}", e))?;
    if buf.len() >= 9 {
        buf[8] = match tex_format {
            TexFormat::Bc1 | TexFormat::Bc3 => 0x01,
            _ => 0x00,
        };
    }

    Ok(tauri::ipc::Response::new(buf))
}

/// What `fix_texture_alignment` did to one file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlignmentFixResult {
    pub path: String,
    pub old_width: u32,
    pub old_height: u32,
    pub width: u32,
    pub height: u32,
    pub format: String,
    /// True when the source shipped a mip chain the re-encode did not reproduce.
    pub mipmaps_dropped: bool,
}

/// Round up to the next multiple of 4, never below one whole block.
fn fit_to_block(value: u32) -> u32 {
    value.div_ceil(4).max(1) * 4
}

/// Resize a block-compressed texture up to the next multiple of 4 on both axes,
/// rewriting it in place in its own container and format.
///
/// Rounding UP resamples the whole image; rounding down would crop up to three
/// pixel rows off the edge, and the BIN's UVs know nothing about either. Upscaling
/// is the one that keeps every pixel the author drew.
#[tauri::command]
pub async fn fix_texture_alignment(path: String) -> Result<AlignmentFixResult, String> {
    let _t = ipc_trace::enter("fix_texture_alignment");
    let src = PathBuf::from(&path);
    let data = fs::read(&src).map_err(|e| format!("Failed to read file: {}", e))?;
    let is_dds = data.len() >= 4 && &data[0..4] == b"DDS ";

    let (rgba, texture) = decode_texture_rgba(&data)?;
    let (w, h) = rgba.dimensions();
    let (tw, th) = (fit_to_block(w), fit_to_block(h));
    if (tw, th) == (w, h) {
        return Err(format!("{w}×{h} is already a multiple of 4."));
    }

    let resized = image::imageops::resize(&rgba, tw, th, image::imageops::FilterType::Lanczos3);
    let mipmaps_dropped = flint_core::bin::texture_header::read_texture_header(&data)
        .map(|h| h.has_mipmaps)
        .unwrap_or(false);

    let (bytes, format) = if is_dds {
        let (b, label) = encode_dds(&resized, texture.format)?;
        (b, label.to_string())
    } else {
        let new_tex = match texture.format {
            TexFormat::Bgra8 => Texture::from_rgba_bgra8(&resized),
            fmt => Texture::encode(&resized, fmt, false)
                .map_err(|e| format!("Failed to encode TEX: {:?}", e))?,
        };
        let mut buf = new_tex
            .to_bytes()
            .map_err(|e| format!("Failed to serialize TEX: {:?}", e))?;
        if buf.len() >= 9 {
            buf[8] = match texture.format {
                TexFormat::Bgra8 => 0x00,
                _ => 0x01,
            };
        }
        (buf, format!("{:?}", texture.format))
    };

    fs::write(&src, &bytes).map_err(|e| format!("Failed to write texture: {}", e))?;

    Ok(AlignmentFixResult {
        path,
        old_width: w,
        old_height: h,
        width: tw,
        height: th,
        format,
        mipmaps_dropped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alignment_rounds_up_and_never_below_one_block() {
        // Rounding UP is the product decision: down would crop pixels the BIN's UVs
        // still expect. 4 is the floor because a block is 4x4.
        assert_eq!(fit_to_block(1), 4);
        assert_eq!(fit_to_block(4), 4);
        assert_eq!(fit_to_block(5), 8);
        assert_eq!(fit_to_block(126), 128);
        assert_eq!(fit_to_block(1023), 1024);
    }

    #[test]
    fn an_aligned_texture_is_left_alone() {
        for size in [4u32, 64, 256, 1024] {
            assert_eq!(fit_to_block(size), size);
        }
    }
}
