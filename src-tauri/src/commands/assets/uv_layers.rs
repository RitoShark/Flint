//! Cut a skin's textures into one Photoshop layer per submesh, using the mesh's
//! own UVs as the stencil.
//!
//! Recolouring a champion means finding which patch of a shared texture sheet
//! belongs to the cape and which to the boots. The mesh already answers that —
//! every submesh's triangles carry UVs — so this rasterises each submesh's UV
//! shells into a mask, cuts the texture with it, and writes the pieces as layers.
//!
//! One PSD per texture, because League routinely points many submeshes at one
//! sheet. Each PSD carries the untouched texture as a bottom layer so the artist
//! can see what the shells sit on.

use flint_core::path_slash::to_slash;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use image::RgbaImage;
use ritoshark::prelude::Parse;
use serde::{Deserialize, Serialize};

use crate::core::ipc_trace;
use crate::core::psd_write::{write_psd, PsdDoc, PsdGroup, PsdLayer};
use flint_core::mesh::animation::resolve_animation_path;
use flint_core::mesh::materials::{extract_texture_mapping, BinIndex};
use flint_core::mesh::ritobin::mesh_bins;

use super::texture_convert::decode_full_rgba;

/// Grow the mask outwards by this many pixels. A UV shell's edge lands mid-texel,
/// and a block-compressed sheet bleeds colour a few texels past it, so a mask cut
/// exactly on the triangle leaves a hairline of the neighbouring shell behind
/// when the layers are recomposed.
const DEFAULT_BLEED: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UvLayerExport {
    /// Absolute path of every PSD written, one per texture.
    pub files: Vec<String>,
    pub layers: usize,
    /// Submeshes that produced no layer, with why.
    pub skipped: Vec<String>,
}

/// Signed area of the triangle `(a, b, c)`, doubled. Sign gives the winding.
fn edge(a: [f32; 2], b: [f32; 2], c: [f32; 2]) -> f32 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Fill every pixel whose centre lies inside one of the submesh's UV triangles.
///
/// UVs are top-left origin, the same as an image buffer, so no V flip here — the
/// Babylon path flips only because its texture sampling is bottom-left origin.
fn rasterize_shells(
    uvs: &[[f32; 2]],
    indices: &[u32],
    tri_range: std::ops::Range<usize>,
    width: u32,
    height: u32,
) -> Vec<bool> {
    let mut mask = vec![false; (width * height) as usize];
    let (fw, fh) = (width as f32, height as f32);

    for tri in indices[tri_range].chunks_exact(3) {
        let pts: Vec<[f32; 2]> = tri
            .iter()
            .filter_map(|&i| uvs.get(i as usize))
            .map(|uv| [uv[0] * fw, uv[1] * fh])
            .collect();
        if pts.len() != 3 {
            continue;
        }
        let (p0, p1, p2) = (pts[0], pts[1], pts[2]);
        if edge(p0, p1, p2).abs() < f32::EPSILON {
            continue;
        }

        let min_x = p0[0].min(p1[0]).min(p2[0]).floor().max(0.0) as u32;
        let min_y = p0[1].min(p1[1]).min(p2[1]).floor().max(0.0) as u32;
        let max_x = (p0[0].max(p1[0]).max(p2[0]).ceil().max(0.0) as u32).min(width - 1);
        let max_y = (p0[1].max(p1[1]).max(p2[1]).ceil().max(0.0) as u32).min(height - 1);

        for y in min_y..=max_y {
            for x in min_x..=max_x {
                let c = [x as f32 + 0.5, y as f32 + 0.5];
                let (w0, w1, w2) = (edge(p1, p2, c), edge(p2, p0, c), edge(p0, p1, c));
                // Either sign set, so a shell is filled whichever way it winds.
                let inside = (w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0)
                    || (w0 <= 0.0 && w1 <= 0.0 && w2 <= 0.0);
                if inside {
                    mask[(y * width + x) as usize] = true;
                }
            }
        }
    }
    mask
}

/// Grow the mask by `amount` pixels, one 8-neighbour ring per pass.
fn dilate(mask: &mut [bool], width: u32, height: u32, amount: u32) {
    for _ in 0..amount {
        let prev = mask.to_vec();
        for y in 0..height {
            for x in 0..width {
                let idx = (y * width + x) as usize;
                if prev[idx] {
                    continue;
                }
                let touching = (-1i64..=1).any(|dy| {
                    (-1i64..=1).any(|dx| {
                        let nx = x as i64 + dx;
                        let ny = y as i64 + dy;
                        nx >= 0
                            && ny >= 0
                            && nx < width as i64
                            && ny < height as i64
                            && prev[(ny as u32 * width + nx as u32) as usize]
                    })
                });
                if touching {
                    mask[idx] = true;
                }
            }
        }
    }
}

/// Cut `texture` with `mask`, cropped to the mask's bounding box.
///
/// Cropping is what keeps the file sane: a PSD layer stores only its own rect,
/// and a submesh's shells usually cover a small part of the sheet.
fn cut_layer(
    texture: &RgbaImage,
    mask: &[bool],
    width: u32,
    height: u32,
) -> Option<(u32, u32, RgbaImage)> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for y in 0..height {
        for x in 0..width {
            if mask[(y * width + x) as usize] {
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }
    if min_x == u32::MAX {
        return None;
    }

    let (w, h) = (max_x - min_x + 1, max_y - min_y + 1);
    let mut out = RgbaImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (sx, sy) = (min_x + x, min_y + y);
            if mask[(sy * width + sx) as usize] {
                out.put_pixel(x, y, *texture.get_pixel(sx, sy));
            }
        }
    }
    Some((min_x, min_y, out))
}

fn texture_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "texture".to_string())
}

/// Write one PSD per texture the mesh uses, with a layer per submesh cut to its
/// UV shells. `out_dir` defaults to the `.skn`'s own folder.
#[tauri::command]
pub async fn export_uv_layers(
    skn_path: String,
    out_dir: Option<String>,
    bleed: Option<u32>,
) -> Result<UvLayerExport, String> {
    let _t = ipc_trace::enter("export_uv_layers");
    tokio::task::spawn_blocking(move || {
        let skn = PathBuf::from(&skn_path);
        let data = std::fs::read(&skn).map_err(|e| format!("Failed to read '{skn_path}': {e}"))?;
        let mesh = ritoshark::mesh::SkinnedMesh::from_bytes(&data)
            .map_err(|e| format!("Failed to parse SKN '{skn_path}': {e:?}"))?;

        let uvs: Vec<[f32; 2]> = mesh.vertices().iter().map(|v| [v.uv.x, v.uv.y]).collect();
        let indices = mesh.absolute_indices();

        let bins = mesh_bins(&skn);
        if bins.is_empty() {
            return Err("Found no BIN describing this mesh, so no texture could be resolved.".into());
        }
        let index = BinIndex::new(bins.iter().map(|b| (&b.0, b.1.clone())));
        let mapping = extract_texture_mapping(&index);

        // Many submeshes share one sheet, so the PSD is per TEXTURE, not per submesh.
        let mut by_texture: BTreeMap<String, Vec<&ritoshark::mesh::SkinnedMeshRange>> =
            BTreeMap::new();
        let mut skipped = Vec::new();
        for range in mesh.ranges() {
            let texture = mapping
                .material_properties
                .get(&range.name)
                .map(|p| p.texture_path.clone())
                .or_else(|| mapping.default_texture.clone());
            match texture {
                Some(path) => by_texture.entry(path).or_default().push(range),
                None => skipped.push(format!("{}: the BINs name no texture for it", range.name)),
            }
        }
        if by_texture.is_empty() {
            return Err("No submesh of this mesh resolves to a texture.".into());
        }

        let base_dir = skn.parent().unwrap_or(Path::new("."));
        let dir = out_dir
            .map(PathBuf::from)
            .unwrap_or_else(|| base_dir.to_path_buf());
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create '{}': {e}", dir.display()))?;

        let bleed = bleed.unwrap_or(DEFAULT_BLEED);
        let mut files = Vec::new();
        let mut layer_count = 0usize;

        for (texture_path, ranges) in by_texture {
            let Some(disk) = resolve_animation_path(base_dir, &texture_path) else {
                skipped.push(format!("{texture_path}: not found in this project"));
                continue;
            };
            let bytes = match std::fs::read(&disk) {
                Ok(b) => b,
                Err(e) => {
                    skipped.push(format!("{texture_path}: {e}"));
                    continue;
                }
            };
            let texture = match decode_full_rgba(&bytes) {
                Ok(img) => img,
                Err(e) => {
                    skipped.push(format!("{texture_path}: {e}"));
                    continue;
                }
            };
            let (w, h) = texture.dimensions();
            if w == 0 || h == 0 {
                skipped.push(format!("{texture_path}: decodes to {w}×{h}"));
                continue;
            }

            let mut layers = Vec::new();
            for range in ranges {
                let start = range.index_start as usize;
                let count = range.index_count as usize;
                if start + count > indices.len() {
                    skipped.push(format!("{}: index range runs past the mesh", range.name));
                    continue;
                }
                let mut mask = rasterize_shells(&uvs, &indices, start..start + count, w, h);
                if bleed > 0 {
                    dilate(&mut mask, w, h, bleed);
                }
                match cut_layer(&texture, &mask, w, h) {
                    Some((x, y, image)) => layers.push(PsdLayer {
                        name: range.name.clone(),
                        x,
                        y,
                        image,
                        visible: true,
                    }),
                    None => skipped.push(format!("{}: its UV shells cover no pixel", range.name)),
                }
            }
            if layers.is_empty() {
                continue;
            }
            layer_count += layers.len();

            let groups = vec![
                PsdGroup {
                    name: "UV shells".to_string(),
                    visible: true,
                    layers,
                },
                PsdGroup {
                    name: "Source".to_string(),
                    visible: true,
                    layers: vec![PsdLayer {
                        name: texture_stem(&texture_path),
                        x: 0,
                        y: 0,
                        image: texture,
                        visible: true,
                    }],
                },
            ];

            let out = dir.join(format!("{}.psd", texture_stem(&texture_path)));
            std::fs::write(&out, write_psd(&PsdDoc { width: w, height: h, groups }))
                .map_err(|e| format!("Failed to write '{}': {e}", out.display()))?;
            files.push(to_slash(&out));
        }

        if files.is_empty() {
            return Err(format!(
                "Nothing could be cut. {}",
                skipped.first().map(String::as_str).unwrap_or("No texture resolved.")
            ));
        }

        Ok(UvLayerExport {
            files,
            layers: layer_count,
            skipped,
        })
    })
    .await
    .map_err(|e| format!("UV layer task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A full-sheet quad covers every pixel; anything less would mean the fill
    /// misses texels along the shared diagonal.
    #[test]
    fn a_full_sheet_quad_fills_every_pixel() {
        let uvs = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let indices = [0u16, 1, 2, 0, 2, 3];
        let mask = rasterize_shells(&uvs, &indices, 0..6, 8, 8);
        assert!(mask.iter().all(|&m| m), "{} of 64 filled", mask.iter().filter(|m| **m).count());
    }

    /// Winding must not matter — League's is the opposite of Babylon's, and a
    /// mesh can carry either after an edit.
    #[test]
    fn winding_does_not_change_the_fill() {
        let uvs = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]];
        let cw = rasterize_shells(&uvs, &[0u16, 1, 2], 0..3, 8, 8);
        let ccw = rasterize_shells(&uvs, &[0u16, 2, 1], 0..3, 8, 8);
        assert_eq!(cw, ccw);
        assert!(cw.iter().any(|&m| m));
    }

    /// Only the shell's own quadrant, so two submeshes on one sheet stay apart.
    #[test]
    fn a_half_sheet_shell_leaves_the_rest_clear() {
        let uvs = [[0.0, 0.0], [0.5, 0.0], [0.5, 1.0], [0.0, 1.0]];
        let mask = rasterize_shells(&uvs, &[0u16, 1, 2, 0, 2, 3], 0..6, 8, 8);
        for y in 0..8u32 {
            for x in 0..8u32 {
                assert_eq!(mask[(y * 8 + x) as usize], x < 4, "at {x},{y}");
            }
        }
    }

    /// UVs are top-left origin like the image buffer — a V flip here would put
    /// every shell on the wrong half of the sheet.
    #[test]
    fn v_runs_downwards_with_no_flip() {
        let uvs = [[0.0, 0.0], [1.0, 0.0], [1.0, 0.5], [0.0, 0.5]];
        let mask = rasterize_shells(&uvs, &[0u16, 1, 2, 0, 2, 3], 0..6, 4, 4);
        assert!(mask[0], "top-left should be covered");
        assert!(!mask[(3 * 4) as usize], "bottom-left should not be");
    }

    #[test]
    fn bleed_grows_the_mask_outwards() {
        let mut mask = vec![false; 25];
        mask[12] = true;
        dilate(&mut mask, 5, 5, 1);
        assert_eq!(mask.iter().filter(|m| **m).count(), 9);
    }

    #[test]
    fn a_cut_layer_is_cropped_to_its_shells() {
        let mut texture = RgbaImage::new(4, 4);
        for p in texture.pixels_mut() {
            *p = image::Rgba([10, 20, 30, 255]);
        }
        let mut mask = vec![false; 16];
        mask[5] = true; // (1, 1)
        let (x, y, image) = cut_layer(&texture, &mask, 4, 4).expect("one pixel");
        assert_eq!((x, y), (1, 1));
        assert_eq!(image.dimensions(), (1, 1));
        assert_eq!(image.get_pixel(0, 0).0, [10, 20, 30, 255]);
    }

    #[test]
    fn an_empty_mask_produces_no_layer() {
        let texture = RgbaImage::new(4, 4);
        assert!(cut_layer(&texture, &[false; 16], 4, 4).is_none());
    }
}
