//! TEX ↔ DDS bidirectional converters.
//!
//! Both directions go RGBA-roundtrip:
//!   TEX → decode top mipmap to RGBA → encode as DDS (BC1/BC3 matched
//!         from the source TEX format) → write `<basename>.dds` alongside.
//!   DDS → decode top mipmap to RGBA → encode as TEX (format matched from
//!         the source DDS FourCC) → write `<basename>.tex` alongside.
//!
//! Mipmaps are intentionally disabled in both output paths — matches the
//! existing recolor pipeline. See `commands::file::recolor_single_file`
//! for the in-depth reasoning (League rejects partial mip chains; encoder
//! mip walkers also under-encode sub-block sizes).
//!
//! Both commands return the absolute path of the new file. They never
//! delete the source — caller (frontend or fixer) decides whether to
//! remove the original after the conversion is verified.

use ritoshark::prelude::*;
// rs_io's `Serialize` (provides `.to_bytes()`) must be imported explicitly: the glob
// above is suppressed by the `serde::Serialize` import below, so without this the
// trait method isn't in scope.
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
    /// Width of the decoded top mipmap (post-clamp).
    pub width: u32,
    /// Height of the decoded top mipmap (post-clamp).
    pub height: u32,
    /// Human-readable description of the encode format selected (e.g. "BC3 (DXT5)").
    pub format: String,
}

/// Decode any DDS or TEX file and return its top mipmap as an RGBA image
/// clamped to multiples of 4 (BC1/BC3 block boundary). The clamped buffer
/// is what both writers consume.
fn decode_to_clamped_rgba(data: &[u8]) -> Result<(image::RgbaImage, Texture), String> {
    if data.len() < 4 {
        return Err("File too small to be a valid texture".into());
    }
    // RitoShark's `Texture` is a single struct with two constructors; branch on
    // the 4-byte magic to pick the right one (TEX = b"TEX\0", DDS = b"DDS ").
    let texture = if &data[0..4] == b"DDS " {
        Texture::from_dds_bytes(data)
            .map_err(|e| format!("Failed to parse texture: {:?}", e))?
    } else {
        Texture::from_bytes(data)
            .map_err(|e| format!("Failed to parse texture: {:?}", e))?
    };

    let mut rgba = texture
        .decode_rgba()
        .map_err(|e| format!("Failed to decode top mipmap: {:?}", e))?;

    // Block-compression formats need dims divisible by 4. The recolor path
    // does the same trim (see commands::file::recolor_single_file). We must
    // do it here too so the destination encoder doesn't panic.
    let (w, h) = rgba.dimensions();
    let cw = (w / 4) * 4;
    let ch = (h / 4) * 4;
    if cw != w || ch != h {
        rgba =
            image::imageops::crop_imm(&rgba, 0, 0, cw.max(4), ch.max(4)).to_image();
    }

    Ok((rgba, texture))
}

/// Decode a DDS or TEX file's top mipmap to full RGBA with NO block-boundary
/// crop. Used by the map preview, which uploads pixels straight to a Babylon
/// RawTexture (never re-encodes), so the multiple-of-4 crop that
/// `decode_to_clamped_rgba` applies for re-encoding is both unnecessary and
/// would shift UVs. Returns the decoded RGBA image.
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

/// Convert a TEX file to a sibling .dds.
///
/// Format selection: RitoShark's `Texture::format` (BC1 / BC3 / RGBA8) is
/// mapped to the matching `image_dds::ImageFormat`. Anything we can't map
/// falls through to BC3 — the output is valid and preserves alpha.
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

    let (rgba, texture) = decode_to_clamped_rgba(&data)?;

    // Pick a DDS format that matches the source TEX. We use whatever
    // RitoShark parsed as its on-disk format — that's the most truthful
    // mapping (BC1 source → BC1 destination, BC3 → BC3, etc.). Any format
    // image_dds can't encode (ETC mobile formats, BC5/BC7, the alt/snorm
    // variants) falls back to BC3, which preserves alpha and is widely
    // supported.
    let (dds_format, label) = match texture.format {
        TexFormat::Bc1 => (image_dds::ImageFormat::BC1RgbaUnorm, "BC1 (DXT1)"),
        TexFormat::Bc3 => (image_dds::ImageFormat::BC3RgbaUnorm, "BC3 (DXT5)"),
        TexFormat::Bgra8 => (image_dds::ImageFormat::Rgba8Unorm, "RGBA8"),
        _ => (image_dds::ImageFormat::BC3RgbaUnorm, "BC3 (fallback)"),
    };

    let new_dds = image_dds::dds_from_image(
        &rgba,
        dds_format,
        image_dds::Quality::Normal,
        image_dds::Mipmaps::Disabled,
    )
    .map_err(|e| format!("Failed to encode DDS: {:?}", e))?;

    let out_path = src.with_extension("dds");
    let mut output = fs::File::create(&out_path)
        .map_err(|e| format!("Failed to create output file: {}", e))?;
    new_dds
        .write(&mut output)
        .map_err(|e| format!("Failed to write DDS: {}", e))?;

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

    let (rgba, _) = decode_to_clamped_rgba(&data)?;

    // Read the DDS header again with ddsfile to look up the FourCC. We
    // need the FourCC to pick the matching TEX format; the decoded RGBA
    // image alone doesn't tell us the original on-disk format.
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
        // Uncompressed DDS — pick RGBA8 if we have alpha bits, else BC3
        // for size. Headers without FourCC are rare for skin textures so
        // we don't bend over backwards here.
        (TexFormat::Bgra8, "RGBA8")
    };

    // RitoShark's `Texture::encode` only handles the block-compressed formats;
    // build the uncompressed Bgra8 surface directly via `from_rgba_bgra8`.
    let new_tex = match tex_format {
        TexFormat::Bgra8 => Texture::from_rgba_bgra8(&rgba),
        _ => Texture::encode(&rgba, tex_format, false)
            .map_err(|e| format!("Failed to encode TEX: {:?}", e))?,
    };

    // RitoShark's writer emits `unknown1` (header byte 8) as 1; League's
    // original TEX files use 0x01 for BC1/BC3. The recolor path patches this
    // from the *source* TEX byte 8, but we don't have a source TEX here. Set
    // it to 0x01 for BC1/BC3 (matches Riot's pattern) and 0x00 for RGBA8.
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
    let (rgba, _) = decode_to_clamped_rgba(&data)?;

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

    let (rgba, texture) = decode_to_clamped_rgba(data)?;
    let dds_format = match texture.format {
        TexFormat::Bc1 => image_dds::ImageFormat::BC1RgbaUnorm,
        TexFormat::Bgra8 => image_dds::ImageFormat::Rgba8Unorm,
        _ => image_dds::ImageFormat::BC3RgbaUnorm,
    };

    let new_dds = image_dds::dds_from_image(
        &rgba,
        dds_format,
        image_dds::Quality::Normal,
        image_dds::Mipmaps::Disabled,
    )
    .map_err(|e| format!("Failed to encode DDS: {:?}", e))?;

    let mut buf = Vec::new();
    new_dds.write(&mut buf).map_err(|e| format!("Failed to serialize DDS: {}", e))?;
    Ok(tauri::ipc::Response::new(buf))
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

    let (rgba, _) = decode_to_clamped_rgba(data)?;

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

    // RitoShark's `Texture::encode` only handles block-compressed formats;
    // build the uncompressed Bgra8 surface directly via `from_rgba_bgra8`.
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
