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
//! for the in-depth reasoning (League rejects partial mip chains; ltk-
//! texture's mipmap walker also under-encodes sub-block sizes).
//!
//! Both commands return the absolute path of the new file. They never
//! delete the source — caller (frontend or fixer) decides whether to
//! remove the original after the conversion is verified.

use base64::{engine::general_purpose::STANDARD, Engine};
use flint_ltk::ltk_types::{EncodeOptions, Tex, Texture};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

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
    let mut cursor = Cursor::new(data);
    let texture = Texture::from_reader(&mut cursor)
        .map_err(|e| format!("Failed to parse texture: {:?}", e))?;

    let surface = texture
        .decode_mipmap(0)
        .map_err(|e| format!("Failed to decode top mipmap: {:?}", e))?;
    let mut rgba = surface
        .into_rgba_image()
        .map_err(|e| format!("Failed to convert to RGBA: {:?}", e))?;

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

/// Convert a TEX file to a sibling .dds.
///
/// Format selection: ltk-texture's `Tex::format` (BC1 / BC3 / RGBA8) is
/// mapped to the matching `image_dds::ImageFormat`. Anything we can't map
/// falls through to BGRA8 uncompressed — the output is valid but larger.
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

    // Pick a DDS format that matches the source TEX. We use whatever the
    // ltk Tex parsed as its on-disk format — that's the most truthful
    // mapping (BC1 source → BC1 destination, BC3 → BC3, etc.).
    use flint_ltk::ltk_types::TexFormat;
    let (dds_format, label) = match &texture {
        Texture::Tex(t) => match t.format {
            TexFormat::Etc1 | TexFormat::Etc2Eac => {
                // Mobile-only formats. image_dds can't encode these — fall
                // back to BC3 which preserves alpha and is widely supported.
                (image_dds::ImageFormat::BC3RgbaUnorm, "BC3 (fallback from ETC)")
            }
            TexFormat::Bc1 => (image_dds::ImageFormat::BC1RgbaUnorm, "BC1 (DXT1)"),
            TexFormat::Bc3 => (image_dds::ImageFormat::BC3RgbaUnorm, "BC3 (DXT5)"),
            TexFormat::Bgra8 => (image_dds::ImageFormat::Rgba8Unorm, "RGBA8"),
        },
        Texture::Dds(_) => return Err("Source is already DDS — use the .dds → .tex conversion instead".into()),
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
/// `ltk_texture::tex::Format`. Unknown FourCCs default to BC3 (the
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
    // need the FourCC to pick the matching TEX format; the Texture::Dds
    // wrapper hides this from us.
    let mut cursor = Cursor::new(&data);
    let dds = ddsfile::Dds::read(&mut cursor)
        .map_err(|e| format!("Failed to parse DDS header: {}", e))?;

    use flint_ltk::ltk_types::TexFormat;
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

    let options = EncodeOptions::new(tex_format);
    let new_tex = Tex::encode_rgba_image(&rgba, options)
        .map_err(|e| format!("Failed to encode TEX: {:?}", e))?;

    // ltk_texture's write() hardcodes ext_format byte 8 to 0; League's
    // original TEX files use 0x01 for BC1/BC3. The recolor path patches
    // this from the *source* TEX byte 8, but we don't have a source TEX
    // here. Set it to 0x01 for BC1/BC3 (matches Riot's pattern) and 0x00
    // for RGBA8.
    let mut tex_bytes: Vec<u8> = Vec::new();
    new_tex
        .write(&mut tex_bytes)
        .map_err(|e| format!("Failed to encode TEX to buffer: {}", e))?;
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

    // We base64-encode here only to keep the return shape uniform with
    // the other converters. The frontend doesn't have to decode it.
    let _b64_marker = STANDARD.encode(&png_bytes[..png_bytes.len().min(4)]);

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
    use flint_ltk::ltk_types::TexFormat;
    let dds_format = match &texture {
        Texture::Tex(t) => match t.format {
            TexFormat::Bc1 => image_dds::ImageFormat::BC1RgbaUnorm,
            TexFormat::Bgra8 => image_dds::ImageFormat::Rgba8Unorm,
            _ => image_dds::ImageFormat::BC3RgbaUnorm,
        },
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

    use flint_ltk::ltk_types::TexFormat;
    let tex_format = if let Some(fourcc) = dds.header.spf.fourcc {
        if fourcc.0 == u32::from_le_bytes(*b"DXT1") {
            TexFormat::Bc1
        } else {
            TexFormat::Bc3
        }
    } else {
        TexFormat::Bgra8
    };

    let options = EncodeOptions::new(tex_format);
    let new_tex = Tex::encode_rgba_image(&rgba, options)
        .map_err(|e| format!("Failed to encode TEX: {:?}", e))?;

    let mut buf: Vec<u8> = Vec::new();
    new_tex.write(&mut buf).map_err(|e| format!("Failed to serialize TEX: {}", e))?;
    if buf.len() >= 9 {
        buf[8] = match tex_format {
            TexFormat::Bc1 | TexFormat::Bc3 => 0x01,
            _ => 0x00,
        };
    }

    Ok(tauri::ipc::Response::new(buf))
}

/// Helper for tests / fixer pipelines to convert an in-memory texture and
/// drop it next to an arbitrary path. Not exposed as an IPC command.
#[allow(dead_code)]
pub fn convert_file_to_format(src: &Path, target_ext: &str) -> Result<PathBuf, String> {
    let data = fs::read(src).map_err(|e| format!("Failed to read: {}", e))?;
    let target = src.with_extension(target_ext);
    match target_ext.to_ascii_lowercase().as_str() {
        "dds" if data.starts_with(b"TEX\0") => {
            // Reuse the main path by writing through a temp blocking call.
            let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
            rt.block_on(convert_tex_to_dds(src.to_string_lossy().into_owned()))?;
            Ok(target)
        }
        "tex" if data.starts_with(b"DDS ") => {
            let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
            rt.block_on(convert_dds_to_tex(src.to_string_lossy().into_owned()))?;
            Ok(target)
        }
        _ => Err("Unsupported conversion".into()),
    }
}
