use image::{Rgba, RgbaImage};
use ritoshark::tex::{write_dds_bytes, write_dds_bytes_bc, TexFormat, Texture};
use super::texture::parse_texture_any;
use ritoshark::prelude::Serialize as _;
use walkdir::WalkDir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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

    apply_hsl_to_image(&mut rgba_img, hue, saturation, brightness);

    write_back(&path_buf, &rgba_img, &data, is_tex, source_format)
}

/// Write edited pixels over the source file, keeping the format it already had.
///
/// The DDS side goes through RitoShark rather than `image_dds`, whose writer always
/// emits the DX10 extension — a FourCC and a 20-byte header the client's D3D9-era
/// loader can't read, which is what made a recolored DDS crash the game.
fn write_back(
    path: &Path,
    rgba: &RgbaImage,
    source: &[u8],
    is_tex: bool,
    source_format: TexFormat,
) -> Result<(), String> {
    if is_tex {
        let new_tex = encode_tex_same_format(rgba, source_format)?;

        // Preserve the source ext_format byte (header offset +8); changing
        // BC1/BC3's 0x01 to 0x00 can crash the client.
        let mut tex_bytes: Vec<u8> = new_tex.to_bytes()
            .map_err(|e| format!("Failed to encode TEX to buffer: {:?}", e))?;
        if tex_bytes.len() >= 9 && source.len() >= 9 {
            tex_bytes[8] = source[8];
        }
        return fs::write(path, &tex_bytes).map_err(|e| format!("Failed to write TEX: {}", e));
    }

    let dds_bytes = match source_format {
        TexFormat::Bgra8 => write_dds_bytes(rgba),
        TexFormat::Bc1 | TexFormat::Bc1Alt | TexFormat::Bc3 | TexFormat::Bc5 | TexFormat::Bc7 => {
            write_dds_bytes_bc(rgba, source_format)
        }
        _ => write_dds_bytes_bc(rgba, TexFormat::Bc3),
    }
    .map_err(|e| format!("Failed to encode DDS: {:?}", e))?;

    fs::write(path, &dds_bytes).map_err(|e| format!("Failed to write DDS: {}", e))
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

    colorize_image_impl(&mut rgba_img, target_hue, preserve_saturation);

    write_back(&path_buf, &rgba_img, &data, is_tex, source_format)
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


#[cfg(test)]
mod tests {
    use super::*;

    const FOURCC_OFFSET: usize = 84;
    const LEGACY_HEADER_LEN: usize = 128;

    fn sample(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| Rgba([(x * 16) as u8, (y * 16) as u8, 0x60, 0xff]))
    }

    fn write_temp(name: &str, rgba: &RgbaImage, format: TexFormat) -> PathBuf {
        let path = std::env::temp_dir().join(format!("flint-recolor-{}-{}.dds", name, std::process::id()));
        let bytes = match format {
            TexFormat::Bgra8 => write_dds_bytes(rgba),
            other => write_dds_bytes_bc(rgba, other),
        }
        .expect("encode source");
        fs::write(&path, &bytes).expect("write source");
        path
    }

    /// The client's loader can't read the DX10 extension, so a recolored DDS must
    /// come back with the legacy FourCC it went in with.
    #[test]
    fn a_recolored_dds_keeps_a_legacy_header() {
        for (name, format, expected) in [
            ("bc1", TexFormat::Bc1, *b"DXT1"),
            ("bc3", TexFormat::Bc3, *b"DXT5"),
        ] {
            let img = sample(8, 8);
            let path = write_temp(name, &img, format);
            let source = fs::read(&path).unwrap();

            write_back(&path, &img, &source, false, format).expect("write back");

            let out = fs::read(&path).unwrap();
            assert_eq!(&out[FOURCC_OFFSET..FOURCC_OFFSET + 4], &expected, "{name}");
            assert_ne!(&out[FOURCC_OFFSET..FOURCC_OFFSET + 4], b"DX10", "{name}");
            let _ = fs::remove_file(&path);
        }
    }

    #[test]
    fn an_uncompressed_dds_stays_uncompressed() {
        let img = sample(4, 4);
        let path = write_temp("bgra", &img, TexFormat::Bgra8);
        let source = fs::read(&path).unwrap();

        write_back(&path, &img, &source, false, TexFormat::Bgra8).expect("write back");

        let out = fs::read(&path).unwrap();
        assert_ne!(&out[FOURCC_OFFSET..FOURCC_OFFSET + 4], b"DX10");
        assert_eq!(out.len(), LEGACY_HEADER_LEN + 4 * 4 * 4);
        let _ = fs::remove_file(&path);
    }

    /// Dimensions that aren't a multiple of 4 used to be cropped away, silently
    /// resizing the texture; the encoder pads the block grid itself.
    #[test]
    fn an_odd_sized_texture_keeps_its_dimensions() {
        let img = sample(6, 6);
        let path = write_temp("odd", &img, TexFormat::Bc3);
        let source = fs::read(&path).unwrap();

        write_back(&path, &img, &source, false, TexFormat::Bc3).expect("write back");

        let back = ritoshark::tex::read_dds_bytes(&fs::read(&path).unwrap()).expect("read back");
        assert_eq!(back.dimensions(), (6, 6));
        let _ = fs::remove_file(&path);
    }
}
