use base64::{engine::general_purpose::STANDARD, Engine};
use ltk_file::LeagueFileKind;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Information about a file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    pub size: u64,
    pub file_type: String,
    pub extension: String,
    /// For images: width x height
    pub dimensions: Option<(u32, u32)>,
}

/// Result of decoding a DDS file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecodedImage {
    /// Base64-encoded PNG data
    pub data: String,
    pub width: u32,
    pub height: u32,
    pub format: String,
}

/// Detect file type from extension and magic bytes using league-toolkit's LeagueFileKind
fn detect_file_type(path: &Path, data: &[u8]) -> (String, String) {
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    // Use league-toolkit's file identification for known LoL formats
    let ltk_kind = LeagueFileKind::identify_from_bytes(data);

    // Map LeagueFileKind to MIME-like types
    let file_type = match ltk_kind {
        LeagueFileKind::PropertyBin | LeagueFileKind::PropertyBinOverride => {
            "application/x-bin".to_string()
        }
        LeagueFileKind::Texture => "image/tex".to_string(),
        LeagueFileKind::TextureDds => "image/dds".to_string(),
        LeagueFileKind::SimpleSkin => "model/x-lol-skn".to_string(),
        LeagueFileKind::Skeleton => "model/x-lol-skl".to_string(),
        LeagueFileKind::Animation => "animation/x-lol-anm".to_string(),
        LeagueFileKind::Png => "image/png".to_string(),
        LeagueFileKind::Jpeg => "image/jpeg".to_string(),
        LeagueFileKind::WwiseBank => "audio/x-wwise-bnk".to_string(),
        LeagueFileKind::WwisePackage => "audio/x-wwise-wpk".to_string(),
        LeagueFileKind::MapGeometry => "model/x-lol-mapgeo".to_string(),
        LeagueFileKind::WorldGeometry => "model/x-lol-wgeo".to_string(),
        LeagueFileKind::StaticMeshAscii => "model/x-lol-sco".to_string(),
        LeagueFileKind::StaticMeshBinary => "model/x-lol-scb".to_string(),
        LeagueFileKind::RiotStringTable => "text/x-stringtable".to_string(),
        LeagueFileKind::LightGrid => "application/x-lightgrid".to_string(),
        LeagueFileKind::Preload => "application/x-preload".to_string(),
        LeagueFileKind::LuaObj => "application/x-luaobj".to_string(),
        LeagueFileKind::Tga => "image/tga".to_string(),
        LeagueFileKind::Svg => "image/svg+xml".to_string(),
        LeagueFileKind::Unknown => {
            // Fall back to extension-based detection for unknown formats
            match extension.as_str() {
                "dds" => "image/dds".to_string(),
                "tex" => "image/tex".to_string(),
                "png" => "image/png".to_string(),
                "jpg" | "jpeg" => "image/jpeg".to_string(),
                "bin" => "application/x-bin".to_string(),
                "py" | "ritobin" => "text/x-python".to_string(),
                "json" => "application/json".to_string(),
                "txt" => "text/plain".to_string(),
                "lua" => "text/x-lua".to_string(),
                "xml" => "application/xml".to_string(),
                "wav" | "ogg" | "mp3" => "audio".to_string(),
                "skn" | "skl" | "anm" => "model".to_string(),
                _ => "application/octet-stream".to_string(),
            }
        }
    };

    (file_type, extension)
}

/// Read raw file bytes from disk
///
/// # Arguments
/// * `path` - Path to the file
///
/// # Returns
/// * `Ok(Vec<u8>)` - File contents as bytes
/// * `Err(String)` - Error message
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let path = Path::new(&path);

    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }

    fs::read(path).map_err(|e| format!("Failed to read file: {}", e))
}

/// Get file metadata and type information
///
/// # Arguments
/// * `path` - Path to the file
///
/// # Returns
/// * `Ok(FileInfo)` - File metadata
/// * `Err(String)` - Error message
#[tauri::command]
pub async fn read_file_info(path: String) -> Result<FileInfo, String> {
    let path_buf = std::path::PathBuf::from(&path);

    if !path_buf.exists() {
        return Err(format!("File not found: {}", path));
    }

    let metadata = fs::metadata(&path_buf).map_err(|e| format!("Failed to read metadata: {}", e))?;

    // Read first few bytes for magic detection
    let data = fs::read(&path_buf).map_err(|e| format!("Failed to read file: {}", e))?;

    let (file_type, extension) = detect_file_type(&path_buf, &data);

    // Try to get dimensions for DDS and TEX files
    let dimensions = if file_type == "image/dds" {
        parse_dds_dimensions(&data).ok()
    } else if file_type == "image/tex" {
        parse_tex_dimensions(&data).ok()
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

/// Parse DDS header to get dimensions
fn parse_dds_dimensions(data: &[u8]) -> Result<(u32, u32), String> {
    use ddsfile::Dds;
    use std::io::Cursor;

    let dds = Dds::read(Cursor::new(data)).map_err(|e| format!("Failed to parse DDS: {}", e))?;

    Ok((dds.get_width(), dds.get_height()))
}

/// Parse TEX header to get dimensions
/// TEX format: magic (4 bytes) + width (u16) + height (u16) + format info
fn parse_tex_dimensions(data: &[u8]) -> Result<(u32, u32), String> {
    if data.len() < 8 {
        return Err("TEX file too small".to_string());
    }
    
    // Skip magic bytes (4), read width (2) and height (2)
    let width = u16::from_le_bytes([data[4], data[5]]) as u32;
    let height = u16::from_le_bytes([data[6], data[7]]) as u32;
    
    Ok((width, height))
}

/// Decode a DDS or TEX texture file to base64-encoded PNG
///
/// # Arguments
/// * `path` - Path to the texture file (DDS or TEX)
///
/// # Returns
/// * `Ok(DecodedImage)` - Base64 PNG data with dimensions
/// * `Err(String)` - Error message
#[tauri::command]
pub async fn decode_dds_to_png(path: String) -> Result<DecodedImage, String> {
    use image::{ImageBuffer, RgbaImage};

    let path_buf = std::path::PathBuf::from(&path);

    // Read the texture file
    let data = fs::read(&path_buf).map_err(|e| format!("Failed to read texture file: {}", e))?;

    if data.len() < 4 {
        return Err("File too small to be a valid texture".to_string());
    }

    // Detect format by magic bytes
    let (width, height, rgba_data, format) = match &data[0..4] {
        // TEX magic: "TEX\0"
        [0x54, 0x45, 0x58, 0x00] => decode_tex_file(&data)?,
        // DDS magic: "DDS "
        [0x44, 0x44, 0x53, 0x20] => decode_dds_file(&data)?,
        _ => return Err("Unknown texture format (not DDS or TEX)".to_string()),
    };

    // Create an image from the RGBA data
    let img: RgbaImage = ImageBuffer::from_raw(width, height, rgba_data)
        .ok_or_else(|| "Failed to create image buffer".to_string())?;

    // Encode as PNG
    let mut png_data = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png_data);
    encoder
        .encode(&img, width, height, image::ColorType::Rgba8)
        .map_err(|e| format!("Failed to encode PNG: {}", e))?;

    // Base64 encode
    let base64_data = STANDARD.encode(&png_data);

    Ok(DecodedImage {
        data: base64_data,
        width,
        height,
        format,
    })
}

/// Decode a DDS file and return RGBA pixel data
fn decode_dds_file(data: &[u8]) -> Result<(u32, u32, Vec<u8>, String), String> {
    use ddsfile::Dds;
    use std::io::Cursor;

    let dds = Dds::read(Cursor::new(data)).map_err(|e| format!("Failed to parse DDS: {}", e))?;

    let width = dds.get_width();
    let height = dds.get_height();

    // Get the format description
    let format = format!("{:?}", dds.get_dxgi_format().unwrap_or(ddsfile::DxgiFormat::Unknown));

    // Get raw pixel data
    let pixels = dds
        .get_data(0) // mip level 0
        .map_err(|e| format!("Failed to get DDS data: {}", e))?;

    // Decode pixels based on format
    let rgba_data = decode_dds_pixels(&dds, pixels, width, height)?;

    Ok((width, height, rgba_data, format))
}

/// Decode a TEX file and return RGBA pixel data
fn decode_tex_file(data: &[u8]) -> Result<(u32, u32, Vec<u8>, String), String> {
    if data.len() < 12 {
        return Err("TEX file too small".to_string());
    }

    // Parse TEX header
    // Magic: 4 bytes (already validated)
    // Width: u16 at offset 4
    // Height: u16 at offset 6
    // Unknown: u8 at offset 8 (usually 1)
    // Format: u8 at offset 9
    // Resource type: u8 at offset 10
    // Flags: u8 at offset 11
    let width = u16::from_le_bytes([data[4], data[5]]) as u32;
    let height = u16::from_le_bytes([data[6], data[7]]) as u32;
    let format_byte = data[9];
    let flags = data[11];

    // Determine format
    let (format_name, block_size, bytes_per_block) = match format_byte {
        1 => ("ETC1", 4usize, 8usize),
        2 | 3 => ("ETC2_EAC", 4, 16),
        10 | 11 => ("BC1/DXT1", 4, 8),
        12 => ("BC3/DXT5", 4, 16),
        20 => ("BGRA8", 1, 4),
        _ => return Err(format!("Unsupported TEX format: {}", format_byte)),
    };

    // Check if has mipmaps (flag bit 0)
    let has_mipmaps = (flags & 1) != 0;

    // Calculate mip count
    let mip_count = if has_mipmaps {
        ((width.max(height) as f32).log2().floor() + 1.0) as u32
    } else {
        1
    };

    // Find the offset to mip level 0 (largest mip)
    // In TEX format, mipmaps are stored smallest to largest
    let header_size = 12;
    let pixel_data = &data[header_size..];

    // Calculate the size of mip level 0
    let (mip0_w, mip0_h) = (width as usize, height as usize);
    let mip0_blocks_x = (mip0_w + block_size - 1) / block_size;
    let mip0_blocks_y = (mip0_h + block_size - 1) / block_size;
    let mip0_size = mip0_blocks_x * mip0_blocks_y * bytes_per_block;

    // Calculate offset to mip0 (skip all smaller mips)
    let mut offset = 0;
    for level in (1..mip_count).rev() {
        let mip_w = (width >> level).max(1) as usize;
        let mip_h = (height >> level).max(1) as usize;
        let blocks_x = (mip_w + block_size - 1) / block_size;
        let blocks_y = (mip_h + block_size - 1) / block_size;
        offset += blocks_x * blocks_y * bytes_per_block;
    }

    if offset + mip0_size > pixel_data.len() {
        return Err("TEX file data truncated".to_string());
    }

    let mip0_data = &pixel_data[offset..offset + mip0_size];

    // Decode the texture data
    let rgba_data = decode_tex_pixels(mip0_data, mip0_w, mip0_h, format_byte)?;

    Ok((width, height, rgba_data, format_name.to_string()))
}

/// Decode TEX pixel data based on format
fn decode_tex_pixels(data: &[u8], width: usize, height: usize, format: u8) -> Result<Vec<u8>, String> {
    let pixel_count = width * height;
    let mut output = vec![0u32; pixel_count];

    match format {
        1 => {
            // ETC1
            texture2ddecoder::decode_etc1(data, width, height, &mut output)
                .map_err(|e| format!("Failed to decode ETC1: {}", e))?;
        }
        2 | 3 => {
            // ETC2 with alpha
            texture2ddecoder::decode_etc2_rgba8(data, width, height, &mut output)
                .map_err(|e| format!("Failed to decode ETC2: {}", e))?;
        }
        10 | 11 => {
            // BC1/DXT1
            texture2ddecoder::decode_bc1(data, width, height, &mut output)
                .map_err(|e| format!("Failed to decode BC1: {}", e))?;
        }
        12 => {
            // BC3/DXT5
            texture2ddecoder::decode_bc3(data, width, height, &mut output)
                .map_err(|e| format!("Failed to decode BC3: {}", e))?;
        }
        20 => {
            // BGRA8 - uncompressed
            if data.len() < pixel_count * 4 {
                return Err("BGRA8 data too small".to_string());
            }
            for (i, chunk) in data.chunks_exact(4).take(pixel_count).enumerate() {
                let [b, g, r, a] = [chunk[0], chunk[1], chunk[2], chunk[3]];
                output[i] = u32::from_le_bytes([r, g, b, a]);
            }
        }
        _ => return Err(format!("Unsupported TEX format: {}", format)),
    }

    // Convert u32 RGBA to Vec<u8>
    let rgba_bytes: Vec<u8> = output
        .iter()
        .flat_map(|&pixel| pixel.to_le_bytes())
        .collect();

    Ok(rgba_bytes)
}

/// Decode DDS pixel data based on format
fn decode_dds_pixels(
    dds: &ddsfile::Dds,
    data: &[u8],
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    use ddsfile::DxgiFormat;

    let format = dds.get_dxgi_format();

    match format {
        Some(DxgiFormat::R8G8B8A8_UNorm) | Some(DxgiFormat::R8G8B8A8_UNorm_sRGB) => {
            // Already RGBA, just copy
            Ok(data.to_vec())
        }
        Some(DxgiFormat::B8G8R8A8_UNorm) | Some(DxgiFormat::B8G8R8A8_UNorm_sRGB) => {
            // BGRA to RGBA
            let mut rgba = data.to_vec();
            for chunk in rgba.chunks_exact_mut(4) {
                chunk.swap(0, 2); // Swap B and R
            }
            Ok(rgba)
        }
        Some(DxgiFormat::BC1_UNorm)
        | Some(DxgiFormat::BC1_UNorm_sRGB)
        | Some(DxgiFormat::BC2_UNorm)
        | Some(DxgiFormat::BC2_UNorm_sRGB)
        | Some(DxgiFormat::BC3_UNorm)
        | Some(DxgiFormat::BC3_UNorm_sRGB)
        | Some(DxgiFormat::BC4_UNorm)
        | Some(DxgiFormat::BC5_UNorm)
        | Some(DxgiFormat::BC7_UNorm)
        | Some(DxgiFormat::BC7_UNorm_sRGB) => {
            // Use software decoder for BC formats
            decode_bc_texture(data, width, height, format.unwrap())
        }
        _ => {
            // For unknown formats, try to treat as RGBA or return placeholder
            if data.len() >= (width * height * 4) as usize {
                Ok(data[..(width * height * 4) as usize].to_vec())
            } else {
                // Create a placeholder magenta image to indicate unsupported format
                let mut placeholder = Vec::with_capacity((width * height * 4) as usize);
                for y in 0..height {
                    for x in 0..width {
                        // Checkerboard pattern in magenta/black
                        if (x / 8 + y / 8) % 2 == 0 {
                            placeholder.extend_from_slice(&[255, 0, 255, 255]); // Magenta
                        } else {
                            placeholder.extend_from_slice(&[128, 0, 128, 255]); // Dark magenta
                        }
                    }
                }
                Ok(placeholder)
            }
        }
    }
}

/// Decode BC (Block Compression) textures
fn decode_bc_texture(
    data: &[u8],
    width: u32,
    height: u32,
    format: ddsfile::DxgiFormat,
) -> Result<Vec<u8>, String> {
    use ddsfile::DxgiFormat;

    // Calculate block dimensions (BC formats use 4x4 blocks)
    let blocks_x = (width + 3) / 4;
    let blocks_y = (height + 3) / 4;

    let mut output = vec![0u8; (width * height * 4) as usize];

    let block_size = match format {
        DxgiFormat::BC1_UNorm | DxgiFormat::BC1_UNorm_sRGB | DxgiFormat::BC4_UNorm => 8,
        _ => 16,
    };

    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            let block_index = (by * blocks_x + bx) as usize;
            let block_offset = block_index * block_size;

            if block_offset + block_size > data.len() {
                continue;
            }

            let block = &data[block_offset..block_offset + block_size];
            let pixels = decode_bc_block(block, format)?;

            // Copy block pixels to output
            for py in 0..4 {
                for px in 0..4 {
                    let x = bx * 4 + px;
                    let y = by * 4 + py;

                    if x < width && y < height {
                        let src_idx = ((py * 4 + px) * 4) as usize;
                        let dst_idx = ((y * width + x) * 4) as usize;

                        if src_idx + 4 <= pixels.len() && dst_idx + 4 <= output.len() {
                            output[dst_idx..dst_idx + 4]
                                .copy_from_slice(&pixels[src_idx..src_idx + 4]);
                        }
                    }
                }
            }
        }
    }

    Ok(output)
}

/// Decode a single BC block (4x4 pixels)
fn decode_bc_block(block: &[u8], format: ddsfile::DxgiFormat) -> Result<Vec<u8>, String> {
    use ddsfile::DxgiFormat;

    match format {
        DxgiFormat::BC1_UNorm | DxgiFormat::BC1_UNorm_sRGB => decode_bc1_block(block),
        DxgiFormat::BC3_UNorm | DxgiFormat::BC3_UNorm_sRGB => decode_bc3_block(block),
        _ => {
            // For other BC formats, return a solid color placeholder
            Ok(vec![128u8; 64]) // Gray placeholder
        }
    }
}

/// Decode BC1 (DXT1) block
fn decode_bc1_block(block: &[u8]) -> Result<Vec<u8>, String> {
    if block.len() < 8 {
        return Err("BC1 block too small".to_string());
    }

    // Extract two 16-bit colors (RGB565)
    let c0 = u16::from_le_bytes([block[0], block[1]]);
    let c1 = u16::from_le_bytes([block[2], block[3]]);

    // Convert RGB565 to RGBA
    fn rgb565_to_rgba(c: u16) -> [u8; 4] {
        let r = ((c >> 11) & 0x1F) as u8;
        let g = ((c >> 5) & 0x3F) as u8;
        let b = (c & 0x1F) as u8;
        [
            (r << 3) | (r >> 2),
            (g << 2) | (g >> 4),
            (b << 3) | (b >> 2),
            255,
        ]
    }

    let color0 = rgb565_to_rgba(c0);
    let color1 = rgb565_to_rgba(c1);

    // Build color palette
    let mut palette = [[0u8; 4]; 4];
    palette[0] = color0;
    palette[1] = color1;

    if c0 > c1 {
        // 4-color mode
        for i in 0..3 {
            palette[2][i] = ((2 * color0[i] as u16 + color1[i] as u16) / 3) as u8;
            palette[3][i] = ((color0[i] as u16 + 2 * color1[i] as u16) / 3) as u8;
        }
        palette[2][3] = 255;
        palette[3][3] = 255;
    } else {
        // 3-color + transparent mode
        for i in 0..3 {
            palette[2][i] = ((color0[i] as u16 + color1[i] as u16) / 2) as u8;
        }
        palette[2][3] = 255;
        palette[3] = [0, 0, 0, 0]; // Transparent
    }

    // Decode indices
    let indices = u32::from_le_bytes([block[4], block[5], block[6], block[7]]);

    let mut output = Vec::with_capacity(64);
    for i in 0..16 {
        let idx = ((indices >> (i * 2)) & 0x03) as usize;
        output.extend_from_slice(&palette[idx]);
    }

    Ok(output)
}

/// Decode BC3 (DXT5) block
fn decode_bc3_block(block: &[u8]) -> Result<Vec<u8>, String> {
    if block.len() < 16 {
        return Err("BC3 block too small".to_string());
    }

    // First 8 bytes are alpha, remaining 8 are BC1 color

    // Decode alpha
    let alpha0 = block[0];
    let alpha1 = block[1];

    let mut alpha_palette = [0u8; 8];
    alpha_palette[0] = alpha0;
    alpha_palette[1] = alpha1;

    if alpha0 > alpha1 {
        for i in 0..6 {
            alpha_palette[i + 2] =
                ((((6 - i) as u16 * alpha0 as u16) + ((i + 1) as u16 * alpha1 as u16)) / 7) as u8;
        }
    } else {
        for i in 0..4 {
            alpha_palette[i + 2] =
                ((((4 - i) as u16 * alpha0 as u16) + ((i + 1) as u16 * alpha1 as u16)) / 5) as u8;
        }
        alpha_palette[6] = 0;
        alpha_palette[7] = 255;
    }

    // Decode alpha indices (48 bits = 16 * 3 bits)
    let alpha_bits =
        u64::from_le_bytes([block[2], block[3], block[4], block[5], block[6], block[7], 0, 0]);

    let mut alphas = [0u8; 16];
    for i in 0..16 {
        let idx = ((alpha_bits >> (i * 3)) & 0x07) as usize;
        alphas[i] = alpha_palette[idx];
    }

    // Decode BC1 color block (last 8 bytes)
    let mut color_output = decode_bc1_block(&block[8..16])?;

    // Apply alpha values
    for i in 0..16 {
        color_output[i * 4 + 3] = alphas[i];
    }

    Ok(color_output)
}

/// Read text file content with encoding detection
///
/// # Arguments
/// * `path` - Path to the text file
///
/// # Returns
/// * `Ok(String)` - File content as string
/// * `Err(String)` - Error message
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    let path = Path::new(&path);

    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }

    fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))
}
