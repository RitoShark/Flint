//! Decompress and write WAD chunks to disk.
//!
//! Decompression layer
//! -------------------
//! - **None**: passthrough.
//! - **GZip**: `flate2`.
//! - **Zstd / ZstdMulti**: `zstd::stream::decode_all` handles both single-
//!   and multi-frame streams (the loop in zstd-rs concatenates frames
//!   automatically), so we don't need separate code paths.
//! - **Satellite**: Riot's old subchunk-table format. Not extracted — chunk
//!   is skipped with a logged warning.
//!
//! Concurrency
//! -----------
//! `extract_to_dir` slices the chunk plan across rayon threads. Each
//! worker opens its own `File` handle on the WAD (cheap on Windows since
//! the OS keeps the file's pages cached after the TOC parse) and seeks
//! independently. No mutex on the source.
//!
//! Progress
//! --------
//! Workers emit `wad-extract-progress` Tauri events tagged with an
//! `action_id` UUID-ish string supplied by the caller. The frontend
//! filters by `action_id` so multiple concurrent extractions don't bleed.

use crate::wad_jade::format::{WadChunk, WadCompression};
use crate::wad_jade::mount::with_mount;
use crate::error::{Error, Result};
use parking_lot::Mutex;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tauri::Emitter;
use memmap2::Mmap;

const MAX_PATH_LEN: usize = 240;
const PROGRESS_EVENT: &str = "wad-extract-progress";

/// Extraction summary returned to the frontend on completion.
#[derive(Debug, Clone, Serialize)]
pub struct ExtractResult {
    pub action_id: String,
    pub written: usize,
    pub skipped: usize,
    pub errors: usize,
    pub elapsed_ms: u64,
    pub output_dir: String,
    pub cancelled: bool,
}

#[derive(Clone, Serialize)]
struct ExtractProgress<'a> {
    action_id: &'a str,
    phase: &'static str, // "preparing" | "extracting" | "complete" | "cancelled" | "error"
    current: u64,
    total: u64,
    written: u64,
    errors: u64,
    message: &'a str,
}

// ── Cancellation registry ─────────────────────────────────────────────────────

static CANCEL_FLAGS: OnceLock<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>> =
    OnceLock::new();

fn cancel_flags() -> &'static Mutex<std::collections::HashMap<String, Arc<AtomicBool>>> {
    CANCEL_FLAGS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn register_cancel(action_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    cancel_flags()
        .lock()
        .insert(action_id.to_string(), Arc::clone(&flag));
    flag
}

fn deregister_cancel(action_id: &str) {
    cancel_flags().lock().remove(action_id);
}

/// Set the cancel flag for `action_id` if a running extraction is using it.
/// Returns `true` when the id matched.
pub fn cancel_extraction(action_id: &str) -> bool {
    if let Some(flag) = cancel_flags().lock().get(action_id) {
        flag.store(true, Ordering::SeqCst);
        return true;
    }
    false
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Extract every chunk in the named mount whose path-hash is in `selected`,
/// or every chunk if `selected` is empty. Writes go under `output_dir`,
/// preserving the resolved directory layout.
///
/// `use_rename`: when true (default), each chunk is written to
/// `<path>.jdtmp` then renamed over the target — fast even when the
/// destination already exists, since NTFS doesn't have to truncate +
/// re-allocate the existing file's extents. When false, falls back to
/// a direct `File::create` + write (slower in-place overwrite, but
/// leaves no temp files behind on cancel).
pub fn extract_to_dir(
    app: &tauri::AppHandle<tauri::Wry>,
    mount_id: u64,
    selected: &HashSet<u64>,
    output_dir: &Path,
    action_id: &str,
    use_rename: bool,
) -> Result<ExtractResult> {
    let started = Instant::now();
    let cancel = register_cancel(action_id);
    let result = extract_inner(app, mount_id, selected, output_dir, action_id, &cancel, use_rename);
    deregister_cancel(action_id);
    let mut summary = result?;
    summary.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(summary)
}

fn extract_inner(
    app: &tauri::AppHandle<tauri::Wry>,
    mount_id: u64,
    selected: &HashSet<u64>,
    output_dir: &Path,
    action_id: &str,
    cancel: &Arc<AtomicBool>,
    use_rename: bool,
) -> Result<ExtractResult> {
    // Snapshot the chunks + resolved paths under the read lock so workers
    // can run without blocking other commands. We copy chunk metadata
    // (28 bytes each) and clone path strings — for a 20k-chunk WAD that's
    // ~2 MB of allocation, cheap relative to extraction itself.
    let plan = with_mount(mount_id, |m| {
        let wad_path = m.path.clone();
        let mut entries: Vec<PlanEntry> = m
            .chunks
            .iter()
            .filter(|c| selected.is_empty() || selected.contains(&c.path_hash))
            .map(|c| {
                let hex = format!("{:016x}", c.path_hash);
                let path = m.resolved.get(&c.path_hash).cloned().unwrap_or(hex.clone());
                PlanEntry {
                    chunk: *c,
                    path,
                    hex,
                }
            })
            .collect();
        // Sort by data_offset so workers stream forward through the file.
        entries.sort_by_key(|e| e.chunk.data_offset);
        (wad_path, entries)
    })
    .ok_or_else(|| Error::Wad {
        message: format!("No mounted WAD with id {}", mount_id),
        path: None,
    })?;

    let (wad_path, plan) = plan;
    let total = plan.len() as u64;

    emit(
        app,
        ExtractProgress {
            action_id,
            phase: "preparing",
            current: 0,
            total,
            written: 0,
            errors: 0,
            message: "Creating output directories...",
        },
    );

    std::fs::create_dir_all(output_dir).map_err(|e| Error::io_with_path(e, output_dir))?;

    // Memory-map the WAD once and share the byte slice across rayon
    // workers. The previous per-chunk `File::open` was paying a Windows
    // CreateFile syscall ~5–20k times per extraction; mmap fronts the
    // file with a single mapping that the OS pages in lazily as workers
    // slice into it. Same approach Flint and Quartz use.
    let mmap = {
        let file = File::open(&wad_path).map_err(|e| Error::io_with_path(e, &wad_path))?;
        unsafe { Mmap::map(&file).map_err(|e| Error::io_with_path(e, &wad_path))? }
    };
    let mmap = Arc::new(mmap);

    // Pre-create every directory once (sequential — it's I/O bound but
    // tiny relative to extraction). Avoids races between workers and a
    // mountain of redundant `create_dir_all` calls.
    let mut prepared_dirs: HashSet<PathBuf> = HashSet::new();
    for entry in &plan {
        if let Some(parent) = resolve_output_path(output_dir, &entry.path).parent() {
            if prepared_dirs.insert(parent.to_path_buf()) {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    eprintln!(
                        "[WadExtract] Failed to create dir {}: {}",
                        parent.display(),
                        e
                    );
                }
            }
        }
    }

    let written = AtomicU64::new(0);
    let skipped = AtomicU64::new(0);
    let errors = AtomicU64::new(0);
    let progress_counter = AtomicU64::new(0);
    let last_emit = Mutex::new(Instant::now());

    // Slice the work and let rayon dispatch — its default thread pool
    // sizes itself to the available cores.
    plan.par_iter().for_each(|entry| {
        if cancel.load(Ordering::SeqCst) {
            return;
        }

        match extract_one(&mmap, entry, output_dir, use_rename) {
            Ok(ExtractOutcome::Written) => {
                written.fetch_add(1, Ordering::Relaxed);
            }
            Ok(ExtractOutcome::Skipped) => {
                skipped.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => {
                errors.fetch_add(1, Ordering::Relaxed);
                eprintln!("[WadExtract] {} → {}", entry.path, e);
            }
        }

        let done = progress_counter.fetch_add(1, Ordering::Relaxed) + 1;
        // Throttle progress emits to ~20 Hz so we don't flood the IPC
        // channel for fast extractions.
        let now = Instant::now();
        let mut last = last_emit.lock();
        if done == total || now.duration_since(*last).as_millis() >= 50 {
            *last = now;
            drop(last);
            emit(
                app,
                ExtractProgress {
                    action_id,
                    phase: "extracting",
                    current: done,
                    total,
                    written: written.load(Ordering::Relaxed),
                    errors: errors.load(Ordering::Relaxed),
                    message: "",
                },
            );
        }
    });

    let cancelled = cancel.load(Ordering::SeqCst);
    let final_phase = if cancelled { "cancelled" } else { "complete" };
    emit(
        app,
        ExtractProgress {
            action_id,
            phase: final_phase,
            current: progress_counter.load(Ordering::Relaxed),
            total,
            written: written.load(Ordering::Relaxed),
            errors: errors.load(Ordering::Relaxed),
            message: "",
        },
    );

    Ok(ExtractResult {
        action_id: action_id.to_string(),
        written: written.load(Ordering::Relaxed) as usize,
        skipped: skipped.load(Ordering::Relaxed) as usize,
        errors: errors.load(Ordering::Relaxed) as usize,
        elapsed_ms: 0, // filled by caller
        output_dir: output_dir.to_string_lossy().into_owned(),
        cancelled,
    })
}

fn emit(app: &tauri::AppHandle<tauri::Wry>, payload: ExtractProgress<'_>) {
    let _ = app.emit(PROGRESS_EVENT, payload);
}

// ── Per-chunk pipeline ────────────────────────────────────────────────────────

struct PlanEntry {
    chunk: WadChunk,
    path: String,
    hex: String,
}

enum ExtractOutcome {
    Written,
    Skipped,
}

fn extract_one(
    mmap: &Mmap,
    entry: &PlanEntry,
    output_dir: &Path,
    use_rename: bool,
) -> Result<ExtractOutcome> {
    if matches!(entry.chunk.compression, WadCompression::Satellite) {
        // The Satellite format isn't moddable today; skip with a log.
        eprintln!("[WadExtract] Skipping Satellite-compressed chunk {}", entry.hex);
        return Ok(ExtractOutcome::Skipped);
    }

    // Slice the compressed bytes straight out of the mmap'd WAD. No
    // per-chunk file open, no seek + read_exact — the OS will page in
    // the underlying file region on first touch.
    let start = entry.chunk.data_offset as usize;
    let end = start
        .checked_add(entry.chunk.compressed_size as usize)
        .ok_or_else(|| Error::Wad {
            message: format!("Chunk size overflow at offset {}", start),
            path: None,
        })?;
    if end > mmap.len() {
        return Err(Error::Wad {
            message: format!(
                "Chunk extends past WAD end (offset={}, size={}, mmap_len={})",
                start, end - start, mmap.len()
            ),
            path: None,
        });
    }
    let raw = &mmap[start..end];
    let decompressed = decompress_(raw, entry.chunk.compression, entry.chunk.uncompressed_size)?;

    // If the resolved path lacks an extension (i.e. it's a hex fallback),
    // sniff the magic bytes to add one. Keeps unknown buckets organised.
    let final_path = augment_path_with_extension(&entry.path, &decompressed);
    let mut out_path = resolve_output_path(output_dir, &final_path);

    if path_too_long(&out_path) {
        out_path = output_dir.join(format!("{}{}", entry.hex, sniff_extension(&decompressed).unwrap_or("")));
        if let Some(parent) = out_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
    }

    if use_rename {
        // Write-then-rename pattern. `File::create` on Windows treats
        // an existing target as a truncate, which on NTFS deallocates
        // every extent of the old file + journals each step — that's
        // the ~3× slowdown users see when re-extracting into a
        // populated folder. Writing to a fresh `.jdtmp` and renaming
        // over the final path skips that dance: the rename is one MFT
        // pointer flip with `MOVEFILE_REPLACE_EXISTING` semantics
        // (Rust std default on Windows), so overwrite is ~as fast as
        // a fresh create.
        let original_name = out_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| Error::Wad {
                message: format!("Invalid output filename: {}", out_path.display()),
                path: None,
            })?
            .to_string();
        let mut tmp_path = out_path.clone();
        tmp_path.set_file_name(format!("{}.jdtmp", original_name));

        let mut file = match File::create(&tmp_path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if let Some(parent) = tmp_path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
                }
                File::create(&tmp_path).map_err(|e| Error::io_with_path(e, &tmp_path))?
            }
            Err(e) => return Err(Error::io_with_path(e, &tmp_path)),
        };
        file.write_all(&decompressed)
            .map_err(|e| Error::io_with_path(e, &tmp_path))?;
        drop(file);

        std::fs::rename(&tmp_path, &out_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            Error::io_with_path(e, &out_path)
        })?;
    } else {
        // Classic in-place overwrite. Slower on NTFS for re-extracts
        // (truncate + extent dance) but never leaves `.jdtmp` files
        // behind on cancel.
        let mut file = match File::create(&out_path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if let Some(parent) = out_path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
                }
                File::create(&out_path).map_err(|e| Error::io_with_path(e, &out_path))?
            }
            Err(e) => return Err(Error::io_with_path(e, &out_path)),
        };
        file.write_all(&decompressed)
            .map_err(|e| Error::io_with_path(e, &out_path))?;
    }
    Ok(ExtractOutcome::Written)
}

/// Chunk I/O helpers shared by extraction and the on-demand preview command.
/// Public-but-pub(super) so they're reachable from `wad_commands` without
/// turning into general API surface.
pub(crate) mod chunk_io {
    use super::*;

    pub fn read_chunk_raw(wad_path: &Path, chunk: &WadChunk) -> Result<Vec<u8>> {
        let mut file = File::open(wad_path).map_err(|e| Error::io_with_path(e, wad_path))?;
        file.seek(SeekFrom::Start(chunk.data_offset))
            .map_err(|e| Error::io_with_path(e, wad_path))?;
        let mut buf = vec![0u8; chunk.compressed_size as usize];
        file.read_exact(&mut buf)
            .map_err(|e| Error::io_with_path(e, wad_path))?;
        Ok(buf)
    }

    pub fn decompress(
        raw: &[u8],
        kind: WadCompression,
        expected_uncompressed: u64,
    ) -> Result<Vec<u8>> {
        match kind {
            WadCompression::None => Ok(raw.to_vec()),
            WadCompression::GZip => {
                let mut decoder = flate2::read::GzDecoder::new(raw);
                let mut out = Vec::with_capacity(expected_uncompressed as usize);
                decoder.read_to_end(&mut out).map_err(|e| Error::Wad {
                    message: format!("GZip decode failed: {}", e),
                    path: None,
                })?;
                Ok(out)
            }
            WadCompression::Zstd | WadCompression::ZstdMulti => {
                zstd::stream::decode_all(raw).map_err(|e| Error::Wad {
                    message: format!("Zstd decode failed: {}", e),
                    path: None,
                })
            }
            WadCompression::Satellite => Err(Error::Wad {
                message: "Satellite compression not supported".to_string(),
                path: None,
            }),
        }
    }

    /// One-shot read + decompress, used by the preview command. Heavy enough
    /// (TEX/DDS files reach a few MB) to warrant the caller running it on
    /// the blocking pool.
    pub fn read_chunk_decompressed_bytes(wad_path: &Path, chunk: &WadChunk) -> Result<Vec<u8>> {
        let raw = read_chunk_raw(wad_path, chunk)?;
        decompress(&raw, chunk.compression, chunk.uncompressed_size)
    }
}

use chunk_io::decompress as decompress_;

// ── Path handling ─────────────────────────────────────────────────────────────

fn resolve_output_path(output_dir: &Path, asset_path: &str) -> PathBuf {
    let normalized = asset_path.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');

    // Strip any `..` / drive-letter components — defense against malicious
    // paths even though Riot WADs don't actually contain them.
    let mut safe = PathBuf::new();
    for component in Path::new(trimmed).components() {
        if let std::path::Component::Normal(seg) = component {
            safe.push(seg);
        }
    }
    output_dir.join(safe)
}

fn path_too_long(path: &Path) -> bool {
    path.to_string_lossy().len() > MAX_PATH_LEN
}

fn augment_path_with_extension(path: &str, data: &[u8]) -> String {
    let p = Path::new(path);
    if p.extension().is_some() {
        return path.to_string();
    }
    if let Some(ext) = sniff_extension(data) {
        return format!("{}{}", path, ext);
    }
    path.to_string()
}

/// Cheap magic-byte sniffer for the formats League ships. Returns the
/// extension *with* the leading dot, or `None` when we don't recognise
/// the data — caller leaves the file extensionless in that case.
///
/// Visible to the rest of the crate so the WAD-list view can run the
/// same sniff against a streamed peek of each compressed chunk and
/// surface a real extension on hash-named entries (instead of the user
/// seeing every unknown file as just `aabbccddeeff0011`).
pub(crate) fn sniff_magic(data: &[u8]) -> Option<&'static str> {
    sniff_extension(data)
}
///
/// This runs on **every** chunk written when the resolved path lacks an
/// extension (typically: hash-named files where the WAD path-hash isn't
/// in any hashtable). Quartz writes hashed files with the same magic-
/// derived extensions so users can still tell at a glance whether
/// `aabbccddeeff0011.dds` is a texture or
/// `aabbccddeeff0011.bin` is a property file — Jade matches the
/// behaviour here.
fn sniff_extension(data: &[u8]) -> Option<&'static str> {
    if data.len() < 4 {
        return None;
    }

    // Eight-byte r3d2-family magics first — these would otherwise be
    // shadowed by the four-byte `r3d2` catch-all and we'd mis-tag every
    // SKL/ANM/SCB as one common type.
    if data.len() >= 8 && &data[0..4] == b"r3d2" {
        return Some(match &data[0..8] {
            b"r3d2sklt" => ".skl",
            b"r3d2anmd" | b"r3d2canm" => ".anm",
            b"r3d2Mesh" => ".scb",
            b"r3d2aims" => ".aimesh",
            // Anything else with the r3d2 prefix is most often a
            // Wwise package (.wpk) — Riot's container for sound data.
            _ => ".wpk",
        });
    }

    // SKN — magic `0x00112233` little-endian, appears as the first u32.
    if u32::from_le_bytes([data[0], data[1], data[2], data[3]]) == 0x0011_2233 {
        return Some(".skn");
    }

    // Four-byte ASCII magics — fast path for the rest.
    match &data[0..4] {
        b"PROP" | b"PTCH" => return Some(".bin"),
        b"DDS " => return Some(".dds"),
        b"OggS" => return Some(".ogg"),
        b"\x89PNG" => return Some(".png"),
        b"BKHD" => return Some(".bnk"),
        b"OEGM" => return Some(".mapgeo"),
        b"TEX\0" => return Some(".tex"),
        b"\x1bLua" | b"\x1bLJ\x01" | b"\x1bLJ\x02" => return Some(".luaobj"),
        _ => {}
    }

    // Three-byte / shorter magics.
    if data.starts_with(b"\xff\xd8\xff") {
        return Some(".jpg");
    }
    if data.starts_with(b"RST") {
        return Some(".stringtable");
    }
    if data.starts_with(b"<lua") {
        return Some(".lua");
    }
    if data.starts_with(b"GIF8") {
        return Some(".gif");
    }
    // glTF / config JSON. Crude but everything else with a leading `{`
    // in the corpus is JSON-ish.
    if data.starts_with(b"{") {
        return Some(".json");
    }

    None
}
