use flint_core::overlay::HashResolver;
use flint_core::hash::ResolvedHashes;
use flint_core::wad_jade::adapter::WadHandle as WadReader;
use crate::state::{HashOverlayState, LmdbCacheState, WadCacheState};
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
    _lmdb: State<'_, LmdbCacheState>,
    wad_cache_state: State<'_, WadCacheState>,
    overlay_state: State<'_, HashOverlayState>,
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
    let hash_dir = flint_core::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let overlay = overlay_state.get();
    let resolver = HashResolver::new(&hash_dir, overlay.as_ref());
    let resolved: Vec<String> = resolver.resolve_wad(&hash_u64s);
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

    tracing::debug!(
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
    _lmdb: State<'_, LmdbCacheState>,
    wad_cache_state: State<'_, WadCacheState>,
    overlay_state: State<'_, HashOverlayState>,
) -> Result<tauri::ipc::Response, String> {
    let _t = ipc_trace::enter("load_all_wad_chunks");
    let total_start = Instant::now();
    let cache = wad_cache_state.get();

    let hash_dir = flint_core::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let overlay = overlay_state.get();
    let resolver = HashResolver::new(&hash_dir, overlay.as_ref());

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
    let resolved_map: ResolvedHashes = resolver.resolve_wad_bulk(&unique_vec);
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

    tracing::debug!(
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

impl WadChunkMeta for flint_core::wad_jade::format::WadChunk {
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
    _lmdb: State<'_, LmdbCacheState>,
    overlay_state: State<'_, HashOverlayState>,
) -> Result<ExtractionResult, String> {
    let _t = ipc_trace::enter("extract_wad");

    // Build the resolver before spawn_blocking so the move doesn't borrow the
    // Tauri State guard across an await.
    let hash_dir = flint_core::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let overlay = overlay_state.get();
    let hash_resolver = HashResolver::new(&hash_dir, overlay.as_ref());

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
        let resolver = |hashes: &[u64]| -> ResolvedHashes { hash_resolver.resolve_wad_bulk(hashes) };
        flint_core::wad_jade::adapter::extract_chunks_parallel(
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

/// Extract a mesh chunk (SKN/SCB/SCO) and its companion files from a WAD to a
/// temp directory for inline 3D preview. Companion files: .skn, .skl, .scb,
/// .sco, .bin, .dds, .tex in the same folder. Also auto-generates .ritobin
/// cache for .bin files (texture mapping).
#[tauri::command]
pub async fn extract_wad_model_preview(
    wad_path: String,
    skn_hash: String,
    _lmdb: State<'_, LmdbCacheState>,
    wad_cache_state: State<'_, WadCacheState>,
    overlay_state: State<'_, HashOverlayState>,
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
    let hash_dir = flint_core::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let overlay = overlay_state.get();
    let resolver = HashResolver::new(&hash_dir, overlay.as_ref());
    let mut resolved_map: ResolvedHashes = resolver.resolve_wad_bulk(&hash_u64s);
    if !resolver.has_global_wad() {
        // No downloaded global hash DB: `resolve_wad_bulk` omits misses (the
        // bulk contract other call sites rely on), but this site's original
        // fallback hex-filled every hash so `target_hash` below always
        // resolved to *something*. Preserve that — overlay hits (already in
        // `resolved_map`) still win over the hex filler.
        for h in &hash_u64s {
            if !resolved_map.contains_key(h) {
                let hex = format!("{:016x}", h);
                resolved_map.insert(*h, &hex);
            }
        }
    }

    let skn_resolved = resolved_map.get(&target_hash)
        .ok_or_else(|| format!("Mesh chunk {:016x} not found in WAD", target_hash))?;

    let skn_normalized = skn_resolved.replace('\\', "/");
    let skn_folder = skn_normalized.rsplit_once('/')
        .map(|(folder, _)| format!("{}/", folder))
        .unwrap_or_default();

    let companion_exts = [".skn", ".skl", ".scb", ".sco", ".bin", ".dds", ".tex"];

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
        return Err("No extractable files found for mesh preview".to_string());
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
            if let Err(e) = flint_core::wad_jade::adapter::extract_chunk(
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
        return Err("Failed to extract mesh chunk".to_string());
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

    tracing::debug!(
        "Extracted {} files for mesh preview to {}",
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

/// Result of concatenating a skin bin's linked bins from a WAD.
#[derive(serde::Serialize)]
pub struct ConcatWadResult {
    /// Absolute path the skin bin was written to (with links repointed).
    pub skin_bin_path: String,
    /// Absolute path the concat bin was written to.
    pub concat_bin_path: String,
    /// Number of source (Type-3 LinkedData) bins merged.
    pub source_count: usize,
}

/// Build a safe relative output path from a WAD-internal path, stripping any
/// `..`/drive components and normalizing slashes.
fn safe_rel(path: &str) -> std::path::PathBuf {
    let normalized = path.replace('\\', "/");
    let mut safe = std::path::PathBuf::new();
    for comp in std::path::Path::new(normalized.trim_start_matches('/')).components() {
        if let std::path::Component::Normal(seg) = comp {
            safe.push(seg);
        }
    }
    safe
}

/// Concatenate the Type-3 (LinkedData) bins linked by a skin bin **inside a
/// WAD** into a single self-contained bin, then write the FULL structure into
/// `out_dir` exactly like project creation: the concat bin at
/// `data/<Champion>_<Skin>_Concat.bin`, and the selected skin bin at its real
/// resolved path with its linked list repointed to the concat (root + animation
/// bins preserved, Type-3 links replaced). The linked bins are read from the WAD
/// by their xxh64(lowercased path) hash.
#[tauri::command]
pub async fn concat_wad_skin_bin(
    wad_path: String,
    hash: String,
    skin_path: Option<String>,
    out_dir: String,
) -> Result<ConcatWadResult, String> {
    use xxhash_rust::xxh64::xxh64;

    let path_hash =
        u64::from_str_radix(&hash, 16).map_err(|e| format!("Invalid hash '{}': {}", hash, e))?;

    tokio::task::spawn_blocking(move || {
        let mut reader = WadReader::open(&wad_path)?;

        // The selected skin bin (the "main" bin whose links we concat).
        let skin_chunk = *reader
            .get_chunk(path_hash)
            .ok_or_else(|| format!("Skin bin {:016x} not found in WAD", path_hash))?;
        let skin_bytes = reader
            .wad_mut()
            .load_chunk_decompressed(&skin_chunk)
            .map_err(|e| format!("Failed to read skin bin: {}", e))?;
        let mut main_bin = flint_core::bin::read_bin(&skin_bytes)
            .map_err(|e| format!("Failed to parse skin bin: {}", e))?;

        // Read each linked bin from the WAD by its xxh64(lowercased path) hash.
        let (concat_bin, source_count) =
            flint_core::bin::concat_linked_bins_with(&main_bin, |linked_path| {
                let h = xxh64(linked_path.to_lowercase().as_bytes(), 0);
                let chunk = *reader.get_chunk(h)?;
                reader.wad_mut().load_chunk_decompressed(&chunk).ok()
            })
            .map_err(|e| e.to_string())?;

        // Name: champion (WAD file stem) + selected skin, e.g.
        // Aatrox_Skin0_Concat.bin.
        let champion = std::path::Path::new(&wad_path)
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.split('.').next().unwrap_or(n).to_string())
            .unwrap_or_else(|| "Champion".to_string());
        let skin_stem = skin_path
            .as_deref()
            .map(|n| n.rsplit(['/', '\\']).next().unwrap_or(n))
            .map(|n| n.trim_end_matches(".bin"))
            .filter(|n| !n.is_empty())
            .map(|n| {
                let mut c = n.chars();
                c.next()
                    .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        let concat_name = if skin_stem.is_empty() {
            format!("{}_Concat.bin", champion)
        } else {
            format!("{}_{}_Concat.bin", champion, skin_stem)
        };
        // Concat bin lives under data/ (its linked-path form, same as project creation).
        let concat_linked_path = format!("data/{}", concat_name);

        let base = std::path::Path::new(&out_dir);

        // 1) Write the concat bin at data/<name>.
        let concat_out = base.join(safe_rel(&concat_linked_path));
        if let Some(parent) = concat_out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
        }
        let concat_data = flint_core::bin::write_bin(&concat_bin)
            .map_err(|e| format!("Failed to write concat bin: {}", e))?;
        std::fs::write(&concat_out, &concat_data)
            .map_err(|e| format!("Failed to write {}: {}", concat_out.display(), e))?;

        // 2) Repoint the skin bin's links: concat first, then keep root + animation.
        flint_core::bin::update_main_bin_links(&mut main_bin, concat_linked_path)
            .map_err(|e| e.to_string())?;

        // 3) Write the skin bin at its real resolved path (create the structure).
        let skin_rel = skin_path
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(safe_rel)
            .unwrap_or_else(|| std::path::PathBuf::from(format!("data/{:016x}.bin", path_hash)));
        let skin_out = base.join(&skin_rel);
        if let Some(parent) = skin_out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
        }
        let skin_data = flint_core::bin::write_bin(&main_bin)
            .map_err(|e| format!("Failed to write skin bin: {}", e))?;
        std::fs::write(&skin_out, &skin_data)
            .map_err(|e| format!("Failed to write {}: {}", skin_out.display(), e))?;

        tracing::info!(
            "[concat] wrote skin {} + concat {} ({} entries from {} bin(s))",
            skin_out.display(),
            concat_out.display(),
            concat_bin.entries.len(),
            source_count
        );
        Ok(ConcatWadResult {
            skin_bin_path: skin_out.to_string_lossy().replace('\\', "/"),
            concat_bin_path: concat_out.to_string_lossy().replace('\\', "/"),
            source_count,
        })
    })
    .await
    .map_err(|e| format!("concat task join error: {}", e))?
}

/// Pre-fault the WAD-hash LMDB into the OS page cache with one sequential
/// read. Cold random b-tree lookups otherwise cost seconds on the first
/// bulk resolve (measured 4.3s for a 306 MB data.mdb).
fn warm_wad_lmdb_once() {
    static WARMED: std::sync::Once = std::sync::Once::new();
    WARMED.call_once(|| {
        std::thread::spawn(|| {
            let Ok(dir) = flint_core::hash::get_hash_dir() else { return };
            let Ok(mut f) = std::fs::File::open(dir.join("hashes-wad.lmdb").join("data.mdb")) else { return };
            let t = Instant::now();
            let mut buf = vec![0u8; 4 << 20];
            let mut total: u64 = 0;
            use std::io::Read;
            while let Ok(n) = f.read(&mut buf) {
                if n == 0 {
                    break;
                }
                total += n as u64;
            }
            tracing::debug!("[TIMING] warmed LMDB page cache: {} MB in {:?}", total >> 20, t.elapsed());
        });
    });
}

/// Scan a game installation directory for all WAD archive files.
#[tauri::command]
pub async fn scan_game_wads(game_path: String) -> Result<Vec<GameWadInfo>, String> {
    let _t = ipc_trace::enter("scan_game_wads");
    warm_wad_lmdb_once();
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
                // Normalize to forward slashes: `Path::join` mixes native `\`
                // into the forward-slash `game_path`, giving e.g.
                // `C:/Riot Games/.../Game\DATA\FINAL\...`. Forward slashes are a
                // valid Windows path and match the rest of the app's convention.
                path: path.to_string_lossy().replace('\\', "/"),
                name: name.to_string(),
                category,
            })
        })
        .collect();

    wads.sort_unstable_by(|a, b| a.category.cmp(&b.category).then(a.name.cmp(&b.name)));

    Ok(wads)
}
