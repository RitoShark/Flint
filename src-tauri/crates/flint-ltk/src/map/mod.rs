//! Map project discovery & creation.
//!
//! Adapted from MapgeoAddon's `project_manager.py` — the relevant flow is:
//! find `Map<id>.wad.client` (and optionally `Map<id>LEVELS.wad.client`) in
//! `<League>/Game/DATA/FINAL/Maps/Shipping/`, scan it for variants
//! (`data/maps/mapgeometry/<id>/<variant>.{mapgeo,materials.bin}`), and pull
//! the WAD into the project.

use crate::error::{Error, Result};
use crate::hash::ResolvedHashes;
use crate::project::{create_project as core_create_project, Project};
use crate::wad::extractor::{extract_full_wad_filtered, resolve_wad_paths, ExtractionResult};
use league_toolkit::wad::{Wad, WadChunk};
use memmap2::Mmap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Cursor;
use std::path::{Path, PathBuf};

/// A map discovered in a League install.
#[derive(Debug, Clone, Serialize)]
pub struct MapEntry {
    /// Lowercase id, e.g. `"map11"`.
    pub id: String,
    /// Human-readable name, e.g. `"Summoner's Rift"`. Falls back to `"Map 11"`.
    pub display_name: String,
    /// Absolute path to `Map<id>.wad.client`.
    pub wad_path: PathBuf,
    /// Absolute path to `Map<id>LEVELS.wad.client`, if present.
    pub levels_wad_path: Option<PathBuf>,
}

/// A single mapgeo + materials.bin pair living inside a map WAD.
#[derive(Debug, Clone, Serialize)]
pub struct MapVariant {
    /// Variant base name, e.g. `"room"`, `"srx_baseworld"`.
    pub name: String,
    /// Resolved WAD-relative path to the .mapgeo file.
    pub mapgeo: String,
    /// Resolved WAD-relative path to the .materials.bin file.
    pub materials: String,
}

/// True if a WAD filename (already lowercased) carries a locale segment like
/// `.en_us.` / `.de_de.` between the map id and the WAD extension. League ships
/// one of these per supported language carrying audio/text bundles only — they
/// are useless for asset modding.
fn is_locale_wad_name(lower_name: &str) -> bool {
    // Strip the WAD suffix first so we look at just the stem.
    let stem = lower_name
        .strip_suffix(".wad.client")
        .or_else(|| lower_name.strip_suffix(".wad"))
        .unwrap_or(lower_name);
    // After the map id, a `.xx_yy` locale dot-segment is a clear signal.
    // Example stems: "map11.en_us", "map11.de_de", "common.fr_fr"
    if let Some(dot_idx) = stem.rfind('.') {
        let suffix = &stem[dot_idx + 1..];
        if is_locale_token(suffix) { return true; }
    }
    false
}

/// True for tokens like `en_us`, `de_de`, `pt_br` (already lowercase).
fn is_locale_token(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 5
        && bytes[2] == b'_'
        && bytes[0..2].iter().all(|b| b.is_ascii_lowercase())
        && bytes[3..5].iter().all(|b| b.is_ascii_lowercase())
}

/// True if a resolved chunk path lives under a localized subtree (`.../<locale>/...`
/// or filenames containing a locale token). We skip these during map extraction
/// because the modding workflow doesn't need per-language voiceover/text bundles.
pub fn is_locale_path(path_lower: &str) -> bool {
    for segment in path_lower.split(['/', '\\']) {
        if is_locale_token(segment) { return true; }
        // Filenames with a `.<locale>.` infix, e.g. `voices.en_us.bnk`.
        for part in segment.split('.') {
            if is_locale_token(part) { return true; }
        }
    }
    false
}

/// Locate `<league>/Game/DATA/FINAL/Maps/Shipping/`.
pub fn maps_shipping_dir(league_path: &Path) -> Option<PathBuf> {
    let candidate = league_path
        .join("Game")
        .join("DATA")
        .join("FINAL")
        .join("Maps")
        .join("Shipping");
    if candidate.is_dir() { Some(candidate) } else { None }
}

/// Hardcoded display names for the well-known map IDs. Anything not listed
/// falls back to `Map <N>` (or the raw id if it doesn't parse as a number).
fn display_name_for(id: &str) -> String {
    let lower = id.to_lowercase();
    let known: &[(&str, &str)] = &[
        ("map11", "Summoner's Rift"),
        ("map12", "Howling Abyss"),
        ("map21", "Nexus Blitz"),
        ("map22", "TFT"),
        ("map30", "Arena"),
        ("map33", "Swarm"),
        ("common", "Common (shared assets)"),
    ];
    for (k, v) in known {
        if &lower == k { return (*v).to_string(); }
    }
    if let Some(rest) = lower.strip_prefix("map") {
        if rest.chars().all(|c| c.is_ascii_digit()) {
            return format!("Map {}", rest);
        }
    }
    id.to_string()
}

/// Scan the maps shipping dir for `Map*.wad.client` files (and matching
/// `Map*LEVELS.wad.client` siblings). Common.wad.client is included too.
pub fn list_available_maps(league_path: &Path) -> Result<Vec<MapEntry>> {
    let dir = maps_shipping_dir(league_path)
        .ok_or_else(|| Error::InvalidInput(format!(
            "Maps directory not found under '{}'. Expected Game/DATA/FINAL/Maps/Shipping/.",
            league_path.display()
        )))?;

    // First pass: index every .wad / .wad.client by lowercase filename so we
    // can pair main + LEVELS without doing a second readdir.
    let mut by_name: HashMap<String, PathBuf> = HashMap::new();
    for entry in fs::read_dir(&dir).map_err(|e| Error::io_with_path(e, &dir))? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() { continue; }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
        if !name.ends_with(".wad.client") && !name.ends_with(".wad") { continue; }
        // Skip language-specific WADs (Map11.en_US.wad.client, Map11.de_DE.wad.client, …).
        // Their stem after stripping the WAD suffix matches `<id>.<locale>` where the
        // locale is two lowercase letters + underscore + two uppercase letters in the
        // original filename. Working in lowercase so we just match `_xx`.
        if is_locale_wad_name(&name) { continue; }
        by_name.insert(name, path);
    }

    let mut maps: HashMap<String, MapEntry> = HashMap::new();

    for (name, path) in &by_name {
        // Strip .wad.client / .wad
        let stem = name
            .strip_suffix(".wad.client")
            .or_else(|| name.strip_suffix(".wad"))
            .unwrap_or(name.as_str());

        // Skip LEVELS WADs in the main pass — they're paired below.
        if stem.ends_with("levels") { continue; }

        // Accept "common" or anything that starts with "map".
        let id = if stem == "common" { "common".to_string() }
                 else if stem.starts_with("map") { stem.to_string() }
                 else { continue };

        // Look for a paired LEVELS WAD using the same suffix style.
        let levels_name_client = format!("{}levels.wad.client", id);
        let levels_name_plain = format!("{}levels.wad", id);
        let levels_wad_path = by_name
            .get(&levels_name_client)
            .or_else(|| by_name.get(&levels_name_plain))
            .cloned();

        maps.insert(id.clone(), MapEntry {
            display_name: display_name_for(&id),
            id,
            wad_path: path.clone(),
            levels_wad_path,
        });
    }

    let mut result: Vec<MapEntry> = maps.into_values().collect();
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(result)
}

/// Mount the map's WAD, resolve every chunk's path hash, and group the
/// resulting paths by variant (the base name shared between a `.mapgeo`
/// and a `.materials.bin` under `data/maps/mapgeometry/<map_id>/`).
pub fn list_map_variants(
    league_path: &Path,
    map_id: &str,
    resolve_paths: impl Fn(&[u64]) -> ResolvedHashes,
) -> Result<Vec<MapVariant>> {
    let maps = list_available_maps(league_path)?;
    let entry = maps.into_iter().find(|m| m.id.eq_ignore_ascii_case(map_id))
        .ok_or_else(|| Error::InvalidInput(format!(
            "Map id '{}' not found in League install at '{}'", map_id, league_path.display()
        )))?;

    let resolved = resolve_wad_paths(&entry.wad_path, resolve_paths)?;

    // Group resolved paths under data/maps/mapgeometry/<map_id>/ by variant base.
    let prefix = format!("data/maps/mapgeometry/{}/", map_id.to_lowercase());
    let mut variants: HashMap<String, MapVariant> = HashMap::new();

    for (_hash, path) in resolved.iter() {
        let lower = path.to_lowercase();
        if !lower.starts_with(&prefix) { continue; }
        let rel = &lower[prefix.len()..];
        // We only care about the file name; sub-folders (lightmaps/, etc.)
        // get filtered out here.
        if rel.contains('/') { continue; }

        if let Some(base) = rel.strip_suffix(".mapgeo") {
            variants.entry(base.to_string())
                .and_modify(|v| v.mapgeo = path.to_string())
                .or_insert_with(|| MapVariant {
                    name: base.to_string(),
                    mapgeo: path.to_string(),
                    materials: String::new(),
                });
        } else if let Some(base) = rel.strip_suffix(".materials.bin") {
            variants.entry(base.to_string())
                .and_modify(|v| v.materials = path.to_string())
                .or_insert_with(|| MapVariant {
                    name: base.to_string(),
                    mapgeo: String::new(),
                    materials: path.to_string(),
                });
        }
    }

    // Only keep variants that have both halves — a lone mapgeo or lone
    // materials.bin is not loadable.
    let mut result: Vec<MapVariant> = variants
        .into_values()
        .filter(|v| !v.mapgeo.is_empty() && !v.materials.is_empty())
        .collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

/// Output of `create_map_project`.
#[derive(Debug, Clone, Serialize)]
pub struct MapProjectResult {
    pub project: Project,
    pub main_extracted: usize,
    pub levels_extracted: usize,
    /// True when the result came from variant-scoped extraction (vs. a full WAD dump).
    pub variant_scoped: bool,
}

/// Extraction strategy for a map project.
///
/// `Variant` only pulls the chosen variant's `.mapgeo` + `.materials.bin` from
/// the main WAD, every asset path that materials.bin references, and the
/// matching lightmap/lightgrid pair from the LEVELS WAD — the same shape
/// MapgeoAddon's `EMPTY`/`SEMI` modes produce, just with the referenced
/// kit-piece textures already pulled. `Full` is the legacy whole-WAD dump.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MapExtractMode {
    Variant,
    Full,
}

/// Create a new map project: makes the project structure, then extracts
/// either the chosen variant only (default) or the entire WAD into
/// `<project>/content/base/<wad_filename>/`.
///
/// The `champion` slot of the Project struct is set to `"map-<id>"` so the
/// recent-projects list and existing UI code can identify it without a
/// schema change. (See plan §6 for the longer-term cleanup.)
#[allow(clippy::too_many_arguments)]
pub fn create_map_project(
    name: &str,
    map_id: &str,
    include_levels: bool,
    league_path: &Path,
    output_dir: &Path,
    author: Option<String>,
    mode: MapExtractMode,
    variant_name: Option<&str>,
    resolve_paths: impl Fn(&[u64]) -> ResolvedHashes + Send + Sync,
    progress: impl Fn(&str, &str),
) -> Result<MapProjectResult> {
    progress("init", "Locating map WADs...");
    let maps = list_available_maps(league_path)?;
    let entry = maps.into_iter().find(|m| m.id.eq_ignore_ascii_case(map_id))
        .ok_or_else(|| Error::InvalidInput(format!(
            "Map id '{}' not found in League install at '{}'", map_id, league_path.display()
        )))?;

    progress("create", "Creating project structure...");
    let champion_tag = format!("map-{}", entry.id);
    let project = core_create_project(name, &champion_tag, 0, league_path, output_dir, author)?;

    let assets_root = project.assets_path();

    let main_wad_name = entry.wad_path
        .file_name().and_then(|n| n.to_str())
        .unwrap_or("map.wad.client")
        .to_string();
    let main_out = assets_root.join(&main_wad_name);

    let main_extracted: usize;
    let mut levels_extracted = 0usize;
    let variant_scoped = matches!(mode, MapExtractMode::Variant);

    match mode {
        MapExtractMode::Full => {
            progress("extract", &format!("Extracting full WAD: {}...", main_wad_name));
            let main_result: ExtractionResult = match extract_full_wad_filtered(
                &entry.wad_path,
                &main_out,
                &resolve_paths,
                is_locale_path,
            ) {
                Ok(r) => r,
                Err(e) => {
                    let _ = fs::remove_dir_all(&project.project_path);
                    return Err(e);
                }
            };
            main_extracted = main_result.extracted_count;

            if include_levels {
                if let Some(levels_path) = entry.levels_wad_path.as_ref() {
                    let levels_name = levels_path
                        .file_name().and_then(|n| n.to_str())
                        .unwrap_or("levels.wad.client").to_string();
                    let levels_out = assets_root.join(&levels_name);
                    progress("extract", &format!("Extracting {}...", levels_name));
                    match extract_full_wad_filtered(levels_path, &levels_out, &resolve_paths, is_locale_path) {
                        Ok(r) => { levels_extracted = r.extracted_count; }
                        Err(e) => tracing::warn!("LEVELS WAD extraction failed: {}", e),
                    }
                }
            }
        }
        MapExtractMode::Variant => {
            let variant = variant_name.ok_or_else(|| Error::InvalidInput(
                "Variant-scoped extraction requires variant_name".into(),
            ))?;
            progress("extract", &format!("Extracting {} variant '{}'...", main_wad_name, variant));
            match extract_variant_files(
                &entry.wad_path,
                &main_out,
                &entry.id,
                variant,
            ) {
                Ok(n) => { main_extracted = n; }
                Err(e) => {
                    let _ = fs::remove_dir_all(&project.project_path);
                    return Err(e);
                }
            }

            if include_levels {
                if let Some(levels_path) = entry.levels_wad_path.as_ref() {
                    let levels_name = levels_path
                        .file_name().and_then(|n| n.to_str())
                        .unwrap_or("levels.wad.client").to_string();
                    let levels_out = assets_root.join(&levels_name);
                    progress("extract", &format!("Extracting LEVELS for variant '{}'...", variant));
                    match extract_levels_variant_files(levels_path, &levels_out, &entry.id, variant) {
                        Ok(n) => { levels_extracted = n; }
                        Err(e) => tracing::warn!("LEVELS variant extraction failed: {}", e),
                    }
                }
            }
        }
    }

    progress("complete", "Map project created.");
    Ok(MapProjectResult {
        project,
        main_extracted,
        levels_extracted,
        variant_scoped,
    })
}

// ─── Variant-scoped extraction ─────────────────────────────────────────────

fn xx64(s: &str) -> u64 {
    xxhash_rust::xxh64::xxh64(s.as_bytes(), 0)
}

/// Extract one chunk of a mounted WAD to disk by absolute path. Skips
/// silently if the chunk isn't present in the WAD.
fn extract_one(
    wad: &mut Wad<Cursor<&[u8]>>,
    by_hash: &HashMap<u64, WadChunk>,
    rel_path: &str,
    output_dir: &Path,
) -> Result<bool> {
    let h = xx64(rel_path);
    let Some(chunk) = by_hash.get(&h).copied() else { return Ok(false); };
    let data = wad.load_chunk_decompressed(&chunk).map_err(|e| Error::Wad {
        message: format!("Failed to decompress chunk for '{}': {}", rel_path, e),
        path: None,
    })?;
    let out = output_dir.join(rel_path.replace('\\', "/"));
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
    }
    fs::write(&out, &data).map_err(|e| Error::io_with_path(e, &out))?;
    Ok(true)
}

const ASSET_PREFIXES: &[&str] = &[
    "assets/", "data/",
];

const ASSET_EXTS: &[&str] = &[
    ".dds", ".tex", ".png", ".tga", ".skn", ".scb", ".sco", ".skl", ".bin",
    ".wpk", ".bnk", ".troybin", ".bnk", ".anm",
];

/// Scan a BIN's raw bytes for length-prefixed UTF-8 strings that look like
/// asset paths (start with `assets/`/`data/`, end in a known extension).
/// Same approach as the extract_hashes scanner, but tighter — we only need
/// paths that materials.bin actually references.
fn scan_referenced_paths(data: &[u8]) -> HashSet<String> {
    let mut out = HashSet::new();
    if data.len() < 4 { return out; }
    let mut i = 0usize;
    while i + 2 <= data.len() {
        let len = u16::from_le_bytes([data[i], data[i + 1]]) as usize;
        // Asset paths in BINs are typically 12–260 bytes. Tightening the
        // bounds vs. the hash extractor means we don't fish out garbage.
        if (12..=260).contains(&len) {
            if let Some(slice) = data.get(i + 2..i + 2 + len) {
                if let Ok(s) = std::str::from_utf8(slice) {
                    let lb = s.as_bytes();
                    if s.is_ascii() && s.contains('/') {
                        let lower = s.to_ascii_lowercase();
                        let prefix_match = ASSET_PREFIXES.iter()
                            .any(|p| lb.len() >= p.len() && lower.as_bytes()[..p.len()].eq(p.as_bytes()));
                        let ext_match = ASSET_EXTS.iter().any(|e| lower.ends_with(e));
                        if prefix_match && ext_match {
                            out.insert(lower);
                            i += 2 + len;
                            continue;
                        }
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// Pull `<variant>.mapgeo` + `<variant>.materials.bin` out of the main map
/// WAD, then walk materials.bin's string table and pull every asset path it
/// references. Skips missing chunks silently — Riot ships some materials
/// that reference shared textures from `Common.wad.client`, which the user
/// can layer in separately if they need to swap them.
pub fn extract_variant_files(
    wad_path: &Path,
    output_dir: &Path,
    map_id: &str,
    variant: &str,
) -> Result<usize> {
    let map_lower = map_id.to_lowercase();
    let var_lower = variant.to_lowercase();
    let prefix = format!("data/maps/mapgeometry/{}/", map_lower);
    let mapgeo_path = format!("{}{}.mapgeo", prefix, var_lower);
    let materials_path = format!("{}{}.materials.bin", prefix, var_lower);

    let file = File::open(wad_path).map_err(|e| Error::io_with_path(e, wad_path))?;
    let mmap = unsafe { Mmap::map(&file) }.map_err(|e| Error::Wad {
        message: format!("Failed to mmap WAD: {}", e),
        path: Some(wad_path.to_path_buf()),
    })?;
    let mut wad = Wad::mount(Cursor::new(&mmap[..])).map_err(|e| Error::Wad {
        message: format!("Failed to mount WAD: {}", e),
        path: Some(wad_path.to_path_buf()),
    })?;

    let by_hash: HashMap<u64, WadChunk> = wad
        .chunks().iter().copied()
        .map(|c| (c.path_hash(), c))
        .collect();

    fs::create_dir_all(output_dir).map_err(|e| Error::io_with_path(e, output_dir))?;

    let mut extracted = 0usize;
    if extract_one(&mut wad, &by_hash, &mapgeo_path, output_dir)? { extracted += 1; }
    if extract_one(&mut wad, &by_hash, &materials_path, output_dir)? { extracted += 1; }

    // Scan materials.bin for referenced paths. If we couldn't pull it (e.g.
    // hash miss), there's nothing to scan and we just return what we have.
    let mat_h = xx64(&materials_path);
    if let Some(chunk) = by_hash.get(&mat_h).copied() {
        if let Ok(bytes) = wad.load_chunk_decompressed(&chunk) {
            let referenced = scan_referenced_paths(&bytes);
            tracing::info!(
                "Variant '{}' references {} candidate asset path(s) in materials.bin",
                variant, referenced.len()
            );
            for path in referenced {
                if extract_one(&mut wad, &by_hash, &path, output_dir).unwrap_or(false) {
                    extracted += 1;
                }
            }
        }
    }

    tracing::info!(
        "Variant-scoped extraction wrote {} files for {}/{}",
        extracted, map_id, variant
    );
    Ok(extracted)
}

/// Variant-scoped LEVELS WAD extraction. Mirrors MapgeoAddon's
/// `_preregister_levels_hashes` — enumerates known lightmap/lightgrid path
/// patterns and pulls only the chunks that actually exist for this variant.
pub fn extract_levels_variant_files(
    wad_path: &Path,
    output_dir: &Path,
    map_id: &str,
    variant: &str,
) -> Result<usize> {
    let map_lower = map_id.to_lowercase();
    let var_lower = variant.to_lowercase();

    // Suffix forms a variant might appear under inside LEVELS path patterns.
    // We try the bare variant name plus the addon's pre-known suffix set —
    // covers the dragon variants on Map11.
    let mut suffixes: Vec<String> = vec![
        String::new(),
        format!("_{}", var_lower),
    ];
    for extra in [
        "_srx", "_base_srx",
        "_srx.srt_2024_strategy_differentiation_preseason",
        "_srx.cloud", "_srx.hextech", "_srx.chemtech",
        "_srx.infernal", "_srx.mountain", "_srx.ocean", "_srx.void",
    ] {
        suffixes.push(extra.to_string());
    }
    suffixes.sort();
    suffixes.dedup();

    let info_dir = format!("levels/{}/info", map_lower);
    let mut candidates: HashSet<String> = HashSet::new();
    for suf in &suffixes {
        for ext in [".dds", ".tex"] {
            candidates.insert(format!("{}/grasstint{}{}", info_dir, suf, ext));
            candidates.insert(format!("{}/lightmap{}{}", info_dir, suf, ext));
            candidates.insert(format!("{}/rma_lightmap{}{}", info_dir, suf, ext));
        }
        candidates.insert(format!("{}/base{}.lightgrid.bin", info_dir, suf));
        candidates.insert(format!("{}/{}{}.lightgrid.bin", info_dir, map_lower, suf));
    }
    candidates.insert(format!("{}/maplight_rma.bin", info_dir));
    candidates.insert(format!("{}/lightgrid.bin", info_dir));
    candidates.insert(format!("{}/mapdata.bin", info_dir));

    // Riot uses both `levels/...` and `data/levels/...` for these.
    let with_data: Vec<String> = candidates.iter().map(|p| format!("data/{}", p)).collect();
    candidates.extend(with_data);

    let file = File::open(wad_path).map_err(|e| Error::io_with_path(e, wad_path))?;
    let mmap = unsafe { Mmap::map(&file) }.map_err(|e| Error::Wad {
        message: format!("Failed to mmap LEVELS WAD: {}", e),
        path: Some(wad_path.to_path_buf()),
    })?;
    let mut wad = Wad::mount(Cursor::new(&mmap[..])).map_err(|e| Error::Wad {
        message: format!("Failed to mount LEVELS WAD: {}", e),
        path: Some(wad_path.to_path_buf()),
    })?;
    let by_hash: HashMap<u64, WadChunk> = wad
        .chunks().iter().copied()
        .map(|c| (c.path_hash(), c))
        .collect();

    fs::create_dir_all(output_dir).map_err(|e| Error::io_with_path(e, output_dir))?;
    let mut extracted = 0usize;
    for path in candidates {
        if extract_one(&mut wad, &by_hash, &path, output_dir).unwrap_or(false) {
            extracted += 1;
        }
    }
    tracing::info!("LEVELS variant extraction wrote {} files for {}/{}", extracted, map_id, variant);
    Ok(extracted)
}
