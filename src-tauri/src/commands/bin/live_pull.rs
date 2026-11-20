use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use flint_core::hash::wad_chunk_hash;
use flint_core::league::detect_league_installation;
use flint_core::overlay::HashResolver;
use flint_core::path_slash::to_slash;
use flint_core::wad::adapter::{extract_chunk, WadHandle};
use flint_core::wad::cache::WadCache;
use flint_core::wad::format::WadChunk;
use serde::{Deserialize, Serialize};
use tauri::State;
use walkdir::WalkDir;

use crate::commands::platform::settings::get_settings;
use crate::state::WadCacheState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAssetMatch {
    pub missing_path: String,
    pub wad_path: String,
    pub wad_name: String,
    pub chunk_hash: String,
    pub live_path: String,
    pub exact: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindLiveAssetsResult {
    pub matches: Vec<LiveAssetMatch>,
    pub unmatched: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullLiveAssetItem {
    pub missing_path: String,
    pub wad_path: String,
    pub chunk_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullLiveAssetsResult {
    pub pulled: usize,
    pub failed: Vec<String>,
}

fn resolve_league_final_dir() -> Result<PathBuf, String> {
    if let Ok(settings) = get_settings() {
        if let Some(ref lp) = settings.league_path {
            let trimmed = lp.trim();
            if !trimmed.is_empty() {
                let candidate = Path::new(trimmed).join("Game").join("DATA").join("FINAL");
                if candidate.is_dir() {
                    return Ok(candidate);
                }
            }
        }
    }

    if let Ok(inst) = detect_league_installation() {
        let candidate = inst.path.join("Game").join("DATA").join("FINAL");
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }

    Err("League of Legends installation not found. Set your League path in Settings.".to_string())
}

fn is_locale_wad_name(name_lower: &str) -> bool {
    let stem = name_lower
        .strip_suffix(".wad.client")
        .or_else(|| name_lower.strip_suffix(".wad"))
        .unwrap_or(name_lower);
    let Some((_, locale)) = stem.rsplit_once('.') else {
        return false;
    };
    let bytes = locale.as_bytes();
    bytes.len() == 5
        && bytes[2] == b'_'
        && bytes[0].is_ascii_alphabetic()
        && bytes[1].is_ascii_alphabetic()
        && bytes[3].is_ascii_alphabetic()
        && bytes[4].is_ascii_alphabetic()
}

fn collect_live_wads(final_dir: &Path, folder_name: &str) -> Vec<(PathBuf, String, bool)> {
    let folder_lower = folder_name.to_ascii_lowercase();
    let mut primary = Vec::new();
    let mut champions = Vec::new();
    let mut root_wads = Vec::new();
    let mut other = Vec::new();
    let mut locale = Vec::new();

    for entry in WalkDir::new(final_dir)
        .max_depth(5)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let name_lower = name.to_ascii_lowercase();
        if !name_lower.ends_with(".wad.client") && !name_lower.ends_with(".wad") {
            continue;
        }
        let item = (path.to_path_buf(), name.to_string(), name_lower == folder_lower);
        if name_lower == folder_lower {
            primary.push(item);
        } else if is_locale_wad_name(&name_lower) {
            locale.push(item);
        } else if path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).is_some_and(|d| d.eq_ignore_ascii_case("Champions")) {
            champions.push(item);
        } else if path.parent() == Some(final_dir) {
            root_wads.push(item);
        } else {
            other.push(item);
        }
    }

    let mut out = Vec::with_capacity(
        primary.len() + champions.len() + root_wads.len() + other.len() + locale.len(),
    );
    out.extend(primary);
    out.extend(root_wads);
    out.extend(champions);
    out.extend(other);
    out.extend(locale);
    out
}

fn extract_repath_tails(norm: &str) -> Vec<String> {
    let parts: Vec<&str> = norm.split('/').filter(|s| !s.is_empty()).collect();
    let mut tails = Vec::new();
    if parts.len() >= 4 && (parts[0] == "assets" || parts[0] == "data") {
        let tail = parts[3..].join("/");
        if !tail.is_empty() {
            if let Some(rest) = tail
                .strip_prefix("shared-champion/")
                .or_else(|| tail.strip_prefix("shared/"))
            {
                if !rest.is_empty() {
                    tails.push(rest.to_string());
                }
            }
            tails.push(tail);
        }
    }
    if parts.len() >= 3 && (parts[0] == "assets" || parts[0] == "data") {
        let tail = parts[2..].join("/");
        if !tail.is_empty() && !tails.contains(&tail) {
            tails.push(tail);
        }
    }
    tails
}

struct MissingQuery {
    original: String,
    norm: String,
    exact_hash: u64,
    candidate_hashes: Vec<u64>,
    tails: Vec<String>,
    filename: String,
    wants_vo: bool,
}

fn build_query(raw: &str, champion: Option<&str>) -> Option<MissingQuery> {
    let norm = raw.replace('\\', "/").trim_start_matches('/').to_ascii_lowercase();
    if norm.is_empty() || (norm.starts_with("0x") && !norm.contains('/')) {
        return None;
    }

    let exact_hash = wad_chunk_hash(&norm);
    let filename = norm.rsplit('/').next().unwrap_or("").to_string();
    let tails = extract_repath_tails(&norm);

    let mut candidate_paths = Vec::new();
    for tail in &tails {
        if let Some(champ) = champion {
            candidate_paths.push(format!("assets/characters/{champ}/{tail}"));
            candidate_paths.push(format!("assets/characters/{champ}/skins/base/{tail}"));
            candidate_paths.push(format!("assets/characters/{champ}/skins/skin0/{tail}"));
            candidate_paths.push(format!("data/characters/{champ}/{tail}"));
            candidate_paths.push(format!("data/characters/{champ}/skins/base/{tail}"));
            candidate_paths.push(format!("data/characters/{champ}/skins/skin0/{tail}"));
        }
        candidate_paths.push(format!("assets/{tail}"));
        candidate_paths.push(format!("data/{tail}"));
        candidate_paths.push(format!("assets/shared/{tail}"));
    }

    let mut seen = HashSet::new();
    seen.insert(exact_hash);
    let mut candidate_hashes = Vec::new();
    for path in candidate_paths {
        let h = wad_chunk_hash(&path);
        if seen.insert(h) {
            candidate_hashes.push(h);
        }
    }

    let wants_vo = norm.contains("/vo/") || norm.contains("/audio/vo/");

    Some(MissingQuery {
        original: raw.to_string(),
        norm,
        exact_hash,
        candidate_hashes,
        tails,
        filename,
        wants_vo,
    })
}

fn get_wad_chunks(wad_path: &Path, cache: &Arc<WadCache>) -> Result<Arc<Vec<WadChunk>>, String> {
    let key = to_slash(wad_path);
    if let Some(cached) = cache.get(&key) {
        return Ok(cached);
    }
    let reader = WadHandle::open(wad_path).map_err(|e| e.to_string())?;
    let chunks = Arc::new(reader.into_chunks());
    let _ = cache.insert(key, Arc::clone(&chunks));
    Ok(chunks)
}

fn score_resolved_match(
    query: &MissingQuery,
    live_lower: &str,
    champion: Option<&str>,
    is_primary_wad: bool,
) -> Option<u32> {
    let mut base = 0u32;
    for tail in &query.tails {
        if tail.contains('/') && live_lower.ends_with(&format!("/{tail}")) {
            base = base.max(500 + tail.len() as u32);
        }
    }
    if base == 0 && !query.filename.is_empty() && live_lower.ends_with(&format!("/{0}", query.filename)) {
        base = 100;
    }
    if base == 0 {
        return None;
    }

    let mut score = base;
    if is_primary_wad {
        score += 100;
    }
    if let Some(champ) = champion {
        if live_lower.contains(&format!("characters/{champ}/")) {
            score += 50;
        }
    }
    if live_lower.contains("/skins/base/") || live_lower.contains("/skins/skin0/") {
        score += 20;
    }
    if (query.norm.starts_with("assets/") && live_lower.starts_with("assets/"))
        || (query.norm.starts_with("data/") && live_lower.starts_with("data/"))
    {
        score += 10;
    }
    Some(score)
}

fn find_live_assets_blocking(
    folder_path: &str,
    missing_paths: Vec<String>,
    cache: Arc<WadCache>,
) -> Result<FindLiveAssetsResult, String> {
    let final_dir = resolve_league_final_dir()?;
    let folder = Path::new(folder_path);
    let folder_name = folder
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let champion = folder_name
        .strip_suffix(".wad.client")
        .or_else(|| folder_name.strip_suffix(".wad"))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase());

    let wads = collect_live_wads(&final_dir, &folder_name);
    if wads.is_empty() {
        return Err(format!("No WAD files found under {}", final_dir.display()));
    }

    let mut queries = Vec::new();
    let mut unmatched_raw = Vec::new();
    for raw in missing_paths {
        if let Some(q) = build_query(&raw, champion.as_deref()) {
            queries.push(q);
        } else {
            unmatched_raw.push(raw);
        }
    }

    let hash_dir = flint_core::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let resolver = HashResolver::global(&hash_dir);

    let mut best_matches: HashMap<usize, (u32, LiveAssetMatch)> = HashMap::new();
    let mut remaining: Vec<usize> = (0..queries.len()).collect();

    for (wad_path, wad_name, is_primary) in &wads {
        if remaining.is_empty() {
            break;
        }
        let is_locale = is_locale_wad_name(&wad_name.to_ascii_lowercase());
        if is_locale && !remaining.iter().any(|&i| queries[i].wants_vo) {
            continue;
        }

        let Ok(chunks) = get_wad_chunks(wad_path, &cache) else {
            continue;
        };
        let chunk_hashes: HashSet<u64> = chunks.iter().map(|c| c.path_hash).collect();
        let wad_path_str = to_slash(wad_path);

        let mut still_remaining = Vec::new();
        for &idx in &remaining {
            let q = &queries[idx];
            if chunk_hashes.contains(&q.exact_hash) {
                let resolved = resolver
                    .resolve_wad(&[q.exact_hash])
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| q.norm.clone());
                best_matches.insert(
                    idx,
                    (
                        u32::MAX,
                        LiveAssetMatch {
                            missing_path: q.original.clone(),
                            wad_path: wad_path_str.clone(),
                            wad_name: wad_name.clone(),
                            chunk_hash: format!("{:016x}", q.exact_hash),
                            live_path: resolved,
                            exact: true,
                        },
                    ),
                );
                continue;
            }

            if let Some(&cand_hash) = q.candidate_hashes.iter().find(|h| chunk_hashes.contains(h)) {
                let resolved = resolver
                    .resolve_wad(&[cand_hash])
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| format!("{:016x}", cand_hash));
                let score = 900 + if *is_primary { 100 } else { 0 };
                let replace = best_matches
                    .get(&idx)
                    .is_none_or(|(best, _)| score > *best);
                if replace {
                    best_matches.insert(
                        idx,
                        (
                            score,
                            LiveAssetMatch {
                                missing_path: q.original.clone(),
                                wad_path: wad_path_str.clone(),
                                wad_name: wad_name.clone(),
                                chunk_hash: format!("{:016x}", cand_hash),
                                live_path: resolved,
                                exact: false,
                            },
                        ),
                    );
                }
                if *is_primary {
                    continue;
                }
            }

            still_remaining.push(idx);
        }
        remaining = still_remaining;
    }

    let unresolved_indices: Vec<usize> = (0..queries.len())
        .filter(|i| !best_matches.contains_key(i))
        .collect();

    if !unresolved_indices.is_empty() {
        let mut search_indices = unresolved_indices;
        for (wad_path, wad_name, is_primary) in &wads {
            if search_indices.is_empty() {
                break;
            }
            let is_locale = is_locale_wad_name(&wad_name.to_ascii_lowercase());
            if is_locale && !search_indices.iter().any(|&i| queries[i].wants_vo) {
                continue;
            }

            let Ok(chunks) = get_wad_chunks(wad_path, &cache) else {
                continue;
            };
            let hashes: Vec<u64> = chunks.iter().map(|c| c.path_hash).collect();
            let resolved_paths = resolver.resolve_wad(&hashes);
            let wad_path_str = to_slash(wad_path);

            for (chunk, live_path) in chunks.iter().zip(resolved_paths.iter()) {
                let live_lower = live_path.to_ascii_lowercase();
                if !live_lower.contains('/') {
                    continue;
                }
                for &idx in &search_indices {
                    let q = &queries[idx];
                    if let Some(score) =
                        score_resolved_match(q, &live_lower, champion.as_deref(), *is_primary)
                    {
                        let replace = best_matches
                            .get(&idx)
                            .is_none_or(|(best, _)| score > *best);
                        if replace {
                            best_matches.insert(
                                idx,
                                (
                                    score,
                                    LiveAssetMatch {
                                        missing_path: q.original.clone(),
                                        wad_path: wad_path_str.clone(),
                                        wad_name: wad_name.clone(),
                                        chunk_hash: format!("{:016x}", chunk.path_hash),
                                        live_path: live_path.clone(),
                                        exact: false,
                                    },
                                ),
                            );
                        }
                    }
                }
            }

            if *is_primary {
                search_indices.retain(|i| {
                    best_matches
                        .get(i)
                        .is_none_or(|(score, _)| *score < 500)
                });
            }
        }
    }

    let mut matches = Vec::new();
    let mut unmatched = unmatched_raw;
    for (idx, q) in queries.into_iter().enumerate() {
        if let Some((_, m)) = best_matches.remove(&idx) {
            matches.push(m);
        } else {
            unmatched.push(q.original);
        }
    }

    Ok(FindLiveAssetsResult { matches, unmatched })
}

fn sanitize_relative_path(raw: &str) -> Result<PathBuf, String> {
    let cleaned = raw.replace('\\', "/");
    let trimmed = cleaned.trim_start_matches('/');
    if trimmed.is_empty() {
        return Err("Empty destination path".to_string());
    }
    let rel = Path::new(trimmed);
    for comp in rel.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return Err(format!("Unsafe destination path: {raw}")),
        }
    }
    Ok(rel.to_path_buf())
}

#[tauri::command]
pub async fn find_live_assets(
    folder_path: String,
    missing_paths: Vec<String>,
    wad_cache_state: State<'_, WadCacheState>,
) -> Result<FindLiveAssetsResult, String> {
    let cache = wad_cache_state.get();
    tokio::task::spawn_blocking(move || {
        find_live_assets_blocking(&folder_path, missing_paths, cache)
    })
    .await
    .map_err(|e| format!("Live asset search failed: {e}"))?
}

#[tauri::command]
pub async fn pull_live_assets(
    folder_path: String,
    items: Vec<PullLiveAssetItem>,
) -> Result<PullLiveAssetsResult, String> {
    tokio::task::spawn_blocking(move || {
        let base_dir = Path::new(&folder_path);
        if !base_dir.is_dir() {
            return Err(format!("Folder not found: {folder_path}"));
        }

        let mut by_wad: HashMap<String, Vec<PullLiveAssetItem>> = HashMap::new();
        for item in items {
            by_wad.entry(item.wad_path.clone()).or_default().push(item);
        }

        let mut pulled = 0usize;
        let mut failed = Vec::new();

        for (wad_path, group) in by_wad {
            let mut wad = match WadHandle::open(&wad_path) {
                Ok(w) => w,
                Err(e) => {
                    for item in group {
                        failed.push(format!("{}: {}", item.missing_path, e));
                    }
                    continue;
                }
            };

            let mut resolved_items = Vec::new();
            for item in group {
                let hash = match u64::from_str_radix(item.chunk_hash.trim_start_matches("0x"), 16) {
                    Ok(h) => h,
                    Err(_) => {
                        failed.push(format!("{}: invalid chunk hash", item.missing_path));
                        continue;
                    }
                };
                let rel = match sanitize_relative_path(&item.missing_path) {
                    Ok(r) => r,
                    Err(e) => {
                        failed.push(e);
                        continue;
                    }
                };
                let Some(chunk) = wad.get_chunk(hash).copied() else {
                    failed.push(format!("{}: chunk not found in live WAD", item.missing_path));
                    continue;
                };
                resolved_items.push((item.missing_path, chunk, base_dir.join(rel)));
            }

            let mut decoder = wad.wad_mut();
            for (missing_path, chunk, dest) in resolved_items {
                match extract_chunk(&mut decoder, &chunk, &dest, None) {
                    Ok(()) => pulled += 1,
                    Err(e) => failed.push(format!("{missing_path}: {e}")),
                }
            }
        }

        Ok(PullLiveAssetsResult { pulled, failed })
    })
    .await
    .map_err(|e| format!("Pull live assets failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repath_tails_strip_creator_and_project() {
        let tails = extract_repath_tails("assets/sirdexal/ahri-mod/particles/ahri_q_mis.tex");
        assert!(tails.contains(&"particles/ahri_q_mis.tex".to_string()));
    }

    #[test]
    fn repath_tails_strip_shared_champion() {
        let tails = extract_repath_tails("assets/sirdexal/shared-champion/particles/spark.tex");
        assert!(tails.contains(&"particles/spark.tex".to_string()));
    }

    #[test]
    fn build_query_hashes_repathed_candidates() {
        let q = build_query("assets/sirdexal/ahri-mod/particles/ahri_q_mis.tex", Some("ahri")).unwrap();
        let expected = wad_chunk_hash("assets/characters/ahri/skins/base/particles/ahri_q_mis.tex");
        assert!(q.candidate_hashes.contains(&expected));
    }

    #[test]
    fn build_query_skips_raw_hex_hash() {
        assert!(build_query("0x0123456789abcdef", Some("ahri")).is_none());
    }

    #[test]
    fn score_prefers_tail_and_primary_wad() {
        let q = build_query("assets/sirdexal/ahri-mod/particles/ahri_q_mis.tex", Some("ahri")).unwrap();
        let tail_hit = score_resolved_match(
            &q,
            "assets/characters/ahri/skins/base/particles/ahri_q_mis.tex",
            Some("ahri"),
            true,
        )
        .unwrap();
        let filename_only = score_resolved_match(
            &q,
            "assets/characters/lux/skins/skin1/ahri_q_mis.tex",
            Some("ahri"),
            false,
        )
        .unwrap();
        assert!(tail_hit > filename_only);
    }

    #[test]
    fn sanitize_rejects_traversal() {
        assert!(sanitize_relative_path("../secret.tex").is_err());
        assert!(sanitize_relative_path("assets/sirdexal/mod/a.tex").is_ok());
    }

    #[test]
    fn detects_locale_wad_names() {
        assert!(is_locale_wad_name("ahri.en_us.wad.client"));
        assert!(!is_locale_wad_name("ahri.wad.client"));
    }
}
