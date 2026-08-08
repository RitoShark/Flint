//! Repathing engine: scans BIN files for asset paths (`assets/`, `data/`),
//! prefixes them with `ASSETS/{creator}/{project}`, and relocates the files.

use crate::bin::codec::{read_bin, write_bin};
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
pub(crate) use super::paths::*;
pub(crate) use super::prune::*;

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
pub(crate) static SKIN_FOLDER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(skin)(\d+)(/)").expect("Invalid skin folder regex")
});

pub(crate) static BASE_MIDDLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)/base/").expect("Invalid base folder regex")
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AssetPath<'a> {
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

    /// Detected sub-champion (Tibbers, Skaarl, …) → `ASSETS/{creator}/{sub}/...`.
    SubCharacter {
        character: &'a str,
        subpath: &'a str,
    },

    /// `characters/{other_champion}/...` → creator-level shared-champion/ folder.
    OtherChampion {
        /// Everything after "characters/{champion}/".
        subpath: &'a str,
    },

    /// Non-champion assets (maps/, …) → creator-level shared/ folder.
    Shared {
        /// Path after stripping "shared/" prefix if present.
        subpath: &'a str,
    },

    /// Author/shared VFX with a `particles/` segment → champion project folder.
    /// Relocated under `ASSETS/{creator}/{project}/particles/<rest>`.
    SharedParticles {
        /// Path from the `particles/` segment onward (inclusive of `particles/`).
        particles_tail: &'a str,
    },
}

impl<'a> AssetPath<'a> {
    pub(crate) fn parse(path: &'a str, target_champion: &str, sub_characters: &[String]) -> Option<Self> {
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
            } else if sub_characters.iter().any(|s| champion.eq_ignore_ascii_case(s)) {
                return Some(AssetPath::SubCharacter { character: champion, subpath });
            } else {
                return Some(AssetPath::OtherChampion { subpath });
            }
        }

        // Strip "shared/" prefix if present to avoid duplication.
        let subpath = Self::strip_prefix_ignore_case(stripped, "shared/").unwrap_or(stripped);

        // Author/shared VFX (a `particles/` segment) relocate under the champion project.
        if let Some(idx) = particles_segment_start(subpath) {
            return Some(AssetPath::SharedParticles {
                particles_tail: &subpath[idx..],
            });
        }

        Some(AssetPath::Shared { subpath })
    }

    pub(crate) fn to_repathed(&self, config: &RepathConfig) -> String {
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
                format!("ASSETS/{}/{}", prefix, strip_skin_layout(subpath, config.target_skin_id))
            }
            AssetPath::SubCharacter { character, subpath } => {
                format!(
                    "ASSETS/{}/{}/{}",
                    creator,
                    character.to_lowercase(),
                    strip_skin_layout(subpath, config.target_skin_id)
                )
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
            AssetPath::SharedParticles { particles_tail } => {
                format!("ASSETS/{}/{}", config.prefix(), particles_tail)
            }
        }
    }

    #[inline]
    pub(crate) fn strip_prefix_ignore_case<'b>(s: &'b str, prefix: &str) -> Option<&'b str> {
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
    /// Lowercased sub-champion names (Tibbers, Skaarl, …) detected in the WAD.
    pub sub_characters: Vec<String>,
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
    let wad_folder_name = format!("{}.wad.client", flint_wad::wad::extractor::wad_champion_name(&champion_lower));
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
    // Champion-root BINs (kayn.bin, root.bin) never ship on the creation path: the concat
    // BIN replaces their link and cleanup_irrelevant_bins deletes them. Assets referenced
    // ONLY by them (hud/icons2d portraits, …) must therefore stay at their ORIGINAL paths —
    // the live game's root still points there, so leaving them in place keeps them working
    // as overrides while repathing would orphan them. They're collected here and scanned
    // separately into a preserve set. Imports (skip_bin_cleanup) keep the root BIN, so
    // there the old repath-everything behavior stays self-consistent.
    let mut root_bin_files: Vec<PathBuf> = Vec::new();
    let exclude_roots = !config.skip_bin_cleanup;

    let push_with_links =
        |root: PathBuf, bin_files: &mut Vec<PathBuf>, root_bin_files: &mut Vec<PathBuf>| {
            if let Ok(data) = fs::read(&root) {
                if let Ok(bin) = read_bin(&data) {
                    for dep_path in &bin.linked {
                        let normalized_path = dep_path.to_lowercase().replace('\\', "/");
                        let actual_path = path_mappings.get(&normalized_path)
                            .cloned()
                            .unwrap_or_else(|| normalized_path.clone());
                        let full_path = file_base.join(&actual_path);
                        if full_path.exists() {
                            if exclude_roots
                                && crate::bin::classify_bin(&normalized_path)
                                    == crate::bin::BinCategory::ChampionRoot
                            {
                                root_bin_files.push(full_path);
                            } else {
                                bin_files.push(full_path);
                            }
                        } else {
                            tracing::warn!("Linked BIN not found: {}", normalized_path);
                        }
                    }
                }
            }
            bin_files.push(root);
        };

    if let Some(ref main_path) = main_bin_path {
        tracing::info!("Found main skin BIN: {}", main_path.display());
        push_with_links(main_path.clone(), &mut bin_files, &mut root_bin_files);

        for sub in &config.sub_characters {
            if let Some(sub_path) = find_main_skin_bin(file_base, sub, config.target_skin_id) {
                tracing::info!("Found sub-champion skin BIN: {}", sub_path.display());
                push_with_links(sub_path, &mut bin_files, &mut root_bin_files);
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
        if exclude_roots {
            let (roots, shipped): (Vec<PathBuf>, Vec<PathBuf>) =
                bin_files.into_iter().partition(|p| {
                    p.strip_prefix(file_base)
                        .map(|rel| {
                            crate::bin::classify_bin(&rel.to_string_lossy())
                                == crate::bin::BinCategory::ChampionRoot
                        })
                        .unwrap_or(false)
                });
            root_bin_files.extend(roots);
            bin_files = shipped;
        }
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
    tracing::debug!("[TIMING] step3 existing_paths filter ({} paths): {:?}", all_asset_paths.len(), t_step3.elapsed());

    // Paths referenced ONLY by non-shipping champion-root BINs: never repathed or
    // relocated, and protected from the cleanup passes so they keep overriding the
    // original game paths. Anything a shipped BIN also references repaths normally.
    let preserved_paths: HashSet<String> = if root_bin_files.is_empty() {
        HashSet::new()
    } else {
        let set: DashSet<String> = DashSet::new();
        root_bin_files.par_iter().for_each(|bin_path| {
            if let Ok(paths) = scan_bin_for_paths(bin_path) {
                for path in paths {
                    set.insert(path);
                }
            }
        });
        set.into_iter().filter(|p| !all_asset_paths.contains(p)).collect()
    };
    if !preserved_paths.is_empty() {
        tracing::info!(
            "{} asset path(s) referenced only by champion-root BINs kept at their original paths",
            preserved_paths.len()
        );
    }

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
    tracing::debug!("[TIMING] step4 repath {} BINs in parallel: {:?}", result.bins_processed, t_step4.elapsed());

    let t_step5 = std::time::Instant::now();
    result.files_relocated = relocate_assets(file_base, &existing_paths, &prefix, config)?;
    tracing::debug!("[TIMING] step5 relocate_assets ({} files): {:?}", result.files_relocated, t_step5.elapsed());

    if config.cleanup_unused {
        let t_step6 = std::time::Instant::now();
        result.files_removed = cleanup_unused_files(file_base, &existing_paths, &prefix, config, &preserved_paths)?;
        tracing::debug!("[TIMING] step6 cleanup_unused_files ({} removed): {:?}", result.files_removed, t_step6.elapsed());
    }

    if !config.skip_bin_cleanup {
        let t_step7 = std::time::Instant::now();
        let keep = referenced_bin_keep_set(file_base);
        cleanup_irrelevant_bins(file_base, &config.champion, config.target_skin_id, &keep)?;
        tracing::debug!("[TIMING] step7 cleanup_irrelevant_bins: {:?}", t_step7.elapsed());
    } else {
        tracing::info!("Skipping cleanup_irrelevant_bins because skip_bin_cleanup is true");
    }

    // Safety-net sweep (project creation only): after repath+relocate+cleanup,
    // any non-BIN file still sitting under the ORIGINAL game-layout `characters/`
    // tree is an un-relocated orphan (unreferenced HD twins like `2x_body1.tex`,
    // or leftover clones whose real copy already moved to the project folder).
    // `cleanup_unused_files` can miss these when a referenced sibling shares the
    // directory; this pass removes exactly the orphaned originals.
    if config.cleanup_unused {
        let t_sweep = std::time::Instant::now();
        let swept = sweep_source_tree_orphans(file_base, &existing_paths, &prefix, config, &preserved_paths);
        if swept > 0 {
            tracing::info!("Swept {} un-relocated orphan(s) from the source characters/ tree", swept);
        }
        tracing::debug!("[TIMING] step7b sweep_source_tree_orphans ({} removed): {:?}", swept, t_sweep.elapsed());
    }

    let t_step8 = std::time::Instant::now();
    cleanup_empty_dirs(file_base)?;
    tracing::debug!("[TIMING] step8 cleanup_empty_dirs: {:?}", t_step8.elapsed());

    tracing::info!(
        "Repathing complete: {} bins, {} paths modified, {} files relocated",
        result.bins_processed,
        result.paths_modified,
        result.files_relocated
    );

    Ok(result)
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

/// `skins/skinN/base/…` → flattened path with the animation BIN remapped to the target skin id.
fn relocate_assets(content_base: &Path, existing_paths: &HashSet<String>, prefix: &str, config: &RepathConfig) -> Result<usize> {
    /* Pass 1 (serial): plan the moves with first-writer-wins conflict
       detection (cheap — one HashMap insert per path). Paths are sorted so
       which source wins a conflicting destination is deterministic. */
    let mut destinations: HashMap<String, String> = HashMap::new();
    let mut moves: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(existing_paths.len());
    let mut parent_dirs: HashSet<PathBuf> = HashSet::new();
    let mut conflict_sources: Vec<PathBuf> = Vec::new();

    let mut sorted_paths: Vec<&String> = existing_paths.iter().collect();
    sorted_paths.sort();

    for path in sorted_paths {
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
            // The BINs were already rewritten to the shared destination, so this
            // source is dead weight — and the cleanup passes keep it (its raw path
            // still counts as referenced). Remove it here instead of leaving it.
            if config.cleanup_unused {
                conflict_sources.push(content_base.join(path));
            }
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

    for source in &conflict_sources {
        match fs::remove_file(source) {
            Ok(()) => tracing::info!("Removed conflict-losing duplicate source: {}", source.display()),
            Err(e) => tracing::warn!("Failed to remove conflict-losing source {}: {}", source.display(), e),
        }
    }

    Ok(relocated)
}

pub(crate) fn find_main_skin_bin(content_base: &Path, champion: &str, skin_id: u32) -> Option<PathBuf> {
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
            sub_characters: vec![],
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
    fn test_apply_prefix_to_path_sub_character() {
        let config = RepathConfig {
            creator_name: "SirDexal".to_string(),
            project_name: "Anniversary".to_string(),
            champion: "annie".to_string(),
            target_skin_id: 22,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec!["annietibbers".to_string()],
        };

        assert_eq!(
            apply_prefix_to_path(
                "assets/characters/annietibbers/skins/skin22/tibbers.skn",
                "SirDexal/Anniversary",
                &config
            ),
            "ASSETS/SirDexal/annietibbers/tibbers.skn"
        );

        assert_eq!(
            apply_prefix_to_path(
                "data/characters/AnnieTibbers/animations/skin8.bin",
                "SirDexal/Anniversary",
                &config
            ),
            "ASSETS/SirDexal/annietibbers/animations/skin22.bin"
        );

        assert_eq!(
            apply_prefix_to_path(
                "assets/characters/sona/skins/skin5/sona.skn",
                "SirDexal/Anniversary",
                &config
            ),
            "ASSETS/SirDexal/shared-champion/sona.skn"
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
            sub_characters: vec![],
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
            sub_characters: vec![],
        };

        assert_eq!(
            apply_prefix_to_path(
                "data/maps/summoners_rift/textures/grass.dds",
                "SirDexal/Renny",
                &config
            ),
            "ASSETS/SirDexal/shared/maps/summoners_rift/textures/grass.dds"
        );
    }

    #[test]
    fn particles_segment_start_unit() {
        assert_eq!(particles_segment_start("particles/x"), Some(0));
        assert_eq!(particles_segment_start("a/particles/x"), Some(2));
        assert_eq!(particles_segment_start("a/b.dds"), None);
        assert_eq!(particles_segment_start("myparticles/x"), None);
    }

    #[test]
    fn shared_particles_relocate_under_project() {
        let config = RepathConfig {
            creator_name: "CZ".to_string(),
            project_name: "Project-Yone".to_string(),
            champion: "yone".to_string(),
            target_skin_id: 1,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec![],
        };

        assert_eq!(
            apply_prefix_to_path(
                "assets/shared/sirdexal/project-yone/particles/ba-vfx/x.dds",
                "CZ/Project-Yone",
                &config
            ),
            "ASSETS/CZ/Project-Yone/particles/ba-vfx/x.dds"
        );
    }

    #[test]
    fn shared_particles_at_root() {
        let config = RepathConfig {
            creator_name: "CZ".to_string(),
            project_name: "Project-Yone".to_string(),
            champion: "yone".to_string(),
            target_skin_id: 1,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec![],
        };

        assert_eq!(
            apply_prefix_to_path("assets/particles/fire.dds", "CZ/Project-Yone", &config),
            "ASSETS/CZ/Project-Yone/particles/fire.dds"
        );
    }

    #[test]
    fn shared_non_particle_unchanged() {
        let config = RepathConfig {
            creator_name: "CZ".to_string(),
            project_name: "Project-Yone".to_string(),
            champion: "yone".to_string(),
            target_skin_id: 1,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec![],
        };

        assert_eq!(
            apply_prefix_to_path("assets/shared/maps/x.dds", "CZ/Project-Yone", &config),
            "ASSETS/CZ/shared/maps/x.dds"
        );
    }

    #[test]
    fn target_champion_particle_unchanged() {
        let config = RepathConfig {
            creator_name: "CZ".to_string(),
            project_name: "Project-Yone".to_string(),
            champion: "yone".to_string(),
            target_skin_id: 1,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec![],
        };

        assert_eq!(
            apply_prefix_to_path(
                "assets/characters/yone/skins/skin0/particles/x.dds",
                "CZ/Project-Yone",
                &config
            ),
            "ASSETS/CZ/Project-Yone/particles/x.dds"
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
            sub_characters: vec![],
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
            sub_characters: vec![],
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
        let parsed = AssetPath::parse(path, "Kayn", &[]);

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
        let parsed = AssetPath::parse(path, "Kayn", &[]);

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
        let parsed = AssetPath::parse(path, "Renekton", &[]);

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
        let parsed = AssetPath::parse(path, "Kayn", &[]);

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
        let parsed = AssetPath::parse(path, "Kayn", &[]);

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
        let path = "assets/maps/sr/fire.dds";
        let parsed = AssetPath::parse(path, "Kayn", &[]);

        assert!(parsed.is_some());
        match parsed.unwrap() {
            AssetPath::Shared { subpath } => {
                assert_eq!(subpath, "maps/sr/fire.dds");
            }
            _ => panic!("Expected Shared variant"),
        }
    }

    #[test]
    fn test_asset_path_parse_shared_with_prefix() {
        let path = "assets/shared/maps/sr/fire.dds";
        let parsed = AssetPath::parse(path, "Kayn", &[]);

        assert!(parsed.is_some());
        match parsed.unwrap() {
            AssetPath::Shared { subpath } => {
                assert_eq!(subpath, "maps/sr/fire.dds");
            }
            _ => panic!("Expected Shared variant"),
        }
    }

    #[test]
    fn test_asset_path_parse_shared_particles() {
        // A shared-category path with a particles/ segment routes to SharedParticles,
        // carrying the tail from particles/ onward (inclusive).
        match AssetPath::parse("assets/particles/fire.dds", "Kayn", &[]).unwrap() {
            AssetPath::SharedParticles { particles_tail } => {
                assert_eq!(particles_tail, "particles/fire.dds");
            }
            _ => panic!("Expected SharedParticles variant"),
        }

        match AssetPath::parse("assets/shared/sirdexal/proj/particles/x.dds", "Kayn", &[]).unwrap() {
            AssetPath::SharedParticles { particles_tail } => {
                assert_eq!(particles_tail, "particles/x.dds");
            }
            _ => panic!("Expected SharedParticles variant"),
        }
    }

    #[test]
    fn test_asset_path_parse_case_insensitive() {
        let path = "ASSETS/SOUNDS/wwise2016/VO/en_us/kayn_vo.wpk";
        let parsed = AssetPath::parse(path, "Kayn", &[]);

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
            sub_characters: vec![],
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
            sub_characters: vec![],
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
        let parsed = AssetPath::parse(path, "Kayn", &[]);
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
    fn root_only_assets_stay_at_original_paths() {
        // Project creation: the skin BIN links the champion root (kayn.bin), which
        // is the ONLY referrer of hud/icons2d icons. The root never ships (concat
        // replaces it, cleanup deletes it), so those icons must stay at their
        // original game paths — not be repathed into the project folder, and not
        // be cleaned up either.
        use ritoshark::bin::{Bin, BinEntry};
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let wad = base.join("kayn.wad.client");

        let icons_dir = wad.join("assets/characters/kayn/hud/icons2d");
        std::fs::create_dir_all(&icons_dir).unwrap();
        std::fs::write(icons_dir.join("kayn_circle.png"), b"i").unwrap();

        let tex_dir = wad.join("assets/characters/kayn/skins/base");
        std::fs::create_dir_all(&tex_dir).unwrap();
        std::fs::write(tex_dir.join("body.tex"), b"t").unwrap();

        // Champion root: references only the icon.
        let champ_dir = wad.join("data/characters/kayn");
        std::fs::create_dir_all(champ_dir.join("skins")).unwrap();
        let mut root = Bin::new();
        let mut root_fields = indexmap::IndexMap::new();
        root_fields.insert(0xAAAA_u32, BinValue::String(
            "ASSETS/Characters/Kayn/HUD/Icons2D/Kayn_Circle.png".to_string()));
        root.entries.push(BinEntry { path_hash: 0x1, class_hash: 0x2, fields: root_fields });
        std::fs::write(champ_dir.join("kayn.bin"), write_bin(&root).unwrap()).unwrap();

        // Main skin BIN: links the root, references the body texture.
        let mut skin = Bin::new();
        skin.linked.push("DATA/Characters/Kayn/Kayn.bin".to_string());
        let mut skin_fields = indexmap::IndexMap::new();
        skin_fields.insert(0xBBBB_u32, BinValue::String(
            "ASSETS/Characters/Kayn/Skins/Base/Body.tex".to_string()));
        skin.entries.push(BinEntry { path_hash: 0x3, class_hash: 0x4, fields: skin_fields });
        std::fs::write(champ_dir.join("skins/skin0.bin"), write_bin(&skin).unwrap()).unwrap();

        let config = RepathConfig {
            creator_name: "SirDexal".to_string(),
            project_name: "Teeest".to_string(),
            champion: "kayn".to_string(),
            target_skin_id: 0,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec![],
        };

        repath_project(base, &config, &HashMap::new()).unwrap();

        assert!(
            icons_dir.join("kayn_circle.png").exists(),
            "root-only icon must stay at its original path"
        );
        assert!(
            !wad.join("assets/sirdexal/teeest/hud/icons2d/kayn_circle.png").exists(),
            "root-only icon must not be repathed into the project folder"
        );
        // The skin-referenced texture still repaths normally.
        assert!(wad.join("assets/sirdexal/teeest/body.tex").exists());
        assert!(!tex_dir.join("body.tex").exists());
    }

    #[test]
    fn conflict_losing_duplicate_source_is_removed() {
        // Two per-skin clones flatten to the same project destination. The loser's
        // reference was rewritten to the shared destination too, so its source file
        // must be removed — not left behind on the original path.
        use ritoshark::bin::{Bin, BinEntry};
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let wad = base.join("kayn.wad.client");

        for skin in ["skin15", "skin20"] {
            let d = wad.join(format!("assets/characters/kayn/skins/{skin}/particles"));
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("trail.tex"), skin.as_bytes()).unwrap();
        }

        let skins_dir = wad.join("data/characters/kayn/skins");
        std::fs::create_dir_all(&skins_dir).unwrap();
        let mut bin = Bin::new();
        let mut fields = indexmap::IndexMap::new();
        fields.insert(0xAAAA_u32, BinValue::String(
            "ASSETS/Characters/Kayn/Skins/Skin15/Particles/Trail.tex".to_string()));
        fields.insert(0xBBBB_u32, BinValue::String(
            "ASSETS/Characters/Kayn/Skins/Skin20/Particles/Trail.tex".to_string()));
        bin.entries.push(BinEntry { path_hash: 0x1, class_hash: 0x2, fields });
        std::fs::write(skins_dir.join("skin20.bin"), write_bin(&bin).unwrap()).unwrap();

        let config = RepathConfig {
            creator_name: "SirDexal".to_string(),
            project_name: "Teeest".to_string(),
            champion: "kayn".to_string(),
            target_skin_id: 20,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec![],
        };

        repath_project(base, &config, &HashMap::new()).unwrap();

        assert!(wad.join("assets/sirdexal/teeest/particles/trail.tex").exists());
        for skin in ["skin15", "skin20"] {
            assert!(
                !wad.join(format!("assets/characters/kayn/skins/{skin}/particles/trail.tex")).exists(),
                "{skin} source must not be left behind"
            );
        }
    }

    #[test]
    fn repath_removes_unreferenced_hd_twins() {
        // Project creation: a yone skin BIN references only base-res textures
        // under characters/yone/skins/base/, with unreferenced 2x_/4x_ HD twins
        // next to them. After repath the base-res move to the project folder and
        // the orphan HD twins are cleaned up — NOT left on their original path.
        use ritoshark::bin::{Bin, BinEntry};
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let wad = base.join("yone.wad.client");
        let skinbase = wad.join("assets/characters/yone/skins/base");
        std::fs::create_dir_all(&skinbase).unwrap();

        for f in ["body1.tex", "2x_body1.tex", "4x_body1.tex", "cape.tex", "2x_cape.tex"] {
            std::fs::write(skinbase.join(f), b"x").unwrap();
        }

        let skins_dir = wad.join("data/characters/yone/skins");
        std::fs::create_dir_all(&skins_dir).unwrap();
        let mut bin = Bin::new();
        let mut fields = indexmap::IndexMap::new();
        fields.insert(0xAAAA_u32, BinValue::String(
            "ASSETS/Characters/Yone/Skins/Base/Body1.tex".to_string()));
        fields.insert(0xBBBB_u32, BinValue::String(
            "ASSETS/Characters/Yone/Skins/Base/Cape.tex".to_string()));
        bin.entries.push(BinEntry { path_hash: 0x1234, class_hash: 0x5678, fields });
        std::fs::write(skins_dir.join("skin0.bin"), write_bin(&bin).unwrap()).unwrap();

        let config = RepathConfig {
            creator_name: "CZ".to_string(),
            project_name: "Project-Yone".to_string(),
            champion: "yone".to_string(),
            target_skin_id: 0,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec![],
        };

        repath_project(base, &config, &HashMap::new()).unwrap();

        // No leftovers on the original character path.
        let leftover = wad.join("assets/characters/yone/skins/base");
        for f in ["body1.tex", "2x_body1.tex", "4x_body1.tex", "cape.tex", "2x_cape.tex"] {
            assert!(!leftover.join(f).exists(), "orphan/original {f} must not be left behind");
        }
        // Referenced base-res moved to the project folder.
        assert!(wad.join("assets/cz/project-yone/body1.tex").exists());
        assert!(wad.join("assets/cz/project-yone/cape.tex").exists());
    }

    #[test]
    fn repath_moves_other_champion_particle_without_leftover() {
        // Reported case: an Akshan project whose skin BIN references a yasuo
        // (other-champion) common particle. The yasuo file must MOVE to the
        // shared-champion folder, leaving no clone on the original yasuo path.
        use ritoshark::bin::{Bin, BinEntry};
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let wad = base.join("akshan.wad.client");

        let yasuo_file = wad.join("assets/characters/yasuo/skins/base/particles/common_aura_self.tex");
        std::fs::create_dir_all(yasuo_file.parent().unwrap()).unwrap();
        std::fs::write(&yasuo_file, b"aura").unwrap();

        let skins_dir = wad.join("data/characters/akshan/skins");
        std::fs::create_dir_all(&skins_dir).unwrap();
        let mut bin = Bin::new();
        let mut fields = indexmap::IndexMap::new();
        fields.insert(0xAAAA_u32, BinValue::String(
            "ASSETS/Characters/Yasuo/Skins/Base/Particles/Common_Aura_Self.tex".to_string()));
        bin.entries.push(BinEntry { path_hash: 0x1, class_hash: 0x2, fields });
        std::fs::write(skins_dir.join("skin0.bin"), write_bin(&bin).unwrap()).unwrap();

        let config = RepathConfig {
            creator_name: "SirDexal".to_string(),
            project_name: "Tesasasd".to_string(),
            champion: "akshan".to_string(),
            target_skin_id: 0,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec![],
        };

        repath_project(base, &config, &HashMap::new()).unwrap();

        assert!(!yasuo_file.exists(), "original yasuo particle must not be left behind (no clone)");
        assert!(
            wad.join("assets/sirdexal/shared-champion/particles/common_aura_self.tex").exists(),
            "particle must be relocated to the shared-champion folder"
        );
    }

    #[test]
    fn sweep_removes_stranded_twin_when_base_relocated() {
        use std::collections::HashSet;
        // The case strip_hd_twins MISSES: after repath the base-res texture has
        // already moved to the project folder, so the 2x_ twin has no base
        // sibling in its own directory. The source-tree orphan sweep still
        // removes it because it's under characters/ and unreferenced.
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();

        // base-res already relocated to the project folder (referenced).
        let moved = base.join("assets/cz/project-yone/body1.tex");
        std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
        std::fs::write(&moved, b"base").unwrap();

        // stranded twin under the original characters/ tree (unreferenced).
        let twin = base.join("assets/characters/yone/skins/base/2x_body1.tex");
        std::fs::create_dir_all(twin.parent().unwrap()).unwrap();
        std::fs::write(&twin, b"hd").unwrap();

        let config = RepathConfig {
            creator_name: "CZ".to_string(),
            project_name: "Project-Yone".to_string(),
            champion: "yone".to_string(),
            target_skin_id: 0,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec![],
        };

        // existing_paths references only the relocated base-res copy.
        let mut existing: HashSet<String> = HashSet::new();
        existing.insert("assets/cz/project-yone/body1.tex".to_string());

        let swept = sweep_source_tree_orphans(base, &existing, &config.prefix(), &config, &HashSet::new());
        assert_eq!(swept, 1, "the stranded twin must be swept");
        assert!(!twin.exists(), "stranded twin removed");
        assert!(moved.exists(), "relocated base-res untouched (not under characters/)");
    }

    #[test]
    fn sweep_keeps_referenced_other_champion_file() {
        use std::collections::HashSet;
        // A referenced other-champion file under characters/ must NOT be swept
        // (relocate handles it; only truly-unreferenced orphans are removed).
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let f = base.join("assets/characters/yasuo/skins/base/particles/keep.tex");
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(&f, b"x").unwrap();

        let config = RepathConfig {
            creator_name: "SirDexal".to_string(),
            project_name: "P".to_string(),
            champion: "akshan".to_string(),
            target_skin_id: 0,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec![],
        };

        let mut existing: HashSet<String> = HashSet::new();
        existing.insert("assets/characters/yasuo/skins/base/particles/keep.tex".to_string());

        assert_eq!(sweep_source_tree_orphans(base, &existing, &config.prefix(), &config, &HashSet::new()), 0);
        assert!(f.exists(), "referenced file must survive the sweep");
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

    #[test]
    fn keep_set_excludes_champion_root() {
        // The skin BIN links the champ root (concat -> root -> anim), but on
        // project creation the concat replaces it, so the keep-set must NOT
        // protect it — otherwise the stale <champ>.bin is left behind and pins
        // its assets to their original (un-repathed) locations.
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();

        let champ_dir = base.join("data/characters/aatrox");
        std::fs::create_dir_all(champ_dir.join("skins")).unwrap();

        // Champion root BIN — must be deleted.
        let root_bin = champ_dir.join("aatrox.bin");
        std::fs::write(&root_bin, write_bin(&ritoshark::bin::Bin::new()).unwrap()).unwrap();

        // Skin BIN whose linked list references the champ root (the real layout).
        let mut skin = ritoshark::bin::Bin::new();
        skin.linked = vec!["data/characters/aatrox/aatrox.bin".to_string()];
        let skin_bin = champ_dir.join("skins/skin0.bin");
        std::fs::write(&skin_bin, write_bin(&skin).unwrap()).unwrap();

        // Build the keep-set the way repath_project does.
        let keep = referenced_bin_keep_set(base);
        assert!(
            !keep.contains("data/characters/aatrox/aatrox.bin"),
            "champion root must be excluded from the keep-set"
        );

        cleanup_irrelevant_bins(base, "aatrox", 0, &keep).unwrap();
        assert!(!root_bin.exists(), "champion root BIN must be deleted");
        assert!(skin_bin.exists(), "target skin BIN must be kept");
    }

    #[test]
    fn cleanup_unused_keeps_raw_referenced_file() {
        use std::collections::HashSet;
        let config = RepathConfig {
            creator_name: "SirDexal".to_string(),
            project_name: "Renny".to_string(),
            champion: "Renekton".to_string(),
            target_skin_id: 42,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec![],
        };

        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();

        // A referenced asset present under its RAW (not-yet-repathed) path.
        let raw_rel = "assets/characters/renekton/skins/skin17/particles/blade.dds";
        let raw_file = base.join(raw_rel);
        std::fs::create_dir_all(raw_file.parent().unwrap()).unwrap();
        std::fs::write(&raw_file, b"raw").unwrap();

        let mut referenced: HashSet<String> = HashSet::new();
        referenced.insert(raw_rel.to_string());

        let removed = cleanup_unused_files(base, &referenced, "SirDexal/Renny", &config, &HashSet::new()).unwrap();
        assert_eq!(removed, 0, "raw-referenced file must not be deleted");
        assert!(raw_file.exists(), "raw-referenced file should still exist");
    }

    #[test]
    fn cleanup_unused_deletes_unreferenced_in_tree_file() {
        use std::collections::HashSet;
        let config = RepathConfig {
            creator_name: "SirDexal".to_string(),
            project_name: "Renny".to_string(),
            champion: "Renekton".to_string(),
            target_skin_id: 42,
            cleanup_unused: true,
            skip_bin_cleanup: false,
            sub_characters: vec![],
        };

        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();

        // An UNREFERENCED orphan sitting INSIDE the new creator tree
        // (assets/<creator>/<project>/...). The old code deleted it; the
        // regression silently kept it. It must be deleted.
        let orphan_rel = "assets/sirdexal/renny/particles/orphan.dds";
        let orphan_file = base.join(orphan_rel);
        std::fs::create_dir_all(orphan_file.parent().unwrap()).unwrap();
        std::fs::write(&orphan_file, b"orphan").unwrap();

        // Referenced set does NOT contain the orphan.
        let referenced: HashSet<String> = HashSet::new();

        let removed = cleanup_unused_files(base, &referenced, "SirDexal/Renny", &config, &HashSet::new()).unwrap();
        assert!(removed >= 1, "in-tree orphan must be deleted");
        assert!(!orphan_file.exists(), "in-tree orphan should be gone");
    }
}
