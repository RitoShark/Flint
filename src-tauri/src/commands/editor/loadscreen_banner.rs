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
    rebuild_mask: Option<bool>,
) -> Result<ApplyBannerResult, String> {
    let mut r = resolve(&project_path)?;
    let params = params.unwrap_or_default().into_params();
    // Default true: "Add"/"Re-apply" rebuild the mask (R/G pattern, keep blue).
    // The editor's params-only save passes false so it never touches the mask
    // the user is actively painting.
    let rebuild_mask = rebuild_mask.unwrap_or(true);

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

    // 3. Build/rebuild the mask (bundled R/G pattern resized to the loadscreen,
    //    preserving any existing painted blue) — or just read its dims if this
    //    is a params-only save.
    let (width, height) = if rebuild_mask || !r.mask_disk.exists() {
        build_mask(&r.loadscreen_disk, &r.mask_disk)?
    } else {
        let data = std::fs::read(&r.mask_disk).map_err(|e| format!("Failed to read mask: {e}"))?;
        tex_dimensions(&data)?
    };

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

    // The R/G scroll pattern is authoritative data that must NEVER round-trip
    // through the editor (TEX→PNG→canvas→re-encode degrades it, and a stale/black
    // mask would get faithfully re-saved as black). So we IGNORE the incoming
    // R/G/A and rebuild R/G/B from the bundled base pattern resized to the mask
    // size — only the BLUE channel (the actual mask the user paints) comes from
    // the incoming buffer. This guarantees the saved mask always carries the
    // correct pattern, no matter what the on-disk file looked like before.
    let base = decode_tex_rgba(BASE_MASK_TEX)?;
    let mut out = image::imageops::resize(
        &base,
        width,
        height,
        image::imageops::FilterType::Triangle,
    );
    for (i, px) in out.pixels_mut().enumerate() {
        px.0[2] = rgba[i * 4 + 2]; // painted blue
        px.0[3] = 255; // opaque
    }

    // Preserve the existing file's format (the reference masks ship as BC7).
    let format = std::fs::read(&path)
        .ok()
        .and_then(|d| Texture::from_bytes(&d).ok())
        .map(|t| t.format)
        .unwrap_or(TexFormat::Bc7);

    let tex_bytes = encode_mask_tex(&out.into_raw(), width, height, format)?;
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

/// Decode a `.tex`/`.dds` byte buffer to an `RgbaImage`.
fn decode_tex_rgba(data: &[u8]) -> Result<image::RgbaImage, String> {
    let tex = Texture::from_bytes(data)
        .or_else(|_| Texture::from_dds_bytes(data))
        .map_err(|e| format!("Failed to parse texture: {e:?}"))?;
    tex.decode_rgba()
        .map_err(|e| format!("Failed to decode texture: {e:?}"))
}

/// Build (or rebuild) the mask `.tex` so its R/G/B carries the bundled scroll
/// pattern resized to the loadscreen dimensions, while PRESERVING the blue mask
/// channel of any existing mask (so re-applying the preset keeps the painting).
///
/// * Fresh apply → mask = bundled pattern resized to the loadscreen (R/G/B from
///   the pattern, ready for the user to paint blue).
/// * Re-apply over an existing mask → same resized R/G, but the BLUE channel is
///   taken from the current mask (resized to match) so the user's painted mask
///   survives.
///
/// Returns the mask's `(width, height)`.
fn build_mask(loadscreen_disk: &Path, mask_disk: &Path) -> Result<(u32, u32), String> {
    // Target size = the loadscreen's, so the mask UV-maps onto the banner. Fall
    // back to the bundled base's own size if the loadscreen can't be read.
    let (tw, th) = if loadscreen_disk.exists() {
        let ls = std::fs::read(loadscreen_disk)
            .map_err(|e| format!("Failed to read loadscreen: {e}"))?;
        tex_dimensions(&ls).or_else(|_| tex_dimensions(BASE_MASK_TEX))?
    } else {
        tex_dimensions(BASE_MASK_TEX)?
    };

    // Bundled pattern resized to the target — we use its R/G (the scroll
    // pattern) only. The bundled base's OWN blue channel is Evelynn's painted
    // mask, NOT a clean slate, so we must NOT seed it on a fresh apply.
    let base = decode_tex_rgba(BASE_MASK_TEX)?;
    let mut resized = image::imageops::resize(&base, tw, th, image::imageops::FilterType::Triangle);

    // Set the BLUE channel: from the existing mask if there is one (preserve the
    // user's painting across re-apply), otherwise ZERO (a clean, unpainted mask —
    // never Evelynn's bundled blue).
    let existing_blue: Option<image::RgbaImage> = if mask_disk.exists() {
        std::fs::read(mask_disk)
            .ok()
            .and_then(|b| decode_tex_rgba(&b).ok())
            .map(|existing| {
                if existing.width() == tw && existing.height() == th {
                    existing
                } else {
                    image::imageops::resize(&existing, tw, th, image::imageops::FilterType::Triangle)
                }
            })
    } else {
        None
    };
    for (i, dst) in resized.pixels_mut().enumerate() {
        dst.0[2] = existing_blue.as_ref().map_or(0, |b| b.as_raw()[i * 4 + 2]);
        dst.0[3] = 255; // opaque
    }

    let rgba = resized.into_raw();
    let tex_bytes = encode_mask_tex(&rgba, tw, th, TexFormat::Bc7)?;

    if let Some(parent) = mask_disk.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create mask directory: {e}"))?;
    }
    write_atomic(mask_disk, &tex_bytes)?;
    Ok((tw, th))
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
