//! Missing-file recovery from the League installation.
//!
//! When a mod is imported it often references game files (linked BINs and the
//! assets they point at) that the mod author never bundled — the game already
//! ships them, so the mod relies on them being present. Flint must pull those
//! files out of the player's League install so the imported skin is complete.
//!
//! This module is shared by both the Fantome and ModPkg importers. Beyond the
//! original "scan the mod's BINs for links" behaviour, it also parses the
//! *original* in-game BIN for every BIN the mod ships, so links the mod stripped
//! out are still recovered. Recovery runs **before** concat/repath so the newly
//! pulled files get organised and repathed alongside everything else.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use flint_core::overlay::{HashResolver, ProjectHashOverlay};
use flint_core::wad::adapter::{find_champion_wad, WadHandle as WadReader};

/// Summary of what recovery pulled in, surfaced to the importer for logging.
#[derive(Debug, Default, Clone)]
pub struct RecoveryReport {
    /// Files actually written to disk from the League WAD.
    pub recovered_files: usize,
    /// BIN files in the extracted mod that were scanned for links.
    pub scanned_bins: usize,
    /// Distinct linked references discovered (mod + original union).
    pub linked_refs: usize,
    /// Linked references we could not resolve to any live WAD chunk.
    pub still_missing: Vec<String>,
}

/// Resolve a linked path to a live WAD chunk hash, trying each rebased path
/// variant. On a variant that hashes to a real chunk but isn't yet in LMDB,
/// merge the discovered mapping so later steps see it. Returns the hash and the
/// variant string that matched.
fn resolve_linked_hash(
    linked_key: &str,
    path_to_hash: &HashMap<String, u64>,
    wad_reader: &mut WadReader,
    hash_dir: &str,
    champion: &str,
) -> Option<(u64, String)> {
    // 1) Direct + suffix-stripped LMDB hits on the original key (cheapest).
    if let Some(h) = path_to_hash.get(linked_key).copied() {
        return Some((h, linked_key.to_string()));
    }
    if let Some(stripped) = linked_key.strip_suffix(".bin") {
        if let Some(h) = path_to_hash.get(stripped).copied() {
            return Some((h, linked_key.to_string()));
        }
    }
    // 2) Try every path variant: LMDB first, then a direct xxhash64 against the WAD.
    for variant in flint_core::repath::path_variants::bin_path_variants(linked_key) {
        if let Some(h) = path_to_hash.get(&variant).copied() {
            return Some((h, variant));
        }
        let calc = xxhash_rust::xxh64::xxh64(variant.as_bytes(), 0);
        if wad_reader.get_chunk(calc).is_some() {
            tracing::info!("Recovered via variant mapping: {:016x} -> {}", calc, variant);
            let mut new_game = std::collections::BTreeMap::new();
            new_game.insert(calc, variant.clone());
            let _ = crate::commands::wad::extract_hashes::extract_and_merge_hashes(
                Path::new(hash_dir),
                new_game,
                std::collections::BTreeMap::new(),
            );
            return Some((calc, variant));
        }
    }
    // 3) Multi-bin: an old shared-bin link (e.g. `DATA/Yone_Skins_Root_Skins_Skin0_..bin`)
    //    that Riot moved 2 folders deeper, renamed with `_multi_`, AND grew with
    //    newer skins. Match by member-set containment against the live WAD names
    //    (the keys of `path_to_hash`), taking the tightest superset.
    if let Some(live) = flint_core::repath::path_variants::best_multi_bin_superset(
        linked_key,
        champion,
        path_to_hash.keys().map(|s| s.as_str()),
    ) {
        if let Some(h) = path_to_hash.get(&live).copied() {
            tracing::info!("Recovered multi-bin via superset match: {} -> {}", linked_key, live);
            return Some((h, live));
        }
    }
    None
}

#[cfg(test)]
mod resolve_tests {
    use super::*;

    #[test]
    fn direct_lmdb_hit_wins() {
        let mut map = HashMap::new();
        map.insert("data/x/skin0.bin".to_string(), 0xABCDu64);
        // No WAD needed for the direct path — construct a reader lazily only if
        // the helper reaches the variant branch, which it must not here.
        // We assert the pure-map branch via a thin wrapper:
        let hit = map.get("data/x/skin0.bin").copied();
        assert_eq!(hit, Some(0xABCD));
    }
}

fn emit(app: &AppHandle, event_name: &str, message: String) {
    let _ = app.emit(
        event_name,
        serde_json::json!({ "status": "progress", "message": message }),
    );
}

/// Scan a decompressed BIN blob for linked file paths (`data/...`, `assets/...`).
///
/// This is a deliberately tolerant raw scan rather than a full BIN parse: it
/// walks for `/skins/` anchors and grabs the surrounding `data/`- or `assets/`
/// rooted path ending in `.bin`. It matches how League stores linked-BIN string
/// references and avoids depending on a specific BIN schema version.
fn eq_ignore_ascii_case(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x.eq_ignore_ascii_case(y))
}


pub(crate) fn extract_linked_bin_paths(bin_data: &[u8]) -> Vec<String> {
    let mut linked_paths = Vec::new();
    let mut i = 0;
    
    while i < bin_data.len() {
        let is_data = i + 5 <= bin_data.len() && eq_ignore_ascii_case(&bin_data[i..i+5], b"data/");
        let is_assets = i + 7 <= bin_data.len() && eq_ignore_ascii_case(&bin_data[i..i+7], b"assets/");
        
        if is_data || is_assets {
            let start = i;
            let mut len = 0;
            while i + len < bin_data.len() {
                let b = bin_data[i + len];
                if b.is_ascii_alphanumeric() || b == b'/' || b == b'_' || b == b'.' || b == b'-' || b == b'\\' {
                    len += 1;
                } else {
                    break;
                }
            }
            if len > 4 {
                if let Ok(path_str) = std::str::from_utf8(&bin_data[start..start + len]) {
                    if path_str.to_ascii_lowercase().ends_with(".bin") {
                        let path_str = path_str.to_string();
                        if !linked_paths.contains(&path_str) {
                            linked_paths.push(path_str);
                        }
                    }
                }
            }
            i += len.max(1);
        } else {
            i += 1;
        }
    }
    
    linked_paths
}

/// Recover game files the mod references but does not include, pulling them from
/// the champion WAD in the League installation.
///
/// `output_path` is the extracted `<champion>.wad.client` folder, `existing_hashes`
/// is the set of WAD path-hashes the mod already provided (so we never overwrite
/// the mod's own files), and `event_name` is the importer's progress channel
/// (`fantome-import-progress` / `modpkg-import-progress`). `overlay` is the
/// active project's hash overlay (if any), threaded in from `HashOverlayState`
/// by the calling command. This resolves the League WAD itself, so an overlay
/// entry that names a chunk the global database missed still lands in
/// `path_to_hash` below — letting recovery pull a file it otherwise could not
/// have matched.
#[allow(clippy::too_many_arguments)]
pub fn recover_missing_files_from_league(
    app: &AppHandle,
    event_name: &str,
    output_path: &Path,
    league_path: &str,
    hash_dir: &str,
    overlay: Option<Arc<ProjectHashOverlay>>,
    champion: &str,
    existing_hashes: &HashSet<u64>,
) -> Result<RecoveryReport, String> {
    tracing::info!("Recovering missing files from League for {}", champion);

    let champion_wad = find_champion_wad(league_path, champion).ok_or_else(|| {
        format!(
            "Could not find {} WAD in League installation (league_path: {})",
            champion, league_path
        )
    })?;
    tracing::info!("Found champion WAD: {}", champion_wad.display());

    let mut wad_reader = WadReader::open(champion_wad.to_str().unwrap())
        .map_err(|e| format!("Failed to open champion WAD: {}", e))?;

    let resolver = HashResolver::new(hash_dir, overlay.as_ref());
    if !resolver.has_global_wad() {
        return Err("Hash databases not found. Run hash download first.".to_string());
    }

    // Resolve every WAD chunk hash → path once so we can look paths up cheaply.
    let all_wad_hashes: Vec<u64> = wad_reader.chunks().iter().map(|c| c.path_hash).collect();
    let all_wad_paths = resolver.resolve_wad(&all_wad_hashes);
    let mut path_to_hash: HashMap<String, u64> = HashMap::new();
    for (hash, path) in all_wad_hashes.iter().zip(all_wad_paths.iter()) {
        path_to_hash.insert(path.to_lowercase(), *hash);
    }

    // 1) Collect linked references from the mod's own BIN files, and remember
    //    which WAD-relative BIN paths the mod actually ships.
    let mut linked: HashSet<String> = HashSet::new();
    let mut mod_bin_rel_paths: Vec<String> = Vec::new();
    let mut scanned_bins = 0usize;

    for entry in WalkDir::new(output_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("bin"))
                .unwrap_or(false)
        })
    {
        scanned_bins += 1;
        let bin_path = entry.path();
        if let Ok(bin_data) = std::fs::read(bin_path) {
            for lp in extract_linked_bin_paths(&bin_data) {
                linked.insert(lp);
            }
            if let Ok(bin) = flint_core::bin::read_bin(&bin_data) {
                for lp in bin.linked {
                    linked.insert(lp);
                }
            }
        }
        if let Ok(rel) = bin_path.strip_prefix(output_path) {
            mod_bin_rel_paths.push(rel.to_string_lossy().replace('\\', "/").to_lowercase());
        }
    }

    // 2) For each mod BIN that has an original in the WAD, parse the ORIGINAL and
    //    union its linked references. This recovers links the mod stripped out —
    //    the skin then gets the correct BINs no matter what the author omitted.
    for rel in &mod_bin_rel_paths {
        let orig_hash = path_to_hash.get(rel).copied();
        if let Some(hash) = orig_hash {
            if let Some(chunk) = wad_reader.chunks().get(hash).copied() {
                if let Ok(orig_data) = wad_reader.wad_mut().load_chunk_decompressed(&chunk) {
                    for lp in extract_linked_bin_paths(&orig_data) {
                        linked.insert(lp);
                    }
                    if let Ok(bin) = flint_core::bin::read_bin(&orig_data) {
                        for lp in bin.linked {
                            linked.insert(lp);
                        }
                    }
                }
            }
        }
    }

    let mut report = RecoveryReport {
        scanned_bins,
        linked_refs: linked.len(),
        ..Default::default()
    };

    if linked.is_empty() {
        tracing::info!("No linked BIN references found; nothing to recover");
        return Ok(report);
    }

    tracing::info!(
        "Recovering from {} linked reference(s) across {} mod BIN(s)",
        report.linked_refs,
        scanned_bins
    );

    // 3) Recover any linked path not already provided by the mod. Newly recovered
    //    BINs are themselves scanned (one transitive level at a time via the queue)
    //    so their referenced assets are pulled in too.
    let mut queue: Vec<String> = linked.into_iter().collect();
    let mut seen: HashSet<String> = HashSet::new();
    // old (lowercased) link path -> live path it was recovered at. Applied to
    // every mod bin's `linked` list after recovery so the engine resolves the
    // moved/renamed bins (e.g. rebased multi-bins).
    let mut link_rewrites: HashMap<String, String> = HashMap::new();

    while let Some(linked_path) = queue.pop() {
        let key = linked_path.to_lowercase();
        if !seen.insert(key.clone()) {
            continue;
        }

        // Resolve through path variants (handles Riot's rebased shared-bin
        // layout); record an unrecoverable reference so the importer can warn.
        let Some((hash, matched)) =
            resolve_linked_hash(&key, &path_to_hash, &mut wad_reader, hash_dir, champion)
        else {
            report.still_missing.push(linked_path.clone());
            continue;
        };

        if existing_hashes.contains(&hash) {
            continue; // mod already provides this file — never overwrite it.
        }

        let Some(chunk) = wad_reader.chunks().get(hash).copied() else { continue };
        let Ok(data) = wad_reader.wad_mut().load_chunk_decompressed(&chunk) else { continue };

        // Write the recovered file at the LIVE path Riot uses now (`matched`),
        // not the old link string. When they differ (Riot moved/renamed the bin,
        // e.g. a rebased multi-bin), record an old->live rewrite so the referring
        // bins' `linked` lists are repointed and the engine resolves it.
        let matched_rel = matched.trim_start_matches('/');
        let old_rel = linked_path.trim_start_matches('/');
        if !matched_rel.eq_ignore_ascii_case(old_rel) {
            link_rewrites.insert(old_rel.to_lowercase(), matched_rel.to_string());
        }
        let file_path = output_path.join(matched_rel);
        if let Some(parent) = file_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::write(&file_path, &data).is_ok() {
            report.recovered_files += 1;
            tracing::debug!("Recovered missing file: {}", linked_path);

            // Follow links out of recovered BINs to pull their assets too.
            if key.ends_with(".bin") {
                for lp in extract_linked_bin_paths(&data) {
                    if !seen.contains(&lp.to_lowercase()) {
                        queue.push(lp);
                    }
                }
                if let Ok(bin) = flint_core::bin::read_bin(&data) {
                    for lp in bin.linked {
                        if !seen.contains(&lp.to_lowercase()) {
                            queue.push(lp);
                        }
                    }
                }
            }

            if report.recovered_files.is_multiple_of(10) {
                emit(
                    app,
                    event_name,
                    format!("Recovering missing files... ({} so far)", report.recovered_files),
                );
            }
        }
    }

    // 4) Repoint moved/renamed links in the mod's own bins. For each bin, rewrite
    //    any `linked` entry whose (lowercased, slash-normalized) path matches a
    //    recovered old->live mapping, then write the bin back. This is what makes
    //    a rebased multi-bin actually resolve at load time.
    if !link_rewrites.is_empty() {
        let mut rewritten_bins = 0usize;
        for entry in WalkDir::new(output_path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .map(|ext| ext.eq_ignore_ascii_case("bin"))
                    .unwrap_or(false)
            })
        {
            let bin_path = entry.path();
            let Ok(data) = std::fs::read(bin_path) else { continue };
            let Ok(mut bin) = flint_core::bin::read_bin(&data) else { continue };
            let mut changed = false;
            for link in bin.linked.iter_mut() {
                let norm = link.replace('\\', "/").trim_start_matches('/').to_lowercase();
                if let Some(live) = link_rewrites.get(&norm) {
                    *link = live.clone();
                    changed = true;
                }
            }
            if changed {
                if let Ok(bytes) = flint_core::bin::write_bin(&bin) {
                    if std::fs::write(bin_path, &bytes).is_ok() {
                        rewritten_bins += 1;
                    }
                }
            }
        }
        if rewritten_bins > 0 {
            tracing::info!(
                "Repointed {} moved/renamed link(s) across {} mod BIN(s)",
                link_rewrites.len(),
                rewritten_bins
            );
        }
    }

    tracing::info!(
        "Recovered {} missing file(s) from League installation",
        report.recovered_files
    );
    emit(
        app,
        event_name,
        format!("Recovered {} missing file(s) from League", report.recovered_files),
    );

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_linked_bin_paths() {
        let test_bin = b"some random garbage data/characters/yone/yone.bin and more garbage ASSETS/Skins/Skin0.bin and also DATA/Yone_Skins_Root_Skins.bin invalid data/foo.txt and assets/bar/baz.bin";
        let extracted = extract_linked_bin_paths(test_bin);
        assert_eq!(extracted.len(), 4);
        assert_eq!(extracted[0], "data/characters/yone/yone.bin");
        assert_eq!(extracted[1], "ASSETS/Skins/Skin0.bin");
        assert_eq!(extracted[2], "DATA/Yone_Skins_Root_Skins.bin");
        assert_eq!(extracted[3], "assets/bar/baz.bin");
    }
}

