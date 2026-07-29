use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use flint_core::loadscreen_banner as banner;
use flint_core::project::open_project;

use ritoshark::tex::{TexFormat, Texture};
use ritoshark::prelude::{Parse as _, Serialize as _};

// =============================================================================
// Project / BIN location helpers
// =============================================================================

fn find_main_skin_bin(content_base: &Path, champion: &str, skin_id: u32) -> Option<PathBuf> {
    let champ = champion.to_lowercase();
    let wad = content_base.join(format!("{champ}.wad.client"));
    let candidates = [
        wad.join(format!("data/characters/{champ}/skins/skin{skin_id}.bin")),
        wad.join(format!("data/characters/{champ}/skins/skin{skin_id:02}.bin")),
    ];
    candidates.into_iter().find(|p| p.exists())
}

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

fn asset_disk_path(wad_folder: &Path, asset_path: &str) -> PathBuf {
    let rel = asset_path.replace('\\', "/").to_lowercase();
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
    pub loadscreen_image_path: String,
    pub loadscreen_exists: bool,
    pub mask_path: String,
    pub mask_exists: bool,
    pub material_name: String,
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
    let bin = flint_core::bin::read_bin(&data)
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
    let _ = r.loadscreen_asset;
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
    let rebuild_mask = rebuild_mask.unwrap_or(true);

    banner::apply_banner_to_bin(&mut r.bin, &r.material_name, &r.mask_asset, &params)?;

    let bytes =
        flint_core::bin::write_bin(&r.bin).map_err(|e| format!("Failed to write BIN: {e}"))?;
    write_atomic(&r.main_bin, &bytes)?;

    let ritobin_cache = {
        let mut p = r.main_bin.clone().into_os_string();
        p.push(".ritobin");
        std::path::PathBuf::from(p)
    };
    let _ = std::fs::remove_file(&ritobin_cache);

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

/// Undo an `apply_loadscreen_banner` that the user backed out of.
///
/// Applying writes to disk immediately (BIN + mask) so the editor has something
/// to paint on, which means cancelling has to actively put the project back —
/// there is nothing to simply "not do". Strips the material link and entry from
/// the BIN, invalidates the `.ritobin` cache so the editor re-reads the reverted
/// file, and deletes the generated mask.
///
/// `delete_mask` should be false when the mask already existed before this apply,
/// so a cancel never destroys artwork the user painted earlier.
#[tauri::command]
pub async fn revert_loadscreen_banner(
    project_path: String,
    delete_mask: Option<bool>,
) -> Result<(), String> {
    let mut r = resolve(&project_path)?;

    if banner::remove_banner_from_bin(&mut r.bin) {
        let bytes =
            flint_core::bin::write_bin(&r.bin).map_err(|e| format!("Failed to write BIN: {e}"))?;
        write_atomic(&r.main_bin, &bytes)?;

        let ritobin_cache = {
            let mut p = r.main_bin.clone().into_os_string();
            p.push(".ritobin");
            std::path::PathBuf::from(p)
        };
        let _ = std::fs::remove_file(&ritobin_cache);
    }

    if delete_mask.unwrap_or(true) && r.mask_disk.exists() {
        std::fs::remove_file(&r.mask_disk)
            .map_err(|e| format!("Failed to remove generated mask: {e}"))?;
    }

    Ok(())
}

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

    let mut out = decode_tex_rgba(BASE_MASK_TEX)?;
    let (nw, nh) = (out.width(), out.height());

    let blue: Vec<u8> = if width == nw && height == nh {
        (0..(nw * nh) as usize).map(|i| rgba[i * 4 + 2]).collect()
    } else {
        let mut tmp = image::RgbaImage::new(width, height);
        for (i, px) in tmp.pixels_mut().enumerate() {
            let b = rgba[i * 4 + 2];
            *px = image::Rgba([b, b, b, 255]);
        }
        let r = image::imageops::resize(&tmp, nw, nh, image::imageops::FilterType::Triangle);
        r.as_raw().chunks_exact(4).map(|p| p[2]).collect()
    };

    for (i, px) in out.pixels_mut().enumerate() {
        px.0[2] = blue[i];
        px.0[3] = 255;
    }

    let format = std::fs::read(&path)
        .ok()
        .and_then(|d| Texture::from_bytes(&d).ok())
        .map(|t| t.format)
        .unwrap_or(TexFormat::Bc7);

    let tex_bytes = encode_mask_tex(&out.into_raw(), nw, nh, format)?;
    write_atomic(Path::new(&path), &tex_bytes)?;
    Ok(())
}

// =============================================================================
// Texture / file helpers
// =============================================================================

/// R/G channels carry the secondary-VFX scroll pattern; the blue channel is the
/// editable mask.
static BASE_MASK_TEX: &[u8] = include_bytes!("../../../resources/banner-mask-base.tex");

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
        TexFormat::Bc1 | TexFormat::Bc1Alt | TexFormat::Bc3 | TexFormat::Bc5 | TexFormat::Bc7 => {
            Texture::encode(&image, format, false)
                .map_err(|e| format!("Failed to encode mask TEX ({format:?}): {e:?}"))?
        }
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

fn decode_tex_rgba(data: &[u8]) -> Result<image::RgbaImage, String> {
    let tex = Texture::from_bytes(data)
        .or_else(|_| Texture::from_dds_bytes(data))
        .map_err(|e| format!("Failed to parse texture: {e:?}"))?;
    tex.decode_rgba()
        .map_err(|e| format!("Failed to decode texture: {e:?}"))
}

fn build_mask(_loadscreen_disk: &Path, mask_disk: &Path) -> Result<(u32, u32), String> {
    let mut base = decode_tex_rgba(BASE_MASK_TEX)?;
    let (tw, th) = (base.width(), base.height());

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
    for (i, px) in base.pixels_mut().enumerate() {
        px.0[2] = existing_blue.as_ref().map_or(255, |b| b.as_raw()[i * 4 + 2]);
        px.0[3] = 255;
    }

    let rgba = base.into_raw();
    let tex_bytes = encode_mask_tex(&rgba, tw, th, TexFormat::Bc7)?;

    if let Some(parent) = mask_disk.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create mask directory: {e}"))?;
    }
    write_atomic(mask_disk, &tex_bytes)?;
    Ok((tw, th))
}

fn tex_dimensions(data: &[u8]) -> Result<(u32, u32), String> {
    if data.len() >= 4 && &data[0..4] == b"TEX\0" {
        let w = u16::from_le_bytes([data[4], data[5]]) as u32;
        let h = u16::from_le_bytes([data[6], data[7]]) as u32;
        if w > 0 && h > 0 {
            return Ok((w, h));
        }
    }
    let tex = Texture::from_bytes(data)
        .or_else(|_| Texture::from_dds_bytes(data))
        .map_err(|e| format!("Failed to read texture header: {e:?}"))?;
    let img = tex
        .decode_rgba()
        .map_err(|e| format!("Failed to decode texture: {e:?}"))?;
    Ok((img.width(), img.height()))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp-flint");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to finalize {}: {e}", path.display())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel_avgs(img: &image::RgbaImage) -> [u64; 4] {
        let mut s = [0u64; 4];
        let n = (img.width() * img.height()) as u64;
        for px in img.as_raw().chunks_exact(4) {
            for c in 0..4 {
                s[c] += px[c] as u64;
            }
        }
        [s[0] / n, s[1] / n, s[2] / n, s[3] / n]
    }

    #[test]
    fn fresh_mask_is_bundle_rg_with_full_blue() {
        let bundle = decode_tex_rgba(BASE_MASK_TEX).unwrap();
        let (bw, bh) = (bundle.width(), bundle.height());
        let bundle_avg = channel_avgs(&bundle);

        let dir = std::env::temp_dir().join("flint_banner_test_fresh");
        let _ = std::fs::remove_dir_all(&dir);
        let mask = dir.join("foo-mask.tex");

        let (w, h) = build_mask(Path::new("does-not-exist.tex"), &mask).unwrap();
        assert_eq!((w, h), (bw, bh), "mask must be the bundle's native size");

        let out = decode_tex_rgba(&std::fs::read(&mask).unwrap()).unwrap();
        let out_avg = channel_avgs(&out);
        assert!(out_avg[0].abs_diff(bundle_avg[0]) <= 4, "R drifted: {out_avg:?} vs {bundle_avg:?}");
        assert!(out_avg[1].abs_diff(bundle_avg[1]) <= 4, "G drifted");
        assert!(out_avg[2] >= 254, "fresh blue must be ~255, got {}", out_avg[2]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reapply_preserves_blue() {
        let bundle = decode_tex_rgba(BASE_MASK_TEX).unwrap();
        let (bw, bh) = (bundle.width(), bundle.height());

        let dir = std::env::temp_dir().join("flint_banner_test_reapply");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mask = dir.join("foo-mask.tex");

        let mut existing = image::RgbaImage::new(bw, bh);
        for px in existing.pixels_mut() {
            *px = image::Rgba([0, 0, 200, 255]);
        }
        let bytes = encode_mask_tex(existing.as_raw(), bw, bh, TexFormat::Bc7).unwrap();
        std::fs::write(&mask, &bytes).unwrap();

        build_mask(Path::new("does-not-exist.tex"), &mask).unwrap();

        let out = decode_tex_rgba(&std::fs::read(&mask).unwrap()).unwrap();
        let blue_avg = channel_avgs(&out)[2];
        assert!((180..=220).contains(&blue_avg), "blue not preserved: {blue_avg}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
