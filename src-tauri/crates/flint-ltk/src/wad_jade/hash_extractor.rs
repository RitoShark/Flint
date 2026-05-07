//! Drive the per-WAD hash scan: decompress every chunk, scan for paths
//! and submesh names, merge results into the on-disk overlay files.
//!
//! Triggered by the `wad_extract_hashes` Tauri command (separate UI
//! action — does not piggyback on regular extraction). Same shape as
//! Quartz's `extractHashesFromWad` so the resulting `hashes.extracted.txt`
//! stays interoperable with the two apps.

use crate::wad_jade::extracted_overlay::{merge_and_write, MergeStats};
use crate::wad_jade::extractor::chunk_io::decompress;
use crate::wad_jade::format::{WadChunk, WadCompression};
use crate::wad_jade::hash_scanner::{scan_chunk_for_bin_names, scan_chunk_for_paths};
use crate::wad_jade::lmdb_hashes::{lookup_bin, lookup_wad};
use crate::wad_jade::mount::{refresh_resolved, with_mount};
use crate::error::{Error, Result};
use memmap2::Mmap;
use parking_lot::Mutex;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;

const PROGRESS_EVENT: &str = "wad-hash-scan-progress";

/// Summary returned to the frontend on completion.
#[derive(Debug, Clone, Serialize)]
pub struct HashScanResult {
    pub action_id: String,
    /// Newly discovered WAD path hashes (not previously in the overlay).
    pub wad_paths_added: usize,
    /// Newly discovered BIN field/entry/etc. names.
    pub bin_names_added: usize,
    /// Total path hashes the scan emitted before LMDB de-dup.
    pub wad_paths_scanned: usize,
    /// Total BIN names emitted before LMDB de-dup.
    pub bin_names_scanned: usize,
    pub total_chunks: usize,
    pub elapsed_ms: u64,
}

#[derive(Clone, Serialize)]
struct ScanProgress<'a> {
    action_id: &'a str,
    /// "preparing" | "scanning" | "merging" | "complete" | "error"
    phase: &'static str,
    current: u64,
    total: u64,
    message: &'a str,
}

fn emit(app: &tauri::AppHandle<tauri::Wry>, payload: ScanProgress<'_>) {
    let _ = app.emit(PROGRESS_EVENT, payload);
}

/// Scan every chunk in `mount_id`, write deltas to the overlay files in
/// `hash_dir`, return aggregate counts. Heavy operation — caller should
/// run on the blocking pool.
pub fn extract_hashes(
    app: &tauri::AppHandle<tauri::Wry>,
    mount_id: u64,
    hash_dir: &Path,
    action_id: &str,
) -> Result<HashScanResult> {
    let started = Instant::now();

    // Snapshot chunks + WAD path under the read lock so workers run unblocked.
    let plan = with_mount(mount_id, |m| {
        (m.path.clone(), m.chunks.clone())
    })
    .ok_or_else(|| Error::Wad {
        message: format!("No mounted WAD with id {}", mount_id),
        path: None,
    })?;

    let (wad_path, chunks): (PathBuf, Vec<WadChunk>) = plan;
    let total = chunks.len() as u64;

    emit(app, ScanProgress {
        action_id, phase: "preparing", current: 0, total, message: "Mapping WAD...",
    });

    let mmap = {
        let file = File::open(&wad_path).map_err(|e| Error::io_with_path(e, &wad_path))?;
        unsafe { Mmap::map(&file).map_err(|e| Error::io_with_path(e, &wad_path))? }
    };
    let mmap = Arc::new(mmap);

    let progress_counter = AtomicU64::new(0);
    let last_emit = Mutex::new(Instant::now());

    emit(app, ScanProgress {
        action_id, phase: "scanning", current: 0, total, message: "Scanning chunks for hashes...",
    });

    // Each worker scans into its own (HashMap, HashMap) — fold then reduce
    // merges them at the end. Same shape Quartz uses.
    type WadMap = HashMap<u64, Arc<str>>;
    type BinMap = HashMap<u32, Arc<str>>;

    let (wad_found, bin_found): (WadMap, BinMap) = chunks
        .par_iter()
        .fold(
            || (WadMap::new(), BinMap::new()),
            |(mut wad_acc, mut bin_acc), chunk| {
                if let Some(decompressed) = decompress_chunk_silent(&mmap, chunk) {
                    for (h, p) in scan_chunk_for_paths(&decompressed) {
                        wad_acc.entry(h).or_insert_with(|| Arc::from(p));
                    }
                    for (h, n) in scan_chunk_for_bin_names(&decompressed) {
                        bin_acc.entry(h).or_insert_with(|| Arc::from(n));
                    }
                }

                let done = progress_counter.fetch_add(1, Ordering::Relaxed) + 1;
                let now = Instant::now();
                let mut last = last_emit.lock();
                if done == total || now.duration_since(*last).as_millis() >= 50 {
                    *last = now;
                    drop(last);
                    emit(app, ScanProgress {
                        action_id,
                        phase: "scanning",
                        current: done,
                        total,
                        message: "",
                    });
                }

                (wad_acc, bin_acc)
            },
        )
        .reduce(
            || (WadMap::new(), BinMap::new()),
            |(mut a_wad, mut a_bin), (b_wad, b_bin)| {
                for (k, v) in b_wad {
                    a_wad.entry(k).or_insert(v);
                }
                for (k, v) in b_bin {
                    a_bin.entry(k).or_insert(v);
                }
                (a_wad, a_bin)
            },
        );

    let wad_paths_scanned = wad_found.len();
    let bin_names_scanned = bin_found.len();

    emit(app, ScanProgress {
        action_id, phase: "merging", current: total, total, message: "Filtering known hashes...",
    });

    // De-dup against LMDB — overlay should only carry hashes upstream
    // doesn't already know. Cheap because both lookup_* keep the env
    // mmap'd; an unknown hash returns None on a single B-tree probe.
    let wad_unknown: WadMap = wad_found
        .into_iter()
        .filter(|(h, _)| lookup_wad(*h, hash_dir).is_none())
        .collect();
    let bin_unknown: BinMap = bin_found
        .into_iter()
        .filter(|(h, _)| lookup_bin(*h, hash_dir).is_none())
        .collect();

    let stats: MergeStats = merge_and_write(hash_dir, &wad_unknown, &bin_unknown)?;

    // Re-resolve this mount's chunks against the freshly-merged overlay
    // so the next `wad_list_entries` call returns real names where the
    // scan recovered them. Without this the in-memory `resolved` map
    // captured at mount time still holds the hex fallbacks.
    refresh_resolved(mount_id);
    // The refresh wipes any magic-sniffed extensions back to bare hex
    // for chunks the overlay didn't cover — re-run the sniff so those
    // entries keep showing real types in the file list.
    let _ = crate::wad_jade::sniff::sniff_unknown_in_mount(mount_id);

    let elapsed_ms = started.elapsed().as_millis() as u64;

    emit(app, ScanProgress {
        action_id, phase: "complete", current: total, total, message: "",
    });

    Ok(HashScanResult {
        action_id: action_id.to_string(),
        wad_paths_added: stats.wad_added,
        bin_names_added: stats.bin_added,
        wad_paths_scanned,
        bin_names_scanned,
        total_chunks: chunks.len(),
        elapsed_ms,
    })
}

/// Decompress a chunk for scanning. Skips Satellite (unsupported) and
/// swallows decode errors silently — corrupt chunks shouldn't fail the
/// whole scan.
fn decompress_chunk_silent(mmap: &Mmap, chunk: &WadChunk) -> Option<Vec<u8>> {
    if matches!(chunk.compression, WadCompression::Satellite) {
        return None;
    }
    let start = chunk.data_offset as usize;
    let end = start.checked_add(chunk.compressed_size as usize)?;
    if end > mmap.len() {
        return None;
    }
    let raw = &mmap[start..end];
    decompress(raw, chunk.compression, chunk.uncompressed_size).ok()
}
