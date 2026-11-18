use crate::commands::bin::search::{build_regex, search_in_text, SearchMatch, SearchOptions};
use flint_core::overlay::HashResolver;
use flint_core::wad::adapter::WadHandle;
use flint_core::wad::format::WadChunk;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use tauri::Emitter;

fn searches() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static SEARCHES: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    SEARCHES.get_or_init(Default::default)
}

#[tauri::command]
pub fn begin_wad_grep() -> String {
    let id = uuid::Uuid::new_v4().to_string();
    searches()
        .lock()
        .unwrap()
        .insert(id.clone(), Arc::new(AtomicBool::new(false)));
    id
}

#[tauri::command]
pub fn cancel_wad_grep(id: String) {
    if let Some(cancel) = searches().lock().unwrap().remove(&id) {
        cancel.store(true, Ordering::Relaxed);
    }
}

#[derive(Serialize)]
pub struct WadGrepFile {
    pub wad_path: String,
    pub path: String,
    pub hash: String,
    pub matches: Vec<SearchMatch>,
    pub extra: usize,
}

#[derive(Default, Serialize)]
pub struct WadGrepResult {
    pub files: Vec<WadGrepFile>,
    pub scanned: usize,
    pub failed: usize,
    pub unresolved: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

#[derive(Clone, Serialize)]
struct Progress<'a> {
    id: &'a str,
    completed: usize,
    total: usize,
    scanned: usize,
}

fn reference_pattern(path: &str) -> String {
    let path = path.replace('\\', "/").to_lowercase();
    if path.strip_prefix("0x").is_some_and(|hash| {
        matches!(hash.len(), 8 | 16) && hash.chars().all(|ch| ch.is_ascii_hexdigit())
    }) {
        return regex::escape(&path);
    }
    let filename = path.rsplit('/').next().unwrap_or(&path);
    let stem = filename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(filename);
    let mut terms = vec![
        path.clone(),
        filename.to_string(),
        stem.to_string(),
        format!("0x{:08x}", ritoshark::hash::fnv1a(&path)),
        format!("0x{:016x}", xxhash_rust::xxh64::xxh64(path.as_bytes(), 0)),
    ];
    terms.retain(|term| !term.is_empty());
    terms.sort_by_key(|term| std::cmp::Reverse(term.len()));
    terms.dedup();
    terms
        .iter()
        .map(|term| regex::escape(term))
        .collect::<Vec<_>>()
        .join("|")
}

fn file_kind(path: &str) -> Option<&'static str> {
    match path.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "bin" => Some("bin"),
        "troybin" => Some("troybin"),
        "luabin" | "luabin64" => Some("luabin"),
        _ => None,
    }
}

fn decode(bytes: &[u8], kind: &str) -> Result<String, String> {
    match kind {
        "bin" => {
            if !matches!(bytes.get(..4), Some(b"PROP" | b"PTCH")) {
                return Ok(String::new());
            }
            let tree = flint_core::bin::read_bin(bytes).map_err(|e| e.to_string())?;
            flint_core::bin::tree_to_text_cached(&tree).map_err(|e| e.to_string())
        }
        "troybin" => flint_core::troybin::convert_troybin(bytes),
        "luabin" => flint_core::luabin::convert_luabin(bytes),
        _ => Err("Unsupported search format".into()),
    }
}

type ChunkMatches = Result<(Vec<SearchMatch>, usize), String>;

fn scan_batch<'a>(
    pool: &rayon::ThreadPool,
    path: &std::path::Path,
    batch: &[(WadChunk, &'a str, &'static str)],
    pattern: &regex::Regex,
    whole_word: bool,
    cancel: &AtomicBool,
) -> Vec<(u64, &'a str, ChunkMatches)> {
    pool.install(|| {
        batch
            .par_iter()
            .filter_map(|(chunk, name, kind)| {
                if cancel.load(Ordering::Relaxed) {
                    return None;
                }
                let matches = flint_core::wad::chunk_io::read_chunk_decompressed_bytes(path, chunk)
                    .map_err(|e| e.to_string())
                    .and_then(|bytes| decode(&bytes, kind))
                    .map(|text| search_in_text(&text, pattern, whole_word));
                Some((chunk.path_hash, *name, matches))
            })
            .collect()
    })
}

#[tauri::command]
pub async fn grep_game_wads(
    app: tauri::AppHandle,
    id: String,
    wad_paths: Vec<String>,
    query: String,
    options: SearchOptions,
    file_types: Vec<String>,
    references: bool,
) -> Result<WadGrepResult, String> {
    let cancel = searches()
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("Search cancelled")?;
    let task_id = id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        if query.trim().is_empty() {
            return Err("Enter a search query".into());
        }
        if file_types.is_empty() {
            return Err("Select at least one file type".into());
        }
        let pattern = if references {
            build_regex(
                &reference_pattern(&query),
                &SearchOptions {
                    case_sensitive: false,
                    whole_word: false,
                    regex: true,
                },
            )?
        } else {
            build_regex(&query, &options)?
        };
        let hash_dir = flint_core::hash::get_hash_dir().map_err(|e| e.to_string())?;
        let resolver = HashResolver::global(&hash_dir.to_string_lossy());
        if !resolver.has_global_wad() {
            return Err("Download WAD hashes in Settings before searching game data".into());
        }
        let mut result = WadGrepResult::default();
        let mut seen = HashSet::new();
        let paths: Vec<_> = wad_paths
            .into_iter()
            .filter(|p| seen.insert(p.replace('\\', "/").to_lowercase()))
            .collect();
        let workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            .min(4);
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(workers)
            .build()
            .map_err(|e| e.to_string())?;
        let mut total_matches = 0;
        'wads: for (index, path) in paths.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                result.cancelled = true;
                break;
            }
            let _ = app.emit(
                "wad-grep-progress",
                Progress {
                    id: &task_id,
                    completed: index,
                    total: paths.len(),
                    scanned: result.scanned,
                },
            );
            let reader = match WadHandle::open(path) {
                Ok(reader) => reader,
                Err(e) => {
                    tracing::warn!("WAD search {}: {}", path, e);
                    result.failed += 1;
                    continue;
                }
            };
            let chunks: Vec<_> = reader.chunks().iter().copied().collect();
            let hashes: Vec<_> = chunks.iter().map(|c| c.path_hash).collect();
            let resolved = resolver.resolve_wad_bulk(&hashes);
            let mut candidates = Vec::new();
            for chunk in chunks {
                let Some(name) = resolved.get(&chunk.path_hash) else {
                    result.unresolved += 1;
                    continue;
                };
                if let Some(kind) = file_kind(name) {
                    if file_types.iter().any(|selected| selected == kind) {
                        candidates.push((chunk, name, kind));
                    }
                }
            }
            for batch in candidates.chunks(32) {
                if cancel.load(Ordering::Relaxed) {
                    result.cancelled = true;
                    break 'wads;
                }
                let outcomes = scan_batch(
                    &pool,
                    std::path::Path::new(path),
                    batch,
                    &pattern,
                    !references && options.whole_word,
                    &cancel,
                );
                for (hash, name, outcome) in outcomes {
                    result.scanned += 1;
                    let (mut matches, mut extra) = match outcome {
                        Ok(matches) => matches,
                        Err(e) => {
                            tracing::warn!("WAD search {} / {}: {}", path, name, e);
                            result.failed += 1;
                            continue;
                        }
                    };
                    if matches.is_empty() {
                        continue;
                    }
                    let remaining = 5_000usize.saturating_sub(total_matches);
                    if matches.len() > remaining {
                        extra += matches.len() - remaining;
                        matches.truncate(remaining);
                    }
                    total_matches += matches.len();
                    result.files.push(WadGrepFile {
                        wad_path: path.clone(),
                        path: name.to_string(),
                        hash: format!("{:016x}", hash),
                        matches,
                        extra,
                    });
                    if total_matches >= 5_000 {
                        result.truncated = true;
                        break 'wads;
                    }
                }
                let _ = app.emit(
                    "wad-grep-progress",
                    Progress {
                        id: &task_id,
                        completed: index,
                        total: paths.len(),
                        scanned: result.scanned,
                    },
                );
            }
            if cancel.load(Ordering::Relaxed) {
                result.cancelled = true;
                break;
            }
            let _ = app.emit(
                "wad-grep-progress",
                Progress {
                    id: &task_id,
                    completed: index + 1,
                    total: paths.len(),
                    scanned: result.scanned,
                },
            );
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string());
    searches().lock().unwrap().remove(&id);
    outcome?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parallel_batches_keep_order_isolate_errors_and_honor_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chunks.bin");
        let bytes = flint_core::bin::write_bin(&ritoshark::bin::Bin::new()).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let chunk = WadChunk {
            path_hash: 0,
            data_offset: 0,
            compressed_size: bytes.len() as u64,
            uncompressed_size: bytes.len() as u64,
            compression: flint_core::wad::format::WadCompression::None,
        };
        let batch: Vec<_> = (0..32)
            .map(|index| {
                (
                    WadChunk {
                        path_hash: index,
                        data_offset: if index == 15 { bytes.len() as u64 } else { 0 },
                        ..chunk
                    },
                    "test.bin",
                    "bin",
                )
            })
            .collect();
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .build()
            .unwrap();
        let pattern = regex::Regex::new("PROP").unwrap();
        let cancelled = AtomicBool::new(false);
        let outcomes = scan_batch(&pool, &path, &batch, &pattern, false, &cancelled);
        assert_eq!(
            outcomes
                .iter()
                .map(|(hash, _, _)| *hash)
                .collect::<Vec<_>>(),
            (0..32).collect::<Vec<_>>()
        );
        assert!(outcomes[15].2.is_err());
        assert!(outcomes[0]
            .2
            .as_ref()
            .unwrap()
            .0
            .iter()
            .any(|hit| hit.line == 1));
        assert!(outcomes[31]
            .2
            .as_ref()
            .unwrap()
            .0
            .iter()
            .any(|hit| hit.line == 1));
        cancelled.store(true, Ordering::Relaxed);
        assert!(scan_batch(&pool, &path, &batch, &pattern, false, &cancelled).is_empty());
    }

    #[test]
    fn reference_search_matches_paths_names_and_both_hash_widths_literally() {
        let path = "ASSETS/Characters/Ahri/Foo.Bar.tex";
        let pattern = build_regex(
            &reference_pattern(path),
            &SearchOptions {
                case_sensitive: false,
                whole_word: false,
                regex: true,
            },
        )
        .unwrap();
        assert!(pattern.is_match(path));
        assert!(pattern.is_match("foo.bar"));
        assert!(!pattern.is_match("fooXbar"));
        let lower = path.to_lowercase();
        assert!(pattern.is_match(&format!("0x{:08x}", ritoshark::hash::fnv1a(&lower))));
        assert!(pattern.is_match(&format!(
            "0x{:016x}",
            xxhash_rust::xxh64::xxh64(lower.as_bytes(), 0)
        )));
    }

    #[test]
    fn includes_both_lua_formats_and_excludes_other_extensions() {
        assert_eq!(file_kind("x.LUABIN64"), Some("luabin"));
        assert_eq!(file_kind("x.luabin"), Some("luabin"));
        assert_eq!(file_kind("x.troybin"), Some("troybin"));
        assert_eq!(file_kind("x.bin.bak"), None);
    }

    #[test]
    fn cancellation_survives_command_startup_races() {
        let id = begin_wad_grep();
        let signal = searches().lock().unwrap().get(&id).unwrap().clone();
        cancel_wad_grep(id.clone());
        assert!(signal.load(Ordering::Relaxed));
        assert!(!searches().lock().unwrap().contains_key(&id));
    }
}
