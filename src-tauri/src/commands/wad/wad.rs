use flint_ltk::hash::{resolve_hashes_lmdb, resolve_hashes_lmdb_bulk, ResolvedHashes};
use flint_ltk::wad_jade::adapter::WadHandle as WadReader;
use crate::state::{LmdbCacheState, WadCacheState};
use crate::core::ipc_trace;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;
use tauri::State;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WadInfo {
    pub path: String,
    pub chunk_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkInfo {
    pub hash: String,
    pub path: Option<String>,
    pub size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractionResult {
    pub extracted_count: usize,
    pub failed_count: usize,
}

#[tauri::command]
pub async fn read_wad(path: String) -> Result<WadInfo, String> {
    let reader = WadReader::open(&path)?;
    Ok(WadInfo {
        path,
        chunk_count: reader.chunk_count(),
    })
}

/// Returns a list of all chunks in a WAD archive with resolved paths.
#[tauri::command]
pub async fn get_wad_chunks(
    path: String,
    lmdb: State<'_, LmdbCacheState>,
    wad_cache_state: State<'_, WadCacheState>,
) -> Result<Vec<ChunkInfo>, String> {
    let _t = ipc_trace::enter("get_wad_chunks");
    let total_start = Instant::now();
    let cache = wad_cache_state.get();

    let cache_hit;
    let t_open = Instant::now();
    let chunks = if let Some(cached) = cache.get(&path) {
        cache_hit = true;
        cached
    } else {
        cache_hit = false;
        let reader = WadReader::open(&path)?;
        let chunks: Vec<_> = reader.chunks().iter().cloned().collect();
        let chunks = Arc::new(chunks);
        let _ = cache.insert(&path, Arc::clone(&chunks));
        chunks
    };
    let d_open = t_open.elapsed();

    let t_hashes = Instant::now();
    let hash_u64s: Vec<u64> = chunks.iter().map(|c| c.path_hash).collect();
    let d_hash_collect = t_hashes.elapsed();

    let t_resolve = Instant::now();
    let resolved: Vec<String> = if let Some(env) = lmdb.get_env(
        &flint_ltk::hash::get_hash_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    ) {
        resolve_hashes_lmdb(&hash_u64s, &env)
    } else {
        hash_u64s.iter().map(|h| format!("{:016x}", h)).collect()
    };
    let d_resolve = t_resolve.elapsed();

    let t_build = Instant::now();
    let chunk_infos = chunks
        .iter()
        .zip(resolved.into_iter())
        .map(|(chunk, resolved_path)| {
            let path_hash = chunk.path_hash;
            // Hex-only 16-char strings are unresolved hashes — treat as None.
            let path = if resolved_path.len() == 16
                && resolved_path.bytes().all(|b| b.is_ascii_hexdigit())
            {
                None
            } else {
                Some(resolved_path)
            };
            ChunkInfo {
                hash: format!("{:016x}", path_hash),
                path,
                size: chunk.uncompressed_size as u32,
            }
        })
        .collect::<Vec<_>>();
    let d_build = t_build.elapsed();
    let total = total_start.elapsed();

    tracing::info!(
        "[TIMING] get_wad_chunks {} chunks ({}, total {:?}): \
         open/parse {:?}, hash_collect {:?}, lmdb_resolve {:?}, build_response {:?}",
        chunks.len(),
        if cache_hit { "cache_hit" } else { "cache_miss" },
        total,
        d_open,
        d_hash_collect,
        d_resolve,
        d_build,
    );

    Ok(chunk_infos)
}

/// Loads chunk metadata for multiple WAD files in one call, returning a compact
/// binary payload via `tauri::ipc::Response`.
///
/// Phase 1: parallel WAD header parsing (rayon). Phase 2: collect + dedup all
/// unique hashes. Phase 3: single LMDB read txn resolves every unique hash.
/// Phase 4: encode the per-WAD binary blocks.
///
/// Layout (all little-endian; frontend decoder `decodeWadChunkPayload()` in `api.ts`):
/// ```text
/// [u32 wad_count]
/// per WAD:
///   [u32 path_len] [path_bytes utf-8]
///   [u32 error_len] [error_bytes utf-8]    // 0 when no error
///   [u32 chunk_count]
///   [chunk_count × u64 path_hash]
///   [chunk_count × u32 size]
///   [chunk_count × u16 resolved_path_len]   // 0xFFFF = null/unresolved
///   [packed resolved-path utf-8 bytes ...]
/// ```
#[tauri::command]
pub async fn load_all_wad_chunks(
    paths: Vec<String>,
    lmdb: State<'_, LmdbCacheState>,
    wad_cache_state: State<'_, WadCacheState>,
) -> Result<tauri::ipc::Response, String> {
    let _t = ipc_trace::enter("load_all_wad_chunks");
    let total_start = Instant::now();
    let cache = wad_cache_state.get();

    let hash_dir = flint_ltk::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let env_opt = lmdb.get_env(&hash_dir);

    // Phase 1: parallel WAD header reads (rayon).
    let t_phase1 = Instant::now();
    let toc_results: Vec<(String, Result<Arc<Vec<_>>, String>)> = paths
        .par_iter()
        .map(|wad_path| {
            let result: Result<Arc<Vec<_>>, String> = (|| {
                if let Some(cached) = cache.get(wad_path) {
                    return Ok(cached);
                }
                let reader = WadReader::open(wad_path).map_err(|e| e.to_string())?;
                let chunks: Vec<_> = reader.chunks().iter().cloned().collect();
                let chunks = Arc::new(chunks);
                let _ = cache.insert(wad_path, Arc::clone(&chunks));
                Ok(chunks)
            })();
            (wad_path.clone(), result)
        })
        .collect();
    let d_phase1 = t_phase1.elapsed();

    // Phase 2: separate successes from errors, collect all unique hashes.
    // FxHashSet because keys are already xxh64 outputs.
    let t_phase2 = Instant::now();
    let mut entries: Vec<(String, Result<Arc<Vec<_>>, String>)> = Vec::with_capacity(toc_results.len());
    let mut unique_hashes: rustc_hash::FxHashSet<u64> =
        rustc_hash::FxHashSet::with_capacity_and_hasher(total_chunks_estimate(&toc_results), Default::default());
    let mut total_chunks: usize = 0;
    for (wad_path, result) in toc_results {
        if let Ok(chunks) = &result {
            total_chunks += chunks.len();
            for c in chunks.iter() {
                unique_hashes.insert(c.path_hash);
            }
        }
        entries.push((wad_path, result));
    }
    let d_phase2 = t_phase2.elapsed();

    // Phase 3: parallel LMDB resolve for ALL unique hashes (deduped)
    let t_phase3 = Instant::now();
    let unique_vec: Vec<u64> = unique_hashes.into_iter().collect();
    let unique_count = unique_vec.len();
    let resolved_map: ResolvedHashes = if let Some(ref env) = env_opt {
        resolve_hashes_lmdb_bulk(&unique_vec, env)
    } else {
        ResolvedHashes::default()
    };
    let d_phase3 = t_phase3.elapsed();

    // Phase 4: encode binary payload in parallel (each WAD's bytes are independent).
    let t_phase4 = Instant::now();
    let resolved_ref = &resolved_map;
    let per_wad_buffers: Vec<Vec<u8>> = entries
        .par_iter()
        .map(|(wad_path, result)| encode_one_wad(wad_path, result, resolved_ref))
        .collect();

    // Stitch: u32 count + concatenated per-WAD buffers.
    let total_len: usize = 4 + per_wad_buffers.iter().map(|b| b.len()).sum::<usize>();
    let mut buf: Vec<u8> = Vec::with_capacity(total_len);
    buf.extend_from_slice(&(per_wad_buffers.len() as u32).to_le_bytes());
    for b in per_wad_buffers {
        buf.extend_from_slice(&b);
    }
    let d_phase4 = t_phase4.elapsed();

    // Free the resolved map eagerly — it can be hundreds of MB.
    drop(resolved_map);

    tracing::info!(
        "[TIMING] load_all_wad_chunks {} WADs, {} chunks, {} unique hashes, {} bytes (total {:?}): \
         phase1_read {:?}, phase2_dedup {:?}, phase3_lmdb {:?}, phase4_encode {:?}",
        entries.len(),
        total_chunks,
        unique_count,
        buf.len(),
        total_start.elapsed(),
        d_phase1,
        d_phase2,
        d_phase3,
        d_phase4,
    );

    Ok(tauri::ipc::Response::new(buf))
}

trait WadChunkMeta {
    fn path_hash_le(&self) -> u64;
    fn uncompressed_size_u32(&self) -> u32;
}

impl WadChunkMeta for flint_ltk::wad_jade::format::WadChunk {
    fn path_hash_le(&self) -> u64 { self.path_hash }
    fn uncompressed_size_u32(&self) -> u32 { self.uncompressed_size as u32 }
}

type TocResult<C> = (String, Result<Arc<Vec<C>>, String>);

fn total_chunks_estimate<C>(results: &[TocResult<C>]) -> usize {
    results.iter().filter_map(|(_, r)| r.as_ref().ok()).map(|v| v.len()).sum()
}

fn encode_one_wad<C: WadChunkMeta>(
    wad_path: &str,
    result: &Result<Arc<Vec<C>>, String>,
    resolved: &ResolvedHashes,
) -> Vec<u8> {
    let path_bytes = wad_path.as_bytes();

    let (chunks_opt, err_bytes): (Option<&Arc<Vec<C>>>, &[u8]) = match result {
        Ok(c) => (Some(c), &[]),
        Err(e) => (None, e.as_bytes()),
    };
    let chunk_count = chunks_opt.map(|c| c.len()).unwrap_or(0);

    let mut resolved_total: usize = 0;
    if let Some(chunks) = chunks_opt {
        for c in chunks.iter() {
            if let Some(s) = resolved.get(&c.path_hash_le()) {
                resolved_total += s.len().min(0xFFFE);
            }
        }
    }

    let cap = 4 + path_bytes.len()
        + 4 + err_bytes.len()
        + 4
        + chunk_count * (8 + 4 + 2)
        + resolved_total;
    let mut buf: Vec<u8> = Vec::with_capacity(cap);

    buf.extend_from_slice(&(path_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(path_bytes);
    buf.extend_from_slice(&(err_bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(err_bytes);
    buf.extend_from_slice(&(chunk_count as u32).to_le_bytes());

    if let Some(chunks) = chunks_opt {
        for c in chunks.iter() {
            buf.extend_from_slice(&c.path_hash_le().to_le_bytes());
        }
        for c in chunks.iter() {
            buf.extend_from_slice(&c.uncompressed_size_u32().to_le_bytes());
        }
        // Path-len table (u16 LE) followed by packed UTF-8 bytes.
        // 0xFFFF means "unresolved/null".
        let lens_off = buf.len();
        for _ in 0..chunk_count {
            buf.extend_from_slice(&[0u8, 0u8]);
        }
        for (i, c) in chunks.iter().enumerate() {
            let len_u16 = match resolved.get(&c.path_hash_le()) {
                None => 0xFFFFu16,
                Some(s) => {
                    let n = s.len().min(0xFFFE);
                    buf.extend_from_slice(&s.as_bytes()[..n]);
                    n as u16
                }
            };
            let off = lens_off + i * 2;
            buf[off] = (len_u16 & 0xFF) as u8;
            buf[off + 1] = (len_u16 >> 8) as u8;
        }
    }

    buf
}

/// Extracts chunks from a WAD archive to the specified output directory.
///
/// Uses mmap + rayon: each worker mounts its own `Wad` cursor over the shared
/// mmap and decompresses + writes in parallel. Hash → path resolution happens
/// in one bulk LMDB read txn up front.
#[tauri::command]
pub async fn extract_wad(
    wad_path: String,
    output_dir: String,
    chunk_hashes: Option<Vec<String>>,
    lmdb: State<'_, LmdbCacheState>,
) -> Result<ExtractionResult, String> {
    let _t = ipc_trace::enter("extract_wad");

    // Snapshot the LMDB env so the move into spawn_blocking doesn't borrow
    // the Tauri State guard across an await.
    let hash_dir = flint_ltk::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let env_opt = lmdb.get_env(&hash_dir);

    let want_hashes: Option<HashSet<u64>> = match chunk_hashes {
        None => None,
        Some(list) => {
            let mut set = HashSet::with_capacity(list.len());
            for s in list {
                let h = u64::from_str_radix(&s, 16)
                    .map_err(|e| format!("Invalid hash format '{}': {}", s, e))?;
                set.insert(h);
            }
            Some(set)
        }
    };

    let output_dir_clone = output_dir.clone();
    let result: Result<(usize, usize, std::collections::HashMap<String, String>), String> = tokio::task::spawn_blocking(move || {
        let resolver = |hashes: &[u64]| -> ResolvedHashes {
            if let Some(ref env) = env_opt {
                resolve_hashes_lmdb_bulk(hashes, env)
            } else {
                hashes.iter().map(|h| (*h, format!("{:016x}", h))).collect()
            }
        };
        flint_ltk::wad_jade::adapter::extract_chunks_parallel(
            &wad_path,
            &output_dir,
            want_hashes.as_ref(),
            resolver,
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task panic: {}", e))?;

    let (extracted_count, failed_count, path_mappings) = result?;

    if !path_mappings.is_empty() {
        let out = std::path::PathBuf::from(&output_dir_clone);
        if let Ok(json) = serde_json::to_string_pretty(&path_mappings) {
            let _ = std::fs::write(out.join("_flint_hashed_names.json"), json);
        }
    }

    Ok(ExtractionResult { extracted_count, failed_count })
}

/// Invalidate a WAD entry from the metadata cache so the next read re-parses it.
#[tauri::command]
pub async fn invalidate_wad_cache(
    path: String,
    wad_cache_state: State<'_, WadCacheState>,
) -> Result<(), String> {
    wad_cache_state.get().remove(&path);
    tracing::info!("Invalidated WAD cache for: {}", path);
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WadModelPreviewResult {
    pub skn_path: String,
    pub temp_dir: String,
}

/// Extract an SKN chunk and its companion files from a WAD to a temp directory
/// for inline 3D preview. Companion files: .skl, .bin, .dds, .tex in the same
/// skin folder. Also auto-generates .ritobin cache for .bin files.
#[tauri::command]
pub async fn extract_wad_model_preview(
    wad_path: String,
    skn_hash: String,
    lmdb: State<'_, LmdbCacheState>,
    wad_cache_state: State<'_, WadCacheState>,
) -> Result<WadModelPreviewResult, String> {
    let target_hash = u64::from_str_radix(&skn_hash, 16)
        .map_err(|e| format!("Invalid hash '{}': {}", skn_hash, e))?;

    let cache = wad_cache_state.get();

    let chunks = if let Some(cached) = cache.get(&wad_path) {
        cached
    } else {
        let reader = WadReader::open(&wad_path)?;
        let chunks: Vec<_> = reader.chunks().iter().cloned().collect();
        let chunks = Arc::new(chunks);
        let _ = cache.insert(&wad_path, Arc::clone(&chunks));
        chunks
    };

    let hash_u64s: Vec<u64> = chunks.iter().map(|c| c.path_hash).collect();
    let hash_dir = flint_ltk::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let resolved_map: ResolvedHashes = if let Some(ref env) = lmdb.get_env(&hash_dir) {
        resolve_hashes_lmdb_bulk(&hash_u64s, env)
    } else {
        hash_u64s.iter().map(|h| (*h, format!("{:016x}", h))).collect()
    };

    let skn_resolved = resolved_map.get(&target_hash)
        .ok_or_else(|| format!("SKN chunk {:016x} not found in WAD", target_hash))?;

    let skn_normalized = skn_resolved.replace('\\', "/");
    let skn_folder = skn_normalized.rsplit_once('/')
        .map(|(folder, _)| format!("{}/", folder))
        .unwrap_or_default();

    let companion_exts = [".skn", ".skl", ".bin", ".dds", ".tex"];

    let mut to_extract: Vec<(u64, String)> = Vec::new();
    for chunk in chunks.iter() {
        let h = chunk.path_hash;
        if let Some(resolved) = resolved_map.get(&h) {
            let norm = resolved.replace('\\', "/");
            if !skn_folder.is_empty() && norm.starts_with(&skn_folder) {
                let lower = norm.to_lowercase();
                if companion_exts.iter().any(|ext| lower.ends_with(ext)) {
                    to_extract.push((h, norm));
                }
            } else if h == target_hash {
                to_extract.push((h, norm));
            }
        }
    }

    if to_extract.is_empty() {
        return Err("No extractable files found for SKN preview".to_string());
    }

    let uuid = uuid::Uuid::new_v4();
    let temp_dir = std::env::temp_dir().join("flint-wad-preview").join(uuid.to_string());
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let mut reader = WadReader::open(&wad_path)?;
    let mut skn_path = String::new();

    for (hash, rel_path) in &to_extract {
        if let Some(chunk) = reader.get_chunk(*hash) {
            let output_path = temp_dir.join(rel_path);
            if let Some(parent) = output_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let chunk_copy = *chunk;
            if let Err(e) = flint_ltk::wad_jade::adapter::extract_chunk(
                &mut reader.wad_mut(), &chunk_copy, &output_path, None,
            ) {
                tracing::warn!("Failed to extract {}: {}", rel_path, e);
                continue;
            }
            if *hash == target_hash {
                skn_path = output_path.to_string_lossy().to_string();
            }
        }
    }

    if skn_path.is_empty() {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err("Failed to extract SKN chunk".to_string());
    }

    // Auto-generate .ritobin cache for all extracted .bin files.
    for (_, rel_path) in &to_extract {
        if rel_path.to_lowercase().ends_with(".bin") {
            let bin_path = temp_dir.join(rel_path);
            let ritobin_path = std::path::PathBuf::from(format!("{}.ritobin", bin_path.display()));
            if let Err(e) = crate::commands::mesh::create_ritobin_cache(&bin_path, &ritobin_path) {
                tracing::warn!("Failed to create ritobin cache for {}: {}", rel_path, e);
            }
        }
    }

    tracing::info!(
        "Extracted {} files for SKN preview to {}",
        to_extract.len(),
        temp_dir.display()
    );

    Ok(WadModelPreviewResult {
        skn_path,
        temp_dir: temp_dir.to_string_lossy().to_string(),
    })
}

/// Clean up a temporary WAD model preview directory.
/// Validates the path starts with the expected temp prefix.
#[tauri::command]
pub async fn cleanup_wad_model_preview(temp_dir: String) -> Result<(), String> {
    let path = std::path::Path::new(&temp_dir);
    let expected_prefix = std::env::temp_dir().join("flint-wad-preview");

    if !path.starts_with(&expected_prefix) {
        return Err("Invalid temp dir path — must be inside flint-wad-preview".to_string());
    }

    if path.exists() {
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to cleanup temp dir: {}", e))?;
        tracing::debug!("Cleaned up WAD preview temp: {}", temp_dir);
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameWadInfo {
    pub path: String,
    pub name: String,
    pub category: String,
}

/// Read decompressed chunk data from a WAD archive into memory, returning raw
/// bytes via `tauri::ipc::Response`.
#[tauri::command]
pub async fn read_wad_chunk_data(
    wad_path: String,
    hash: String,
) -> Result<tauri::ipc::Response, String> {
    let path_hash = u64::from_str_radix(&hash, 16)
        .map_err(|e| format!("Invalid hash '{}': {}", hash, e))?;

    let mut reader = WadReader::open(&wad_path)?;
    let chunk = *reader
        .get_chunk(path_hash)
        .ok_or_else(|| format!("Chunk {:016x} not found in WAD", path_hash))?;

    let bytes: Vec<u8> = reader
        .wad_mut()
        .load_chunk_decompressed(&chunk)
        .map_err(|e| format!("Failed to decompress chunk {:016x}: {}", path_hash, e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Scan a game installation directory for all WAD archive files.
#[tauri::command]
pub async fn scan_game_wads(game_path: String) -> Result<Vec<GameWadInfo>, String> {
    let _t = ipc_trace::enter("scan_game_wads");
    let root = std::path::Path::new(&game_path).join("DATA").join("FINAL");

    if !root.exists() {
        return Err(format!(
            "WAD directory not found: {} — make sure this is the League Game/ folder",
            root.display()
        ));
    }

    let mut wads: Vec<GameWadInfo> = WalkDir::new(&root)
        .max_depth(5)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?;
            if !name.ends_with(".wad.client") && !name.ends_with(".wad") {
                return None;
            }
            let category = path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("Other")
                .to_string();
            Some(GameWadInfo {
                path: path.to_string_lossy().to_string(),
                name: name.to_string(),
                category,
            })
        })
        .collect();

    wads.sort_unstable_by(|a, b| a.category.cmp(&b.category).then(a.name.cmp(&b.name)));

    Ok(wads)
}
