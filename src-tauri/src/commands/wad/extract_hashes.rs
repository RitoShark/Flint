//! Extract WAD path hashes from BIN/SKN chunks.
//!
//! * **Game hashes** (xxhash64) — length-prefixed UTF-8 asset-path strings
//!   inside `PROP`/`PTCH` BIN files (prefixed `assets/`, `data/`, `maps/`,
//!   `levels/`, `clientstates/`, `ux/`, `uiautoatlas/`). `.dds` paths also emit
//!   `2x_`/`4x_` variants; `.bin` paths emit their `.py` cousin.
//! * **BIN hashes** (fnv1a-lower 32-bit) — null-terminated mesh range names
//!   inside SKN files (magic `0x00112233`).
//!
//! Pairs are merged into `hashes.extracted.txt` (xxhash64 hex → path) and
//! `hashes.binhashes.extracted.txt` (fnv1a hex → name) in the user hash dir.

use flint_core::wad_jade::adapter::WadHandle as WadReader;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use flint_core::heed::types::{Bytes, Str};
use flint_core::heed::Database;

// ─── Scanners (port of Quartz's bin_hashes.rs) ──────────────────────────────

const PATH_PREFIXES: &[&[u8]] = &[
    b"assets/",
    b"data/",
    b"maps/",
    b"levels/",
    b"clientstates/",
    b"ux/",
    b"uiautoatlas/",
];

fn xxhash_path(s: &str) -> u64 {
    xxhash_rust::xxh64::xxh64(s.as_bytes(), 0)
}

fn fnv1a_lower(s: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in s.bytes().map(|b| b.to_ascii_lowercase()) {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

/// Scan a BIN (`PROP` / `PTCH`) for length-prefixed asset paths.
fn scan_bin_game_hashes(data: &[u8]) -> Vec<(u64, String)> {
    if data.len() < 4 {
        return vec![];
    }
    if &data[..4] != b"PROP" && &data[..4] != b"PTCH" {
        return vec![];
    }
    let mut results = Vec::new();
    let mut i = 0usize;
    while i + 2 <= data.len() {
        let len = u16::from_le_bytes([data[i], data[i + 1]]) as usize;
        if (8..=300).contains(&len) {
            if let Some(slice) = data.get(i + 2..i + 2 + len) {
                if let Ok(s) = std::str::from_utf8(slice) {
                    let lb = s.as_bytes();
                    let is_path = s.contains('/')
                        && s.is_ascii()
                        && PATH_PREFIXES
                            .iter()
                            .any(|p| lb.len() >= p.len() && lb[..p.len()].eq_ignore_ascii_case(p));
                    if is_path {
                        let lower = s.to_ascii_lowercase();
                        results.push((xxhash_path(&lower), lower.clone()));
                        if lower.ends_with(".dds") {
                            let slash = lower.rfind('/').map(|v| v + 1).unwrap_or(0);
                            let dir = &lower[..slash];
                            let fname = &lower[slash..];
                            let v2x = format!("{}2x_{}", dir, fname);
                            let v4x = format!("{}4x_{}", dir, fname);
                            results.push((xxhash_path(&v2x), v2x));
                            results.push((xxhash_path(&v4x), v4x));
                        }
                        if lower.ends_with(".bin") {
                            let py = format!("{}.py", &lower[..lower.len() - 4]);
                            results.push((xxhash_path(&py), py));
                        }
                        i += 2 + len;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    results
}

/// Scan a SKN file for mesh range names.
fn scan_skn_bin_hashes(data: &[u8]) -> Vec<(u32, String)> {
    if data.len() < 12 {
        return vec![];
    }
    let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    if magic != 0x0011_2233 {
        return vec![];
    }
    let major = u16::from_le_bytes([data[4], data[5]]);
    if major == 0 {
        return vec![];
    }
    let range_count = u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize;
    if range_count == 0 || range_count > 256 {
        return vec![];
    }
    let mut results = Vec::with_capacity(range_count);
    let mut pos = 12usize;
    for _ in 0..range_count {
        if pos + 80 > data.len() {
            break;
        }
        let name_bytes = &data[pos..pos + 64];
        let null_pos = name_bytes.iter().position(|&b| b == 0).unwrap_or(64);
        if let Ok(name) = std::str::from_utf8(&name_bytes[..null_pos]) {
            if !name.is_empty() {
                results.push((fnv1a_lower(name), name.to_string()));
            }
        }
        pos += 80;
    }
    results
}

pub(crate) fn scan_one(
    data: &[u8],
    game_out: &mut BTreeMap<u64, String>,
    bin_out: &mut BTreeMap<u32, String>,
) {
    for (k, v) in scan_bin_game_hashes(data) {
        game_out.entry(k).or_insert(v);
    }
    for (k, v) in scan_skn_bin_hashes(data) {
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

    let hash_dir_str = hash_dir.to_string_lossy().to_string();
    if !game_for_lmdb.is_empty() {
        if let Err(e) = merge_into_wad_lmdb(&hash_dir_str, &game_for_lmdb) {
            tracing::warn!("Failed to merge extracted game hashes into LMDB: {}", e);
        }
    }
    if !bin_for_lmdb.is_empty() {
        if let Err(e) = merge_into_bin_lmdb(&hash_dir_str, &bin_for_lmdb) {
            tracing::warn!("Failed to merge extracted bin hashes into LMDB: {}", e);
        }
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
        outputs.push(
            hash_dir
                .join("hashes.extracted.txt")
                .to_string_lossy()
                .to_string(),
        );
    }
    if added_bin > 0 {
        outputs.push(
            hash_dir
                .join("hashes.binhashes.extracted.txt")
                .to_string_lossy()
                .to_string(),
        );
    }

    Ok(ExtractHashesResult {
        scanned,
        game_hashes_added: added_game,
        bin_hashes_added: added_bin,
        output_files: outputs,
    })
}
