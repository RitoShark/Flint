use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use image::{RgbaImage, Rgba};
use ritoshark::prelude::*;
use ritoshark::prelude::Serialize as _;
use ritoshark::tex::{TexFormat, Texture};
use std::io::Cursor;
use std::process::Command;
use crate::core::ipc_trace;

static FLOOR_PNG: &[u8] = include_bytes!("../../../resources/floor.png");
// Skybox cubemap faces (WebP, SRU sky). Babylon builds a CubeTexture from these
// 6 images; order matches +X,-X,+Y,-Y,+Z,-Z (px,nx,py,ny,pz,nz).
static SKYBOX_PX: &[u8] = include_bytes!("../../../resources/skybox/px.webp");
static SKYBOX_NX: &[u8] = include_bytes!("../../../resources/skybox/nx.webp");
static SKYBOX_PY: &[u8] = include_bytes!("../../../resources/skybox/py.webp");
static SKYBOX_NY: &[u8] = include_bytes!("../../../resources/skybox/ny.webp");
static SKYBOX_PZ: &[u8] = include_bytes!("../../../resources/skybox/pz.webp");
static SKYBOX_NZ: &[u8] = include_bytes!("../../../resources/skybox/nz.webp");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    pub size: u64,
    pub file_type: String,
    pub extension: String,
    /// For images: width x height
    pub dimensions: Option<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecodedImage {
    /// Base64-encoded PNG data
    pub data: String,
    pub width: u32,
    pub height: u32,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecolorFolderResult {
    pub processed: u32,
    pub failed: u32,
}

// =============================================================================
// HSL Color Transformation Helpers
// =============================================================================

fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;

    if max == min {
        return (0.0, 0.0, l);
    }

    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };

    let mut h = if max == r {
        (g - b) / d + (if g < b { 6.0 } else { 0.0 })
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    h /= 6.0;

    (h * 360.0, s, l)
}

fn hue_to_rgb(p: f32, q: f32, mut t: f32) -> f32 {
    if t < 0.0 { t += 1.0; }
    if t > 1.0 { t -= 1.0; }
    if t < 1.0/6.0 { return p + (q - p) * 6.0 * t; }
    if t < 1.0/2.0 { return q; }
    if t < 2.0/3.0 { return p + (q - p) * (2.0/3.0 - t) * 6.0; }
    p
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    if s == 0.0 {
        return (l, l, l);
    }

    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;

    let h = h / 360.0;
    let r = hue_to_rgb(p, q, h + 1.0/3.0);
    let g = hue_to_rgb(p, q, h);
    let b = hue_to_rgb(p, q, h - 1.0/3.0);

    (r, g, b)
}

fn apply_hsl_to_image(img: &mut RgbaImage, hue_shift: f32, sat_mult: f32, bri_mult: f32) {
    for pixel in img.pixels_mut() {
        let Rgba([r, g, b, a]) = *pixel;

        let rf = r as f32 / 255.0;
        let gf = g as f32 / 255.0;
        let bf = b as f32 / 255.0;

        let (h, s, l) = rgb_to_hsl(rf, gf, bf);

        let new_h = (h + hue_shift) % 360.0;
        let new_h = if new_h < 0.0 { new_h + 360.0 } else { new_h };
        let new_s = (s * sat_mult).clamp(0.0, 1.0);
        let new_l = (l * bri_mult).clamp(0.0, 1.0);

        let (nr, ng, nb) = hsl_to_rgb(new_h, new_s, new_l);

        *pixel = Rgba([
            (nr * 255.0).round() as u8,
            (ng * 255.0).round() as u8,
            (nb * 255.0).round() as u8,
            a
        ]);
    }
}

/// Set all pixels to a target hue while preserving lightness. Skips
/// transparent and very dark pixels to preserve backgrounds.
fn colorize_image_impl(img: &mut RgbaImage, target_hue: f32, preserve_saturation: bool) {
    for pixel in img.pixels_mut() {
        let Rgba([r, g, b, a]) = *pixel;

        if a == 0 {
            continue;
        }

        let rf = r as f32 / 255.0;
        let gf = g as f32 / 255.0;
        let bf = b as f32 / 255.0;

        let (_h, s, l) = rgb_to_hsl(rf, gf, bf);

        // Skip very dark pixels (black backgrounds) at ~10% lightness.
        if l < 0.10 {
            continue;
        }

        let new_s = if preserve_saturation { s } else { 0.7_f32.min(s.max(0.3)) };

        let (nr, ng, nb) = hsl_to_rgb(target_hue, new_s, l);

        *pixel = Rgba([
            (nr * 255.0).round() as u8,
            (ng * 255.0).round() as u8,
            (nb * 255.0).round() as u8,
            a
        ]);
    }
}

/// Detect file type from extension and magic bytes. Generic/auxiliary
/// types `rs_file::detect` doesn't recognise (PNG, JPEG, TGA, SVG, WGEO,
/// Light Grid, Preload, LuaObj) are recovered by [`detect_aux_mime_from_magic`]
/// before falling through to the extension-based guess.
fn detect_file_type(path: &Path, data: &[u8]) -> (String, String) {
    use ritoshark::file::FileKind;

    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let file_type = match ritoshark::file::detect(data) {
        FileKind::PropBin | FileKind::PatchBin => "application/x-bin".to_string(),
        FileKind::Tex => "image/tex".to_string(),
        FileKind::Dds => "image/dds".to_string(),
        FileKind::SkinnedMesh => "model/x-lol-skn".to_string(),
        FileKind::Skeleton => "model/x-lol-skl".to_string(),
        FileKind::AnimUncompressed | FileKind::AnimCompressed => "animation/x-lol-anm".to_string(),
        FileKind::Bnk => "audio/x-wwise-bnk".to_string(),
        FileKind::Wpk => "audio/x-wwise-wpk".to_string(),
        FileKind::MapGeo => "model/x-lol-mapgeo".to_string(),
        FileKind::StaticMeshText => "model/x-lol-sco".to_string(),
        FileKind::StaticMeshBinary => "model/x-lol-scb".to_string(),
        FileKind::Rst => "application/x-stringtable".to_string(),
        FileKind::Wad | FileKind::Rman | FileKind::Unknown => {
            if let Some(mime) = detect_aux_mime_from_magic(data) {
                mime.to_string()
            } else {
                match extension.as_str() {
                    "dds" => "image/dds".to_string(),
                    "tex" => "image/tex".to_string(),
                    "png" => "image/png".to_string(),
                    "jpg" | "jpeg" => "image/jpeg".to_string(),
                    "webp" => "image/webp".to_string(),
                    "tga" => "image/tga".to_string(),
                    "bmp" => "image/bmp".to_string(),
                    "bin" => "application/x-bin".to_string(),
                    "py" | "ritobin" => "text/x-python".to_string(),
                    "json" => "application/json".to_string(),
                    "txt" => "text/plain".to_string(),
                    "lua" => "text/x-lua".to_string(),
                    "xml" => "application/xml".to_string(),
                    "wav" | "ogg" | "mp3" => "audio".to_string(),
                    "skn" | "skl" | "anm" => "model".to_string(),
                    "inibin" | "cfgbin" => "application/x-inibin".to_string(),
                    "stringtable" | "rst" => "application/x-stringtable".to_string(),
                    "manifest" | "rman" => "application/x-manifest".to_string(),
                    "luabin64" | "luabin" => "application/x-luabin".to_string(),
                    "troybin" => "application/x-troybin".to_string(),
                    _ => "application/octet-stream".to_string(),
                }
            }
        }
    };

    (file_type, extension)
}

/// Magic-byte fallback for file types `rs_file::detect` does not recognise.
/// Returns the matching MIME string, or `None`. TGA and Light Grid are last
/// because they're heuristic (no fixed magic) and lowest-confidence.
fn detect_aux_mime_from_magic(data: &[u8]) -> Option<&'static str> {
    let len = data.len();

    if len >= 4 && &data[1..4] == b"PNG" {
        return Some("image/png");
    }
    if len >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF {
        return Some("image/jpeg");
    }
    if len >= 4 && &data[0..4] == b"<svg" {
        return Some("image/svg+xml");
    }
    if len >= 5 && &data[1..5] == b"LuaQ" {
        return Some("application/x-luaobj");
    }
    if len >= 4 && &data[0..4] == b"WGEO" {
        return Some("model/x-lol-wgeo");
    }
    if len >= 7 && &data[0..7] == b"PreLoad" {
        return Some("application/x-preload");
    }
    if len >= 8 && &data[0..8] == b"r3d2sklt" {
        return Some("model/x-lol-skl");
    }
    // TGA heuristic: color-map type byte ∈ {0,1} + image-type byte ∈ {1,2,3,9,10,11}.
    if len >= 3 {
        let color_map_type = data[1];
        let image_type = data[2];
        if (color_map_type == 0 || color_map_type == 1)
            && matches!(image_type, 1 | 2 | 3 | 9 | 10 | 11)
        {
            return Some("image/tga");
        }
    }
    // Light Grid: leading u32 LE == 3.
    if len >= 4 && u32::from_le_bytes([data[0], data[1], data[2], data[3]]) == 3 {
        return Some("application/x-lightgrid");
    }

    None
}

/// Read raw file bytes from disk as a raw-byte IPC response.
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let _t = ipc_trace::enter("read_file_bytes");
    let path = Path::new(&path);

    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }

    let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn read_file_info(path: String) -> Result<FileInfo, String> {
    let _t = ipc_trace::enter("read_file_info");
    let path_buf = std::path::PathBuf::from(&path);

    if !path_buf.exists() {
        return Err(format!("File not found: {}", path));
    }

    read_file_info_inner(path, &path_buf)
}

/// Shared file-info reader — extracted so `inspect_path` can reuse it.
fn read_file_info_inner(path: String, path_buf: &std::path::Path) -> Result<FileInfo, String> {
    let metadata = fs::metadata(path_buf).map_err(|e| format!("Failed to read metadata: {}", e))?;

    // Only read a header chunk for detection — NEVER the whole file (a GB-sized
    // `.wad.client` read in full can abort the process on allocation failure).
    const HEADER_BYTES: u64 = 64 * 1024;
    let data = {
        use std::io::Read;
        let f = fs::File::open(path_buf).map_err(|e| format!("Failed to open file: {}", e))?;
        let mut buf = Vec::new();
        f.take(HEADER_BYTES)
            .read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read file: {}", e))?;
        buf
    };

    let (file_type, extension) = detect_file_type(path_buf, &data);

    let dimensions = if file_type == "image/dds" || file_type == "image/tex" {
        parse_texture_dimensions(&data).ok()
    } else {
        None
    };

    Ok(FileInfo {
        path,
        size: metadata.len(),
        file_type,
        extension,
        dimensions,
    })
}

/// Combined "is this a directory, and if not what's the file info" — single
/// IPC round-trip replacing the `is_directory` + `read_file_info` sequence in
/// [PreviewPanel.tsx]. `info` is None for directories or missing paths.
#[derive(Debug, Clone, Serialize)]
pub struct PathInspection {
    pub is_directory: bool,
    pub info: Option<FileInfo>,
}

#[tauri::command]
pub async fn inspect_path(path: String) -> PathInspection {
    let _t = ipc_trace::enter("inspect_path");
    let path_buf = std::path::PathBuf::from(&path);

    if path_buf.is_dir() {
        return PathInspection { is_directory: true, info: None };
    }
    if !path_buf.exists() {
        return PathInspection { is_directory: false, info: None };
    }

    let info = read_file_info_inner(path, &path_buf).ok();
    PathInspection { is_directory: false, info }
}

/// Parse texture dimensions using RitoShark's rs_tex (handles both DDS and TEX)
fn parse_texture_dimensions(data: &[u8]) -> Result<(u32, u32), String> {
    let texture = parse_texture_any(data)?;
    Ok((texture.width, texture.height))
}

/// Parse a DDS or TEX byte buffer into a RitoShark `Texture`.
///
/// RitoShark's `Texture` is one struct with two constructors; branch on the
/// 4-byte magic (`b"DDS "` → `from_dds_bytes`, otherwise TEX → `from_bytes`).
fn parse_texture_any(data: &[u8]) -> Result<Texture, String> {
    if data.len() < 4 {
        return Err("Data too small to be a valid texture".to_string());
    }
    if &data[0..4] == b"DDS " {
        Texture::from_dds_bytes(data).map_err(|e| format!("Failed to parse texture: {:?}", e))
    } else {
        Texture::from_bytes(data).map_err(|e| format!("Failed to parse texture: {:?}", e))
    }
}

/// Synchronous DDS/TEX → base64 PNG, callable from rayon workers / other
/// commands that need to decode many textures in parallel without going back
/// through the async tauri::command path.
pub fn decode_texture_file_sync(path: &Path) -> Result<String, String> {
    let data = fs::read(path).map_err(|e| format!("Failed to read texture file: {}", e))?;
    Ok(decode_texture_bytes_impl(&data)?.data)
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

/// Read a text file and return its raw UTF-8 bytes as an IPC response.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<tauri::ipc::Response, String> {
    let _t = ipc_trace::enter("read_text_file");
    let path = Path::new(&path);

    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }

    let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    let path = Path::new(&path);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }

    fs::write(path, content).map_err(|e| format!("Failed to write file: {}", e))
}

/// Decode a percent-encoded (`encodeURIComponent`) string back to its raw
/// UTF-8 form. Mirrors JS `decodeURIComponent`; used for header-passed paths
/// that must be ASCII on the wire but can contain spaces / unicode on disk.
fn percent_decode_str(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Save raw bytes to a file (used for binary data like thumbnails).
///
/// The file path is passed via the `path` request header (percent-encoded so it
/// stays ASCII) so the body itself can be a raw byte payload.
#[tauri::command]
pub async fn save_file_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let raw = request
        .headers()
        .get("path")
        .ok_or("Missing 'path' header on save_file_bytes")?
        .to_str()
        .map_err(|e| format!("Invalid 'path' header: {}", e))?;
    // The frontend percent-encodes the path (headers must be ASCII); decode it
    // back to the real OS path (spaces, unicode folder names, etc.).
    let path = percent_decode_str(raw);
    let data: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("save_file_bytes expects raw bytes; got JSON body".into())
        }
    };

    let path = Path::new(&path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }

    fs::write(path, data).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub async fn recolor_image(
    path: String,
    hue: f32,
    saturation: f32,
    brightness: f32,
) -> Result<(), String> {
    recolor_single_file(&path, hue, saturation, brightness).await
}

async fn recolor_single_file(
    path: &str,
    hue: f32,
    saturation: f32,
    brightness: f32,
) -> Result<(), String> {
    let path_buf = PathBuf::from(path);
    if !path_buf.exists() {
        return Err(format!("File not found: {}", path));
    }

    let data = fs::read(&path_buf).map_err(|e| format!("Failed to read file: {}", e))?;
    if data.len() < 4 {
        return Err("File too small".into());
    }

    let is_tex = &data[0..4] == b"TEX\0";
    let is_dds = &data[0..4] == b"DDS ";

    if !is_tex && !is_dds {
        return Err("Not a supported texture format (DDS or TEX)".into());
    }

    let texture = parse_texture_any(&data)?;
    let source_format = texture.format;

    let mut rgba_img = texture.decode_rgba()
        .map_err(|e| format!("Failed to decode mipmap: {:?}", e))?;

    // BC1/BC3 block compression requires dimensions that are multiples of 4;
    // clamp down to avoid corrupt output / panics on oddly-sized textures.
    let (orig_w, orig_h) = rgba_img.dimensions();
    let clamped_w = (orig_w / 4) * 4;
    let clamped_h = (orig_h / 4) * 4;
    if clamped_w != orig_w || clamped_h != orig_h {
        rgba_img = image::imageops::crop_imm(&rgba_img, 0, 0, clamped_w.max(4), clamped_h.max(4)).to_image();
    }

    apply_hsl_to_image(&mut rgba_img, hue, saturation, brightness);

    if is_tex {
        let new_tex = encode_tex_same_format(&rgba_img, source_format)?;

        // Preserve the source ext_format byte (header offset +8); changing
        // BC1/BC3's 0x01 to 0x00 can crash the client.
        let mut tex_bytes: Vec<u8> = new_tex.to_bytes()
            .map_err(|e| format!("Failed to encode TEX to buffer: {:?}", e))?;
        if tex_bytes.len() >= 9 && data.len() >= 9 {
            tex_bytes[8] = data[8];
        }
        fs::write(&path_buf, &tex_bytes).map_err(|e| format!("Failed to write TEX: {}", e))?;
    } else {
        let mut cursor = Cursor::new(&data);
        let dds = ddsfile::Dds::read(&mut cursor).map_err(|e| format!("Failed to parse DDS: {}", e))?;

        let format = if let Some(fourcc) = dds.header.spf.fourcc {
            if fourcc.0 == u32::from_le_bytes(*b"DXT1") {
                image_dds::ImageFormat::BC1RgbaUnorm
            } else {
                image_dds::ImageFormat::BC3RgbaUnorm
            }
        } else {
            image_dds::ImageFormat::Bgra8Unorm
        };

        // Mipmaps disabled — League crashes on partial mip chains.
        let new_dds = image_dds::dds_from_image(
            &rgba_img,
            format,
            image_dds::Quality::Normal,
            image_dds::Mipmaps::Disabled,
        ).map_err(|e| format!("Failed to encode DDS: {:?}", e))?;

        let mut output = fs::File::create(&path_buf).map_err(|e| format!("Failed to create output file: {}", e))?;
        new_dds.write(&mut output).map_err(|e| format!("Failed to write DDS: {}", e))?;
    }

    Ok(())
}

/// Re-encode an RGBA image into a TEX, matching the source texture's format.
/// Mipmaps are OFF (League rejects partial mip chains). `Bgra8` is built
/// uncompressed; ETC formats and `Rgba16Snorm` fall back to BC3; the rest
/// encode to their own format.
fn encode_tex_same_format(rgba: &RgbaImage, format: TexFormat) -> Result<Texture, String> {
    match format {
        TexFormat::Bgra8 => Ok(Texture::from_rgba_bgra8(rgba)),
        TexFormat::Bc1
        | TexFormat::Bc1Alt
        | TexFormat::Bc3
        | TexFormat::Bc5
        | TexFormat::Bc7 => Texture::encode(rgba, format, false)
            .map_err(|e| format!("Failed to encode TEX: {:?}", e)),
        TexFormat::Etc1 | TexFormat::Etc2 | TexFormat::Etc2Eac | TexFormat::Rgba16Snorm => {
            Texture::encode(rgba, TexFormat::Bc3, false)
                .map_err(|e| format!("Failed to encode TEX: {:?}", e))
        }
    }
}

#[tauri::command]
pub async fn recolor_folder(
    path: String,
    hue: f32,
    saturation: f32,
    brightness: f32,
    skip_distortion: Option<bool>,
) -> Result<RecolorFolderResult, String> {
    let root = PathBuf::from(&path);
    if !root.exists() || !root.is_dir() {
        return Err("Invalid folder path".into());
    }

    let should_skip_distortion = skip_distortion.unwrap_or(true);
    let mut processed = 0;
    let mut failed = 0;

    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_lowercase();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
            
            // Skip distortion/distort textures - they use special UV effects
            if should_skip_distortion && (filename.contains("distortion") || filename.contains("distort")) {
                tracing::debug!("Skipping distortion texture: {}", path.display());
                continue;
            }
            
            if ext == "dds" || ext == "tex" {
                match recolor_single_file(&path.to_string_lossy(), hue, saturation, brightness).await {
                    Ok(_) => processed += 1,
                    Err(e) => {
                        tracing::warn!("Failed to recolor {}: {}", path.display(), e);
                        failed += 1;
                    }
                }
            }
        }
    }

    Ok(RecolorFolderResult { processed, failed })
}

#[tauri::command]
pub async fn colorize_image(
    path: String,
    target_hue: f32,
    preserve_saturation: bool,
) -> Result<(), String> {
    colorize_single_file(&path, target_hue, preserve_saturation).await
}

async fn colorize_single_file(
    path: &str,
    target_hue: f32,
    preserve_saturation: bool,
) -> Result<(), String> {
    let path_buf = PathBuf::from(path);
    if !path_buf.exists() {
        return Err(format!("File not found: {}", path));
    }

    let data = fs::read(&path_buf).map_err(|e| format!("Failed to read file: {}", e))?;
    if data.len() < 4 {
        return Err("File too small".into());
    }

    let is_tex = &data[0..4] == b"TEX\0";
    let is_dds = &data[0..4] == b"DDS ";

    if !is_tex && !is_dds {
        return Err("Not a supported texture format (DDS or TEX)".into());
    }

    let texture = parse_texture_any(&data)?;
    let source_format = texture.format;

    let mut rgba_img = texture.decode_rgba()
        .map_err(|e| format!("Failed to decode mipmap: {:?}", e))?;

    // BC1/BC3 block compression requires dimensions that are multiples of 4;
    // clamp down to avoid corrupt output / panics.
    let (orig_w, orig_h) = rgba_img.dimensions();
    let clamped_w = (orig_w / 4) * 4;
    let clamped_h = (orig_h / 4) * 4;
    if clamped_w != orig_w || clamped_h != orig_h {
        rgba_img = image::imageops::crop_imm(&rgba_img, 0, 0, clamped_w.max(4), clamped_h.max(4)).to_image();
    }

    colorize_image_impl(&mut rgba_img, target_hue, preserve_saturation);

    if is_tex {
        let new_tex = encode_tex_same_format(&rgba_img, source_format)?;

        // Preserve the source ext_format byte (offset +8); changing
        // BC1/BC3's 0x01 to 0x00 can crash the client.
        let mut tex_bytes: Vec<u8> = new_tex.to_bytes()
            .map_err(|e| format!("Failed to encode TEX to buffer: {:?}", e))?;
        if tex_bytes.len() >= 9 && data.len() >= 9 {
            tex_bytes[8] = data[8];
        }
        fs::write(&path_buf, &tex_bytes).map_err(|e| format!("Failed to write TEX: {}", e))?;
    } else {
        let mut cursor = Cursor::new(&data);
        let dds = ddsfile::Dds::read(&mut cursor).map_err(|e| format!("Failed to parse DDS: {}", e))?;

        let format = if let Some(fourcc) = dds.header.spf.fourcc {
            if fourcc.0 == u32::from_le_bytes(*b"DXT1") {
                image_dds::ImageFormat::BC1RgbaUnorm
            } else {
                image_dds::ImageFormat::BC3RgbaUnorm
            }
        } else {
            image_dds::ImageFormat::Bgra8Unorm
        };

        // Mipmaps disabled — League crashes on partial mip chains.
        let new_dds = image_dds::dds_from_image(
            &rgba_img,
            format,
            image_dds::Quality::Normal,
            image_dds::Mipmaps::Disabled,
        ).map_err(|e| format!("Failed to encode DDS: {:?}", e))?;

        let mut output = fs::File::create(&path_buf).map_err(|e| format!("Failed to create output file: {}", e))?;
        new_dds.write(&mut output).map_err(|e| format!("Failed to write DDS: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn colorize_folder(
    path: String,
    target_hue: f32,
    preserve_saturation: bool,
    skip_distortion: Option<bool>,
) -> Result<RecolorFolderResult, String> {
    let root = PathBuf::from(&path);
    if !root.exists() || !root.is_dir() {
        return Err("Invalid folder path".into());
    }

    let should_skip_distortion = skip_distortion.unwrap_or(true);
    let mut processed = 0;
    let mut failed = 0;

    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_lowercase();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
            
            // Skip distortion/distort textures - they use special UV effects
            if should_skip_distortion && (filename.contains("distortion") || filename.contains("distort")) {
                tracing::debug!("Skipping distortion texture: {}", path.display());
                continue;
            }
            
            if ext == "dds" || ext == "tex" {
                match colorize_single_file(&path.to_string_lossy(), target_hue, preserve_saturation).await {
                    Ok(_) => processed += 1,
                    Err(e) => {
                        tracing::warn!("Failed to colorize {}: {}", path.display(), e);
                        failed += 1;
                    }
                }
            }
        }
    }

    Ok(RecolorFolderResult { processed, failed })
}

// =============================================================================
// File Management Commands (rename, delete, open, create directory)
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameResult {
    pub old_path: String,
    pub new_path: String,
    pub bin_updates: u32,
}

/// Rename a file or directory, updating references in .bin files when inside `content/`.
#[tauri::command]
pub async fn rename_file(
    project_path: String,
    file_path: String,
    new_name: String,
) -> Result<RenameResult, String> {
    let full_path = PathBuf::from(&project_path).join(&file_path);
    if !full_path.exists() {
        return Err(format!("Path does not exist: {}", file_path));
    }

    let parent = full_path.parent().ok_or("Cannot get parent directory")?;
    let new_full_path = parent.join(&new_name);

    if new_full_path.exists() {
        return Err(format!("A file or folder named '{}' already exists", new_name));
    }

    let project_root = PathBuf::from(&project_path);
    let new_rel_path = new_full_path
        .strip_prefix(&project_root)
        .map_err(|_| "Failed to compute relative path")?
        .to_string_lossy()
        .replace('\\', "/");

    fs::rename(&full_path, &new_full_path)
        .map_err(|e| format!("Failed to rename: {}", e))?;

    let bin_updates = if file_path.starts_with("content/") || file_path.starts_with("content\\") {
        update_bin_references(&project_root, &file_path, &new_rel_path)
    } else {
        0
    };

    Ok(RenameResult {
        old_path: file_path,
        new_path: new_rel_path,
        bin_updates,
    })
}

/// Replace a filename in path strings (case-insensitive).
/// Searches for `/old_name` (with leading slash) so only exact filenames match —
/// e.g. renaming `white.tex` won't touch `blablabla_white.tex`.
fn replace_filename_in_paths(text: &str, old_name: &str, new_name: &str) -> String {
    let search = format!("/{}", old_name).to_lowercase();
    let replace = format!("/{}", new_name);
    let text_lower = text.to_lowercase();
    let mut result = String::with_capacity(text.len());
    let mut last_end = 0;

    for (start, _) in text_lower.match_indices(&search) {
        result.push_str(&text[last_end..start]);
        result.push_str(&replace);
        last_end = start + search.len();
    }
    result.push_str(&text[last_end..]);
    result
}

/// Walk all .bin files in the project and update filename references after a rename.
///
/// Uses the BIN parse→text→modify→write pipeline so that different-length renames
/// are handled correctly (string length prefixes are updated by the serializer).
/// Matches by filename only (case-insensitive) because BIN text uses mixed-case
/// game paths (e.g. `ASSETS/Characters/...`) that differ from the project's lowercase paths.
fn update_bin_references(project_root: &Path, old_rel: &str, new_rel: &str) -> u32 {
    use flint_ltk::bin::{read_bin_ltk, write_bin_ltk, tree_to_text_cached, text_to_tree};

    // Match by filename only — BIN text paths have different casing/prefixes.
    let old_name = match Path::new(old_rel).file_name().and_then(|n| n.to_str()) {
        Some(n) => n.to_string(),
        None => return 0,
    };
    let new_name = match Path::new(new_rel).file_name().and_then(|n| n.to_str()) {
        Some(n) => n.to_string(),
        None => return 0,
    };

    if old_name.eq_ignore_ascii_case(&new_name) {
        return 0;
    }

    let old_name_lower = old_name.to_lowercase();

    let mut count = 0u32;
    for entry in WalkDir::new(project_root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
        if ext != "bin" {
            continue;
        }

        let data = match fs::read(path) {
            Ok(d) => d,
            Err(_) => continue,
        };

        // Skip BIN files that don't contain the old filename at all.
        let old_bytes = old_name_lower.as_bytes();
        let data_lower: Vec<u8> = data.iter().map(|b| b.to_ascii_lowercase()).collect();
        if !data_lower.windows(old_bytes.len()).any(|w| w == old_bytes) {
            continue;
        }

        let tree = match read_bin_ltk(&data) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("Skipping BIN (parse failed) {}: {}", path.display(), e);
                continue;
            }
        };

        let text = match tree_to_text_cached(&tree) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("Skipping BIN (text conv failed) {}: {}", path.display(), e);
                continue;
            }
        };

        let modified_text = replace_filename_in_paths(&text, &old_name, &new_name);
        if modified_text == text {
            continue;
        }

        let new_tree = match text_to_tree(&modified_text) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("Skipping BIN (re-parse failed) {}: {}", path.display(), e);
                continue;
            }
        };

        let new_data = match write_bin_ltk(&new_tree) {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!("Skipping BIN (write failed) {}: {}", path.display(), e);
                continue;
            }
        };

        if let Err(e) = fs::write(path, &new_data) {
            tracing::warn!("Failed to save updated BIN {}: {}", path.display(), e);
            continue;
        }

        let ritobin_path = format!("{}.ritobin", path.display());
        if Path::new(&ritobin_path).exists() {
            let _ = fs::write(&ritobin_path, &modified_text);
        }

        tracing::info!("Updated BIN references in {}", path.display());
        count += 1;
    }
    count
}

#[tauri::command]
pub async fn delete_file(
    project_path: String,
    file_path: String,
) -> Result<(), String> {
    let full_path = PathBuf::from(&project_path).join(&file_path);
    if !full_path.exists() {
        return Err(format!("Path does not exist: {}", file_path));
    }

    if full_path.is_dir() {
        fs::remove_dir_all(&full_path)
            .map_err(|e| format!("Failed to delete directory: {}", e))?;
    } else {
        fs::remove_file(&full_path)
            .map_err(|e| format!("Failed to delete file: {}", e))?;
    }

    Ok(())
}

/// Open a path in the system file explorer (Windows Explorer).
#[tauri::command]
pub async fn open_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if p.is_file() {
        Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    } else {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    Ok(())
}

/// Open a file with the system's default application.
#[tauri::command]
pub async fn open_with_default_app(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    opener::open(&path).map_err(|e| format!("Failed to open file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn create_directory(
    project_path: String,
    dir_path: String,
) -> Result<String, String> {
    let full_path = PathBuf::from(&project_path).join(&dir_path);
    if full_path.exists() {
        return Err(format!("Directory already exists: {}", dir_path));
    }

    fs::create_dir_all(&full_path)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    Ok(dir_path)
}

/// Copy a file to the same directory with a " (copy)" suffix.
#[tauri::command]
pub async fn duplicate_file(
    project_path: String,
    file_path: String,
) -> Result<String, String> {
    let full_path = PathBuf::from(&project_path).join(&file_path);
    if !full_path.is_file() {
        return Err(format!("Not a file: {}", file_path));
    }

    let stem = full_path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = full_path.extension().and_then(|e| e.to_str());

    let parent = full_path.parent().ok_or("Cannot get parent directory")?;
    let mut copy_name = match ext {
        Some(e) => format!("{} (copy).{}", stem, e),
        None => format!("{} (copy)", stem),
    };

    let mut dest = parent.join(&copy_name);
    let mut counter = 2;
    while dest.exists() {
        copy_name = match ext {
            Some(e) => format!("{} (copy {}).{}", stem, counter, e),
            None => format!("{} (copy {})", stem, counter),
        };
        dest = parent.join(&copy_name);
        counter += 1;
    }

    fs::copy(&full_path, &dest)
        .map_err(|e| format!("Failed to duplicate file: {}", e))?;

    let project_root = PathBuf::from(&project_path);
    let new_rel = dest
        .strip_prefix(&project_root)
        .map_err(|_| "Failed to compute relative path")?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(new_rel)
}

/// Move a file or directory to a different folder within the project.
/// Returns the new relative path of the moved item.
#[tauri::command]
pub async fn move_file(
    project_path: String,
    source_path: String,
    dest_folder: String,
) -> Result<String, String> {
    let project_root = PathBuf::from(&project_path);
    let src_full = project_root.join(&source_path);

    if !src_full.exists() {
        return Err(format!("Source does not exist: {}", source_path));
    }

    let dest_dir_full = project_root.join(&dest_folder);
    if !dest_dir_full.is_dir() {
        return Err(format!("Destination is not a directory: {}", dest_folder));
    }

    // Prevent moving a directory into itself or its own subtree
    if src_full.is_dir() {
        let canonical_src = src_full.canonicalize()
            .map_err(|e| format!("Failed to resolve source path: {}", e))?;
        let canonical_dest = dest_dir_full.canonicalize()
            .map_err(|e| format!("Failed to resolve destination path: {}", e))?;
        if canonical_dest.starts_with(&canonical_src) {
            return Err("Cannot move a folder into itself or its subdirectory".to_string());
        }
    }

    let file_name = src_full
        .file_name()
        .ok_or("Cannot get filename from source path")?
        .to_string_lossy()
        .to_string();

    let dest_full = dest_dir_full.join(&file_name);
    if dest_full.exists() {
        return Err(format!("'{}' already exists in the destination folder", file_name));
    }

    fs::rename(&src_full, &dest_full)
        .map_err(|e| format!("Failed to move: {}", e))?;

    let new_rel = dest_full
        .strip_prefix(&project_root)
        .map_err(|_| "Failed to compute relative path")?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(new_rel)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderEntry {
    /// Filename only (no parent path).
    pub name: String,
    /// Project-relative path (forward slashes).
    pub relative_path: String,
    pub absolute_path: String,
    pub is_directory: bool,
    /// Size in bytes. 0 for directories.
    pub size: u64,
    /// Lowercase extension without dot. Empty for directories and
    /// extensionless files.
    pub extension: String,
}

#[tauri::command]
pub async fn is_directory(path: String) -> bool {
    let _t = ipc_trace::enter("is_directory");
    std::path::Path::new(&path).is_dir()
}

/// Return immediate children of `folder_path`. Entries are split into
/// directories first then files, both alphabetically. Hidden files
/// (starting with `.`) are included so users can see what's in their
/// project root, but `.ritobin` sidecars are skipped — those are derived
/// content and clutter the grid view.
#[tauri::command]
pub async fn list_folder_contents(
    project_path: String,
    folder_path: String,
) -> Result<Vec<FolderEntry>, String> {
    let _t = ipc_trace::enter("list_folder_contents");
    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("Not a folder: {}", folder_path));
    }

    let project_root = PathBuf::from(&project_path);

    let mut entries: Vec<FolderEntry> = Vec::new();
    let read_dir = fs::read_dir(&folder)
        .map_err(|e| format!("Failed to read folder: {}", e))?;

    for entry in read_dir.filter_map(|e| e.ok()) {
        let path = entry.path();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let lower = name.to_lowercase();

        // Skip ritobin sidecars — BIN-editor cache artifacts, not content.
        if lower.ends_with(".ritobin") {
            continue;
        }

        let is_directory = metadata.is_dir();
        let size = if is_directory { 0 } else { metadata.len() };
        let extension = if is_directory {
            String::new()
        } else {
            path.extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default()
        };
        let relative_path = path
            .strip_prefix(&project_root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        entries.push(FolderEntry {
            name,
            relative_path,
            absolute_path: path.to_string_lossy().into_owned(),
            is_directory,
            size,
            extension,
        });
    }

    // Directories first, then files; each group sorted case-insensitively.
    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// Import (copy) external files/folders from the OS into a destination folder
/// inside the project. Used by drag-and-drop from Windows Explorer.
/// Returns the list of relative paths (project-relative, forward slashes) that
/// were created.
#[tauri::command]
pub async fn import_external_files(
    project_path: String,
    dest_folder: String,
    sources: Vec<String>,
) -> Result<Vec<String>, String> {
    let project_root = PathBuf::from(&project_path);
    let dest_dir_full = project_root.join(&dest_folder);

    if !dest_dir_full.is_dir() {
        return Err(format!("Destination is not a directory: {}", dest_folder));
    }

    let canonical_project = project_root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project path: {}", e))?;

    let mut created: Vec<String> = Vec::new();

    for src_str in sources {
        let src = PathBuf::from(&src_str);
        if !src.exists() {
            return Err(format!("Source does not exist: {}", src_str));
        }

        // Refuse a source already inside the project — that's what move is for.
        if let Ok(canonical_src) = src.canonicalize() {
            if canonical_src.starts_with(&canonical_project) {
                continue;
            }
        }

        let file_name = src
            .file_name()
            .ok_or("Cannot get filename from source path")?
            .to_string_lossy()
            .to_string();

        let dest_full = unique_dest(&dest_dir_full, &file_name);
        if dest_full.exists() {
            return Err(format!("'{}' already exists and uniquification failed", file_name));
        }

        if src.is_dir() {
            copy_dir_recursive(&src, &dest_full)
                .map_err(|e| format!("Failed to copy directory '{}': {}", file_name, e))?;
        } else {
            fs::copy(&src, &dest_full)
                .map_err(|e| format!("Failed to copy file '{}': {}", file_name, e))?;
        }

        let rel = dest_full
            .strip_prefix(&project_root)
            .map_err(|_| "Failed to compute relative path")?
            .to_string_lossy()
            .replace('\\', "/");
        created.push(rel);
    }

    Ok(created)
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in WalkDir::new(src).min_depth(1) {
        let entry = entry?;
        let rel = entry.path().strip_prefix(src).unwrap();
        let target = dest.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Resolve a non-colliding path inside `dest_dir` for `file_name`. If the name
/// is free it's returned as-is; otherwise a `" (n)"` suffix is inserted before
/// the extension until a free name is found (gives up after 10000 tries and
/// returns the still-colliding base path so the caller can error).
fn unique_dest(dest_dir: &Path, file_name: &str) -> PathBuf {
    let base = dest_dir.join(file_name);
    if !base.exists() {
        return base;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.to_string());
    let ext = Path::new(file_name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for n in 1..10000 {
        let candidate = dest_dir.join(format!("{} ({}){}", stem, n, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    base
}

/// Copy or move files/folders from one project into a folder of ANOTHER
/// project. `source_rel_paths` are project-relative (forward slashes) within
/// `source_project`; `dest_folder` is relative to `dest_project`. Collisions
/// are auto-uniquified with a `" (n)"` suffix. Moves use `rename` and fall back
/// to copy-then-delete across volumes. Returns the dest-project-relative paths
/// created.
fn transfer_between_projects(
    source_project: &str,
    source_rel_paths: &[String],
    dest_project: &str,
    dest_folder: &str,
    do_move: bool,
    on_conflict: &str,
) -> Result<Vec<String>, String> {
    let src_root = PathBuf::from(source_project);
    let dst_root = PathBuf::from(dest_project);
    let dst_dir = dst_root.join(dest_folder);

    if !dst_dir.is_dir() {
        return Err(format!("Destination is not a directory: {}", dest_folder));
    }

    let canonical_dst_dir = dst_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve destination path: {}", e))?;

    let mut created: Vec<String> = Vec::new();

    for rel in source_rel_paths {
        let src_full = src_root.join(rel);
        if !src_full.exists() {
            return Err(format!("Source does not exist: {}", rel));
        }

        if src_full.is_dir() {
            if let Ok(canonical_src) = src_full.canonicalize() {
                if canonical_dst_dir.starts_with(&canonical_src) {
                    return Err("Cannot transfer a folder into itself or its subdirectory".to_string());
                }
            }
        }

        let file_name = src_full
            .file_name()
            .ok_or("Cannot get filename from source path")?
            .to_string_lossy()
            .to_string();

        let dest_full = if on_conflict == "replace" {
            let target = dst_dir.join(&file_name);
            if target.exists() {
                if target.is_dir() {
                    fs::remove_dir_all(&target)
                        .map_err(|e| format!("Failed to replace directory '{}': {}", file_name, e))?;
                } else {
                    fs::remove_file(&target)
                        .map_err(|e| format!("Failed to replace file '{}': {}", file_name, e))?;
                }
            }
            target
        } else {
            unique_dest(&dst_dir, &file_name)
        };
        if dest_full.exists() {
            return Err(format!("'{}' already exists and could not be resolved", file_name));
        }

        if do_move {
            // rename fails across volumes; fall back to copy-then-delete.
            if fs::rename(&src_full, &dest_full).is_err() {
                if src_full.is_dir() {
                    copy_dir_recursive(&src_full, &dest_full)
                        .map_err(|e| format!("Failed to move directory '{}': {}", file_name, e))?;
                    fs::remove_dir_all(&src_full)
                        .map_err(|e| format!("Failed to remove source directory '{}': {}", file_name, e))?;
                } else {
                    fs::copy(&src_full, &dest_full)
                        .map_err(|e| format!("Failed to move file '{}': {}", file_name, e))?;
                    fs::remove_file(&src_full)
                        .map_err(|e| format!("Failed to remove source file '{}': {}", file_name, e))?;
                }
            }
        } else if src_full.is_dir() {
            copy_dir_recursive(&src_full, &dest_full)
                .map_err(|e| format!("Failed to copy directory '{}': {}", file_name, e))?;
        } else {
            fs::copy(&src_full, &dest_full)
                .map_err(|e| format!("Failed to copy file '{}': {}", file_name, e))?;
        }

        let rel_out = dest_full
            .strip_prefix(&dst_root)
            .map_err(|_| "Failed to compute relative path")?
            .to_string_lossy()
            .replace('\\', "/");
        created.push(rel_out);
    }

    Ok(created)
}

/// Copy files/folders from one project into a folder of another project.
/// `on_conflict` is `"rename"` (keep both, default) or `"replace"` (overwrite).
#[tauri::command]
pub async fn copy_between_projects(
    source_project: String,
    source_rel_paths: Vec<String>,
    dest_project: String,
    dest_folder: String,
    on_conflict: Option<String>,
) -> Result<Vec<String>, String> {
    let policy = on_conflict.unwrap_or_else(|| "rename".to_string());
    transfer_between_projects(&source_project, &source_rel_paths, &dest_project, &dest_folder, false, &policy)
}

/// Move files/folders from one project into a folder of another project.
/// `on_conflict` is `"rename"` (keep both, default) or `"replace"` (overwrite).
#[tauri::command]
pub async fn move_between_projects(
    source_project: String,
    source_rel_paths: Vec<String>,
    dest_project: String,
    dest_folder: String,
    on_conflict: Option<String>,
) -> Result<Vec<String>, String> {
    let policy = on_conflict.unwrap_or_else(|| "rename".to_string());
    transfer_between_projects(&source_project, &source_rel_paths, &dest_project, &dest_folder, true, &policy)
}

/// Return the filenames that would collide if `source_rel_paths` were
/// transferred into `dest_folder` of `dest_project` (i.e. already exist there).
#[tauri::command]
pub async fn check_transfer_conflicts(
    source_rel_paths: Vec<String>,
    dest_project: String,
    dest_folder: String,
) -> Result<Vec<String>, String> {
    let dst_dir = PathBuf::from(&dest_project).join(&dest_folder);
    let mut conflicts = Vec::new();
    for rel in &source_rel_paths {
        if let Some(name) = Path::new(rel).file_name().map(|n| n.to_string_lossy().into_owned()) {
            if dst_dir.join(&name).exists() {
                conflicts.push(name);
            }
        }
    }
    Ok(conflicts)
}

/// Get floor texture as PNG bytes. Checks `%APPDATA%/Flint/themes/floor.png`
/// first for user customization, falls back to the bundled default.
#[tauri::command]
pub fn get_bundled_floor_png() -> tauri::ipc::Response {
    if let Ok(home) = crate::commands::settings::get_flint_home() {
        let custom = home.join("themes").join("floor.png");
        if custom.exists() {
            if let Ok(bytes) = std::fs::read(&custom) {
                return tauri::ipc::Response::new(bytes);
            }
        }
    }
    tauri::ipc::Response::new(FLOOR_PNG.to_vec())
}

/// Get one bundled skybox cubemap face as raw WebP bytes (the model-preview
/// skybox). `face` is one of px|nx|py|ny|pz|nz; unknown names fall back to px.
#[tauri::command]
pub fn get_bundled_skybox_face(face: String) -> tauri::ipc::Response {
    let bytes: &[u8] = match face.as_str() {
        "nx" => SKYBOX_NX,
        "py" => SKYBOX_PY,
        "ny" => SKYBOX_NY,
        "pz" => SKYBOX_PZ,
        "nz" => SKYBOX_NZ,
        _ => SKYBOX_PX,
    };
    tauri::ipc::Response::new(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_roundtrips_paths() {
        assert_eq!(percent_decode_str("E%3A%5CRitoShark%5CFlint"), "E:\\RitoShark\\Flint");
        assert_eq!(percent_decode_str("My%20Folder%2Ffile.webp"), "My Folder/file.webp");
        // Non-% content is untouched; lone % without two hex digits is literal.
        assert_eq!(percent_decode_str("plain.png"), "plain.png");
        assert_eq!(percent_decode_str("100%done"), "100%done");
        // UTF-8 multibyte (e.g. "é" = C3 A9) reassembles.
        assert_eq!(percent_decode_str("caf%C3%A9"), "café");
    }

    #[test]
    fn aux_magic_covers_rs_file_gaps() {
        assert_eq!(detect_aux_mime_from_magic(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(detect_aux_mime_from_magic(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(detect_aux_mime_from_magic(b"<svg xmlns"), Some("image/svg+xml"));
        assert_eq!(detect_aux_mime_from_magic(b"\x1bLuaQ\x00"), Some("application/x-luaobj"));
        assert_eq!(detect_aux_mime_from_magic(b"WGEO\x00\x00\x00\x00"), Some("model/x-lol-wgeo"));
        assert_eq!(detect_aux_mime_from_magic(b"PreLoad\x00"), Some("application/x-preload"));
        assert_eq!(detect_aux_mime_from_magic(b"r3d2sklt"), Some("model/x-lol-skl"));
        // Light Grid: leading u32 LE == 3.
        assert_eq!(detect_aux_mime_from_magic(&[0x03, 0x00, 0x00, 0x00]), Some("application/x-lightgrid"));
        // TGA heuristic: uncompressed true-color (image type 2, no color map).
        assert_eq!(detect_aux_mime_from_magic(&[0x00, 0x00, 0x02, 0x00]), Some("image/tga"));
    }

    #[test]
    fn aux_magic_none_for_known_lol_and_garbage() {
        assert_eq!(detect_aux_mime_from_magic(b"PROP\x01\x00\x00\x00"), None);
        assert_eq!(detect_aux_mime_from_magic(&[]), None);
        assert_eq!(detect_aux_mime_from_magic(&[0x01]), None);
    }

    #[test]
    fn detect_file_type_recovers_png_by_magic() {
        let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0d";
        let (mime, _ext) = detect_file_type(Path::new("blob"), png);
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn detect_file_type_maps_tex_via_rs_file() {
        let tex = [0x54u8, 0x45, 0x58, 0x00, 0xDE, 0xAD, 0xBE, 0xEF];
        let (mime, _ext) = detect_file_type(Path::new("x.tex"), &tex);
        assert_eq!(mime, "image/tex");
    }
}
