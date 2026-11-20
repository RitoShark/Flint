use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use flint_core::hash::{get_cached_bin_hashes, wad_chunk_hash};
use flint_core::league::detect_league_installation;
use flint_core::overlay::{HashResolver, ProjectHashOverlay};
use flint_core::path_slash::to_slash;
use flint_core::repath::refather::{repath_asset_path, RepathConfig};
use flint_core::wad::adapter::{extract_chunk, WadHandle};
use flint_core::wad::cache::WadCache;
use flint_core::wad::format::WadChunk;
use serde::{Deserialize, Serialize};
use tauri::State;
use walkdir::WalkDir;

use crate::commands::platform::settings::get_settings;
use crate::state::{HashOverlayState, WadCacheState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAssetMatch {
    pub missing_path: String,
    pub dest_path: String,
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
    dest_path: Option<String>,
    norm: String,
    exact_hash: u64,
    candidate_hashes: Vec<u64>,
    tails: Vec<String>,
    filename: String,
    wants_vo: bool,
}

fn parse_hash_list_into(content: &str, out: &mut HashMap<u64, String>) {
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((hex, name)) = line.split_once(char::is_whitespace) {
            let clean_hex = hex.trim_start_matches("0x").trim_start_matches("0X");
            if clean_hex.len() == 16 && clean_hex.chars().all(|c| c.is_ascii_hexdigit()) {
                if let Ok(h) = u64::from_str_radix(clean_hex, 16) {
                    let path = name.trim().replace('\\', "/").trim_start_matches('/').to_string();
                    if !path.is_empty() {
                        out.entry(h).or_insert(path);
                    }
                    continue;
                }
            }
        }
        let path = line.replace('\\', "/").trim_start_matches('/').to_string();
        if !path.is_empty() {
            out.entry(wad_chunk_hash(&path)).or_insert(path);
        }
    }
}

fn find_project_root(folder: &Path) -> Option<PathBuf> {
    let mut cur = Some(folder);
    for _ in 0..5 {
        let dir = cur?;
        if dir.join("mod.config.json").is_file() {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

fn load_local_hash_names(folder: &Path) -> HashMap<u64, String> {
    let mut map = HashMap::new();
    let mut trailer = flint_core::bin::Trailer::new();
    flint_core::bin::hash_store::read_dot_hashes_into(folder, &mut trailer);
    if !trailer.files.is_empty() {
        tracing::info!(
            "[live_pull] Loaded {} game entries from .hashes/",
            trailer.files.len()
        );
        map.extend(trailer.files);
    }
    let files_txt = folder.join("files.txt");
    if let Ok(content) = std::fs::read_to_string(&files_txt) {
        parse_hash_list_into(&content, &mut map);
        tracing::info!(
            "[live_pull] Loaded {} entries from {}",
            map.len(),
            files_txt.display()
        );
    } else {
        tracing::info!("[live_pull] No files.txt at {}", files_txt.display());
    }
    if let Some(root) = find_project_root(folder) {
        let hashes_dir = root.join("hashes");
        if let Ok(entries) = std::fs::read_dir(&hashes_dir) {
            let before = map.len();
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    if let Ok(content) = std::fs::read_to_string(&p) {
                        parse_hash_list_into(&content, &mut map);
                    }
                }
            }
            tracing::info!(
                "[live_pull] Loaded {} additional entries from {}",
                map.len() - before,
                hashes_dir.display()
            );
        }
    }
    map
}

fn parse_hex_u64(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    let hex = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))?;
    if hex.is_empty() || hex.len() > 16 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(hex, 16).ok()
}

fn load_project_repath_config(folder: &Path, folder_champion: Option<&str>) -> Option<RepathConfig> {
    let root = find_project_root(folder)?;
    let mut creator = String::new();
    let mut project = String::new();
    let mut champion = folder_champion.unwrap_or("").to_string();
    let mut target_skin_id = 0u32;

    if let Ok(raw) = std::fs::read_to_string(root.join("flint.json")) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(prefix) = val.get("repath_prefix").and_then(|v| v.as_str()) {
                if let Some((c, p)) = prefix.split_once('/') {
                    creator = c.to_string();
                    project = p.to_string();
                }
            }
            if let Some(src) = val.get("source") {
                if let Some(c) = src.get("champion").and_then(|v| v.as_str()) {
                    champion = c.to_ascii_lowercase();
                }
                if let Some(id) = src.get("skin_id").and_then(|v| v.as_u64()) {
                    target_skin_id = id as u32;
                }
            }
        }
    }

    if (creator.is_empty() || project.is_empty())
        && std::fs::read_to_string(root.join("mod.config.json")).is_ok()
    {
        if let Ok(raw) = std::fs::read_to_string(root.join("mod.config.json")) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                if project.is_empty() {
                    if let Some(n) = val.get("name").and_then(|v| v.as_str()) {
                        project = n.to_string();
                    }
                }
                if creator.is_empty() {
                    if let Some(a) = val
                        .get("authors")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|v| v.as_str())
                    {
                        creator = a.to_string();
                    }
                }
            }
        }
    }

    if creator.is_empty() || project.is_empty() || champion.is_empty() {
        return None;
    }

    Some(RepathConfig {
        creator_name: creator,
        project_name: project,
        champion,
        target_skin_id,
        cleanup_unused: false,
        skip_bin_cleanup: true,
        sub_characters: Vec::new(),
        repath_sfx: true,
        repath_vo: false,
    })
}

fn build_query(
    raw: &str,
    champion: Option<&str>,
    local_names: &HashMap<u64, String>,
    overlay: Option<&ProjectHashOverlay>,
    resolver: &HashResolver,
) -> Option<MissingQuery> {
    if let Some(hash) = parse_hex_u64(raw) {
        let unhashed = local_names
            .get(&hash)
            .cloned()
            .or_else(|| overlay.and_then(|o| o.wad_get(hash).map(str::to_string)))
            .or_else(|| {
                get_cached_bin_hashes()
                    .read()
                    .get(hash)
                    .map(str::to_string)
                    .filter(|s| s.contains('/'))
            })
            .or_else(|| {
                resolver
                    .resolve_wad(&[hash])
                    .into_iter()
                    .next()
                    .filter(|s| s.contains('/'))
            });

        if let Some(path) = unhashed {
            let mut q = build_path_query(raw, &path, champion)?;
            q.dest_path = Some(path.replace('\\', "/").trim_start_matches('/').to_string());
            return Some(q);
        }

        return Some(MissingQuery {
            original: raw.to_string(),
            dest_path: None,
            norm: String::new(),
            exact_hash: hash,
            candidate_hashes: Vec::new(),
            tails: Vec::new(),
            filename: String::new(),
            wants_vo: false,
        });
    }

    let mut q = build_path_query(raw, raw, champion)?;
    q.dest_path = Some(raw.replace('\\', "/").trim_start_matches('/').to_string());
    Some(q)
}

fn build_path_query(original: &str, path: &str, champion: Option<&str>) -> Option<MissingQuery> {
    let norm = path.replace('\\', "/").trim_start_matches('/').to_ascii_lowercase();
    if norm.is_empty() {
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
    for cand in candidate_paths {
        let h = wad_chunk_hash(&cand);
        if seen.insert(h) {
            candidate_hashes.push(h);
        }
    }

    let wants_vo = norm.contains("/vo/") || norm.contains("/audio/vo/");

    Some(MissingQuery {
        original: original.to_string(),
        dest_path: Some(path.replace('\\', "/").trim_start_matches('/').to_string()),
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
    overlay: Option<Arc<ProjectHashOverlay>>,
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
    tracing::info!(
        "[live_pull] Searching {} live WADs under {} for {} missing item(s) (folder={}, primary={})",
        wads.len(),
        final_dir.display(),
        missing_paths.len(),
        folder_name,
        wads.iter().any(|(_, _, p)| *p)
    );
    if wads.is_empty() {
        return Err(format!("No WAD files found under {}", final_dir.display()));
    }

    let hash_dir = flint_core::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let resolver = HashResolver::global(&hash_dir);
    let local_names = load_local_hash_names(folder);
    let repath_config = load_project_repath_config(folder, champion.as_deref());
    if let Some(ref cfg) = repath_config {
        tracing::info!(
            "[live_pull] Loaded repath config: prefix={} champion={} skin_id={}",
            cfg.prefix(),
            cfg.champion,
            cfg.target_skin_id
        );
    }

    let mut queries = Vec::new();
    let mut unmatched_raw = Vec::new();
    for raw in missing_paths {
        if let Some(q) = build_query(
            &raw,
            champion.as_deref(),
            &local_names,
            overlay.as_deref(),
            &resolver,
        ) {
            tracing::info!(
                "[live_pull] Query raw='{}' -> dest={:?} exact_hash={:016x} tails={:?} candidates={}",
                q.original,
                q.dest_path,
                q.exact_hash,
                q.tails,
                q.candidate_hashes.len()
            );
            queries.push(q);
        } else {
            tracing::warn!("[live_pull] Skipped invalid query: '{}'", raw);
            unmatched_raw.push(raw);
        }
    }

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
                let dest_path = q
                    .dest_path
                    .clone()
                    .or_else(|| resolved.contains('/').then(|| resolved.clone()));
                if let Some(dest_path) = dest_path {
                    best_matches.insert(
                        idx,
                        (
                            u32::MAX,
                            LiveAssetMatch {
                                missing_path: q.original.clone(),
                                dest_path,
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
                    if let Some(dest_path) = q.dest_path.clone() {
                        best_matches.insert(
                            idx,
                            (
                                score,
                                LiveAssetMatch {
                                    missing_path: q.original.clone(),
                                    dest_path,
                                    wad_path: wad_path_str.clone(),
                                    wad_name: wad_name.clone(),
                                    chunk_hash: format!("{:016x}", cand_hash),
                                    live_path: resolved,
                                    exact: false,
                                },
                            ),
                        );
                    }
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
                    if q.dest_path.is_none() {
                        if let Some(ref cfg) = repath_config {
                            if let Some(repathed) = repath_asset_path(live_path, cfg) {
                                let repathed_norm =
                                    repathed.replace('\\', "/").trim_start_matches('/').to_string();
                                if wad_chunk_hash(&repathed_norm.to_ascii_lowercase()) == q.exact_hash
                                {
                                    best_matches.insert(
                                        idx,
                                        (
                                            u32::MAX,
                                            LiveAssetMatch {
                                                missing_path: q.original.clone(),
                                                dest_path: repathed_norm,
                                                wad_path: wad_path_str.clone(),
                                                wad_name: wad_name.clone(),
                                                chunk_hash: format!("{:016x}", chunk.path_hash),
                                                live_path: live_path.clone(),
                                                exact: true,
                                            },
                                        ),
                                    );
                                    continue;
                                }
                            }
                        }
                        continue;
                    }
                    if let Some(score) =
                        score_resolved_match(q, &live_lower, champion.as_deref(), *is_primary)
                    {
                        let replace = best_matches
                            .get(&idx)
                            .is_none_or(|(best, _)| score > *best);
                        if replace {
                            if let Some(dest_path) = q.dest_path.clone() {
                                best_matches.insert(
                                    idx,
                                    (
                                        score,
                                        LiveAssetMatch {
                                            missing_path: q.original.clone(),
                                            dest_path,
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
            tracing::info!(
                "[live_pull] Matched '{}' -> '{}' in {} (chunk={}, live='{}', exact={})",
                m.missing_path,
                m.dest_path,
                m.wad_name,
                m.chunk_hash,
                m.live_path,
                m.exact
            );
            matches.push(m);
        } else {
            tracing::warn!(
                "[live_pull] Unmatched '{}' (dest={:?}, exact_hash={:016x})",
                q.original,
                q.dest_path,
                q.exact_hash
            );
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
    overlay_state: State<'_, HashOverlayState>,
) -> Result<FindLiveAssetsResult, String> {
    let cache = wad_cache_state.get();
    let overlay = overlay_state.get();
    tokio::task::spawn_blocking(move || {
        find_live_assets_blocking(&folder_path, missing_paths, cache, overlay)
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
        let q = build_path_query(
            "assets/sirdexal/ahri-mod/particles/ahri_q_mis.tex",
            "assets/sirdexal/ahri-mod/particles/ahri_q_mis.tex",
            Some("ahri"),
        )
        .unwrap();
        let expected = wad_chunk_hash("assets/characters/ahri/skins/base/particles/ahri_q_mis.tex");
        assert!(q.candidate_hashes.contains(&expected));
    }

    #[test]
    fn unhashes_hex_from_files_txt() {
        let mut local = HashMap::new();
        parse_hash_list_into(
            "d29c3cd1df8e6543 assets/sirdexal/talon-mod/particles/talon_w.tex\n",
            &mut local,
        );
        let resolver = HashResolver::global("");
        let q = build_query("0xd29c3cd1df8e6543", Some("talon"), &local, None, &resolver).unwrap();
        assert_eq!(
            q.dest_path.as_deref(),
            Some("assets/sirdexal/talon-mod/particles/talon_w.tex")
        );
        assert!(q.tails.contains(&"particles/talon_w.tex".to_string()));
    }

    #[test]
    fn score_prefers_tail_and_primary_wad() {
        let q = build_path_query(
            "assets/sirdexal/ahri-mod/particles/ahri_q_mis.tex",
            "assets/sirdexal/ahri-mod/particles/ahri_q_mis.tex",
            Some("ahri"),
        )
        .unwrap();
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
