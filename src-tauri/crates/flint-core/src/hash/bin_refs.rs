//! Scan a project's BIN files for the asset hashes they reference.
//!
//! Two passes per BIN: a structured parse collecting `File(u64)` values, and a
//! raw byte scan for bare 16-hex tokens and asset-path strings. The byte scan
//! is the fallback for BINs that fail to parse.

use rustc_hash::FxHashMap;
use std::collections::HashSet;
use std::path::Path;
use walkdir::WalkDir;

/// Known asset path extensions used when scanning BIN bytes for path strings.
const ASSET_EXTS: &[&str] = &[
    "dds", "tex", "scb", "skn", "sco", "bnk", "wpk", "wem", "anm", "png",
    "tga", "bin", "troybin", "luabin", "stringtable", "json",
];

/// Walk a `BinValue` tree and collect any `File(u64)` hashes into `set`.
/// `File` is the only `BinValue` variant that holds a u64 WAD-style xxh64 file
/// reference.  `Hash(u32)` and `Link(u32)` are FNV1a-32 entry/type hashes —
/// NOT file path hashes — so they are intentionally skipped.
fn collect_file_hashes_from_value(value: &crate::bin::BinValue, set: &mut HashSet<u64>) {
    use crate::bin::BinValue;
    match value {
        BinValue::File(h) => { set.insert(*h); }
        BinValue::List { items, .. } => {
            for item in items {
                collect_file_hashes_from_value(item, set);
            }
        }
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for v in fields.values() {
                collect_file_hashes_from_value(v, set);
            }
        }
        BinValue::Option { value: Some(inner), .. } => {
            collect_file_hashes_from_value(inner, set);
        }
        BinValue::Map { entries, .. } => {
            for (k, v) in entries {
                collect_file_hashes_from_value(k, set);
                collect_file_hashes_from_value(v, set);
            }
        }
        _ => {}
    }
}

/// One referenced asset found while scanning a project's BINs.
///
/// `path` is `Some` when the reference came from a path string (so the name is
/// recoverable) and `None` for structured `BinValue::File(u64)` references,
/// which store only the hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferencedAsset {
    pub hash: u64,
    pub path: Option<String>,
}

/// Scan all `.bin` files under `wad_root` for referenced assets — structured
/// `BinValue::File(u64)` values, bare 16-hex tokens, and `xxh64(lowercased
/// path)` for any asset-path-looking ASCII substring.
pub fn collect_referenced_assets(wad_root: &Path) -> Vec<ReferencedAsset> {
    // hash → best-known path. `None` means "referenced, but no string behind it
    // yet"; a later hit carrying a path upgrades the entry in place.
    //
    // Keyed rather than a Vec because duplicate hashes are the common case —
    // the same asset path recurs across many BINs and repeatedly within each —
    // so the upgrade lookup must be O(1), not a rescan.
    let mut found: FxHashMap<u64, Option<String>> = FxHashMap::default();

    for entry in WalkDir::new(wad_root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("bin") {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else { continue };

        // --- Structured pass: parse the binary BIN and extract File(u64). ---
        // Ignore parse errors; the byte-scan below acts as a fallback.
        if let Ok(bin) = crate::bin::read_bin(&bytes) {
            let mut hashes: HashSet<u64> = HashSet::new();
            for entry in &bin.entries {
                for value in entry.fields.values() {
                    collect_file_hashes_from_value(value, &mut hashes);
                }
            }
            for h in hashes {
                found.entry(h).or_insert(None);
            }
        }

        // --- Byte-scan pass: walk bytes collecting printable ASCII runs. ---
        let mut i = 0usize;
        while i < bytes.len() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_graphic() {
                i += 1;
            }
            let run_len = i - start;
            if run_len < 4 {
                i += 1;
                continue;
            }
            let Ok(s) = std::str::from_utf8(&bytes[start..i]) else {
                i += 1;
                continue;
            };

            if run_len == 16 && s.chars().all(|c| c.is_ascii_hexdigit()) {
                if let Ok(h) = u64::from_str_radix(s, 16) {
                    found.entry(h).or_insert(None);
                }
            }

            if s.contains('/') {
                let lower = s.to_lowercase();
                if ASSET_EXTS.iter().any(|ext| lower.ends_with(&format!(".{}", ext))) {
                    let h = xxhash_rust::xxh64::xxh64(lower.as_bytes(), 0);
                    let slot = found.entry(h).or_insert(None);
                    if slot.is_none() {
                        *slot = Some(lower);
                    }
                }
            }

            i += 1;
        }
    }

    found
        .into_iter()
        .map(|(hash, path)| ReferencedAsset { hash, path })
        .collect()
}
