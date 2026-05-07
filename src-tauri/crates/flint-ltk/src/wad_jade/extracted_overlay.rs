//! User-discovered hash overlay — sits on top of the LMDB tables so
//! WAD-scan results show up in the UI immediately without waiting for
//! upstream `lmdb-hashes` releases.
//!
//! On-disk format (Quartz-compatible — same `%APPDATA%/FrogTools/hashes/`
//! directory, same filenames):
//!
//! - `hashes.extracted.txt`         — `{hex16} {path}\n` per line, WAD path overlay.
//! - `hashes.binhashes.extracted.txt` — `{hex8} {name}\n` per line, BIN field/entry overlay.
//!
//! Both files are sorted by path/name on write. We preserve whatever
//! Quartz already wrote (entries are merged, never replaced) so users
//! can run scans in either tool without losing discoveries.
//!
//! In-memory state is cached behind a `parking_lot::RwLock` keyed on the
//! file mtime — re-reads are O(1) when the file hasn't changed.

use crate::error::{Error, Result};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

const WAD_OVERLAY_FILE: &str = "hashes.extracted.txt";
const BIN_OVERLAY_FILE: &str = "hashes.binhashes.extracted.txt";

#[derive(Default)]
struct CachedOverlay {
    /// Source file path the cache was loaded from. Cache is invalidated
    /// (key mismatch) if the FrogTools dir moves between calls.
    source: PathBuf,
    /// File mtime at load time. Re-read when this changes, otherwise the
    /// cached `Arc<HashMap>` is reused.
    mtime: Option<SystemTime>,
    /// hash → resolved string (Arc so callers don't pay per-lookup clones).
    map: Arc<HashMap<u64, Arc<str>>>,
}

#[derive(Default)]
struct CachedBinOverlay {
    source: PathBuf,
    mtime: Option<SystemTime>,
    map: Arc<HashMap<u32, Arc<str>>>,
}

static WAD_OVERLAY: OnceLock<RwLock<CachedOverlay>> = OnceLock::new();
static BIN_OVERLAY: OnceLock<RwLock<CachedBinOverlay>> = OnceLock::new();

fn wad_cell() -> &'static RwLock<CachedOverlay> {
    WAD_OVERLAY.get_or_init(|| RwLock::new(CachedOverlay::default()))
}

fn bin_cell() -> &'static RwLock<CachedBinOverlay> {
    BIN_OVERLAY.get_or_init(|| RwLock::new(CachedBinOverlay::default()))
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok().and_then(|m| m.modified().ok())
}

fn parse_wad_overlay(path: &Path) -> HashMap<u64, Arc<str>> {
    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let mut out = HashMap::with_capacity(content.lines().size_hint().0);
    for line in content.lines() {
        // `{hex16} {path}` — first space splits hash from path.
        let Some((h, p)) = line.split_once(' ') else {
            continue;
        };
        let raw = h.trim().trim_start_matches("0x").trim_start_matches("0X");
        if let Ok(hash) = u64::from_str_radix(raw, 16) {
            // Insert-only: first occurrence wins. Files are unique per Quartz
            // and our writers, but be defensive about hand edits.
            out.entry(hash).or_insert_with(|| Arc::from(p));
        }
    }
    out
}

fn parse_bin_overlay(path: &Path) -> HashMap<u32, Arc<str>> {
    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let mut out = HashMap::with_capacity(content.lines().size_hint().0);
    for line in content.lines() {
        let Some((h, p)) = line.split_once(' ') else {
            continue;
        };
        let raw = h.trim().trim_start_matches("0x").trim_start_matches("0X");
        if let Ok(hash) = u32::from_str_radix(raw, 16) {
            out.entry(hash).or_insert_with(|| Arc::from(p));
        }
    }
    out
}

/// Load the WAD-path overlay map for `hash_dir`, reusing the cached copy
/// when the file's mtime hasn't changed since the last read. Returns an
/// empty map when the file is missing — never errors.
pub fn wad_overlay(hash_dir: &Path) -> Arc<HashMap<u64, Arc<str>>> {
    let path = hash_dir.join(WAD_OVERLAY_FILE);
    let mtime = file_mtime(&path);

    {
        let g = wad_cell().read();
        if g.source == path && g.mtime == mtime && !g.map.is_empty() {
            return Arc::clone(&g.map);
        }
        // Empty cached map for an existing file is fine to reuse too —
        // re-parsing wouldn't change anything if mtime matches.
        if g.source == path && g.mtime == mtime {
            return Arc::clone(&g.map);
        }
    }

    let map = Arc::new(parse_wad_overlay(&path));
    let mut g = wad_cell().write();
    g.source = path;
    g.mtime = mtime;
    g.map = Arc::clone(&map);
    map
}

/// Load the BIN-name overlay (FNV1a u32 → name) — same caching contract
/// as [`wad_overlay`].
pub fn bin_overlay(hash_dir: &Path) -> Arc<HashMap<u32, Arc<str>>> {
    let path = hash_dir.join(BIN_OVERLAY_FILE);
    let mtime = file_mtime(&path);

    {
        let g = bin_cell().read();
        if g.source == path && g.mtime == mtime {
            return Arc::clone(&g.map);
        }
    }

    let map = Arc::new(parse_bin_overlay(&path));
    let mut g = bin_cell().write();
    g.source = path;
    g.mtime = mtime;
    g.map = Arc::clone(&map);
    map
}

/// Drop both cached overlays. Next read re-loads from disk. Called by
/// the writer after a successful merge so subsequent hash queries pick
/// up the new entries.
pub fn invalidate() {
    let mut g = wad_cell().write();
    *g = CachedOverlay::default();
    let mut g = bin_cell().write();
    *g = CachedBinOverlay::default();
}

/// Summary returned to the UI after a merge — lets the frontend show
/// "added 1,234 new paths".
#[derive(Debug, Clone, Copy, Default)]
pub struct MergeStats {
    pub wad_added: usize,
    pub bin_added: usize,
    pub wad_total: usize,
    pub bin_total: usize,
}

/// Merge new (hash → string) entries into the on-disk overlay files,
/// preserving any existing entries and appending the deltas. Output is
/// sorted by string for stable diffs and for parity with Quartz's writer.
///
/// Caller passes both maps even when one is empty — we still touch the
/// untouched file's cache so the next read sees a consistent state.
pub fn merge_and_write(
    hash_dir: &Path,
    new_wad: &HashMap<u64, Arc<str>>,
    new_bin: &HashMap<u32, Arc<str>>,
) -> Result<MergeStats> {
    fs::create_dir_all(hash_dir).map_err(|e| Error::io_with_path(e, hash_dir))?;

    let mut stats = MergeStats::default();

    // ── WAD ──────────────────────────────────────────────────────────
    {
        let path = hash_dir.join(WAD_OVERLAY_FILE);
        let mut existing = parse_wad_overlay(&path);
        let before = existing.len();
        for (k, v) in new_wad.iter() {
            existing.entry(*k).or_insert_with(|| Arc::clone(v));
        }
        stats.wad_added = existing.len().saturating_sub(before);
        stats.wad_total = existing.len();

        if stats.wad_added > 0 || !path.exists() {
            let mut entries: Vec<(&u64, &Arc<str>)> = existing.iter().collect();
            entries.sort_by(|a, b| a.1.as_ref().cmp(b.1.as_ref()));
            let mut buf = String::with_capacity(entries.len() * 96);
            for (hash, p) in &entries {
                let _ = writeln!(buf, "{:016x} {}", hash, p);
            }
            atomic_write(&path, buf.as_bytes())?;
        }
    }

    // ── BIN ──────────────────────────────────────────────────────────
    {
        let path = hash_dir.join(BIN_OVERLAY_FILE);
        let mut existing = parse_bin_overlay(&path);
        let before = existing.len();
        for (k, v) in new_bin.iter() {
            existing.entry(*k).or_insert_with(|| Arc::clone(v));
        }
        stats.bin_added = existing.len().saturating_sub(before);
        stats.bin_total = existing.len();

        if stats.bin_added > 0 && !existing.is_empty() {
            let mut entries: Vec<(&u32, &Arc<str>)> = existing.iter().collect();
            entries.sort_by(|a, b| a.1.as_ref().cmp(b.1.as_ref()));
            let mut buf = String::with_capacity(entries.len() * 40);
            for (hash, p) in &entries {
                let _ = writeln!(buf, "{:08x} {}", hash, p);
            }
            atomic_write(&path, buf.as_bytes())?;
        }
    }

    invalidate();
    Ok(stats)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    // Tmp-then-rename so a partial write never corrupts the file Quartz
    // is also reading from.
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| Error::io_with_path(e, &tmp))?;
    fs::rename(&tmp, path).map_err(|e| Error::io_with_path(e, path))?;
    Ok(())
}
