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

use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use flint_ltk::hash::lmdb_cache::{get_or_open_env, resolve_hashes_lmdb};
use flint_ltk::wad_jade::adapter::{find_champion_wad, WadHandle as WadReader};

/// Summary of what recovery pulled in, surfaced to the importer for logging.
#[derive(Debug, Default, Clone)]
pub struct RecoveryReport {
    /// Files actually written to disk from the League WAD.
    pub recovered_files: usize,
    /// BIN files in the extracted mod that were scanned for links.
    pub scanned_bins: usize,
    /// Distinct linked references discovered (mod + original union).
    pub linked_refs: usize,
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
/// (`fantome-import-progress` / `modpkg-import-progress`).
pub fn recover_missing_files_from_league(
    app: &AppHandle,
    event_name: &str,
    output_path: &Path,
    league_path: &str,
    hash_dir: &str,
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

    let env = get_or_open_env(hash_dir).ok_or("Failed to open LMDB environment")?;

    // Resolve every WAD chunk hash → path once so we can look paths up cheaply.
    let all_wad_hashes: Vec<u64> = wad_reader.chunks().iter().map(|c| c.path_hash).collect();
    let all_wad_paths = resolve_hashes_lmdb(&all_wad_hashes, &env);
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
            if let Ok(bin) = flint_ltk::bin::read_bin(&bin_data) {
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
                    if let Ok(bin) = flint_ltk::bin::read_bin(&orig_data) {
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

    while let Some(linked_path) = queue.pop() {
        let key = linked_path.to_lowercase();
        if !seen.insert(key.clone()) {
            continue;
        }

        // Resolve exact, or fall back to the path without its `.bin` suffix
        // (some references include `.bin` where the stored path does not).
        let hash = path_to_hash
            .get(&key)
            .copied()
            .or_else(|| key.strip_suffix(".bin").and_then(|k| path_to_hash.get(k).copied()))
            .or_else(|| {
                // If the path string is not resolved/unhashed in the LMDB mapping,
                // calculate its xxhash64 directly and check if the WAD has a chunk for it!
                let calculated_hash = xxhash_rust::xxh64::xxh64(key.as_bytes(), 0);
                if wad_reader.get_chunk(calculated_hash).is_some() {
                    tracing::info!("Discovered new hash-path mapping through link recovery: {:016x} -> {}", calculated_hash, key);
                    
                    // Merge new hash mapping into LMDB database on the fly
                    let mut new_game = std::collections::BTreeMap::new();
                    new_game.insert(calculated_hash, key.clone());
                    let _ = crate::commands::wad::extract_hashes::extract_and_merge_hashes(
                        Path::new(hash_dir),
                        new_game,
                        std::collections::BTreeMap::new(),
                    );
                    
                    Some(calculated_hash)
                } else {
                    None
                }
            });

        let Some(hash) = hash else { continue };
        if existing_hashes.contains(&hash) {
            continue; // mod already provides this file — never overwrite it.
        }

        let Some(chunk) = wad_reader.chunks().get(hash).copied() else { continue };
        let Ok(data) = wad_reader.wad_mut().load_chunk_decompressed(&chunk) else { continue };

        let file_path = output_path.join(linked_path.trim_start_matches('/'));
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
                if let Ok(bin) = flint_ltk::bin::read_bin(&data) {
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

