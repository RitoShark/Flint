use crate::error::{Error, Result};
use crate::hash::ResolvedHashes;
use ritoshark::bin::BinValue;
use league_toolkit::file::LeagueFileKind;
use league_toolkit::wad::{Wad, WadChunk};
use memmap2::Mmap;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// One entry in the extraction plan: the chunk to extract, the output path,
/// and an optional (relative-path, absolute-path) mapping recorded when a
/// long filename had to be saved under its hash.
type ExtractPlanEntry = (WadChunk, PathBuf, Option<(String, String)>);

/// Result of an extraction operation
#[derive(Debug, Clone)]
pub struct ExtractionResult {
    /// Number of chunks successfully extracted
    pub extracted_count: usize,
    /// Mapping of original paths to actual paths (for long filenames saved with hashes)
    pub path_mappings: HashMap<String, String>,
}

/// Parallel extraction of arbitrary chunks from a WAD archive.
///
/// Used by the WAD-explorer "extract selected" / "extract all" buttons.
/// Mirrors the `extract_skin_assets` pattern: mmap the WAD once, mount a
/// per-rayon-worker `Wad` cursor over the shared mmap, then decompress +
/// write in parallel. The previous implementation walked chunks serially on
/// the IPC thread, so multi-select extracts (a few hundred chunks) blocked
/// the runtime for several seconds.
///
/// `chunk_hashes = None` extracts every chunk in the WAD. Otherwise only
/// chunks whose path-hash appears in the input set are extracted.
///
/// `resolve_paths` is the same bulk-LMDB resolver used elsewhere — one read
/// txn per call, not N.
pub fn extract_chunks_parallel(
    wad_path: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    chunk_hashes: Option<&HashSet<u64>>,
    resolve_paths: impl Fn(&[u64]) -> ResolvedHashes,
) -> Result<(usize, usize, HashMap<String, String>)> {
    let wad_path = wad_path.as_ref();
    let output_dir = output_dir.as_ref();

    // mmap + parse TOC.
    let file = File::open(wad_path).map_err(|e| Error::io_with_path(e, wad_path))?;
    let mmap = unsafe { Mmap::map(&file) }.map_err(|e| Error::Wad {
        message: format!("Failed to mmap WAD: {}", e),
        path: Some(wad_path.to_path_buf()),
    })?;
    let toc = Wad::mount(Cursor::new(&mmap[..])).map_err(|e| Error::Wad {
        message: format!("Failed to mount WAD: {}", e),
        path: Some(wad_path.to_path_buf()),
    })?;

    // Filter the TOC to the requested chunks.
    let target_chunks: Vec<WadChunk> = match chunk_hashes {
        Some(want) => toc
            .chunks()
            .iter()
            .filter(|c| want.contains(&c.path_hash()))
            .copied()
            .collect(),
        None => toc.chunks().iter().copied().collect(),
    };
    let total = target_chunks.len();
    if total == 0 {
        return Ok((0, 0, HashMap::new()));
    }

    // Bulk-resolve every hash in one LMDB txn.
    let all_hashes: Vec<u64> = target_chunks.iter().map(|c| c.path_hash()).collect();
    let resolved_map = resolve_paths(&all_hashes);

    // Build extraction plan in parallel. Reads `resolved_map` via shared `&`
    // so we don't `String::clone` per chunk (was ~80k clones for a full
    // champion WAD). Parents are gathered through a per-thread `HashSet`
    // that we union at the end.
    let plan: Vec<ExtractPlanEntry> = target_chunks
        .par_iter()
        .map(|chunk| {
            let path_hash = chunk.path_hash();
            let fallback;
            let resolved: &str = match resolved_map.get(&path_hash) {
                Some(s) => s,
                None => {
                    fallback = format!("{:016x}", path_hash);
                    fallback.as_str()
                }
            };
            let candidate = output_dir.join(resolved);
            let mut mapping = None;

            // Windows MAX_PATH safety net.
            let out_path = if candidate.to_string_lossy().len() > 240 {
                let ext = Path::new(resolved)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("bin");
                let hash_name = format!("{:016x}.{}", path_hash, ext);
                let fallback_path = output_dir.join(&hash_name);
                
                let orig = resolved.to_lowercase().replace('\\', "/");
                let act = hash_name.to_lowercase().replace('\\', "/");
                mapping = Some((orig, act));
                
                fallback_path
            } else {
                candidate
            };
            (*chunk, out_path, mapping)
        })
        .collect();

    let mut path_mappings = HashMap::new();
    for (_, _, mapping) in &plan {
        if let Some((k, v)) = mapping {
            path_mappings.insert(k.clone(), v.clone());
        }
    }

    // Collect unique parents in parallel via fold + reduce, then create them
    // concurrently. With ~5000 unique folders on a champion WAD, the serial
    // `create_dir_all` loop was costing seconds before the writes could even
    // start — Windows directory-create syscalls aren't free.
    let parents: HashSet<PathBuf> = plan
        .par_iter()
        .fold(HashSet::new, |mut acc, (_, out_path, _)| {
            if let Some(p) = out_path.parent() {
                acc.insert(p.to_path_buf());
            }
            acc
        })
        .reduce(HashSet::new, |mut a, b| {
            a.extend(b);
            a
        });

    parents.par_iter().for_each(|parent| {
        let _ = fs::create_dir_all(parent);
    });

    // Parallel decompress + write. Each worker mounts its own Wad cursor over
    // the shared mmap — no contention on the underlying file handle.
    let mmap_ref = &mmap;
    let chunk_size = (plan.len() / rayon::current_num_threads().max(1)).max(1);
    let results: Vec<(usize, usize)> = plan
        .par_chunks(chunk_size)
        .map(|slice| {
            let mut local_wad = match Wad::mount(Cursor::new(&mmap_ref[..])) {
                Ok(w) => w,
                Err(_) => return (0, slice.len()),
            };
            let mut extracted = 0usize;
            let mut failed = 0usize;
            for (chunk, out_path, _) in slice {
                match local_wad.load_chunk_decompressed(chunk) {
                    Ok(data) => {
                        // Path-already-has-extension fast path: skip the
                        // resolve_chunk_path syscall + create_dir_all dance.
                        let write_path = if out_path.extension().is_some() {
                            out_path.clone()
                        } else {
                            let final_path = resolve_chunk_path(&out_path.to_string_lossy(), &data);
                            let actual = output_dir.join(&final_path);
                            if let Some(p) = actual.parent() {
                                let _ = fs::create_dir_all(p);
                            }
                            actual
                        };
                        if fs::write(&write_path, &data).is_ok() {
                            extracted += 1;
                        } else {
                            failed += 1;
                        }
                    }
                    Err(_) => failed += 1,
                }
            }
            (extracted, failed)
        })
        .collect();

    let (extracted_count, failed_count) = results
        .into_iter()
        .fold((0usize, 0usize), |(e, f), (re, rf)| (e + re, f + rf));

    Ok((extracted_count, failed_count, path_mappings))
}

fn write_hashed_names_file(output_dir: &Path, mappings: &HashMap<String, String>) {
    if mappings.is_empty() {
        return;
    }
    let map_file = output_dir.join("_flint_hashed_names.json");
    if let Ok(json) = serde_json::to_string_pretty(mappings) {
        let _ = fs::write(map_file, json);
    }
}

/// Check whether a champion WAD contains the main skin BIN for the given skin ID.
///
/// Riot stores the skin definition at `data/characters/{champion_lower}/skins/skin{ID}.bin`
/// (or zero-padded `skin{ID:02}.bin`). If neither chunk hash exists in the WAD's TOC,
/// the local install does not ship this skin — typically because a PBE client is behind
/// the patch that introduced it. This is fast: only the WAD TOC is read.
pub fn wad_contains_skin_bin(
    wad_path: impl AsRef<Path>,
    champion: &str,
    skin_id: u32,
) -> Result<bool> {
    let wad_path = wad_path.as_ref();
    let champion_lower = champion.to_lowercase();

    let candidate_paths = [
        format!("data/characters/{}/skins/skin{}.bin", champion_lower, skin_id),
        format!("data/characters/{}/skins/skin{:02}.bin", champion_lower, skin_id),
    ];
    let candidate_hashes: Vec<u64> = candidate_paths
        .iter()
        .map(|p| xxhash_rust::xxh64::xxh64(p.as_bytes(), 0))
        .collect();

    let file = File::open(wad_path)
        .map_err(|e| Error::io_with_path(e, wad_path))?;
    let mmap = unsafe { Mmap::map(&file) }
        .map_err(|e| Error::Wad {
            message: format!("Failed to mmap WAD: {}", e),
            path: Some(wad_path.to_path_buf()),
        })?;
    let wad = Wad::mount(Cursor::new(&mmap[..]))
        .map_err(|e| Error::Wad {
            message: format!("Failed to mount WAD: {}", e),
            path: Some(wad_path.to_path_buf()),
        })?;

    for chunk in wad.chunks().iter() {
        let h = chunk.path_hash();
        if candidate_hashes.contains(&h) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Find the champion WAD file in a League installation
/// 
/// # Arguments
/// * `league_path` - Path to League installation
/// * `champion` - Champion internal name (e.g., "Kayn", "Aatrox")
/// 
/// # Returns
/// * `Option<PathBuf>` - Path to the WAD file if found
pub fn find_champion_wad(league_path: impl AsRef<Path>, champion: &str) -> Option<PathBuf> {
    let league_path = league_path.as_ref();
    
    // Normalize champion name: lowercase, remove special characters
    let champion_normalized = champion
        .to_lowercase()
        .replace("'", "")
        .replace(" ", "")
        .replace(".", "");
    
    // Standard WAD path
    let wad_path = league_path
        .join("Game")
        .join("DATA")
        .join("FINAL")
        .join("Champions")
        .join(format!("{}.wad.client", champion_normalized));
    
    if wad_path.exists() {
        tracing::info!("Found champion WAD: {}", wad_path.display());
        Some(wad_path)
    } else {
        tracing::warn!("Champion WAD not found: {}", wad_path.display());
        None
    }
}

/// Extract skin-specific assets from a WAD archive
/// 
/// This function extracts ALL files from the WAD. Cleanup of unused files
/// happens later during the repathing phase based on what the skin BIN references.
/// 
/// # Arguments
/// * `wad` - Mutable reference to the Wad for decoding
/// * `output_dir` - Base directory where chunks should be extracted
/// * `champion` - Champion internal name (e.g., "kayn")
/// * `skin_id` - Skin ID to extract (e.g., 1 for first skin)
/// * `hashtable` - Hashtable for path resolution
///
/// # Returns
/// * `Result<ExtractionResult>` - Extraction result with count and path mappings, or an error
///
/// ─────────────────────────────────────────────────────────────────────────
///
/// **Selective extraction (`extract_skin_assets_selective`)** is the same flow
/// scoped down to only the chunks the seed BIN's reference graph actually
/// touches — typically ~400 of the 3700+ chunks in a champion WAD. The old
/// path extracted everything under `assets/` or `data/` then deleted ~85% of
/// it during repath; on a Defender-watched filesystem that was 12-13 s of
/// avoidable I/O.
pub fn extract_skin_assets(
    wad_path: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    champion: &str,
    _skin_id: u32,
    resolve_paths: impl Fn(&[u64]) -> ResolvedHashes,
    is_tft: bool,
) -> Result<ExtractionResult> {
    let wad_path   = wad_path.as_ref();
    let output_dir = output_dir.as_ref();

    let champion_lower   = champion.to_lowercase();
    let wad_folder_name  = if is_tft {
        "Companions.wad.client".to_string()
    } else {
        format!("{}.wad.client", champion_lower)
    };
    let wad_output_dir   = output_dir.join(&wad_folder_name);

    tracing::info!(
        "Extracting assets to: {} (WAD folder: {})",
        output_dir.display(), wad_folder_name
    );

    // ── Open + mmap the WAD for parallel access ────────────────────────────
    let file = File::open(wad_path)
        .map_err(|e| Error::io_with_path(e, wad_path))?;
    let mmap = unsafe { Mmap::map(&file) }
        .map_err(|e| Error::Wad {
            message: format!("Failed to mmap WAD: {}", e),
            path: Some(wad_path.to_path_buf()),
        })?;

    // Parse the TOC from the mmap'd data
    let wad_toc = Wad::mount(Cursor::new(&mmap[..]))
        .map_err(|e| Error::Wad {
            message: format!("Failed to mount WAD: {}", e),
            path: Some(wad_path.to_path_buf()),
        })?;

    let chunks: Vec<WadChunk> = wad_toc.chunks().iter().copied().collect();
    let total_chunks = chunks.len();
    tracing::info!("Total chunks in WAD: {}", total_chunks);

    // ── Phase 1: bulk-resolve hashes, filter, plan dirs (sequential) ──────
    // Resolve ALL hashes in one LMDB read txn — single call instead of N per-chunk calls.
    let all_hashes: Vec<u64> = chunks.iter().map(|c| c.path_hash()).collect();
    let resolved_map = resolve_paths(&all_hashes);

    let mut extraction_plan: Vec<(WadChunk, PathBuf)> = Vec::with_capacity(total_chunks / 2);
    let mut path_mappings:   HashMap<String, String>  = HashMap::new();
    let mut parents:         HashSet<PathBuf>          = HashSet::new();
    let mut skipped_unknown = 0usize;

    for chunk in &chunks {
        let path_hash    = chunk.path_hash();
        let resolved     = resolved_map.get(&path_hash)
            .map(String::from)
            .unwrap_or_else(|| format!("{:016x}", path_hash));
        let path_lower   = resolved.to_lowercase();
        let is_unresolved = resolved.chars().all(|c| c.is_ascii_hexdigit());

        if !path_lower.starts_with("assets/") && !path_lower.starts_with("data/") {
            if is_unresolved { skipped_unknown += 1; }
            continue;
        }

        // Detect if filename is suspiciously long (will be resolved with actual data later,
        // but we need a placeholder path for directory creation)
        let final_path = PathBuf::from(&resolved);
        let filename_len = final_path.to_string_lossy().len();

        let out_path = if filename_len > 200 {
            let parent = final_path.parent().unwrap_or_else(|| Path::new("data"));
            let ext    = final_path.extension().and_then(|e| e.to_str()).unwrap_or("bin");
            let hash_name = format!("{:016x}.{}", path_hash, ext);
            let hash_path = parent.join(&hash_name);

            let orig = final_path.to_string_lossy().to_lowercase().replace('\\', "/");
            let act  = hash_path.to_string_lossy().to_lowercase().replace('\\', "/");
            path_mappings.insert(orig, act);

            wad_output_dir.join(hash_path)
        } else {
            wad_output_dir.join(&final_path)
        };

        if let Some(p) = out_path.parent() { parents.insert(p.to_path_buf()); }
        extraction_plan.push((*chunk, out_path));
    }

    if skipped_unknown > 0 {
        tracing::warn!("Skipped {} unresolved hashes (not in hash DB)", skipped_unknown);
    }

    // Batch-create all parent directories before launching rayon workers
    for parent in parents { let _ = fs::create_dir_all(parent); }

    tracing::info!(
        "Extraction plan: {} files, {} path mappings — launching parallel workers",
        extraction_plan.len(), path_mappings.len()
    );

    // ── Phase 2: parallel decompress + write (rayon + mmap) ───────────────
    // Each rayon worker mounts its own Wad cursor over the shared mmap.
    // Mmap is Send + Sync; each cursor is thread-local — zero contention.
    let mmap_ref = &mmap;
    let chunk_size = (extraction_plan.len() / rayon::current_num_threads().max(1)).max(1);

    // Per-thread sub-timings let us see whether the dominant cost is
    // decompression (CPU/zstd) vs disk write (I/O/AV). Sums across threads
    // are a "total work" view, not wall time — wall time is `phase_start`.
    let phase_start = Instant::now();
    let thread_results: Vec<(usize, usize, Duration, Duration, Duration)> = extraction_plan
        .par_chunks(chunk_size)
        .map(|slice| {
            let mut extracted = 0usize;
            let mut skipped   = 0usize;
            let mut t_decompress = Duration::ZERO;
            let mut t_path_resolve = Duration::ZERO;
            let mut t_write = Duration::ZERO;
            let mut local_wad = match Wad::mount(Cursor::new(&mmap_ref[..])) {
                Ok(w)  => w,
                Err(_) => return (0, slice.len(), Duration::ZERO, Duration::ZERO, Duration::ZERO),
            };
            // Per-thread cache so we only `create_dir_all` once per parent
            // even when the extension-correction path goes there many times.
            let mut dirs_seen: HashSet<PathBuf> = HashSet::new();
            for (chunk, out_path) in slice {
                let t0 = Instant::now();
                let decompressed = local_wad.load_chunk_decompressed(chunk);
                t_decompress += t0.elapsed();
                match decompressed {
                    Err(_) => { skipped += 1; },
                    Ok(data) => {
                        let t1 = Instant::now();
                        // Hot-path fast skip: if the planned output path already
                        // has an extension (true for >99% of resolved chunks),
                        // there's no extension correction work to do — just
                        // write to `out_path`. Saves resolve_chunk_path + an
                        // exists() syscall + a create_dir_all per chunk.
                        let needs_resolve = out_path.extension().is_none();
                        let write_path = if needs_resolve {
                            let final_path = resolve_chunk_path(&out_path.to_string_lossy(), &data);
                            let actual_path = output_dir.join(&wad_folder_name).join(&final_path);
                            if actual_path == *out_path {
                                out_path.clone()
                            } else {
                                if let Some(p) = actual_path.parent() {
                                    if dirs_seen.insert(p.to_path_buf()) {
                                        let _ = fs::create_dir_all(p);
                                    }
                                }
                                actual_path
                            }
                        } else {
                            out_path.clone()
                        };
                        t_path_resolve += t1.elapsed();

                        let t2 = Instant::now();
                        let wrote = fs::write(&write_path, &data).is_ok();
                        t_write += t2.elapsed();
                        if wrote { extracted += 1; } else { skipped += 1; }
                    }
                }
            }
            (extracted, skipped, t_decompress, t_path_resolve, t_write)
        })
        .collect();
    let phase_elapsed = phase_start.elapsed();

    let (extracted_count, skipped_count) = thread_results
        .iter()
        .fold((0usize, 0usize), |(e, s), (te, ts, _, _, _)| (e + te, s + ts));
    let sum_decompress: Duration = thread_results.iter().map(|r| r.2).sum();
    let sum_path: Duration = thread_results.iter().map(|r| r.3).sum();
    let sum_write: Duration = thread_results.iter().map(|r| r.4).sum();
    let n_threads = thread_results.len().max(1);
    tracing::info!(
        "[TIMING] extract phase 2 wall {:?} | per-thread avg \
         decompress {:?} path_resolve {:?} write {:?} (across {} threads, sum: dec {:?}, path {:?}, write {:?})",
        phase_elapsed,
        sum_decompress / n_threads as u32,
        sum_path / n_threads as u32,
        sum_write / n_threads as u32,
        n_threads,
        sum_decompress,
        sum_path,
        sum_write,
    );

    tracing::info!(
        "Extracted {}/{} chunks ({} skipped, {} path mappings)",
        extracted_count, total_chunks, skipped_count, path_mappings.len()
    );

    write_hashed_names_file(&wad_output_dir, &path_mappings);

    Ok(ExtractionResult { extracted_count, path_mappings })
}

/// Resolves the final chunk path by handling extensions
/// 
/// This function:
/// - Adds .ltk extension if the path has no extension
/// - Detects file type from content and appends appropriate extension
/// - Handles directory name collisions
/// 
/// # Arguments
/// * `path` - The resolved or hex path
/// * `chunk_data` - The decompressed chunk data for file type detection
/// 
/// # Returns
/// * `PathBuf` - The final path with appropriate extensions
/// 
/// # Requirements
/// Validates: Requirements 4.5, 4.6
fn resolve_chunk_path(path: &str, chunk_data: &[u8]) -> PathBuf {
    let mut chunk_path = PathBuf::from(path);
    
    // Check if the path has an extension
    if chunk_path.extension().is_none() {
        // Detect file type from content
        let file_kind = LeagueFileKind::identify_from_bytes(chunk_data);
        
        match file_kind {
            LeagueFileKind::Unknown => {
                // No known file type, add .ltk extension
                let filename = chunk_path
                    .file_name()
                    .unwrap_or(OsStr::new("unknown"))
                    .to_string_lossy()
                    .to_string();
                chunk_path = chunk_path.with_file_name(format!("{}.ltk", filename));
            }
            _ => {
                // Known file type, add appropriate extension
                if let Some(extension) = file_kind.extension() {
                    // Add .ltk first, then the detected extension
                    let filename = chunk_path
                        .file_name()
                        .unwrap_or(OsStr::new("unknown"))
                        .to_string_lossy()
                        .to_string();
                    chunk_path = chunk_path.with_file_name(format!("{}.ltk.{}", filename, extension));
                } else {
                    // File kind known but no extension, just add .ltk
                    let filename = chunk_path
                        .file_name()
                        .unwrap_or(OsStr::new("unknown"))
                        .to_string_lossy()
                        .to_string();
                    chunk_path = chunk_path.with_file_name(format!("{}.ltk", filename));
                }
            }
        }
    }
    
    chunk_path
}

/// Recursively collect every asset path embedded in a parsed BIN, mirroring
/// the post-extraction scan in `repath::refather::scan_bin_for_paths`. Used
/// by the selective skin extractor so we can compute the chunk allow-list
/// without writing anything to disk first.
fn collect_paths_from_value_into(value: &BinValue, out: &mut Vec<String>) {
    match value {
        BinValue::String(v) => {
            if v.len() >= 5
                && (v.len() >= 7 && v[..7].eq_ignore_ascii_case("assets/")
                    || v.len() >= 5 && v[..5].eq_ignore_ascii_case("data/"))
            {
                out.push(v.to_lowercase().replace('\\', "/"));
            }
        }
        // List / List2 both hold `items: Vec<BinValue>`.
        BinValue::List { items, .. } => {
            for item in items { collect_paths_from_value_into(item, out); }
        }
        // Pointer / Embed both hold `fields: IndexMap<u32, BinValue>`.
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for v in fields.values() { collect_paths_from_value_into(v, out); }
        }
        BinValue::Option { value: Some(inner), .. } => {
            collect_paths_from_value_into(inner, out);
        }
        BinValue::Map { entries, .. } => {
            for (k, v) in entries {
                collect_paths_from_value_into(k, out);
                collect_paths_from_value_into(v, out);
            }
        }
        _ => {}
    }
}

/// Selective skin extraction — Quartz-style.
///
/// Walks the seed BIN's reference graph in **memory** (decompressing chunks
/// straight off the mmap'd WAD, never writing them to disk), collects every
/// referenced asset + linked-BIN path via BFS, hashes them, and hands the
/// resulting `HashSet<u64>` to the existing parallel extractor as a chunk
/// filter. On a typical champion WAD this drops the write count from ~3700
/// → ~400 — which is the entire 12 s "Defender-tax" component of project
/// creation.
///
/// Returns the same shape as [`extract_skin_assets`] so callers stay
/// signature-compatible. `path_mappings` is empty under selective mode
/// (long-name truncation is rare for an already-narrow file set, and the
/// repath stage falls back to direct path lookup when the table doesn't
/// match — same fallback the existing flow already uses).
///
/// If the seed BIN can't be located in the WAD (unusual install layout, mod
/// uses non-standard path, etc.), returns `Err` so the caller can fall back
/// to [`extract_skin_assets`] without losing the project.
pub fn extract_skin_assets_selective(
    wad_path: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    champion: &str,
    skin_id: u32,
    resolve_paths: impl Fn(&[u64]) -> ResolvedHashes,
    is_tft: bool,
) -> Result<ExtractionResult> {
    let wad_path = wad_path.as_ref();
    let output_dir = output_dir.as_ref();

    let champion_lower = champion.to_lowercase();
    let wad_folder_name = if is_tft {
        "Companions.wad.client".to_string()
    } else {
        format!("{}.wad.client", champion_lower)
    };
    let wad_output_dir = output_dir.join(&wad_folder_name);

    // ── Mount WAD via mmap ─────────────────────────────────────────────────
    let file = File::open(wad_path).map_err(|e| Error::io_with_path(e, wad_path))?;
    let mmap = unsafe { Mmap::map(&file) }.map_err(|e| Error::Wad {
        message: format!("Failed to mmap WAD: {}", e),
        path: Some(wad_path.to_path_buf()),
    })?;
    let mut wad_toc = Wad::mount(Cursor::new(&mmap[..])).map_err(|e| Error::Wad {
        message: format!("Failed to mount WAD: {}", e),
        path: Some(wad_path.to_path_buf()),
    })?;

    let by_hash: HashMap<u64, WadChunk> = wad_toc
        .chunks()
        .iter()
        .map(|c| (c.path_hash(), *c))
        .collect();

    let xx = |s: &str| xxhash_rust::xxh64::xxh64(s.as_bytes(), 0);

    // Seed = canonical `data/characters/{champ}/skins/skin{N}.bin`. Riot uses
    // mixed case in some places, but WAD path hashing normalizes lowercase.
    let seed = format!("data/characters/{}/skins/skin{}.bin", champion_lower, skin_id);
    if !by_hash.contains_key(&xx(&seed)) {
        return Err(Error::InvalidInput(format!(
            "Seed BIN not found in WAD ({}) — falling back to full extraction",
            seed
        )));
    }

    // ── Phase A: BFS the BIN graph, collect referenced asset paths ─────────
    let t_walk = Instant::now();
    let mut want_paths: HashSet<String> = HashSet::new();
    let mut bin_seen: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = VecDeque::new();

    queue.push_back(seed.clone());
    bin_seen.insert(seed.clone());

    // Also seed the animation BINs to ensure animations and their .anm files are extracted
    let anim_seeds = vec![
        format!("data/characters/{}/animations/skin0.bin", champion_lower),
        format!("data/characters/{}/animations/skin00.bin", champion_lower),
        format!("data/characters/{}/animations/skin{}.bin", champion_lower, skin_id),
        format!("data/characters/{}/animations/skin{:02}.bin", champion_lower, skin_id),
    ];
    for anim_seed in anim_seeds {
        if bin_seen.insert(anim_seed.clone()) {
            queue.push_back(anim_seed);
        }
    }

    let mut bins_walked: usize = 0;
    let mut bins_failed: usize = 0;

    while let Some(bin_path) = queue.pop_front() {
        let h = xx(&bin_path);
        let chunk = match by_hash.get(&h) {
            Some(c) => *c,
            // Linked BIN listed in deps but not in this WAD (shared assets
            // live in Common.wad.client etc.) — silently skip.
            None => continue,
        };
        let bytes = match wad_toc.load_chunk_decompressed(&chunk) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("[selective] failed to decompress {}: {}", bin_path, e);
                bins_failed += 1;
                continue;
            }
        };
        // The BIN itself is needed.
        want_paths.insert(bin_path.clone());

        let bin = match crate::bin::ltk_bridge::read_bin(&bytes) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("[selective] failed to parse {}: {}", bin_path, e);
                bins_failed += 1;
                continue;
            }
        };
        bins_walked += 1;

        // Linked BINs declared in the BIN header linked-files list.
        for dep in &bin.linked {
            let dep_norm = dep.to_lowercase().replace('\\', "/");
            if bin_seen.insert(dep_norm.clone()) {
                queue.push_back(dep_norm);
            }
        }

        // Asset paths embedded in property values. `.bin` references go on
        // the BFS queue so we recurse into them; everything else (textures,
        // anims, sounds, particles) goes straight in the want set.
        let mut paths_found: Vec<String> = Vec::new();
        for entry in &bin.entries {
            for value in entry.fields.values() {
                collect_paths_from_value_into(value, &mut paths_found);
            }
        }
        for p in paths_found {
            if p.ends_with(".bin") {
                if bin_seen.insert(p.clone()) {
                    queue.push_back(p);
                }
            } else {
                want_paths.insert(p);
            }
        }
    }
    let d_walk = t_walk.elapsed();

    tracing::info!(
        "[selective] BFS walked {} BINs ({} failed) — {} unique asset paths in {:?}",
        bins_walked,
        bins_failed,
        want_paths.len(),
        d_walk
    );

    // ── Phase B: hash → filter set, delegate to extract_chunks_parallel ────
    let mut want_hashes: HashSet<u64> = HashSet::with_capacity(want_paths.len());
    let mut known_paths: HashMap<u64, String> = HashMap::with_capacity(want_paths.len());
    for p in want_paths {
        let h = xx(&p);
        want_hashes.insert(h);
        known_paths.insert(h, p);
    }

    let resolve_wrapper = |hashes: &[u64]| -> ResolvedHashes {
        let mut resolved = resolve_paths(hashes);
        for h in hashes {
            if !resolved.contains_key(h) {
                if let Some(p) = known_paths.get(h) {
                    resolved.insert(*h, p);
                }
            }
        }
        resolved
    };

    // Drop the mmap before extract_chunks_parallel re-mmaps the same file.
    // This Wad cursor borrows from `mmap`, so it must go first.
    drop(wad_toc);
    drop(mmap);
    drop(file);

    let (extracted, failed, path_mappings) = extract_chunks_parallel(
        wad_path,
        &wad_output_dir,
        Some(&want_hashes),
        resolve_wrapper,
    )?;

    if failed > 0 {
        tracing::warn!("[selective] {} chunks failed to write", failed);
    }
    tracing::info!(
        "[selective] extracted {}/{} requested chunks (filtered from {} total)",
        extracted,
        want_hashes.len(),
        by_hash.len()
    );

    write_hashed_names_file(&wad_output_dir, &path_mappings);

    Ok(ExtractionResult {
        extracted_count: extracted,
        path_mappings,
    })
}

/// Extract every chunk from a WAD into `output_dir`, preserving the resolved
/// path layout, but letting the caller drop chunks by their resolved
/// (lowercased) path — the predicate returns `true` to skip the chunk. Used by
/// the map flow to filter out localized files like `data/.../en_us/...`.
/// Mirrors `extract_skin_assets` (mmap + bulk hash resolve + rayon decompress).
pub fn extract_full_wad_filtered(
    wad_path: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    resolve_paths: impl Fn(&[u64]) -> ResolvedHashes,
    skip_path: impl Fn(&str) -> bool,
) -> Result<ExtractionResult> {
    let wad_path   = wad_path.as_ref();
    let output_dir = output_dir.as_ref();

    tracing::info!("Extracting full WAD '{}' → '{}'", wad_path.display(), output_dir.display());

    let file = File::open(wad_path)
        .map_err(|e| Error::io_with_path(e, wad_path))?;
    let mmap = unsafe { Mmap::map(&file) }
        .map_err(|e| Error::Wad {
            message: format!("Failed to mmap WAD: {}", e),
            path: Some(wad_path.to_path_buf()),
        })?;

    let wad_toc = Wad::mount(Cursor::new(&mmap[..]))
        .map_err(|e| Error::Wad {
            message: format!("Failed to mount WAD: {}", e),
            path: Some(wad_path.to_path_buf()),
        })?;

    let chunks: Vec<WadChunk> = wad_toc.chunks().iter().copied().collect();
    let total_chunks = chunks.len();
    tracing::info!("Total chunks in WAD: {}", total_chunks);

    let all_hashes: Vec<u64> = chunks.iter().map(|c| c.path_hash()).collect();
    let resolved_map = resolve_paths(&all_hashes);

    let mut extraction_plan: Vec<(WadChunk, PathBuf)> = Vec::with_capacity(total_chunks);
    let mut path_mappings:   HashMap<String, String>  = HashMap::new();
    let mut parents:         HashSet<PathBuf>          = HashSet::new();
    let mut skipped_unknown = 0usize;

    fs::create_dir_all(output_dir)
        .map_err(|e| Error::io_with_path(e, output_dir))?;

    for chunk in &chunks {
        let path_hash = chunk.path_hash();
        let resolved = resolved_map.get(&path_hash)
            .map(String::from)
            .unwrap_or_else(|| format!("{:016x}", path_hash));
        let path_lower = resolved.to_lowercase();
        let is_unresolved = resolved.chars().all(|c| c.is_ascii_hexdigit());

        // Same allowlist as extract_skin_assets — these are the only prefixes
        // a sane WAD chunk should resolve to. Unresolved hashes get skipped.
        if !path_lower.starts_with("assets/") && !path_lower.starts_with("data/") {
            if is_unresolved { skipped_unknown += 1; }
            continue;
        }

        // Caller-supplied skip filter (e.g. drop localized files for map projects).
        if skip_path(&path_lower) { continue; }

        let final_path = PathBuf::from(&resolved);
        let filename_len = final_path.to_string_lossy().len();

        let out_path = if filename_len > 200 {
            let parent = final_path.parent().unwrap_or_else(|| Path::new("data"));
            let ext = final_path.extension().and_then(|e| e.to_str()).unwrap_or("bin");
            let hash_name = format!("{:016x}.{}", path_hash, ext);
            let hash_path = parent.join(&hash_name);

            let orig = final_path.to_string_lossy().to_lowercase().replace('\\', "/");
            let act  = hash_path.to_string_lossy().to_lowercase().replace('\\', "/");
            path_mappings.insert(orig, act);

            output_dir.join(hash_path)
        } else {
            output_dir.join(&final_path)
        };

        if let Some(p) = out_path.parent() { parents.insert(p.to_path_buf()); }
        extraction_plan.push((*chunk, out_path));
    }

    if skipped_unknown > 0 {
        tracing::warn!("Skipped {} unresolved hashes (not in hash DB)", skipped_unknown);
    }

    for parent in parents { let _ = fs::create_dir_all(parent); }

    tracing::info!(
        "Map WAD extraction plan: {} files — launching parallel workers",
        extraction_plan.len()
    );

    let mmap_ref = &mmap;
    let chunk_size = (extraction_plan.len() / rayon::current_num_threads().max(1)).max(1);

    let thread_results: Vec<(usize, usize)> = extraction_plan
        .par_chunks(chunk_size)
        .map(|slice| {
            let mut extracted = 0usize;
            let mut skipped = 0usize;
            let mut local_wad = match Wad::mount(Cursor::new(&mmap_ref[..])) {
                Ok(w) => w,
                Err(_) => return (0, slice.len()),
            };
            for (chunk, out_path) in slice {
                match local_wad.load_chunk_decompressed(chunk) {
                    Err(_) => { skipped += 1; }
                    Ok(data) => {
                        let final_path = resolve_chunk_path(&out_path.to_string_lossy(), &data);
                        let actual_path = if final_path == *out_path {
                            out_path.clone()
                        } else {
                            // resolve_chunk_path returned a relative path with extension fix —
                            // join under output_dir so we still write into the project.
                            let joined = output_dir.join(&final_path);
                            if let Some(p) = joined.parent() { let _ = fs::create_dir_all(p); }
                            joined
                        };
                        let write_path = if actual_path.exists() || actual_path == *out_path {
                            out_path.clone()
                        } else {
                            actual_path
                        };
                        if fs::write(&write_path, &data).is_ok() { extracted += 1; }
                        else { skipped += 1; }
                    }
                }
            }
            (extracted, skipped)
        })
        .collect();

    let (extracted_count, skipped_count) = thread_results
        .iter()
        .fold((0usize, 0usize), |(e, s), (te, ts)| (e + te, s + ts));

    tracing::info!(
        "Full WAD extracted: {}/{} chunks ({} skipped, {} path mappings)",
        extracted_count, total_chunks, skipped_count, path_mappings.len()
    );

    write_hashed_names_file(output_dir, &path_mappings);

    Ok(ExtractionResult { extracted_count, path_mappings })
}

/// Read a WAD's chunk list and bulk-resolve every path hash, without extracting
/// anything to disk. Used by map variant discovery.
pub fn resolve_wad_paths(
    wad_path: impl AsRef<Path>,
    resolve_paths: impl Fn(&[u64]) -> ResolvedHashes,
) -> Result<ResolvedHashes> {
    let wad_path = wad_path.as_ref();
    let file = File::open(wad_path)
        .map_err(|e| Error::io_with_path(e, wad_path))?;
    let mmap = unsafe { Mmap::map(&file) }
        .map_err(|e| Error::Wad {
            message: format!("Failed to mmap WAD: {}", e),
            path: Some(wad_path.to_path_buf()),
        })?;
    let wad_toc = Wad::mount(Cursor::new(&mmap[..]))
        .map_err(|e| Error::Wad {
            message: format!("Failed to mount WAD: {}", e),
            path: Some(wad_path.to_path_buf()),
        })?;
    let hashes: Vec<u64> = wad_toc.chunks().iter().map(|c| c.path_hash()).collect();
    Ok(resolve_paths(&hashes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_chunk_path_with_extension() {
        let path = "characters/aatrox/aatrox.bin";
        let data = vec![0u8; 100];
        let resolved = resolve_chunk_path(path, &data);
        
        // Should keep the original extension
        assert_eq!(resolved, PathBuf::from(path));
    }
    
    #[test]
    fn test_resolve_chunk_path_without_extension() {
        let path = "characters/aatrox/aatrox";
        let data = vec![0u8; 100];
        let resolved = resolve_chunk_path(path, &data);
        
        // Should add .ltk extension
        assert!(resolved.to_string_lossy().contains(".ltk"));
    }
    
    #[test]
    fn test_resolve_chunk_path_hex_fallback() {
        let path = "1a2b3c4d5e6f7a8b";
        let data = vec![0u8; 100];
        let resolved = resolve_chunk_path(path, &data);
        
        // Should add .ltk extension to hex path
        assert!(resolved.to_string_lossy().contains(".ltk"));
    }
}
