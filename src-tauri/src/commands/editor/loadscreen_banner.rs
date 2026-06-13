//! Tauri commands for the Animated Loadscreen Banner feature.
//!
//! Three commands:
//! * `get_loadscreen_banner_info` — inspect the project: where is the loadscreen
//!   image on disk, where will the mask live, is the banner already applied.
//! * `apply_loadscreen_banner` — inject the `StaticMaterialDef` + link into the
//!   main skin BIN, and drop in the bundled base mask `.tex` (BC7, with the real
//!   R/G scroll pattern) if one doesn't exist yet.
//! * `save_banner_mask` — re-encode the edited mask RGBA back into the mask
//!   `.tex` in its existing format (R/G/A preserved, only blue edited by the UI;
//!   raw-bytes IPC, mirrors `save_painted_texture`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use flint_ltk::loadscreen_banner as banner;
use flint_ltk::project::open_project;

use ritoshark::tex::{TexFormat, Texture};
// `.to_bytes()` lives on rs_io's `Serialize` trait; `Texture::from_bytes` on
// `Parse`. Both come from the ritoshark prelude.
use ritoshark::prelude::{Parse as _, Serialize as _};

// =============================================================================
// Project / BIN location helpers
// =============================================================================

/// Locate the main skin BIN for a project: `content/base/<champ>.wad.client/
/// data/characters/<champ>/skins/skin<id>.bin` (with a `skin{id:02}` fallback).
fn find_main_skin_bin(content_base: &Path, champion: &str, skin_id: u32) -> Option<PathBuf> {
    let champ = champion.to_lowercase();
    let wad = content_base.join(format!("{champ}.wad.client"));
    let candidates = [
        wad.join(format!("data/characters/{champ}/skins/skin{skin_id}.bin")),
        wad.join(format!("data/characters/{champ}/skins/skin{skin_id:02}.bin")),
    ];
    candidates.into_iter().find(|p| p.exists())
}

/// The WAD-folder root that contains a main BIN, i.e. the `<champ>.wad.client`
/// ancestor of `data/...`. Asset disk paths hang off this folder.
fn wad_folder_of(main_bin: &Path) -> Option<PathBuf> {
    let mut cur = main_bin.parent();
    while let Some(dir) = cur {
        if dir
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.to_lowercase().ends_with(".wad.client"))
            .unwrap_or(false)
        {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

/// Map a BIN asset path (`ASSETS/Creator/Project/foo.tex`) to its on-disk
/// location under a WAD folder. Extracted asset paths are always lowercased.
fn asset_disk_path(wad_folder: &Path, asset_path: &str) -> PathBuf {
    let rel = asset_path.replace('\\', "/").to_lowercase();
    // Keep the `assets/...` prefix (strip a leading slash only).
    let rel = rel.trim_start_matches('/');
    let mut p = wad_folder.to_path_buf();
    for seg in rel.split('/') {
        p.push(seg);
    }
    p
}

// =============================================================================
// Command payloads
// =============================================================================

#[derive(Debug, Serialize)]
pub struct LoadscreenBannerInfo {
    /// Real disk path of the loadscreen image (may not exist on disk yet).
    pub loadscreen_image_path: String,
    /// Whether that file actually exists on disk.
    pub loadscreen_exists: bool,
    /// Real disk path where the mask `.tex` lives / will live.
    pub mask_path: String,
    /// Whether the mask file already exists.
    pub mask_exists: bool,
    /// The material name that will be / is used.
    pub material_name: String,
    /// Whether the banner is already applied in the BIN.
    pub applied: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BannerParamsDto {
    pub shine_strength: Option<f32>,
    pub shine_frequency: Option<f32>,
    pub shine_speed: Option<f32>,
    pub scroll_speed_x: Option<f32>,
    pub scroll_speed_y: Option<f32>,
    pub tint: Option<[f32; 3]>,
    pub glow_pulse: Option<f32>,
}

impl BannerParamsDto {
    fn into_params(self) -> banner::BannerParams {
        let d = banner::BannerParams::default();
        banner::BannerParams {
            shine_strength: self.shine_strength.unwrap_or(d.shine_strength),
            shine_frequency: self.shine_frequency.unwrap_or(d.shine_frequency),
            shine_speed: self.shine_speed.unwrap_or(d.shine_speed),
            scroll_speed_x: self.scroll_speed_x.unwrap_or(d.scroll_speed_x),
            scroll_speed_y: self.scroll_speed_y.unwrap_or(d.scroll_speed_y),
            tint: self.tint.unwrap_or(d.tint),
            glow_pulse: self.glow_pulse.unwrap_or(d.glow_pulse),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ApplyBannerResult {
    pub mask_path: String,
    pub width: u32,
    pub height: u32,
}

// =============================================================================
// Internal: resolve everything we need about a project's banner state
// =============================================================================

struct Resolved {
    main_bin: PathBuf,
    bin: ritoshark::bin::Bin,
    loadscreen_asset: String,
    loadscreen_disk: PathBuf,
    mask_asset: String,
    mask_disk: PathBuf,
    material_name: String,
}

fn resolve(project_path: &str) -> Result<Resolved, String> {
    let project = open_project(Path::new(project_path))
        .map_err(|e| format!("Failed to open project: {e}"))?;

    let content_base = project.project_path.join("content").join("base");
    let main_bin = find_main_skin_bin(&content_base, &project.champion, project.skin_id)
        .ok_or_else(|| {
            "Main skin BIN not found for this project — is it a skin project with extracted content?".to_string()
        })?;

    let wad_folder = wad_folder_of(&main_bin)
        .ok_or_else(|| "Could not locate the .wad.client folder for the main BIN.".to_string())?;

    let data = std::fs::read(&main_bin).map_err(|e| format!("Failed to read main BIN: {e}"))?;
    let bin = flint_ltk::bin::read_bin_ltk(&data)
        .map_err(|e| format!("Failed to parse main BIN: {e}"))?;

    let loadscreen_asset = banner::read_loadscreen_image(&bin)
        .ok_or_else(|| "This skin has no loadscreen image (loadScreen.image) to build a banner on.".to_string())?;

    let mask_asset = banner::mask_path_from_loadscreen(&loadscreen_asset);
    let loadscreen_disk = asset_disk_path(&wad_folder, &loadscreen_asset);
    let mask_disk = asset_disk_path(&wad_folder, &mask_asset);
    let material_name = banner::material_name(&project.champion, &project.display_name);

    Ok(Resolved {
        main_bin,
        bin,
        loadscreen_asset,
        loadscreen_disk,
        mask_asset,
        mask_disk,
        material_name,
    })
}

// =============================================================================
// Commands
// =============================================================================

#[tauri::command]
pub async fn get_loadscreen_banner_info(
    project_path: String,
) -> Result<LoadscreenBannerInfo, String> {
    let r = resolve(&project_path)?;
    let status = banner::banner_status(&r.bin);
    let _ = r.loadscreen_asset; // asset string not needed in the payload
    Ok(LoadscreenBannerInfo {
        loadscreen_exists: r.loadscreen_disk.exists(),
        loadscreen_image_path: r.loadscreen_disk.to_string_lossy().to_string(),
        mask_exists: r.mask_disk.exists(),
        mask_path: r.mask_disk.to_string_lossy().to_string(),
        material_name: r.material_name,
        applied: status.applied,
    })
}

#[tauri::command]
pub async fn apply_loadscreen_banner(
    project_path: String,
    params: Option<BannerParamsDto>,
) -> Result<ApplyBannerResult, String> {
    let mut r = resolve(&project_path)?;
    let params = params.unwrap_or_default().into_params();

    // 1. Apply the material + link to the BIN.
    banner::apply_banner_to_bin(&mut r.bin, &r.material_name, &r.mask_asset, &params)?;

    // 2. Write the BIN back atomically.
    let bytes =
        flint_ltk::bin::write_bin_ltk(&r.bin).map_err(|e| format!("Failed to write BIN: {e}"))?;
    write_atomic(&r.main_bin, &bytes)?;

    // 2b. Invalidate the cached `.ritobin` sidecar so the editor re-converts
    //     from the freshly-written BIN (otherwise it serves the pre-banner text
    //     and the new material/link don't show up).
    let ritobin_cache = {
        let mut p = r.main_bin.clone().into_os_string();
        p.push(".ritobin");
        std::path::PathBuf::from(p)
    };
    let _ = std::fs::remove_file(&ritobin_cache);

    // 3. Ensure a mask .tex exists — create an empty black one sized to the
    //    loadscreen if missing.
    let (width, height) = ensure_mask_exists(&r.loadscreen_disk, &r.mask_disk)?;

    Ok(ApplyBannerResult {
        mask_path: r.mask_disk.to_string_lossy().to_string(),
        width,
        height,
    })
}

/// Save painted mask pixels into the mask `.tex`. Raw-bytes IPC: the body is the
/// RGBA buffer; `path`, `width`, `height` ride in headers.
#[tauri::command]
pub async fn save_banner_mask(
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let headers = request.headers();
    let path = headers
        .get("path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing 'path' header")?
        .to_string();
    let width: u32 = headers
        .get("width")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or("missing/invalid 'width' header")?;
    let height: u32 = headers
        .get("height")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or("missing/invalid 'height' header")?;

    let rgba: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => return Err("save_banner_mask expects raw bytes".into()),
    };

    let expected = (width as usize) * (height as usize) * 4;
    if rgba.len() != expected {
        return Err(format!(
            "RGBA length {} does not match {width}x{height}x4 = {expected}",
            rgba.len()
        ));
    }

    // Preserve the existing file's format (the reference masks ship as BC7).
    // The incoming buffer already carries the existing R/G/A with only the blue
    // channel edited — the frontend reads the current mask and overwrites blue.
    let format = std::fs::read(&path)
        .ok()
        .and_then(|d| Texture::from_bytes(&d).ok())
        .map(|t| t.format)
        .unwrap_or(TexFormat::Bc7);

    let tex_bytes = encode_mask_tex(rgba, width, height, format)?;
    write_atomic(Path::new(&path), &tex_bytes)?;
    Ok(())
}

// =============================================================================
// Texture / file helpers
// =============================================================================

/// Bundled base mask `.tex` (BC7) shipped with Flint. Its R/G channels carry the
/// secondary-VFX scroll pattern; the blue channel is the editable mask. Copied
/// verbatim when a project gets its first banner so R/G aren't blank.
static BASE_MASK_TEX: &[u8] = include_bytes!("../../../resources/banner-mask-base.tex");

/// Encode an RGBA buffer into `.tex` bytes in `format`, patching header byte 8
/// (0x01 for block-compressed, 0x00 for uncompressed) like `convert_*` does.
fn encode_mask_tex(
    rgba: &[u8],
    width: u32,
    height: u32,
    format: TexFormat,
) -> Result<Vec<u8>, String> {
    let image = image::RgbaImage::from_raw(width, height, rgba.to_vec())
        .ok_or("failed to build RGBA image from buffer")?;
    let tex = match format {
        TexFormat::Bgra8 => Texture::from_rgba_bgra8(&image),
        // BC7 keeps full RGBA at high quality — the right default for a mask
        // that carries an RGB pattern plus a blue mask channel.
        TexFormat::Bc1 | TexFormat::Bc1Alt | TexFormat::Bc3 | TexFormat::Bc5 | TexFormat::Bc7 => {
            Texture::encode(&image, format, false)
                .map_err(|e| format!("Failed to encode mask TEX ({format:?}): {e:?}"))?
        }
        // Etc / Rgba16 aren't expected for masks — fall back to BC7.
        _ => Texture::encode(&image, TexFormat::Bc7, false)
            .map_err(|e| format!("Failed to encode mask TEX (BC7 fallback): {e:?}"))?,
    };
    let mut buf = tex
        .to_bytes()
        .map_err(|e| format!("Failed to serialize mask TEX: {e:?}"))?;
    if buf.len() >= 9 {
        buf[8] = match format {
            TexFormat::Bgra8 | TexFormat::Rgba16Snorm => 0x00,
            _ => 0x01,
        };
    }
    Ok(buf)
}

/// Ensure a mask `.tex` exists. If missing, drop in the bundled base mask (BC7,
/// with the real R/G scroll pattern + a starter blue channel). Returns its dims.
fn ensure_mask_exists(_loadscreen_disk: &Path, mask_disk: &Path) -> Result<(u32, u32), String> {
    if mask_disk.exists() {
        let data = std::fs::read(mask_disk).map_err(|e| format!("Failed to read mask: {e}"))?;
        return tex_dimensions(&data);
    }

    if let Some(parent) = mask_disk.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create mask directory: {e}"))?;
    }
    write_atomic(mask_disk, BASE_MASK_TEX)?;
    tex_dimensions(BASE_MASK_TEX)
}

/// Read the width/height from a `.tex` or `.dds` header.
fn tex_dimensions(data: &[u8]) -> Result<(u32, u32), String> {
    if data.len() >= 4 && &data[0..4] == b"TEX\0" {
        let w = u16::from_le_bytes([data[4], data[5]]) as u32;
        let h = u16::from_le_bytes([data[6], data[7]]) as u32;
        if w > 0 && h > 0 {
            return Ok((w, h));
        }
    }
    // Fall back to a full decode (handles DDS or odd headers).
    let tex = Texture::from_bytes(data)
        .or_else(|_| Texture::from_dds_bytes(data))
        .map_err(|e| format!("Failed to read texture header: {e:?}"))?;
    let img = tex
        .decode_rgba()
        .map_err(|e| format!("Failed to decode texture: {e:?}"))?;
    Ok((img.width(), img.height()))
}

/// Write `bytes` to `path` via a temp file + rename so a mid-write failure can't
/// leave a half-written (corrupt) file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp-flint");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        // Clean up the temp file on failure.
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to finalize {}: {e}", path.display())
    })?;
    Ok(())
}
