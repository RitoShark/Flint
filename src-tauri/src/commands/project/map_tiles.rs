//! Ground-tile PSD stitcher: combine the open map project's ground textures
//! into one layered PSD and apply an edited PSD back to the .tex files.

use std::path::{Path, PathBuf};

fn col_index(c: char) -> Option<u32> {
    match c.to_ascii_lowercase() {
        'a'..='e' => Some(c.to_ascii_lowercase() as u32 - 'a' as u32),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TileGroup {
    Base,
    DragonElement(String),
    BaronStage(String),
}

#[derive(Debug, Clone)]
pub struct GroundTile {
    pub stem: String,
    pub path: PathBuf,
    pub col: u32,
    pub row: u32,
    pub group: TileGroup,
}

fn classify(path: &Path) -> Option<GroundTile> {
    let fname = path.file_name()?.to_str()?;
    let lower = fname.to_lowercase();
    if !lower.ends_with(".tex") {
        return None;
    }
    let stem = &lower[..lower.len() - 4];
    let rest = stem.strip_prefix("ground_")?;
    let bytes = rest.as_bytes();
    if bytes.len() < 2 {
        return None;
    }
    let col = col_index(bytes[0] as char)?;
    let row_char = bytes[1] as char;
    if !('1'..='5').contains(&row_char) {
        return None;
    }
    let row = row_char as u32 - '1' as u32;

    if is_excluded_texture(&lower, stem) {
        return None;
    }

    let group = if lower.contains("dragonpit_chemtech") {
        TileGroup::DragonElement("Chemtech".into())
    } else if lower.contains("dragonpit_cloud") {
        TileGroup::DragonElement("Cloud".into())
    } else if lower.contains("dragonpit_earth") {
        TileGroup::DragonElement("Mountain".into())
    } else if lower.contains("dragonpit_fire") {
        TileGroup::DragonElement("Infernal".into())
    } else if lower.contains("dragonpit_ocean") {
        TileGroup::DragonElement("Ocean".into())
    } else if lower.contains("baronpit_tunnel") {
        TileGroup::BaronStage("Tunnel".into())
    } else if lower.contains("baronpit_upgraded") {
        TileGroup::BaronStage("Upgraded".into())
    } else if lower.contains("baronpit_walled") {
        TileGroup::BaronStage("Walled".into())
    } else {
        TileGroup::Base
    };

    Some(GroundTile {
        stem: stem.to_string(),
        path: path.to_path_buf(),
        col,
        row,
        group,
    })
}

fn is_kitpiece_texture(path: &Path) -> bool {
    let p = path.to_string_lossy().replace('\\', "/").to_lowercase();
    p.contains("/maps/kitpieces/") && p.contains("/textures/")
}

pub fn find_ground_tiles(project_path: &Path) -> Vec<GroundTile> {
    let mut out = Vec::new();
    let content = project_path.join("content");
    for entry in walkdir::WalkDir::new(&content).into_iter().flatten() {
        if entry.file_type().is_file() && is_kitpiece_texture(entry.path()) {
            if let Some(t) = classify(entry.path()) {
                out.push(t);
            }
        }
    }
    out.sort_by(|a, b| a.stem.cmp(&b.stem));
    out
}

// ============================================================================
// Wall / prop categories (non-ground textures)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CombineMode {
    /// All main tiles merged into one full-canvas layer.
    Combined,
    /// One named layer per tile.
    Split,
}
impl CombineMode {
    fn parse(s: &str) -> Self {
        if s.eq_ignore_ascii_case("split") {
            CombineMode::Split
        } else {
            CombineMode::Combined
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WallCategory {
    Walls,
    Camps,
    Pits,
    River,
    Misc,
}

impl WallCategory {
    fn slug(self) -> &'static str {
        match self {
            WallCategory::Walls => "walls",
            WallCategory::Camps => "camps",
            WallCategory::Pits => "pits",
            WallCategory::River => "river",
            WallCategory::Misc => "misc",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "walls" => Some(WallCategory::Walls),
            "camps" => Some(WallCategory::Camps),
            "pits" => Some(WallCategory::Pits),
            "river" => Some(WallCategory::River),
            "misc" => Some(WallCategory::Misc),
            _ => None,
        }
    }
}

fn is_excluded_texture(lower: &str, stem: &str) -> bool {
    const EXCLUDE: [&str; 7] = ["decal", "wind", "_vfx", "_fx", "mask", "noise", "overlay"];
    if EXCLUDE.iter().any(|tok| lower.contains(tok)) {
        return true;
    }
    stem.rsplit('_')
        .next()
        .map(|last| last.len() >= 2 && last.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or(false)
}

#[derive(Debug, Clone)]
pub struct WallTile {
    pub stem: String,
    pub path: PathBuf,
    pub category: WallCategory,
}

/// Precedence: Camps → Pits → River → Walls → Misc.
fn classify_wall(path: &Path) -> Option<WallTile> {
    let fname = path.file_name()?.to_str()?;
    let lower = fname.to_lowercase();
    if !lower.ends_with(".tex") {
        return None;
    }
    let stem = &lower[..lower.len() - 4];
    if stem.starts_with("ground_") {
        return None;
    }
    if is_excluded_texture(&lower, stem) {
        return None;
    }

    let has = |toks: &[&str]| toks.iter().any(|t| lower.contains(t));
    let category = if has(&["gromp", "krug", "raptor", "wolf", "wolves", "red", "blue", "crab", "scuttle"]) {
        WallCategory::Camps
    } else if has(&["baron", "dragon"]) {
        WallCategory::Pits
    } else if has(&["river", "water"]) {
        WallCategory::River
    } else if has(&["top", "mid", "bot", "base", "spawn", "alcove", "periph", "wall"]) {
        WallCategory::Walls
    } else {
        WallCategory::Misc
    };

    Some(WallTile {
        stem: stem.to_string(),
        path: path.to_path_buf(),
        category,
    })
}

pub fn find_wall_tiles(project_path: &Path) -> Vec<WallTile> {
    let mut out = Vec::new();
    let content = project_path.join("content");
    for entry in walkdir::WalkDir::new(&content).into_iter().flatten() {
        if entry.file_type().is_file() && is_kitpiece_texture(entry.path()) {
            if let Some(t) = classify_wall(entry.path()) {
                out.push(t);
            }
        }
    }
    out.sort_by(|a, b| a.stem.cmp(&b.stem));
    out
}

// ============================================================================
// Combine: tiles -> layered PSD
// ============================================================================

use crate::core::psd_write::{write_psd, PsdDoc, PsdGroup, PsdLayer};

const TILE: u32 = 2048;
const GRID: u32 = 5;
const BASE_LAYER: &str = "Base ground (merged)";

/// Serializes all combine/apply work so only one heavy PSD op runs at a time.
static PSD_OP_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn ground_psd_path(project: &Path) -> PathBuf {
    project.join("textures-psd").join("ground_map.psd")
}

#[tauri::command]
pub async fn ground_psd_exists(project_path: String) -> Result<bool, String> {
    Ok(ground_psd_path(&PathBuf::from(&project_path)).exists())
}

#[tauri::command]
pub async fn combine_ground_to_psd(
    app: tauri::AppHandle,
    project_path: String,
    mode: String,
) -> Result<String, String> {
    let _guard = PSD_OP_LOCK.lock().await;
    let mode = CombineMode::parse(&mode);
    let project = PathBuf::from(&project_path);
    let tiles = find_ground_tiles(&project);
    if tiles.is_empty() {
        return Err("No ground tiles (ground_*.tex) found in this project".into());
    }

    let mut base_canvas = image::RgbaImage::new(GRID * TILE, GRID * TILE);
    let mut base_split: Vec<PsdLayer> = Vec::new();
    let mut base_count = 0u32;
    let mut dragon: std::collections::BTreeMap<String, Vec<PsdLayer>> = Default::default();
    let mut baron: std::collections::BTreeMap<String, Vec<PsdLayer>> = Default::default();

    for t in &tiles {
        let bytes = std::fs::read(&t.path).map_err(|e| format!("read {}: {e}", t.stem))?;
        let img = crate::commands::texture_convert::decode_full_rgba(&bytes)?;
        match &t.group {
            TileGroup::Base => {
                match mode {
                    CombineMode::Combined => image::imageops::overlay(
                        &mut base_canvas,
                        &img,
                        (t.col * TILE) as i64,
                        (t.row * TILE) as i64,
                    ),
                    CombineMode::Split => base_split.push(PsdLayer {
                        name: t.stem.clone(),
                        x: t.col * TILE,
                        y: t.row * TILE,
                        image: img,
                        visible: true,
                    }),
                }
                base_count += 1;
            }
            TileGroup::DragonElement(e) => dragon.entry(e.clone()).or_default().push(PsdLayer {
                name: t.stem.clone(),
                x: t.col * TILE,
                y: t.row * TILE,
                image: img,
                visible: false,
            }),
            TileGroup::BaronStage(s) => baron.entry(s.clone()).or_default().push(PsdLayer {
                name: t.stem.clone(),
                x: t.col * TILE,
                y: t.row * TILE,
                image: img,
                visible: false,
            }),
        }
    }
    if base_count == 0 {
        return Err("No base ground tiles to compose".into());
    }

    let base_layers = match mode {
        CombineMode::Combined => vec![PsdLayer {
            name: BASE_LAYER.into(),
            x: 0,
            y: 0,
            image: base_canvas,
            visible: true,
        }],
        CombineMode::Split => base_split,
    };
    let mut groups = vec![PsdGroup {
        name: "Base".into(),
        visible: true,
        layers: base_layers,
    }];
    for (e, layers) in dragon {
        groups.push(PsdGroup {
            name: format!("DragonPit · {e}"),
            visible: false,
            layers,
        });
    }
    for (s, layers) in baron {
        groups.push(PsdGroup {
            name: format!("BaronPit · {s}"),
            visible: false,
            layers,
        });
    }

    let doc = PsdDoc {
        width: GRID * TILE,
        height: GRID * TILE,
        groups,
    };
    let bytes = write_psd(&doc);
    let out = ground_psd_path(&project);
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create psd dir: {e}"))?;
    }
    std::fs::write(&out, &bytes).map_err(|e| format!("write psd: {e}"))?;

    use tauri::Emitter;
    let _ = app.emit(
        "file-changed",
        serde_json::json!({ "path": out.to_string_lossy().replace('\\', "/"), "kind": "create" }),
    );

    Ok(out.to_string_lossy().into_owned())
}

// ============================================================================
// Apply: edited PSD -> .tex files (by layer name)
// ============================================================================

use ritoshark::prelude::{Parse as _, Serialize as _};
use ritoshark::tex::{TexFormat, Texture};

#[derive(serde::Serialize)]
pub struct ApplyReport {
    pub written: u32,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
}

fn crop_tile(canvas: &[u8], canvas_w: u32, left: u32, top: u32, tw: u32, th: u32) -> image::RgbaImage {
    let mut tile = image::RgbaImage::new(tw, th);
    let n = (tw * 4) as usize;
    for ty in 0..th {
        let src_row = (((top + ty) * canvas_w + left) * 4) as usize;
        let dst_row = (ty * tw * 4) as usize;
        if src_row + n <= canvas.len() {
            tile.as_flat_samples_mut().samples[dst_row..dst_row + n]
                .copy_from_slice(&canvas[src_row..src_row + n]);
        }
    }
    tile
}

fn write_tile_tex(orig: &Path, rgba: &image::RgbaImage) -> Result<(), String> {
    let orig_bytes = std::fs::read(orig).map_err(|e| format!("read orig: {e}"))?;
    let fmt = Texture::from_bytes(&orig_bytes)
        .map_err(|e| format!("parse orig tex: {:?}", e))?
        .format;
    let new_tex = match fmt {
        TexFormat::Bgra8 => Texture::from_rgba_bgra8(rgba),
        _ => Texture::encode(rgba, fmt, false).map_err(|e| format!("encode: {:?}", e))?,
    };
    let mut bytes = new_tex.to_bytes().map_err(|e| format!("to_bytes: {:?}", e))?;
    if bytes.len() >= 9 {
        bytes[8] = match fmt {
            TexFormat::Bc1 | TexFormat::Bc3 => 0x01,
            _ => 0x00,
        };
    }
    std::fs::write(orig, &bytes).map_err(|e| format!("write tex: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn save_painted_texture(
    project_path: String,
    texture_path: String,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let _guard = PSD_OP_LOCK.lock().await;
    if rgba.len() != (width as usize) * (height as usize) * 4 {
        return Err(format!(
            "rgba size mismatch: {} != {}x{}x4",
            rgba.len(),
            width,
            height
        ));
    }
    let real = crate::commands::map_preview::resolve_map_texture_path(
        project_path.clone(),
        texture_path.clone(),
    )
    .await?;
    let img = image::RgbaImage::from_raw(width, height, rgba).ok_or("bad rgba buffer")?;
    write_tile_tex(Path::new(&real), &img)
}

#[tauri::command]
pub async fn apply_psd_to_textures(
    project_path: String,
    psd_path: String,
) -> Result<ApplyReport, String> {
    let _guard = PSD_OP_LOCK.lock().await;
    let project = PathBuf::from(&project_path);
    let by_stem: std::collections::HashMap<String, PathBuf> = find_ground_tiles(&project)
        .into_iter()
        .map(|t| (t.stem, t.path))
        .collect();

    let psd_bytes = std::fs::read(&psd_path).map_err(|e| format!("read psd: {e}"))?;
    let psd = psd::Psd::from_bytes(&psd_bytes).map_err(|e| format!("parse psd: {:?}", e))?;
    let canvas_w = psd.width();
    let canvas_h = psd.height();

    let base_by_cell: std::collections::HashMap<(u32, u32), PathBuf> = find_ground_tiles(&project)
        .into_iter()
        .filter(|t| matches!(t.group, TileGroup::Base))
        .map(|t| ((t.col, t.row), t.path))
        .collect();

    let mut report = ApplyReport {
        written: 0,
        skipped: vec![],
        errors: vec![],
    };

    for layer in psd.layers() {
        let name = layer.name().to_string();
        if name == "</Layer group>" {
            continue;
        }

        let canvas = layer.rgba();
        if canvas.len() < (canvas_w * canvas_h * 4) as usize {
            report.errors.push(format!("{name}: short rgba buffer"));
            continue;
        }

        if name == BASE_LAYER {
            for (&(col, row), path) in &base_by_cell {
                let (ox, oy) = (col * TILE, row * TILE);
                if ox + TILE > canvas_w || oy + TILE > canvas_h {
                    report.skipped.push(format!("cell {col},{row}"));
                    continue;
                }
                let tile = crop_tile(&canvas, canvas_w, ox, oy, TILE, TILE);
                match write_tile_tex(path, &tile) {
                    Ok(()) => report.written += 1,
                    Err(e) => report.errors.push(format!("cell {col},{row}: {e}")),
                }
            }
            continue;
        }

        let Some(orig) = by_stem.get(&name) else {
            report.skipped.push(name);
            continue;
        };
        let left = layer.layer_left().max(0) as u32;
        let top = layer.layer_top().max(0) as u32;
        let right = layer.layer_right().max(0) as u32;
        let bottom = layer.layer_bottom().max(0) as u32;
        if right < left || bottom < top {
            report.skipped.push(name);
            continue;
        }
        let tile = crop_tile(&canvas, canvas_w, left, top, right - left + 1, bottom - top + 1);
        match write_tile_tex(orig, &tile) {
            Ok(()) => report.written += 1,
            Err(e) => report.errors.push(format!("{name}: {e}")),
        }
    }
    Ok(report)
}

// ============================================================================
// Category (wall/prop) PSDs — one stacked layer per texture
// ============================================================================

fn category_psd_path(project: &Path, cat: WallCategory) -> PathBuf {
    project
        .join("textures-psd")
        .join(format!("{}.psd", cat.slug()))
}

#[tauri::command]
pub async fn category_psd_exists(project_path: String, category: String) -> Result<bool, String> {
    let cat = WallCategory::parse(&category).ok_or("unknown category")?;
    Ok(category_psd_path(&PathBuf::from(&project_path), cat).exists())
}

#[derive(serde::Serialize)]
pub struct SectionInfo {
    pub name: String,
    pub tile_count: u32,
    pub exists: bool,
    pub supports_mode: bool,
}

#[tauri::command]
pub async fn list_map_texture_sections(project_path: String) -> Result<Vec<SectionInfo>, String> {
    let project = PathBuf::from(&project_path);

    let ground = find_ground_tiles(&project);
    let mut sections = vec![SectionInfo {
        name: "Ground".into(),
        tile_count: ground.len() as u32,
        exists: ground_psd_path(&project).exists(),
        supports_mode: true,
    }];

    let walls = find_wall_tiles(&project);
    use WallCategory::*;
    for cat in [Walls, Camps, Pits, River, Misc] {
        let count = walls.iter().filter(|t| t.category == cat).count() as u32;
        sections.push(SectionInfo {
            name: match cat {
                Walls => "Walls",
                Camps => "Camps",
                Pits => "Pits",
                River => "River",
                Misc => "Misc",
            }
            .into(),
            tile_count: count,
            exists: category_psd_path(&project, cat).exists(),
            supports_mode: true,
        });
    }
    Ok(sections)
}

const CELL: u32 = 2048;

fn atlas_cols(n: usize) -> u32 {
    ((n as f64).sqrt().ceil() as u32).max(1)
}

#[tauri::command]
pub async fn combine_category_to_psd(
    app: tauri::AppHandle,
    project_path: String,
    category: String,
    mode: Option<String>,
) -> Result<String, String> {
    use tauri::Emitter;
    let _guard = PSD_OP_LOCK.lock().await;
    let mode = CombineMode::parse(mode.as_deref().unwrap_or("split"));
    let cat = WallCategory::parse(&category).ok_or("unknown category")?;
    let project = PathBuf::from(&project_path);

    let mut imgs: Vec<(String, image::RgbaImage)> = Vec::new();
    for t in find_wall_tiles(&project) {
        if t.category != cat {
            continue;
        }
        let bytes = std::fs::read(&t.path).map_err(|e| format!("read {}: {e}", t.stem))?;
        let img = crate::commands::texture_convert::decode_full_rgba(&bytes)?;
        imgs.push((t.stem, img));
    }
    if imgs.is_empty() {
        return Err(format!("No {} textures found in this project", cat.slug()));
    }

    let doc = match mode {
        CombineMode::Split => {
            let max_w = imgs.iter().map(|(_, i)| i.width()).max().unwrap_or(1);
            let max_h = imgs.iter().map(|(_, i)| i.height()).max().unwrap_or(1);
            let layers = imgs
                .into_iter()
                .map(|(name, image)| PsdLayer { name, x: 0, y: 0, image, visible: true })
                .collect();
            PsdDoc {
                width: max_w,
                height: max_h,
                groups: vec![PsdGroup { name: category.clone(), visible: true, layers }],
            }
        }
        CombineMode::Combined => {
            let cols = atlas_cols(imgs.len());
            let rows = (imgs.len() as u32).div_ceil(cols);
            let mut canvas = image::RgbaImage::new(cols * CELL, rows * CELL);
            for (i, (_, img)) in imgs.iter().enumerate() {
                let cx = (i as u32 % cols) * CELL;
                let cy = (i as u32 / cols) * CELL;
                image::imageops::overlay(&mut canvas, img, cx as i64, cy as i64);
            }
            PsdDoc {
                width: cols * CELL,
                height: rows * CELL,
                groups: vec![PsdGroup {
                    name: category.clone(),
                    visible: true,
                    layers: vec![PsdLayer {
                        name: BASE_LAYER.into(),
                        x: 0,
                        y: 0,
                        image: canvas,
                        visible: true,
                    }],
                }],
            }
        }
    };

    let bytes = write_psd(&doc);
    let out = category_psd_path(&project, cat);
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create psd dir: {e}"))?;
    }
    std::fs::write(&out, &bytes).map_err(|e| format!("write psd: {e}"))?;
    let _ = app.emit(
        "file-changed",
        serde_json::json!({ "path": out.to_string_lossy().replace('\\', "/"), "kind": "create" }),
    );
    Ok(out.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn apply_category_psd(
    project_path: String,
    category: String,
) -> Result<ApplyReport, String> {
    let _guard = PSD_OP_LOCK.lock().await;
    let cat = WallCategory::parse(&category).ok_or("unknown category")?;
    let project = PathBuf::from(&project_path);
    let psd_path = category_psd_path(&project, cat);

    let ordered: Vec<(String, PathBuf)> = find_wall_tiles(&project)
        .into_iter()
        .filter(|t| t.category == cat)
        .map(|t| (t.stem, t.path))
        .collect();
    let by_stem: std::collections::HashMap<&str, &PathBuf> =
        ordered.iter().map(|(s, p)| (s.as_str(), p)).collect();

    let psd_bytes = std::fs::read(&psd_path).map_err(|e| format!("read psd: {e}"))?;
    let psd = psd::Psd::from_bytes(&psd_bytes).map_err(|e| format!("parse psd: {:?}", e))?;
    let canvas_w = psd.width();
    let canvas_h = psd.height();

    let mut report = ApplyReport {
        written: 0,
        skipped: vec![],
        errors: vec![],
    };

    if let Some(base) = psd.layers().iter().find(|l| l.name() == BASE_LAYER) {
        let canvas = base.rgba();
        if canvas.len() < (canvas_w * canvas_h * 4) as usize {
            return Err("merged layer buffer too small".into());
        }
        let cols = atlas_cols(ordered.len());
        for (i, (_stem, path)) in ordered.iter().enumerate() {
            let cx = (i as u32 % cols) * CELL;
            let cy = (i as u32 / cols) * CELL;
            let (tw, th) = match std::fs::read(path)
                .ok()
                .and_then(|b| Texture::from_bytes(&b).ok())
            {
                Some(tex) => (tex.width.min(CELL), tex.height.min(CELL)),
                None => (CELL, CELL),
            };
            if cx + tw > canvas_w || cy + th > canvas_h {
                report.skipped.push(format!("cell {i}"));
                continue;
            }
            let tile = crop_tile(&canvas, canvas_w, cx, cy, tw, th);
            match write_tile_tex(path, &tile) {
                Ok(()) => report.written += 1,
                Err(e) => report.errors.push(format!("cell {i}: {e}")),
            }
        }
        return Ok(report);
    }

    for layer in psd.layers() {
        let name = layer.name().to_string();
        if name == "</Layer group>" {
            continue;
        }
        let Some(orig) = by_stem.get(name.as_str()) else {
            report.skipped.push(name);
            continue;
        };
        let canvas = layer.rgba();
        if canvas.len() < (canvas_w * canvas_h * 4) as usize {
            report.errors.push(format!("{name}: short rgba buffer"));
            continue;
        }
        let left = layer.layer_left().max(0) as u32;
        let top = layer.layer_top().max(0) as u32;
        let right = layer.layer_right().max(0) as u32;
        let bottom = layer.layer_bottom().max(0) as u32;
        if right < left || bottom < top {
            report.skipped.push(name);
            continue;
        }
        let tile = crop_tile(&canvas, canvas_w, left, top, right - left + 1, bottom - top + 1);
        match write_tile_tex(orig, &tile) {
            Ok(()) => report.written += 1,
            Err(e) => report.errors.push(format!("{name}: {e}")),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(name: &str) -> Option<GroundTile> {
        classify(&PathBuf::from(name))
    }

    #[test]
    fn classifies_base_grid_cell() {
        let g = t("ground_a1_alcovetop_a.tex").unwrap();
        assert_eq!((g.col, g.row), (0, 0));
        assert_eq!(g.group, TileGroup::Base);
    }

    #[test]
    fn classifies_dragon_element() {
        let g = t("ground_d4_dragonpit_fire_a.tex").unwrap();
        assert_eq!((g.col, g.row), (3, 3));
        assert_eq!(g.group, TileGroup::DragonElement("Infernal".into()));
    }

    #[test]
    fn classifies_baron_stage() {
        let g = t("ground_b2_baronpit_walled_a.tex").unwrap();
        assert_eq!((g.col, g.row), (1, 1));
        assert_eq!(g.group, TileGroup::BaronStage("Walled".into()));
    }

    #[test]
    fn rejects_non_ground() {
        assert!(t("chaos_base_a_1bitalpha.tex").is_none());
        assert!(t("ground_z9_foo.tex").is_none());
    }

    fn wc(name: &str) -> Option<WallCategory> {
        classify_wall(&PathBuf::from(name)).map(|t| t.category)
    }

    #[test]
    fn classifies_wall_categories() {
        assert_eq!(wc("chaos_top_a_1bitalpha.tex"), Some(WallCategory::Walls));
        assert_eq!(wc("chaos_mid_b_1bitalpha.tex"), Some(WallCategory::Walls));
        assert_eq!(wc("chaos_gromp_a_1bitalpha.tex"), Some(WallCategory::Camps));
        assert_eq!(wc("chaos_baron_a_1bitalpha.tex"), Some(WallCategory::Pits));
        assert_eq!(wc("chaos_midriver_a_1bitalpha.tex"), Some(WallCategory::River));
        assert_eq!(wc("chaos_baronriver_a_1bitalpha.tex"), Some(WallCategory::Pits));
        assert_eq!(wc("ground_a1_alcovetop_a.tex"), None);
        assert_eq!(wc("chaos_x_wind_decal_02.tex"), None);
        assert_eq!(wc("hol_kaisastatue_a.tex"), Some(WallCategory::Misc));
    }

    #[test]
    fn rejects_decals_and_variants() {
        assert!(t("ground_d3_wind_decal_02.tex").is_none());
        assert!(t("ground_a1_overlay_mask.tex").is_none());
        assert!(t("ground_c2_chaosred_02.tex").is_none());
        assert!(t("ground_d3_chaosbase_a.tex").is_some());
    }

    #[test]
    fn psd_roundtrip_preserves_tile_pixels() {
        use crate::core::psd_write::{write_psd, PsdDoc, PsdGroup, PsdLayer};
        use image::{Rgba, RgbaImage};

        let tw = 8u32;
        let mut tile = RgbaImage::new(tw, tw);
        for y in 0..tw {
            for x in 0..tw {
                tile.put_pixel(x, y, Rgba([x as u8 * 10, y as u8 * 10, 77, 255]));
            }
        }
        let doc = PsdDoc {
            width: 16,
            height: 16,
            groups: vec![PsdGroup {
                name: "Base".into(),
                visible: true,
                layers: vec![PsdLayer {
                    name: "ground_b2_test_a".into(),
                    x: 8,
                    y: 8,
                    image: tile.clone(),
                    visible: true,
                }],
            }],
        };
        let bytes = write_psd(&doc);
        let psd = psd::Psd::from_bytes(&bytes).expect("parse");
        let canvas_w = psd.width();

        let layer = psd
            .layers()
            .iter()
            .find(|l| l.name() == "ground_b2_test_a")
            .expect("tile layer present");
        let left = layer.layer_left().max(0) as u32;
        let top = layer.layer_top().max(0) as u32;
        let right = layer.layer_right().max(0) as u32;
        let bottom = layer.layer_bottom().max(0) as u32;
        let (cw, ch) = (right - left + 1, bottom - top + 1);
        assert_eq!((cw, ch), (8, 8), "cropped size must equal the source tile");
        assert_eq!((left, top), (8, 8), "tile must be at its placed offset");

        let out = crop_tile(&layer.rgba(), canvas_w, left, top, cw, ch);
        assert_eq!(out.dimensions(), (8, 8));
        for y in 0..tw {
            for x in 0..tw {
                assert_eq!(
                    out.get_pixel(x, y).0,
                    tile.get_pixel(x, y).0,
                    "pixel mismatch at ({x},{y})"
                );
            }
        }
    }
}
