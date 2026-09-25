//! Extract WAD path hashes from BIN/SKN chunks.
//!
//! * **Game hashes** (xxhash64) — length-prefixed UTF-8 asset-path strings
//!   inside `PROP`/`PTCH` BIN files, including custom folder roots and
//!   free-form asset references. `.dds` paths also emit
//!   `2x_`/`4x_` variants; `.bin` paths emit their `.py` cousin.
//! * **BIN hashes** (fnv1a-lower 32-bit) — null-terminated mesh range names
//!   inside SKN files (magic `0x00112233`).
//!
//! Pairs are merged into `hashes.extracted.txt` (xxhash64 hex → path) and
//! `hashes.binhashes.extracted.txt` (fnv1a hex → name) in the user hash dir.

use flint_core::path_slash::to_slash;
use flint_core::wad::adapter::WadHandle as WadReader;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use flint_core::heed::types::{Bytes, Str};
use flint_core::heed::Database;

// ─── Scanners (port of Quartz's bin_hashes.rs) ──────────────────────────────

// Share recovery behavior between manual unhash and archive imports.
use flint_core::wad::hash_scanner::{scan_chunk_for_bin_names, scan_chunk_for_paths};

pub(crate) fn scan_one(
    data: &[u8],
    game_out: &mut BTreeMap<u64, String>,
    bin_out: &mut BTreeMap<u32, String>,
) {
    for (k, v) in scan_chunk_for_paths(data) {
        game_out.entry(k).or_insert(v);
    }
    for (k, v) in scan_chunk_for_bin_names(data) {
        bin_out.entry(k).or_insert(v);
    }
}

// ─── Merge writer (also from Quartz) ────────────────────────────────────────

fn write_merged(
    hash_dir: &Path,
    new_game: BTreeMap<u64, String>,
    new_bin: BTreeMap<u32, String>,
) -> Result<(usize, usize), String> {
    let mut added_game = 0usize;
    let mut added_bin = 0usize;

    if !new_game.is_empty() {
        let path = hash_dir.join("hashes.extracted.txt");
        let mut merged: BTreeMap<u64, String> = BTreeMap::new();
        if let Ok(content) = fs::read_to_string(&path) {
            for line in content.lines() {
                if let Some((h, p)) = line.split_once(' ') {
                    if let Ok(v) = u64::from_str_radix(h, 16) {
                        merged.entry(v).or_insert_with(|| p.to_string());
                    }
                }
            }
        }
        let before = merged.len();
        for (k, v) in new_game {
            merged.entry(k).or_insert(v);
        }
        added_game = merged.len() - before;
        let mut out = String::new();
        for (k, v) in merged {
            out.push_str(&format!("{:016x} {}\n", k, v));
        }
        fs::write(&path, out)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    }

    if !new_bin.is_empty() {
        let path = hash_dir.join("hashes.binhashes.extracted.txt");
        let mut merged: BTreeMap<u32, String> = BTreeMap::new();
        if let Ok(content) = fs::read_to_string(&path) {
            for line in content.lines() {
                if let Some((h, p)) = line.split_once(' ') {
                    let raw = h.trim_start_matches("0x");
                    if let Ok(v) = u32::from_str_radix(raw, 16) {
                        merged.entry(v).or_insert_with(|| p.to_string());
                    }
                }
            }
        }
        let before = merged.len();
        for (k, v) in new_bin {
            merged.entry(k).or_insert(v);
        }
        added_bin = merged.len() - before;
        let mut out = String::new();
        for (k, v) in merged {
            out.push_str(&format!("{:08x} {}\n", k, v));
        }
        fs::write(&path, out)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    }

    Ok((added_game, added_bin))
}

// ─── LMDB merge helpers ─────────────────────────────────────────────────────

/// Insert (or overwrite) (xxhash64 → path) entries into the cached WAD LMDB.
fn merge_into_wad_lmdb(
    hash_dir: &str,
    entries: &BTreeMap<u64, String>,
) -> Result<usize, String> {
    let env = flint_core::hash::get_wad_env(hash_dir)
        .ok_or_else(|| "WAD LMDB not present (run hash download first)".to_string())?;
    let mut wtxn = env.write_txn().map_err(|e| format!("write_txn: {}", e))?;
    let db: Database<Bytes, Str> = env
        .create_database(&mut wtxn, Some("wad"))
        .map_err(|e| format!("create_database wad: {}", e))?;
    let mut written = 0usize;
    for (h, p) in entries {
        let key = h.to_be_bytes();
        if db.put(&mut wtxn, &key[..], p).is_ok() {
            written += 1;
        }
    }
    wtxn.commit().map_err(|e| format!("commit wad: {}", e))?;
    tracing::info!("Merged {} entries into WAD LMDB", written);
    Ok(written)
}

/// Insert (or overwrite) (fnv1a32 → name) entries into the cached BIN LMDB.
fn merge_into_bin_lmdb(
    hash_dir: &str,
    entries: &BTreeMap<u32, String>,
) -> Result<usize, String> {
    let env = flint_core::hash::get_bin_env(hash_dir)
        .ok_or_else(|| "BIN LMDB not present (run hash download first)".to_string())?;
    let mut wtxn = env.write_txn().map_err(|e| format!("write_txn: {}", e))?;
    let db: Database<Bytes, Str> = env
        .create_database(&mut wtxn, Some("bin"))
        .map_err(|e| format!("create_database bin: {}", e))?;
    let mut written = 0usize;
    for (h, n) in entries {
        let key = h.to_be_bytes();
        if db.put(&mut wtxn, &key[..], n).is_ok() {
            written += 1;
        }
    }
    wtxn.commit().map_err(|e| format!("commit bin: {}", e))?;
    tracing::info!("Merged {} entries into BIN LMDB", written);
    Ok(written)
}

pub(crate) fn extract_and_merge_hashes(
    hash_dir: &Path,
    game: BTreeMap<u64, String>,
    bin: BTreeMap<u32, String>,
) -> Result<(usize, usize), String> {
    let game_for_lmdb = game.clone();
    let bin_for_lmdb = bin.clone();
    let (added_game, added_bin) = write_merged(hash_dir, game, bin)?;
    flint_core::wad::extracted_overlay::invalidate();

    let hash_dir_str = hash_dir.to_string_lossy().to_string();
    let mut written = 0usize;
    if !game_for_lmdb.is_empty() {
        match merge_into_wad_lmdb(&hash_dir_str, &game_for_lmdb) {
            Ok(n) => written += n,
            Err(e) => tracing::warn!("Failed to merge extracted game hashes into LMDB: {}", e),
        }
    }
    if !bin_for_lmdb.is_empty() {
        match merge_into_bin_lmdb(&hash_dir_str, &bin_for_lmdb) {
            Ok(n) => written += n,
            Err(e) => tracing::warn!("Failed to merge extracted bin hashes into LMDB: {}", e),
        }
    }

    /* The in-memory mapper is a SNAPSHOT, taken the first time anything resolved
       a hash. Writing new names to the LMDBs above does not touch it, so without
       this the bin editor kept rendering `0x…` for paths that were now on disk —
       extraction appeared to work, editing a bin did not, and restarting the app
       "fixed" it. Reload so the names are live for the next render. */
    if written > 0 || added_game > 0 || added_bin > 0 {
        tracing::info!("Extraction added {written} hash name(s); reloading the resolver cache");
        flint_core::bin::reload_bin_hash_cache();
    }

    Ok((added_game, added_bin))
}

pub(crate) fn extract_hashes_from_wad_path(
    wad_path: &Path,
    hash_dir: &Path,
) -> Result<(usize, usize, usize), String> {
    let mut reader = WadReader::open(wad_path.to_str().ok_or("Invalid path")?)?;
    let chunks: Vec<_> = reader.chunks().iter().copied().collect();

    let mut game: BTreeMap<u64, String> = BTreeMap::new();
    let mut bin: BTreeMap<u32, String> = BTreeMap::new();
    let mut scanned = 0usize;

    for chunk in &chunks {
        let data = match reader.wad_mut().load_chunk_decompressed(chunk) {
            Ok(d) => d,
            Err(e) => {
                tracing::debug!("Skipping chunk (decompress failed): {}", e);
                continue;
            }
        };
        if data.len() < 4 {
            continue;
        }
        let head = &data[..4];
        let is_bin = head == b"PROP" || head == b"PTCH";
        let is_skn = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) == 0x0011_2233;
        if !is_bin && !is_skn {
            continue;
        }
        scan_one(&data, &mut game, &mut bin);
        scanned += 1;
    }

    let (added_game, added_bin) = extract_and_merge_hashes(hash_dir, game, bin)?;
    Ok((scanned, added_game, added_bin))
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ExtractHashesResult {
    pub scanned: usize,
    pub game_hashes_added: usize,
    pub bin_hashes_added: usize,
    pub output_files: Vec<String>,
}

/// Extract path hashes from BIN/SKN chunks inside a single WAD archive and
/// merge them into the user's hash directory.
#[tauri::command]
pub async fn extract_hashes_from_wad(
    wad_path: String,
) -> Result<ExtractHashesResult, String> {
    let hash_dir = flint_core::hash::get_hash_dir()
        .map_err(|e| format!("Failed to locate hash dir: {}", e))?;
    fs::create_dir_all(&hash_dir)
        .map_err(|e| format!("Failed to create hash dir {}: {}", hash_dir.display(), e))?;

    tracing::info!("Extracting hashes from WAD: {}", wad_path);

    let (scanned, added_game, added_bin) = extract_hashes_from_wad_path(Path::new(&wad_path), &hash_dir)?;

    tracing::info!(
        "Extracted hashes: scanned={} game_new={} bin_new={}",
        scanned,
        added_game,
        added_bin
    );

    let mut outputs = Vec::new();
    if added_game > 0 {
        outputs.push(to_slash(&hash_dir.join("hashes.extracted.txt")));
    }
    if added_bin > 0 {
        outputs.push(to_slash(&hash_dir.join("hashes.binhashes.extracted.txt")));
    }

    Ok(ExtractHashesResult {
        scanned,
        game_hashes_added: added_game,
        bin_hashes_added: added_bin,
        output_files: outputs,
    })
}
