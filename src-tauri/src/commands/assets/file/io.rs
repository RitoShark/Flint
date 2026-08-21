use super::texture::parse_texture_dimensions;
use crate::core::ipc_trace;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    pub size: u64,
    pub file_type: String,
    pub extension: String,
    /// For images: width x height
    pub dimensions: Option<(u32, u32)>,
    /// Texture encoding (`Bc3`, `DXT5`, …). None for anything that isn't a texture.
    pub texture_format: Option<String>,
}

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
        FileKind::LuaBin | FileKind::LuaBin64 => "application/x-luabin".to_string(),
        FileKind::TroyBin => "application/x-troybin".to_string(),
        FileKind::Preload => "application/x-preload".to_string(),
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

    // Shared high-confidence table first — one answer for png/jpg/svg/RIFF/
    // WGEO/fonts/archives, so this panel and WAD extraction cannot disagree.
    if let Some(format) = flint_core::wad::sniff::sniff(data) {
        return Some(format.mime);
    }

    // Partial-signature leftovers. `ritoshark::file::detect` claims the full
    // magic for these upstream, so these only fire on truncated heads.
    if len >= 5 && &data[1..5] == b"LuaQ" {
        return Some("application/x-luaobj");
    }
    if len >= 7 && &data[0..7] == b"PreLoad" {
        return Some("application/x-preload");
    }
    if len >= 8 && &data[0..8] == b"r3d2sklt" {
        return Some("model/x-lol-skl");
    }

    // Heuristics below match on byte RANGES, not signatures, so they stay
    // here rather than in the shared table — they would mislabel a large
    // fraction of arbitrary WAD chunks.
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

    let texture = if file_type == "image/dds" || file_type == "image/tex" {
        parse_texture_dimensions(&data).ok()
    } else {
        None
    };

    Ok(FileInfo {
        path,
        size: metadata.len(),
        file_type,
        extension,
        dimensions: texture.as_ref().map(|(w, h, _)| (*w, *h)),
        texture_format: texture.map(|(_, _, format)| format),
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
    fn aux_magic_discriminates_riff_family_via_shared_table() {
        // RIFF fronts WEBP, WAV, and Wwise's own WEM. Before this function
        // delegated to the shared `flint_core::wad::sniff` table it had no
        // RIFF handling at all, so every one of these fell straight through.
        assert_eq!(
            detect_aux_mime_from_magic(b"RIFF\x24\x00\x00\x00WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(
            detect_aux_mime_from_magic(b"RIFF\x24\x00\x00\x00WAVEfmt "),
            Some("audio/wav")
        );
        assert_eq!(
            detect_aux_mime_from_magic(b"RIFFxxxxWSMPfmt "),
            Some("audio/x-wwise-wem")
        );
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

    /// The info panel only reads a 64 KiB head, which is a fraction of any real texture —
    /// so dimensions have to come from the header alone, not from decoding the mip chain.
    #[test]
    fn texture_dimensions_come_from_a_truncated_head() {
        let mut head = vec![0x54u8, 0x45, 0x58, 0x00];
        head.extend_from_slice(&2048u16.to_le_bytes());
        head.extend_from_slice(&1024u16.to_le_bytes());
        head.extend_from_slice(&[1, 12, 0, 1]);

        assert_eq!(
            parse_texture_dimensions(&head).unwrap(),
            (2048, 1024, "Bc3".to_string())
        );
    }
}
