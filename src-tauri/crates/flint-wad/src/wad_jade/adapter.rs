//! Jade-backed WAD reader + extractor API: `WadHandle` (`.chunks()`,
//! `.get_chunk(hash)`, `.wad_mut()`), the `WadChunks` collection, and the
//! `extract_chunks_parallel` / `extract_chunk` / `find_champion_wad` helpers.

use flint_hash::error::{Error, Result};
use flint_hash::hash::ResolvedHashes;
use crate::wad_jade::chunk_io::read_chunk_decompressed_bytes;
use crate::wad_jade::format::WadChunk;
use crate::wad_jade::reader::{read_wad_toc, WadToc};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

pub use crate::wad_jade::format::WadChunk as Chunk;

/// One entry in the extraction plan: chunk descriptor, output path, and an
/// optional (relative-path, absolute-path) mapping recorded when a long
/// filename had to be saved under its hash.
type ExtractPlanEntry = (WadChunk, PathBuf, Option<(String, String)>);

pub struct WadChunks {
    chunks: Vec<WadChunk>,
    by_hash: HashMap<u64, usize>,
}

impl WadChunks {
    pub fn iter(&self) -> std::slice::Iter<'_, WadChunk> { self.chunks.iter() }
    pub fn get(&self, path_hash: u64) -> Option<&WadChunk> {
        self.by_hash.get(&path_hash).map(|&i| &self.chunks[i])
    }
    pub fn len(&self) -> usize { self.chunks.len() }
    pub fn is_empty(&self) -> bool { self.chunks.is_empty() }
}

impl<'a> IntoIterator for &'a WadChunks {
    type Item = &'a WadChunk;
    type IntoIter = std::slice::Iter<'a, WadChunk>;
    fn into_iter(self) -> Self::IntoIter { self.chunks.iter() }
}

pub struct WadHandle {
    toc: WadToc,
    chunks: WadChunks,
}

impl WadHandle {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        tracing::debug!("Opening WAD (jade): {}", path.display());
        let toc = read_wad_toc(path)?;
        let chunks_vec = toc.chunks.clone();
        let by_hash: HashMap<u64, usize> = chunks_vec
            .iter()
            .enumerate()
            .map(|(i, c)| (c.path_hash, i))
            .collect();
        Ok(Self {
            toc,
            chunks: WadChunks { chunks: chunks_vec, by_hash },
        })
    }

    pub fn chunks(&self) -> &WadChunks { &self.chunks }
    pub fn get_chunk(&self, path_hash: u64) -> Option<&WadChunk> { self.chunks.get(path_hash) }
    pub fn chunk_count(&self) -> usize { self.chunks.len() }

    pub fn wad_mut(&mut self) -> WadDecoder<'_> { WadDecoder { toc: &self.toc } }
}

pub struct WadDecoder<'a> {
    toc: &'a WadToc,
}

impl WadDecoder<'_> {
    pub fn load_chunk_decompressed(&mut self, chunk: &WadChunk) -> Result<Vec<u8>> {
        read_chunk_decompressed_bytes(&self.toc.path, chunk)
    }
}

/// Locate a champion's WAD at `Game/DATA/FINAL/Champions/<champ>.wad.client`.
pub fn find_champion_wad(league_path: impl AsRef<Path>, champion: &str) -> Option<PathBuf> {
    let candidate = league_path
        .as_ref()
        .join("Game")
        .join("DATA")
        .join("FINAL")
        .join("Champions")
        .join(format!("{}.wad.client", champion));
    if candidate.exists() { Some(candidate) } else { None }
}

/// Single-chunk extract — used by preview commands.
pub fn extract_chunk(
    decoder: &mut WadDecoder<'_>,
    chunk: &WadChunk,
    output_path: impl AsRef<Path>,
    _resolve_path: Option<&dyn Fn(u64) -> String>,
) -> Result<()> {
    let output_path = output_path.as_ref();
    let bytes = decoder.load_chunk_decompressed(chunk)?;
    if bytes.len() != chunk.uncompressed_size as usize {
        tracing::warn!(
            "Chunk size mismatch: expected {}, got {}",
            chunk.uncompressed_size,
            bytes.len()
        );
    }
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
    }
    let mut f = File::create(output_path).map_err(|e| Error::io_with_path(e, output_path))?;
    f.write_all(&bytes).map_err(|e| Error::io_with_path(e, output_path))?;
    Ok(())
}

/// Bulk parallel extract. Returns `(extracted, failed, path_mappings)`.
///
/// `chunk_hashes = None` extracts every chunk; otherwise only chunks whose
/// path-hash is in the set. Hash resolution is the caller's job via the
/// `resolve_paths` closure.
pub fn extract_chunks_parallel(
    wad_path: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    chunk_hashes: Option<&HashSet<u64>>,
    resolve_paths: impl Fn(&[u64]) -> ResolvedHashes,
) -> Result<(usize, usize, HashMap<String, String>)> {
    let wad_path = wad_path.as_ref();
    let output_dir = output_dir.as_ref();

    let toc = read_wad_toc(wad_path)?;

    let target_chunks: Vec<WadChunk> = match chunk_hashes {
        Some(want) => toc.chunks.iter().filter(|c| want.contains(&c.path_hash)).copied().collect(),
        None => toc.chunks.clone(),
    };
    let total = target_chunks.len();
    if total == 0 {
        return Ok((0, 0, HashMap::new()));
    }

    let all_hashes: Vec<u64> = target_chunks.iter().map(|c| c.path_hash).collect();
    let resolved_map = resolve_paths(&all_hashes);

    let plan: Vec<ExtractPlanEntry> = target_chunks
        .par_iter()
        .map(|chunk| {
            let path_hash = chunk.path_hash;
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

    let parents: HashSet<PathBuf> = plan
        .par_iter()
        .fold(HashSet::new, |mut acc, (_, out_path, _)| {
            if let Some(p) = out_path.parent() { acc.insert(p.to_path_buf()); }
            acc
        })
        .reduce(HashSet::new, |mut a, b| { a.extend(b); a });
    parents.par_iter().for_each(|p| { let _ = fs::create_dir_all(p); });

    use std::sync::atomic::{AtomicUsize, Ordering};
    let extracted = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    plan.par_iter().for_each(|(chunk, out_path, _)| {
        match read_chunk_decompressed_bytes(wad_path, chunk) {
            Ok(bytes) => {
                match File::create(out_path).and_then(|mut f| f.write_all(&bytes)) {
                    Ok(_) => { extracted.fetch_add(1, Ordering::Relaxed); }
                    Err(e) => {
                        tracing::warn!("Failed to write chunk to {}: {}", out_path.display(), e);
                        failed.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Failed to decode chunk {:016x}: {}", chunk.path_hash, e);
                failed.fetch_add(1, Ordering::Relaxed);
            }
        }
    });

    Ok((extracted.into_inner(), failed.into_inner(), path_mappings))
}
