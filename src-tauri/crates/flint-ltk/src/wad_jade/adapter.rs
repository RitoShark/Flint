//! Compatibility adapter — exposes a Jade-backed API that mirrors the
//! method shapes that Flint's binary crate previously called on
//! `flint_ltk::wad::reader::WadReader` and `flint_ltk::wad::extractor::*`.
//!
//! The point: command files can swap `flint_ltk::wad::reader::WadReader`
//! for `flint_ltk::wad_jade::adapter::WadHandle` and keep the same call
//! shape (`.chunks()`, `.get_chunk(hash)`, `.decode_chunk(chunk)`), with
//! the implementation switched over to Jade's native TOC parser + chunk
//! decoder. No more `league_toolkit::wad::Wad`.
//!
//! The collection wrapper lives here too because the binary crate uses
//! `reader.chunks().iter()`, `.get(hash)`, `.len()` patterns from LTK's
//! `WadChunks`. We keep those exact shapes.

use crate::error::{Error, Result};
use crate::hash::ResolvedHashes;
use crate::wad_jade::extractor::chunk_io::read_chunk_decompressed_bytes;
use crate::wad_jade::format::WadChunk;
use crate::wad_jade::reader::{read_wad_toc, WadToc};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

// Re-export so call sites use the same WadChunk type that flows through
// the rest of the codebase.
pub use crate::wad_jade::format::WadChunk as Chunk;

/// LTK-shape collection over Jade chunks. Provides `.iter()`, `.get(hash)`,
/// `.len()`, `.is_empty()` so existing code keeps working without changes
/// beyond the import swap.
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

/// Drop-in replacement for `flint_ltk::wad::reader::WadReader`, backed by
/// Jade's native TOC parser + chunk decoder.
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

    /// Returns a small handle that decodes individual chunks. Provided so
    /// existing call sites that did `reader.wad_mut().load_chunk_decompressed(c)`
    /// can become `reader.wad_mut().load_chunk_decompressed(c)` unchanged.
    pub fn wad_mut(&mut self) -> WadDecoder<'_> { WadDecoder { toc: &self.toc } }
}

/// Mirrors LTK's `&mut Wad<File>` decode path. Holds an immutable
/// reference to the Jade TOC and decodes on demand.
pub struct WadDecoder<'a> {
    toc: &'a WadToc,
}

impl WadDecoder<'_> {
    pub fn load_chunk_decompressed(&mut self, chunk: &WadChunk) -> Result<Vec<u8>> {
        read_chunk_decompressed_bytes(&self.toc.path, chunk)
    }
}

// =============================================================================
// Drop-in replacements for `flint_ltk::wad::extractor::*` — same signatures.
// =============================================================================

/// Locate a champion's WAD in a League install. Same lookup logic LTK
/// extractor used (Game/DATA/FINAL/Champions/<champ>.wad.client).
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

/// Single-chunk extract — used by preview commands. `_resolve_path`
/// kept in the signature for parity with the LTK version even though
/// the caller already passes the resolved output path.
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

/// Bulk parallel extract. Mirrors LTK's `extract_chunks_parallel`
/// signature exactly so callers don't change. Returns `(extracted, failed)`.
///
/// Implementation: mmap the WAD once, parse TOC via Jade, fan out chunk
/// decoding across rayon. Hash resolution stays the caller's job via
/// the `resolve_paths` closure (matches the LTK extractor — Flint
/// already passes its bulk-LMDB resolver).
pub fn extract_chunks_parallel(
    wad_path: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    chunk_hashes: Option<&HashSet<u64>>,
    resolve_paths: impl Fn(&[u64]) -> ResolvedHashes,
) -> Result<(usize, usize)> {
    let wad_path = wad_path.as_ref();
    let output_dir = output_dir.as_ref();

    // chunk_io::read_chunk_decompressed_bytes opens its own File handle
    // internally per call; we just need the TOC for filtering + planning.
    let toc = read_wad_toc(wad_path)?;

    // Filter the TOC to the requested chunks.
    let target_chunks: Vec<WadChunk> = match chunk_hashes {
        Some(want) => toc.chunks.iter().filter(|c| want.contains(&c.path_hash)).copied().collect(),
        None => toc.chunks.clone(),
    };
    let total = target_chunks.len();
    if total == 0 {
        return Ok((0, 0));
    }

    // Bulk-resolve every hash in one LMDB txn (caller-provided closure).
    let all_hashes: Vec<u64> = target_chunks.iter().map(|c| c.path_hash).collect();
    let resolved_map = resolve_paths(&all_hashes);

    // Build extraction plan in parallel.
    let plan: Vec<(WadChunk, PathBuf)> = target_chunks
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

            // Windows MAX_PATH safety net (mirrors the LTK version).
            let out_path = if candidate.to_string_lossy().len() > 240 {
                let ext = Path::new(resolved)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("bin");
                output_dir.join(format!("{:016x}.{}", path_hash, ext))
            } else {
                candidate
            };
            (*chunk, out_path)
        })
        .collect();

    // Create parent directories in one parallel pass.
    let parents: HashSet<PathBuf> = plan
        .par_iter()
        .fold(HashSet::new, |mut acc, (_, out_path)| {
            if let Some(p) = out_path.parent() { acc.insert(p.to_path_buf()); }
            acc
        })
        .reduce(HashSet::new, |mut a, b| { a.extend(b); a });
    parents.par_iter().for_each(|p| { let _ = fs::create_dir_all(p); });

    // Decode + write per-chunk in parallel.
    use std::sync::atomic::{AtomicUsize, Ordering};
    let extracted = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    plan.par_iter().for_each(|(chunk, out_path)| {
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

    Ok((extracted.into_inner(), failed.into_inner()))
}
