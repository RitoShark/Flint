//! Repathing engine: scans BIN files for asset paths (`assets/`, `data/`),
//! prefixes them with `ASSETS/{creator}/{project}`, and relocates the files.

use crate::bin::ltk_bridge::{read_bin, write_bin};
use crate::error::{Error, Result};
use ritoshark::bin::BinValue;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::LazyLock;
use walkdir::WalkDir;
use rayon::prelude::*;
use dashmap::DashSet;
use regex::Regex;

fn fnv1a_hash(s: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for &b in s.to_lowercase().as_bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

static CHAMPION_SKIN_NAME_HASH: LazyLock<u32> = LazyLock::new(|| {
    fnv1a_hash("championSkinName")
});

/// Case-insensitive: League uses mixed case ("skin19/" / "Skin19/") internally.
static SKIN_FOLDER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(skin)(\d+)(/)").expect("Invalid skin folder regex")
});

static BASE_MIDDLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)/base/").expect("Invalid base folder regex")
});

#[derive(Debug, Clone, PartialEq, Eq)]
enum AssetPath<'a> {
    /// SFX files — repath to audio/sfx/. Live in the champion WAD.
    SoundSfx {
        filename: &'a str,
    },

    /// VO files — NOT repathed: they live in separate language WADs and must
    /// keep their original paths or the game can't find them.
    SoundVo {
        original_path: &'a str,
    },

    /// `characters/{champion}/hud/{filename}` → project-level hud/ folder.
    ChampionHud {
        filename: &'a str,
    },

    /// `characters/{target_champion}/skins/skinXX/...` → project folder, skin ID remapped.
    TargetChampionSkin {
        skin_id: Option<u32>,
        /// Everything after the champion folder (may include skins/ prefix).
        subpath: &'a str,
    },

    /// `characters/{other_champion}/...` → creator-level shared-champion/ folder.
    OtherChampion {
        /// Everything after "characters/{champion}/".
        subpath: &'a str,
    },

    /// Non-champion assets (particles/, maps/, …) → creator-level shared/ folder.
    Shared {
        /// Path after stripping "shared/" prefix if present.
        subpath: &'a str,
    },
}

impl<'a> AssetPath<'a> {
    fn parse(path: &'a str, target_champion: &str) -> Option<Self> {
        let stripped = if path.len() >= 7 && path[..7].eq_ignore_ascii_case("assets/") {
            &path[7..]
        } else if path.len() >= 5 && path[..5].eq_ignore_ascii_case("data/") {
            &path[5..]
        } else {
            return None;
        };

        if let Some(sound_path) = Self::strip_prefix_ignore_case(stripped, "sounds/") {
            if Self::contains_ignore_case(sound_path, "/vo/") {
                return Some(AssetPath::SoundVo {
                    original_path: path,
                });
            }

            let filename = sound_path.split('/').next_back().unwrap_or(sound_path);
            return Some(AssetPath::SoundSfx { filename });
        }

        if let Some(rest) = Self::strip_prefix_ignore_case(stripped, "characters/") {
            let mut parts = rest.splitn(2, '/');
            let champion = parts.next()?;
            let subpath = parts.next().unwrap_or("");

            if let Some(filename) = Self::strip_prefix_ignore_case(subpath, "hud/") {
                if champion.eq_ignore_ascii_case(target_champion) {
                    return Some(AssetPath::ChampionHud { filename });
                }
            }

            if champion.eq_ignore_ascii_case(target_champion) {
                let skin_id = if let Some(skins_path) = Self::strip_prefix_ignore_case(subpath, "skins/") {
                    skins_path
                        .split('/')
                        .next()
                        .and_then(|s| Self::strip_prefix_ignore_case(s, "skin"))
                        .and_then(|s| s.parse::<u32>().ok())
                } else {
                    None
                };

                return Some(AssetPath::TargetChampionSkin { skin_id, subpath });
            } else {
                return Some(AssetPath::OtherChampion { subpath });
            }
        }

        // Strip "shared/" prefix if present to avoid duplication.
        let subpath = Self::strip_prefix_ignore_case(stripped, "shared/").unwrap_or(stripped);
        Some(AssetPath::Shared { subpath })
    }

    fn to_repathed(&self, config: &RepathConfig) -> String {
        let creator = config.creator_name.replace(' ', "-");
        let prefix = config.prefix();

        match self {
            AssetPath::SoundSfx { filename } => {
                format!("ASSETS/{}/audio/sfx/{}", prefix, filename)
            }
            AssetPath::SoundVo { original_path } => {
                original_path.to_string()
            }
            AssetPath::ChampionHud { filename } => {
                format!("ASSETS/{}/hud/{}", prefix, filename)
            }
            AssetPath::TargetChampionSkin { subpath, .. } => {
                let after_skins = Self::strip_prefix_ignore_case(subpath, "skins/")
                    .unwrap_or(subpath);

                let without_skin_folder = SKIN_FOLDER_RE.replace(after_skins, "").into_owned();

                let without_base = strip_base_folder(&without_skin_folder);

                let remapped = remap_animation_bin_filename(&without_base, config.target_skin_id);

                format!("ASSETS/{}/{}", prefix, remapped)
            }
            AssetPath::OtherChampion { subpath } => {
                // Flatten: drop skins/ and skinN/ folders from other-champion assets.
                let parts: Vec<&str> = subpath.split('/').collect();
                let flattened = if parts.len() >= 3 && parts[0].eq_ignore_ascii_case("skins") {
                    parts[2..].join("/")
                } else if parts.len() >= 2 && parts[0].eq_ignore_ascii_case("skins") {
                    parts[1..].join("/")
                } else {
                    subpath.to_string()
                };
                format!("ASSETS/{}/shared-champion/{}", creator, flattened)
            }
            AssetPath::Shared { subpath } => {
                format!("ASSETS/{}/shared/{}", creator, subpath)
            }
        }
    }

    #[inline]
    fn strip_prefix_ignore_case<'b>(s: &'b str, prefix: &str) -> Option<&'b str> {
        if s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix) {
            Some(&s[prefix.len()..])
        } else {
            None
        }
    }

    #[inline]
    fn contains_ignore_case(s: &str, pattern: &str) -> bool {
        s.to_lowercase().contains(&pattern.to_lowercase())
    }
}

#[derive(Debug, Clone)]
pub struct RepathConfig {
    pub creator_name: String,
    pub project_name: String,
    pub champion: String,
    pub target_skin_id: u32,
    pub cleanup_unused: bool,
    pub skip_bin_cleanup: bool,
}

impl RepathConfig {
    pub fn prefix(&self) -> String {
        let creator = self.creator_name.replace(' ', "-");
        let project = self.project_name.replace(' ', "-");
        format!("{}/{}", creator, project)
    }
}

#[derive(Debug, Clone)]
pub struct RepathResult {
    pub bins_processed: usize,
    pub paths_modified: usize,
    pub files_relocated: usize,
    pub files_removed: usize,
    pub missing_paths: Vec<String>,
}

pub fn repath_project(
    content_base: &Path,
    config: &RepathConfig,
    path_mappings: &HashMap<String, String>,
) -> Result<RepathResult> {
    tracing::info!(
        "Starting repathing for project with prefix: ASSETS/{}",
        config.prefix()
    );

    if !content_base.exists() {
        return Err(Error::InvalidInput(format!(
            "Content base directory not found: {}",
            content_base.display()
        )));
    }

    let champion_lower = config.champion.to_lowercase();
    let wad_folder_name = format!("{}.wad.client", champion_lower);
    let wad_base = content_base.join(&wad_folder_name);

    let file_base = if wad_base.exists() {
        tracing::info!("Using WAD folder structure: {}", wad_base.display());
        &wad_base
    } else {
        tracing::info!("Using legacy folder structure (no WAD folder found)");
        content_base
    };

    let mut result = RepathResult {
        bins_processed: 0,
        paths_modified: 0,
        files_relocated: 0,
        files_removed: 0,
        missing_paths: Vec::new(),
    };

    let main_bin_path = if !config.champion.is_empty() {
        find_main_skin_bin(file_base, &config.champion, config.target_skin_id)
    } else {
        None
    };

    let mut bin_files: Vec<PathBuf> = Vec::new();

    if let Some(ref main_path) = main_bin_path {
        tracing::info!("Found main skin BIN: {}", main_path.display());
        bin_files.push(main_path.clone());

        if let Ok(data) = fs::read(main_path) {
            if let Ok(bin) = read_bin(&data) {
                tracing::info!("Main skin BIN has {} dependencies", bin.linked.len());

                for dep_path in &bin.linked {
                    let normalized_path = dep_path.to_lowercase().replace('\\', "/");

                    let actual_path = path_mappings.get(&normalized_path)
                        .cloned()
                        .unwrap_or_else(|| normalized_path.clone());
                    
                    let full_path = file_base.join(&actual_path);
                    if full_path.exists() {
                        bin_files.push(full_path);
                    } else {
                        tracing::warn!("Linked BIN not found: {}", normalized_path);
                    }
                }
            }
        }
    } else {
        tracing::warn!("No main skin BIN found, falling back to scanning all BINs");
        bin_files = WalkDir::new(file_base)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .map(|ext| ext.eq_ignore_ascii_case("bin"))
                    .unwrap_or(false)
            })
            .map(|e| e.path().to_path_buf())
            .collect();
    }

    tracing::info!("Processing {} BIN files", bin_files.len());

    let all_asset_paths_set: DashSet<String> = DashSet::new();
    bin_files.par_iter().for_each(|bin_path| {
        if let Ok(paths) = scan_bin_for_paths(bin_path) {
            for path in paths {
                all_asset_paths_set.insert(path);
            }
        }
    });
    tracing::info!("Found {} unique asset paths in BINs", all_asset_paths_set.len());

    let all_asset_paths: HashSet<String> = all_asset_paths_set.into_iter().collect();

    let t_step3 = std::time::Instant::now();
    /* Stat each candidate path in parallel (independent reads, Windows stat is
       per-call kernel-transition bound). Case-insensitive since the Windows FS is. */
    let asset_path_vec: Vec<&String> = all_asset_paths.iter().collect();
    let existing_paths: HashSet<String> = asset_path_vec
        .par_iter()
        .filter(|path| {
            let full_path = file_base.join(path);
            if full_path.exists() {
                return true;
            }
            // Case-insensitive fallback, only on miss (reading the parent dir is expensive).
            if let Some(parent) = full_path.parent() {
                if parent.exists() {
                    if let Some(filename) = full_path.file_name() {
                        let filename_lower = filename.to_string_lossy().to_lowercase();
                        if let Ok(entries) = std::fs::read_dir(parent) {
                            for entry in entries.filter_map(|e| e.ok()) {
                                let entry_name = entry.file_name().to_string_lossy().to_lowercase();
                                if entry_name == filename_lower {
                                    return true;
                                }
                            }
                        }
                    }
                }
            }
            false
        })
        .map(|p| (*p).clone())
        .collect();

    let missing_count = all_asset_paths.len() - existing_paths.len();
    if missing_count > 0 {
        tracing::warn!("{} asset paths referenced in BINs but not found on disk:", missing_count);
        for path in all_asset_paths.difference(&existing_paths).take(10) {
            tracing::warn!("  Missing: {}", path);
        }
        if missing_count > 10 {
            tracing::warn!("  ... and {} more", missing_count - 10);
        }
    }

    for path in all_asset_paths.difference(&existing_paths) {
        result.missing_paths.push(path.clone());
    }
    tracing::info!("[TIMING] step3 existing_paths filter ({} paths): {:?}", all_asset_paths.len(), t_step3.elapsed());

    let t_step4 = std::time::Instant::now();
    let prefix = config.prefix();
    let bins_processed = AtomicUsize::new(0);
    let paths_modified = AtomicUsize::new(0);

    bin_files.par_iter().for_each(|bin_path| {
        match repath_bin_file(bin_path, &existing_paths, &prefix, config) {
            Ok(modified_count) => {
                bins_processed.fetch_add(1, Ordering::Relaxed);
                paths_modified.fetch_add(modified_count, Ordering::Relaxed);
            }
            Err(e) => {
                tracing::warn!("Failed to repath {}: {}", bin_path.display(), e);
            }
        }
    });

    result.bins_processed = bins_processed.load(Ordering::Relaxed);
    result.paths_modified = paths_modified.load(Ordering::Relaxed);
    tracing::info!("[TIMING] step4 repath {} BINs in parallel: {:?}", result.bins_processed, t_step4.elapsed());

    let t_step5 = std::time::Instant::now();
    result.files_relocated = relocate_assets(file_base, &existing_paths, &prefix, config)?;
    tracing::info!("[TIMING] step5 relocate_assets ({} files): {:?}", result.files_relocated, t_step5.elapsed());

    if config.cleanup_unused {
        let t_step6 = std::time::Instant::now();
        result.files_removed = cleanup_unused_files(file_base, &existing_paths, &prefix, config)?;
        tracing::info!("[TIMING] step6 cleanup_unused_files ({} removed): {:?}", result.files_removed, t_step6.elapsed());
    }

    if !config.skip_bin_cleanup {
        let t_step7 = std::time::Instant::now();
        let keep = referenced_bin_keep_set(file_base);
        cleanup_irrelevant_bins(file_base, &config.champion, config.target_skin_id, &keep)?;
        tracing::info!("[TIMING] step7 cleanup_irrelevant_bins: {:?}", t_step7.elapsed());
    } else {
        tracing::info!("Skipping cleanup_irrelevant_bins because skip_bin_cleanup is true");
    }

    let t_step8 = std::time::Instant::now();
    cleanup_empty_dirs(file_base)?;
    tracing::info!("[TIMING] step8 cleanup_empty_dirs: {:?}", t_step8.elapsed());

    tracing::info!(
        "Repathing complete: {} bins, {} paths modified, {} files relocated",
        result.bins_processed,
        result.paths_modified,
        result.files_relocated
    );

    Ok(result)
}

fn scan_bin_for_paths(bin_path: &Path) -> Result<Vec<String>> {
    let data = fs::read(bin_path).map_err(|e| Error::io_with_path(e, bin_path))?;

    let bin = read_bin(&data)
        .map_err(|e| Error::InvalidInput(format!("Failed to parse BIN: {}", e)))?;

    let mut paths = Vec::new();

    for entry in &bin.entries {
        for value in entry.fields.values() {
            collect_paths_from_value(value, &mut paths);
        }
    }

    Ok(paths)
}

fn collect_paths_from_value(value: &BinValue, paths: &mut Vec<String>) {
    match value {
        BinValue::String(s) => {
            if is_asset_path(s) {
                paths.push(normalize_path(s));
            }
        }
        BinValue::List { items, .. } => {
            for item in items {
                collect_paths_from_value(item, paths);
            }
        }
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for v in fields.values() {
                collect_paths_from_value(v, paths);
            }
        }
        BinValue::Option { value: Some(inner), .. } => {
            collect_paths_from_value(inner, paths);
        }
        BinValue::Map { entries, .. } => {
            for (key, val) in entries {
                collect_paths_from_value(key, paths);
                collect_paths_from_value(val, paths);
            }
        }
        _ => {}
    }
}

fn is_asset_path(s: &str) -> bool {
    if s.len() < 5 {
        return false;
    }

    (s.len() >= 7 && s[..7].eq_ignore_ascii_case("assets/")) ||
    (s.len() >= 5 && s[..5].eq_ignore_ascii_case("data/"))
}

/// Lowercase with forward slashes.
fn normalize_path(s: &str) -> String {
    s.to_lowercase().replace('\\', "/")
}

fn apply_prefix_to_path(path: &str, _prefix: &str, config: &RepathConfig) -> String {
    if let Some(asset_path) = AssetPath::parse(path, &config.champion) {
        asset_path.to_repathed(config)
    } else {
        tracing::warn!("Invalid asset path (no assets/ or data/ prefix): {}", path);
        path.to_string()
    }
}

fn repath_bin_file(bin_path: &Path, existing_paths: &HashSet<String>, prefix: &str, config: &RepathConfig) -> Result<usize> {
    let data = fs::read(bin_path).map_err(|e| Error::io_with_path(e, bin_path))?;

    let mut bin = read_bin(&data)
        .map_err(|e| Error::InvalidInput(format!("Failed to parse BIN: {}", e)))?;

    let mut modified_count = 0;

    for entry in bin.entries.iter_mut() {
        for (prop_name, value) in entry.fields.iter_mut() {
            if *prop_name == *CHAMPION_SKIN_NAME_HASH {
                if let BinValue::String(ref mut s) = value {
                    let sanitized_name = config.project_name.replace(' ', "-");
                    *s = sanitized_name.clone();
                    modified_count += 1;
                    tracing::debug!("Replaced championSkinName with '{}' (sanitized from '{}')", sanitized_name, config.project_name);
                }
            }

            modified_count += repath_value(value, existing_paths, prefix, config);
        }
    }

    if modified_count > 0 {
        let new_data = write_bin(&bin)
            .map_err(|e| Error::InvalidInput(format!("Failed to write BIN: {}", e)))?;

        fs::write(bin_path, new_data).map_err(|e| Error::io_with_path(e, bin_path))?;
        tracing::debug!("Repathed {} paths in {}", modified_count, bin_path.display());
    }

    Ok(modified_count)
}

fn repath_value(value: &mut BinValue, existing_paths: &HashSet<String>, prefix: &str, config: &RepathConfig) -> usize {
    let mut count = 0;

    match value {
        BinValue::String(s) => {
            if is_asset_path(s) {
                let normalized = normalize_path(s);
                if existing_paths.contains(&normalized) {
                    let repathed = apply_prefix_to_path(s, prefix, config);
                    *s = replace_base_folder_in_animation_path(&repathed, config.target_skin_id);
                    count += 1;
                }
            }
        }
        BinValue::List { items, .. } => {
            for item in items.iter_mut() {
                count += repath_value(item, existing_paths, prefix, config);
            }
        }
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for v in fields.values_mut() {
                count += repath_value(v, existing_paths, prefix, config);
            }
        }
        BinValue::Option { value: Some(inner), .. } => {
            count += repath_value(inner, existing_paths, prefix, config);
        }
        BinValue::Map { entries, .. } => {
            for (key, val) in entries.iter_mut() {
                count += repath_value(key, existing_paths, prefix, config);
                count += repath_value(val, existing_paths, prefix, config);
            }
        }
        _ => {}
    }

    count
}

/// Strips a leading or mid-path "base/" folder. Case-insensitive.
fn strip_base_folder(path: &str) -> String {
    let lower = path.to_lowercase();

    if lower.starts_with("base/") {
        return path[5..].to_string();
    }

    if lower.contains("/base/") {
        return BASE_MIDDLE_RE.replace_all(path, "/").into_owned();
    }

    path.to_string()
}

/// Remaps `animations/skinN.bin` → `animations/skin{target}.bin`; other paths unchanged.
fn remap_animation_bin_filename(path: &str, target_skin_id: u32) -> String {
    let lower = path.to_lowercase();

    if (lower.contains("/animations/skin") || lower.contains("animations/skin")) && lower.ends_with(".bin") {
        if let Some(last_slash) = path.rfind('/') {
            let dir = &path[..=last_slash];
            let filename = &path[last_slash + 1..];

            if filename.starts_with("skin") && filename.ends_with(".bin") {
                let without_ext = &filename[..filename.len() - 4];
                if without_ext.len() > 4 {
                    let number_part = &without_ext[4..];
                    if number_part.chars().all(|c| c.is_ascii_digit()) {
                        return format!("{}skin{}.bin", dir, target_skin_id);
                    }
                }
            }
        }
    }

    path.to_string()
}

fn replace_base_folder_in_animation_path(path: &str, _target_skin_id: u32) -> String {
    strip_base_folder(path)
}

fn relocate_assets(content_base: &Path, existing_paths: &HashSet<String>, prefix: &str, config: &RepathConfig) -> Result<usize> {
    /* Pass 1 (serial): plan the moves with first-writer-wins conflict
       detection (cheap — one HashMap insert per path). */
    let mut destinations: HashMap<String, String> = HashMap::new();
    let mut moves: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(existing_paths.len());
    let mut parent_dirs: HashSet<PathBuf> = HashSet::new();

    for path in existing_paths {
        // Skip BIN files except concat.bin (which moves to match its repathed reference).
        if path.to_lowercase().ends_with(".bin") && !path.to_lowercase().contains("_concat") {
            continue;
        }

        let new_path = apply_prefix_to_path(path, prefix, config);
        let dest_normalized = normalize_path(&new_path);
        if let Some(prev_source) = destinations.get(&dest_normalized) {
            tracing::warn!(
                "Conflict detected: '{}' and '{}' both map to '{}'",
                prev_source, path, dest_normalized
            );
            continue;
        }
        destinations.insert(dest_normalized, path.clone());

        let source = content_base.join(path);
        let dest = content_base.join(&new_path);
        if let Some(parent) = dest.parent() {
            parent_dirs.insert(parent.to_path_buf());
        }
        moves.push((source, dest));
    }

    // Pass 2: pre-create all unique parent directories.
    for parent in &parent_dirs {
        fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
    }

    /* Pass 3 (parallel): rename each independent file, falling back to
       copy+delete across devices. Probe exists() only on rename failure. */
    let relocated = moves
        .par_iter()
        .filter(|(source, dest)| {
            match fs::rename(source, dest) {
                Ok(_) => true,
                Err(_) => {
                    if !source.exists() {
                        return false;
                    }
                    if let Err(e) = fs::copy(source, dest) {
                        tracing::warn!("relocate copy failed {}: {}", source.display(), e);
                        return false;
                    }
                    if let Err(e) = fs::remove_file(source) {
                        tracing::warn!("relocate remove-after-copy failed {}: {}", source.display(), e);
                    }
                    true
                }
            }
        })
        .count();

    Ok(relocated)
}

fn cleanup_unused_files(content_base: &Path, referenced_paths: &HashSet<String>, prefix: &str, config: &RepathConfig) -> Result<usize> {
    use rayon::prelude::*;

    let expected_paths: HashSet<String> = referenced_paths
        .iter()
        .map(|p| normalize_path(&apply_prefix_to_path(p, prefix, config)))
        .collect();
    let creator_prefix = format!("assets/{}/", config.creator_name.replace(' ', "-").to_lowercase());

    // Walk serially (WalkDir holds file-handle state), then delete in parallel.
    let to_delete: Vec<PathBuf> = WalkDir::new(content_base)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            // BIN files are handled by cleanup_irrelevant_bins.
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if ext.eq_ignore_ascii_case("bin") {
                    return None;
                }
            }
            let rel_path = path.strip_prefix(content_base).ok()?;
            let normalized = normalize_path(&rel_path.to_string_lossy());
            let in_new_tree = normalized.to_lowercase().starts_with(&creator_prefix);
            let filename = path.file_stem().unwrap_or_default().to_string_lossy();
            let is_unresolved = filename.len() == 16 && filename.chars().all(|c| c.is_ascii_hexdigit());

            if is_unresolved {
                tracing::debug!("Preserving unresolved hash file: {}", path.display());
                return None;
            }

            if !expected_paths.contains(&normalized) || !in_new_tree {
                Some(path.to_path_buf())
            } else {
                None
            }
        })
        .collect();

    let removed = to_delete
        .par_iter()
        .filter(|path| match fs::remove_file(path) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!("Failed to remove {}: {}", path.display(), e);
                false
            }
        })
        .count();

    Ok(removed)
}

/// Transitive closure of every BIN reachable from any BIN's `linked` list,
/// as lowercased forward-slashed project-relative paths. Used to protect
/// referenced bins from cleanup deletion.
fn referenced_bin_keep_set(content_base: &Path) -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    let mut keep: HashSet<String> = HashSet::new();
    for entry in WalkDir::new(content_base)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("bin"))
                .unwrap_or(false)
        })
    {
        let path = entry.path();
        let Ok(data) = fs::read(path) else { continue };
        let Ok(bin) = read_bin(&data) else { continue };
        for dep in bin.linked {
            keep.insert(dep.replace('\\', "/").trim_start_matches('/').to_lowercase());
        }
    }
    keep
}

/// Whitelist approach: keeps the main skin BIN (skins/skin{ID}.bin), the
/// animation BIN (animations/skin{ID}.bin), and the concat BIN (_Concat.bin);
/// everything else is deleted.
fn cleanup_irrelevant_bins(
    content_base: &Path,
    champion: &str,
    target_skin_id: u32,
    keep: &std::collections::HashSet<String>,
) -> Result<usize> {
    let mut removed = 0;
    let champion_lower = champion.to_lowercase();

    let target_skin_name = format!("skin{}.bin", target_skin_id);
    let target_skin_name_padded = format!("skin{:02}.bin", target_skin_id);

    let mut referenced_animation_bin: Option<String> = None;
    if let Some(main_bin_path) = find_main_skin_bin(content_base, champion, target_skin_id) {
        if let Ok(data) = fs::read(&main_bin_path) {
            if let Ok(bin) = read_bin(&data) {
                for dep in &bin.linked {
                    if crate::bin::classify_bin(dep) == crate::bin::BinCategory::Animation {
                        if let Some(filename) = Path::new(dep).file_name() {
                            referenced_animation_bin = Some(filename.to_string_lossy().to_lowercase());
                            break;
                        }
                    }
                }
            }
        }
    }

    if let Some(ref ref_anim) = referenced_animation_bin {
        tracing::info!(
            "Cleaning up BINs (keeping only: {}, {}, referenced animation: {}, and _Concat.bin)",
            target_skin_name,
            target_skin_name_padded,
            ref_anim
        );
    } else {
        tracing::info!(
            "Cleaning up BINs (keeping only: {}, {}, and _Concat.bin)",
            target_skin_name,
            target_skin_name_padded
        );
    }

    for entry in WalkDir::new(content_base)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("bin"))
                .unwrap_or(false)
        })
    {
        let path = entry.path();
        if let Ok(rel_path) = path.strip_prefix(content_base) {
            let rel_str = rel_path.to_string_lossy().to_lowercase().replace('\\', "/");
            let filename = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();

            if keep.contains(&rel_str) {
                tracing::debug!("Keeping referenced BIN (keep-set): {}", rel_str);
                continue;
            }

            if filename.contains("_concat") {
                tracing::debug!("Keeping concat BIN: {}", rel_str);
                continue;
            }

            if rel_str.contains("/skins/") &&
               (filename == target_skin_name || filename == target_skin_name_padded) {
                tracing::debug!("Keeping main skin BIN: {}", rel_str);
                continue;
            }

            let file_stem = path.file_stem().unwrap_or_default().to_string_lossy();
            let is_unresolved = file_stem.len() == 16 && file_stem.chars().all(|c| c.is_ascii_hexdigit());
            if is_unresolved {
                tracing::debug!("Keeping unresolved hash BIN: {}", rel_str);
                continue;
            }

            if rel_str.contains("/animations/") {
                let is_match = filename == target_skin_name
                    || filename == target_skin_name_padded
                    || referenced_animation_bin.as_ref().is_some_and(|ref_anim| filename == *ref_anim);
                if is_match {
                    tracing::debug!("Keeping animation BIN: {}", rel_str);
                    continue;
                }
            }

            let reason = if rel_str.contains("/animations/") {
                "wrong animation"
            } else if rel_str.contains("/skins/") {
                "wrong skin"
            } else if filename == format!("{}.bin", champion_lower) {
                "champion root"
            } else if filename.contains("_skins_") || filename.contains("_skin") {
                "linked data"
            } else {
                "unreferenced"
            };

            if let Err(e) = fs::remove_file(path) {
                tracing::warn!("Failed to remove {} BIN {}: {}", reason, path.display(), e);
            } else {
                tracing::debug!("Removed {} BIN: {}", reason, rel_str);
                removed += 1;
            }
        }
    }
    
    if removed > 0 {
        tracing::info!("Cleaned up {} irrelevant BIN files", removed);
    }
    
    Ok(removed)
}

fn cleanup_empty_dirs(dir: &Path) -> Result<()> {
    for entry in WalkDir::new(dir)
        .contents_first(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(entries) = fs::read_dir(path) {
                if entries.count() == 0 {
                    let _ = fs::remove_dir(path);
                }
            }
        }
    }
    Ok(())
}

fn find_main_skin_bin(content_base: &Path, champion: &str, skin_id: u32) -> Option<PathBuf> {
    let champion_lower = champion.to_lowercase();
    
    let patterns = vec![
        format!("data/characters/{}/skins/skin{}.bin", champion_lower, skin_id),
        format!("data/characters/{}/skins/skin{:02}.bin", champion_lower, skin_id),
    ];
    
    for pattern in &patterns {
        let direct_path = content_base.join(pattern);
        if direct_path.exists() {
            return Some(direct_path);
        }
    }

    for entry in WalkDir::new(content_base)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("bin"))
                .unwrap_or(false)
        })
    {
        let path = entry.path();
        if let Ok(rel_path) = path.strip_prefix(content_base) {
            let rel_str = rel_path.to_string_lossy().to_lowercase().replace('\\', "/");
            for pattern in &patterns {
                if rel_str == *pattern {
                    return Some(path.to_path_buf());
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_asset_path() {
        assert!(is_asset_path("assets/characters/ahri/skin0.bin"));
        assert!(is_asset_path("data/effects.bin"));
        assert!(!is_asset_path("some/other/path.txt"));
    }

    #[test]
    fn test_strip_base_folder() {
        assert_eq!(
            strip_base_folder("Base/Animations/Attack.anm"),
            "Animations/Attack.anm"
        );

        assert_eq!(
            strip_base_folder("some/path/Base/file.dds"),
            "some/path/file.dds"
        );

        assert_eq!(
            strip_base_folder("base/textures/skin.tex"),
            "textures/skin.tex"
        );

        assert_eq!(
            strip_base_folder("path/BASE/mesh.skn"),
            "path/mesh.skn"
        );

        assert_eq!(
            strip_base_folder("animations/idle.anm"),
            "animations/idle.anm"
        );
    }

    #[test]
    fn test_remap_animation_bin_filename() {
        assert_eq!(
            remap_animation_bin_filename("animations/skin8.bin", 42),
            "animations/skin42.bin"
        );

        assert_eq!(
            remap_animation_bin_filename("animations/skin0.bin", 42),
            "animations/skin42.bin"
        );

        assert_eq!(
            remap_animation_bin_filename("particles/blade.dds", 42),
            "particles/blade.dds"
        );

        assert_eq!(
            remap_animation_bin_filename("renekton_skin17_base.skn", 42),
            "renekton_skin17_base.skn"
        );

        assert_eq!(
            remap_animation_bin_filename("skins/skin17.bin", 42),
            "skins/skin17.bin"
        );
    }

    #[test]
    fn test_apply_prefix_to_path_target_champion() {
        let config = RepathConfig {
            creator_name: "SirDexal".to_string(),
            project_name: "Renny".to_string(),
            champion: "Renekton".to_string(),
            target_skin_id: 42,
            cleanup_unused: true,
            skip_bin_cleanup: false,
        };

        assert_eq!(
            apply_prefix_to_path(
                "assets/characters/renekton/skins/skin17/renekton_skin17_base.skn",
                "SirDexal/Renny",
                &config
            ),
            "ASSETS/SirDexal/Renny/renekton_skin17_base.skn"
        );

        assert_eq!(
            apply_prefix_to_path(
                "assets/characters/renekton/skins/skin17/particles/blade.dds",
                "SirDexal/Renny",
                &config
            ),
            "ASSETS/SirDexal/Renny/particles/blade.dds"
        );

        assert_eq!(
            apply_prefix_to_path(
                "data/characters/renekton/animations/skin8.bin",
                "SirDexal/Renny",
                &config
            ),
            "ASSETS/SirDexal/Renny/animations/skin42.bin"
        );
    }

    #[test]
    fn test_apply_prefix_to_path_other_champions() {
        let config = RepathConfig {
            creator_name: "SirDexal".to_string(),
            project_name: "Renny".to_string(),
            champion: "Renekton".to_string(),
            target_skin_id: 42,
            cleanup_unused: true,
            skip_bin_cleanup: false,
        };

        assert_eq!(
            apply_prefix_to_path(
                "assets/characters/sona/skins/skin5/sona_skin5_base.skn",
                "SirDexal/Renny",
                &config
            ),
            "ASSETS/SirDexal/shared-champion/sona_skin5_base.skn"
        );

        assert_eq!(
            apply_prefix_to_path(
                "assets/characters/ahri/skins/skin0/particles/orb.dds",
                "SirDexal/Renny",
                &config
            ),
            "ASSETS/SirDexal/shared-champion/particles/orb.dds"
        );
    }

    #[test]
    fn test_apply_prefix_to_path_shared_assets() {
        let config = RepathConfig {
            creator_name: "SirDexal".to_string(),
            project_name: "Renny".to_string(),
            champion: "Renekton".to_string(),
            target_skin_id: 42,
            cleanup_unused: true,
            skip_bin_cleanup: false,
        };

        assert_eq!(
            apply_prefix_to_path(
                "assets/particles/fire_vfx.dds",
                "SirDexal/Renny",
                &config
            ),
            "ASSETS/SirDexal/shared/particles/fire_vfx.dds"
        );

        assert_eq!(
            apply_prefix_to_path(
                "data/maps/summoners_rift/textures/grass.dds",
                "SirDexal/Renny",
                &config
            ),
            "ASSETS/SirDexal/shared/maps/summoners_rift/textures/grass.dds"
        );

        // League's existing shared/ folder must not be duplicated to shared/shared/.
        assert_eq!(
            apply_prefix_to_path(
                "assets/shared/particles/fire.dds",
                "SirDexal/Renny",
                &config
            ),
            "ASSETS/SirDexal/shared/particles/fire.dds"
        );
    }

    #[test]
    fn test_apply_prefix_to_path_sounds() {
        let config = RepathConfig {
            creator_name: "SirDexal".to_string(),
            project_name: "Cozy".to_string(),
            champion: "Kayn".to_string(),
            target_skin_id: 20,
            cleanup_unused: true,
            skip_bin_cleanup: false,
        };

        assert_eq!(
            apply_prefix_to_path(
                "assets/sounds/wwise2016/sfx/characters/kayn/skins/skin20/kayn_skin20_sfx_audio.bnk",
                "SirDexal/Cozy",
                &config
            ),
            "ASSETS/SirDexal/Cozy/audio/sfx/kayn_skin20_sfx_audio.bnk"
        );

        assert_eq!(
            apply_prefix_to_path(
                "assets/sounds/wwise2016/vo/en_us/characters/kayn/kayn_vo.wpk",
                "SirDexal/Cozy",
                &config
            ),
            "assets/sounds/wwise2016/vo/en_us/characters/kayn/kayn_vo.wpk"
        );

        assert_eq!(
            apply_prefix_to_path(
                "data/sounds/wwise2016/sfx/characters/kayn/skins/skin20/kayn_skin20_impact.bnk",
                "SirDexal/Cozy",
                &config
            ),
            "ASSETS/SirDexal/Cozy/audio/sfx/kayn_skin20_impact.bnk"
        );

        assert_eq!(
            apply_prefix_to_path(
                "assets/sounds/wwise2016/vo/ja_jp/characters/kayn/kayn_vo.wpk",
                "SirDexal/Cozy",
                &config
            ),
            "assets/sounds/wwise2016/vo/ja_jp/characters/kayn/kayn_vo.wpk"
        );

        assert_eq!(
            apply_prefix_to_path(
                "ASSETS/Sounds/wwise2016/VO/en_us/characters/kayn/kayn_vo.wpk",
                "SirDexal/Cozy",
                &config
            ),
            "ASSETS/Sounds/wwise2016/VO/en_us/characters/kayn/kayn_vo.wpk"
        );
    }

    #[test]
    fn test_apply_prefix_to_path_hud() {
        let config = RepathConfig {
            creator_name: "SirDexal".to_string(),
            project_name: "Renny".to_string(),
            champion: "Renekton".to_string(),
            target_skin_id: 42,
            cleanup_unused: true,
            skip_bin_cleanup: false,
        };

        assert_eq!(
            apply_prefix_to_path(
                "assets/characters/renekton/hud/renekton_hud.dds",
                "SirDexal/Renny",
                &config
            ),
            "ASSETS/SirDexal/Renny/hud/renekton_hud.dds"
        );
    }

    #[test]
    fn test_asset_path_parse_sound_sfx() {
        let path = "assets/sounds/wwise2016/sfx/characters/kayn/skins/skin20/kayn_skin20_sfx.bnk";
        let parsed = AssetPath::parse(path, "Kayn");

        assert!(parsed.is_some());
        match parsed.unwrap() {
            AssetPath::SoundSfx { filename } => {
                assert_eq!(filename, "kayn_skin20_sfx.bnk");
            }
            _ => panic!("Expected SoundSfx variant"),
        }
    }

    #[test]
    fn test_asset_path_parse_sound_vo() {
        let path = "assets/sounds/wwise2016/vo/en_us/characters/kayn/kayn_vo.wpk";
        let parsed = AssetPath::parse(path, "Kayn");

        assert!(parsed.is_some());
        match parsed.unwrap() {
            AssetPath::SoundVo { original_path } => {
                assert_eq!(original_path, path);
            }
            _ => panic!("Expected SoundVo variant"),
        }
    }

    #[test]
    fn test_asset_path_parse_champion_hud() {
        let path = "assets/characters/renekton/hud/renekton_hud.dds";
        let parsed = AssetPath::parse(path, "Renekton");

        assert!(parsed.is_some());
        match parsed.unwrap() {
            AssetPath::ChampionHud { filename } => {
                assert_eq!(filename, "renekton_hud.dds");
            }
            _ => panic!("Expected ChampionHud variant"),
        }
    }

    #[test]
    fn test_asset_path_parse_target_champion_skin() {
        let path = "assets/characters/kayn/skins/skin20/particles/blade.dds";
        let parsed = AssetPath::parse(path, "Kayn");

        assert!(parsed.is_some());
        match parsed.unwrap() {
            AssetPath::TargetChampionSkin { skin_id, subpath } => {
                assert_eq!(skin_id, Some(20));
                assert_eq!(subpath, "skins/skin20/particles/blade.dds");
            }
            _ => panic!("Expected TargetChampionSkin variant"),
        }
    }

    #[test]
    fn test_asset_path_parse_other_champion() {
        let path = "assets/characters/sona/skins/skin5/particles/orb.dds";
        let parsed = AssetPath::parse(path, "Kayn");

        assert!(parsed.is_some());
        match parsed.unwrap() {
            AssetPath::OtherChampion { subpath } => {
                assert_eq!(subpath, "skins/skin5/particles/orb.dds");
            }
            _ => panic!("Expected OtherChampion variant"),
        }
    }

    #[test]
    fn test_asset_path_parse_shared() {
        let path = "assets/particles/fire.dds";
        let parsed = AssetPath::parse(path, "Kayn");

        assert!(parsed.is_some());
        match parsed.unwrap() {
            AssetPath::Shared { subpath } => {
                assert_eq!(subpath, "particles/fire.dds");
            }
            _ => panic!("Expected Shared variant"),
        }
    }

    #[test]
    fn test_asset_path_parse_shared_with_prefix() {
        let path = "assets/shared/particles/fire.dds";
        let parsed = AssetPath::parse(path, "Kayn");

        assert!(parsed.is_some());
        match parsed.unwrap() {
            AssetPath::Shared { subpath } => {
                assert_eq!(subpath, "particles/fire.dds");
            }
            _ => panic!("Expected Shared variant"),
        }
    }

    #[test]
    fn test_asset_path_parse_case_insensitive() {
        let path = "ASSETS/SOUNDS/wwise2016/VO/en_us/kayn_vo.wpk";
        let parsed = AssetPath::parse(path, "Kayn");

        assert!(parsed.is_some());
        match parsed.unwrap() {
            AssetPath::SoundVo { original_path } => {
                assert_eq!(original_path, path);
            }
            _ => panic!("Expected SoundVo variant"),
        }
    }

    #[test]
    fn test_asset_path_to_repathed_sfx() {
        let config = RepathConfig {
            creator_name: "TestCreator".to_string(),
            project_name: "TestProject".to_string(),
            champion: "Kayn".to_string(),
            target_skin_id: 20,
            cleanup_unused: true,
            skip_bin_cleanup: false,
        };

        let asset_path = AssetPath::SoundSfx {
            filename: "kayn_skin20_sfx.bnk",
        };

        assert_eq!(
            asset_path.to_repathed(&config),
            "ASSETS/TestCreator/TestProject/audio/sfx/kayn_skin20_sfx.bnk"
        );
    }

    #[test]
    fn test_asset_path_to_repathed_vo() {
        let config = RepathConfig {
            creator_name: "TestCreator".to_string(),
            project_name: "TestProject".to_string(),
            champion: "Kayn".to_string(),
            target_skin_id: 20,
            cleanup_unused: true,
            skip_bin_cleanup: false,
        };

        let original = "assets/sounds/wwise2016/vo/en_us/kayn_vo.wpk";
        let asset_path = AssetPath::SoundVo {
            original_path: original,
        };

        assert_eq!(asset_path.to_repathed(&config), original);
    }

    #[test]
    fn test_asset_path_invalid() {
        let path = "sounds/wwise2016/sfx/test.bnk";
        let parsed = AssetPath::parse(path, "Kayn");
        assert!(parsed.is_none());
    }

    #[test]
    fn test_replace_base_folder_in_animation_path() {
        assert_eq!(
            replace_base_folder_in_animation_path(
                "ASSETS/SirDexal/Seele-Vollerei-Kayn/Base/Animations/Kayn_Attack1.anm",
                8
            ),
            "ASSETS/SirDexal/Seele-Vollerei-Kayn/Animations/Kayn_Attack1.anm"
        );

        assert_eq!(
            replace_base_folder_in_animation_path(
                "ASSETS/Creator/Project/base/Animations/Run.anm",
                42
            ),
            "ASSETS/Creator/Project/Animations/Run.anm"
        );

        assert_eq!(
            replace_base_folder_in_animation_path(
                "ASSETS/Creator/Project/BASE/Animations/Idle.anm",
                17
            ),
            "ASSETS/Creator/Project/Animations/Idle.anm"
        );

        assert_eq!(
            replace_base_folder_in_animation_path(
                "ASSETS/Creator/Project/Animations/Attack.anm",
                42
            ),
            "ASSETS/Creator/Project/Animations/Attack.anm"
        );

        assert_eq!(
            replace_base_folder_in_animation_path(
                "ASSETS/Creator/Project/particles/effect.dds",
                42
            ),
            "ASSETS/Creator/Project/particles/effect.dds"
        );
    }

    #[test]
    fn test_fnv1a_hash() {
        assert_eq!(fnv1a_hash("championSkinName"), fnv1a_hash("championskinname"));
        assert_eq!(fnv1a_hash("CHAMPIONSKINNAME"), fnv1a_hash("championSkinName"));

        let hash = fnv1a_hash("championSkinName");
        assert_ne!(hash, 0);
    }

    #[test]
    fn keep_set_protects_referenced_bin() {
        use std::collections::HashSet;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let skins = base.join("data/characters/x/skins");
        std::fs::create_dir_all(&skins).unwrap();
        // A "wrong skin" bin that cleanup would normally delete.
        let victim = skins.join("skin99.bin");
        std::fs::write(&victim, write_bin(&ritoshark::bin::Bin::new()).unwrap()).unwrap();

        let mut keep: HashSet<String> = HashSet::new();
        keep.insert("data/characters/x/skins/skin99.bin".to_string());

        let removed = cleanup_irrelevant_bins(base, "x", 0, &keep).unwrap();
        assert_eq!(removed, 0, "referenced bin must not be deleted");
        assert!(victim.exists());
    }
}
