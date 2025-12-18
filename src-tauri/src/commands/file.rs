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

    // Try to get dimensions for texture files (DDS and TEX)
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

/// Parse texture dimensions using ltk_texture (handles both DDS and TEX)
fn parse_texture_dimensions(data: &[u8]) -> Result<(u32, u32), String> {
    use ltk_texture::Texture;
    use std::io::Cursor;

    let mut cursor = Cursor::new(data);
    let texture = Texture::from_reader(&mut cursor)
        .map_err(|e| format!("Failed to parse texture: {:?}", e))?;

    Ok((texture.width(), texture.height()))
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
    use ltk_texture::Texture;
    use std::io::Cursor;

    let path_buf = std::path::PathBuf::from(&path);

    // Read the texture file
    let data = fs::read(&path_buf).map_err(|e| format!("Failed to read texture file: {}", e))?;

    if data.len() < 4 {
        return Err("File too small to be a valid texture".to_string());
    }

    // Use ltk_texture to read the texture (automatically handles DDS and TEX)
    let mut cursor = Cursor::new(&data);
    let texture = Texture::from_reader(&mut cursor)
        .map_err(|e| format!("Failed to parse texture: {:?}", e))?;

    let width = texture.width();
    let height = texture.height();

    // Decode the mipmap level 0 (full resolution)
    let surface = texture
        .decode_mipmap(0)
        .map_err(|e| format!("Failed to decode texture: {:?}", e))?;

    // Convert to RGBA image
    let rgba_image = surface
        .into_rgba_image()
        .map_err(|e| format!("Failed to convert to RGBA: {:?}", e))?;

    // Determine format based on magic bytes
    let format = match &data[0..4] {
        [0x54, 0x45, 0x58, 0x00] => "TEX",
        [0x44, 0x44, 0x53, 0x20] => "DDS",
        _ => "Unknown",
    };

    // Encode as PNG
    let mut png_data = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut png_data);
        encoder
            .write_image(rgba_image.as_raw(), width, height, image::ExtendedColorType::Rgba8)
            .map_err(|e| format!("Failed to encode PNG: {}", e))?;
    }

    // Base64 encode
    let base64_data = STANDARD.encode(&png_data);

    Ok(DecodedImage {
        data: base64_data,
        width,
        height,
        format: format.to_string(),
    })
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
