//! Hash recovery scanner — finds asset path strings inside decompressed
//! WAD chunks so unknown hashes get a real name.
//!
//! PROP/PTCH (BIN) chunks are scanned with two complementary passes:
//!
//! 1. **Length-prefixed pass** — sliding 1-byte window matching u16-length
//!    UTF-8 records that start with one of [`PATH_PREFIXES`]. Same shape
//!    Quartz uses, kept so the resulting `hashes.extracted.txt` stays
//!    byte-compatible.
//! 2. **Free-form ASCII pass** — walks contiguous runs of path-safe
//!    bytes (alnum + `/._-`) and accepts any run that contains `/` AND
//!    ends with a known asset extension. Catches paths that *don't*
//!    start with one of the rooted prefixes (Riot embeds plenty: shader
//!    refs, particle libraries, mode-specific assets), and is what makes
//!    Jade's recall noticeably better than Quartz's stock scanner.
//!
//! Both passes lowercase before hashing (matches WAD path-hash convention)
//! and feed into the same dedupe map so overlapping hits cost nothing.
//!
//! SKN scanning is unchanged from Quartz — fixed-layout submesh table,
//! magic `0x00112233`, 80-byte header per submesh, first 64 bytes are a
//! null-terminated bone/blend name. FNV1a hashes feed the BIN unhasher
//! (separate domain from WAD path resolution).

use std::collections::HashMap;
use std::hash::Hasher;
use twox_hash::XxHash64;

/// Known asset roots in Riot WADs. Quartz's original list (top group)
/// plus modes/particles/shaders/materials/etc. that frequently host
/// paths the BIN serializer references but Quartz's scanner skipped.
const PATH_PREFIXES: &[&[u8]] = &[
    b"assets/",
    b"data/",
    b"maps/",
    b"levels/",
    b"clientstates/",
    b"ux/",
    b"uiautoatlas/",
    // Mode/feature assets — ship inside their own root buckets in modern WADs.
    b"cherryassets/",
    b"arenaassets/",
    b"tftassets/",
    b"swiftplayassets/",
    b"loadouts/",
    b"shaders/",
    b"common/",
    b"plugins/",
    b"particles/",
    b"materials/",
    b"characters/",
    b"items/",
    b"perks/",
    b"summonerbacks/",
    b"summonericons/",
    b"summonerspells/",
];

/// Known asset extensions used by the free-form ASCII pass to validate
/// candidate runs. Lower-case, includes leading dot. Sorted longest-first
/// so `.luaobj` matches before `.lua`, etc.
const KNOWN_EXTENSIONS: &[&str] = &[
    ".stringtable",
    ".lightgrid",
    ".troybin",
    ".materials",
    ".preload",
    ".luaobj",
    ".mapgeo",
    ".cdtb",
    ".bnk",
    ".troy",
    ".json",
    ".cfx",
    ".dat",
    ".dds",
    ".tex",
    ".skn",
    ".skl",
    ".anm",
    ".bin",
    ".lua",
    ".ogg",
    ".png",
    ".jpg",
    ".scb",
    ".sco",
    ".nvr",
    ".wpk",
    ".fx",
    ".py",
];

/// Bytes accepted inside a free-form ASCII path run.
#[inline]
fn is_path_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-')
}

#[inline]
fn ends_with_known_ext(s: &str) -> bool {
    let lower = s.as_bytes();
    KNOWN_EXTENSIONS.iter().any(|ext| {
        let eb = ext.as_bytes();
        lower.len() > eb.len()
            && lower[lower.len() - eb.len()..]
                .iter()
                .zip(eb.iter())
                .all(|(a, b)| a.eq_ignore_ascii_case(b))
    })
}

/// xxh64 of a lowercase asset path. Matches the WAD path-hash function
/// the LMDB tables are keyed on.
fn xxhash_path(s: &str) -> u64 {
    let mut h = XxHash64::with_seed(0);
    h.write(s.as_bytes());
    h.finish()
}

/// FNV1a-32 of a lowercased ASCII string. Matches Riot's BIN hash function
/// (used by `ltk_ritobin` for entry/field/type/hash lookups).
fn fnv1a_lower(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in s.bytes().map(|b| b.to_ascii_lowercase()) {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Scan a PROP/PTCH chunk for asset path strings. Runs both the
/// length-prefixed pass (Quartz-compatible) and the free-form ASCII
/// pass (Jade's recall extension). Returns deduplicated `(xxh64, path)`
/// tuples — duplicates across passes cost a single HashMap lookup.
///
/// Bails out early on any other magic so the caller can dispatch by
/// `data[..4]` without pre-filtering.
pub fn scan_chunk_for_paths(data: &[u8]) -> Vec<(u64, String)> {
    if data.len() < 4 {
        return Vec::new();
    }
    if &data[..4] != b"PROP" && &data[..4] != b"PTCH" {
        return Vec::new();
    }

    let mut results: HashMap<u64, String> = HashMap::with_capacity(64);
    scan_length_prefixed(data, &mut results);
    scan_free_ascii(data, &mut results);
    results.into_iter().collect()
}

/// Pass 1 — sliding u16 length-prefixed scan over the BIN body. Wider
/// length window than Quartz (5..=512 vs. 8..=300) so short
/// `<root>/x.bin` paths and very-long compound names also land.
fn scan_length_prefixed(data: &[u8], out: &mut HashMap<u64, String>) {
    let mut i = 0usize;
    while i + 2 <= data.len() {
        let len = u16::from_le_bytes([data[i], data[i + 1]]) as usize;
        if (5..=512).contains(&len) {
            if let Some(slice) = data.get(i + 2..i + 2 + len) {
                if let Ok(s) = std::str::from_utf8(slice) {
                    let lb = s.as_bytes();
                    let is_path = s.contains('/')
                        && s.is_ascii()
                        && PATH_PREFIXES
                            .iter()
                            .any(|p| lb.len() >= p.len() && lb[..p.len()].eq_ignore_ascii_case(p));
                    if is_path {
                        enroll(s, out);
                        // Skip past the consumed string — record was a real hit.
                        i += 2 + len;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
}

/// Pass 2 — free-form ASCII run scanner. Walks contiguous spans of
/// path-safe bytes (alnum + `/._-`) and accepts any span that contains
/// a `/` AND ends with one of [`KNOWN_EXTENSIONS`].
///
/// This is what catches paths Quartz misses: anything not rooted under
/// the [`PATH_PREFIXES`] allowlist (sub-paths emitted as standalone
/// strings, mode-only roots Riot adds without updating older scanners,
/// shader/particle references inside packed structs).
fn scan_free_ascii(data: &[u8], out: &mut HashMap<u64, String>) {
    let mut start = 0usize;
    let mut i = 0usize;
    let n = data.len();
    while i <= n {
        let in_run = i < n && is_path_byte(data[i]);
        if !in_run {
            let len = i - start;
            // Lower bound at 5 — anything shorter can't realistically be
            // a slash-containing path with a known extension, and the
            // false-positive rate climbs sharply on tiny runs.
            if len >= 5 {
                if let Ok(s) = std::str::from_utf8(&data[start..i]) {
                    if s.contains('/') && ends_with_known_ext(s) && validate_path_shape(s) {
                        enroll(s, out);
                    }
                }
            }
            start = i + 1;
        }
        i += 1;
    }
}

/// Reject obvious garbage that happens to satisfy the byte-class +
/// suffix test: leading `/`, leading `.`, runs of double-slashes,
/// extension-only runs (`/.dds`), etc. Cheap structural sanity check.
fn validate_path_shape(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let first = bytes[0];
    if matches!(first, b'/' | b'.' | b'-' | b'_') {
        return false;
    }
    if s.contains("//") {
        return false;
    }
    // Need at least one alpha byte before the first `/` so we don't
    // accept "_/foo.dds" style noise.
    let slash = match s.find('/') {
        Some(p) => p,
        None => return false,
    };
    if !bytes[..slash].iter().any(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    // Reject runs where the file stem is empty (e.g. ends in "/.dds").
    if let Some(last_slash) = s.rfind('/') {
        if let Some(dot) = s[last_slash + 1..].find('.') {
            if dot == 0 {
                return false;
            }
        }
    }
    true
}

/// Enroll a candidate path string + its derivatives into `out`, keyed
/// by xxh64(lowercase). Same derivative rules Quartz uses (HD-texture
/// twins for `.dds`, Python-sidecar for `.bin`) so the on-disk overlay
/// stays interoperable.
fn enroll(s: &str, out: &mut HashMap<u64, String>) {
    let lower = s.to_ascii_lowercase();
    let h = xxhash_path(&lower);
    out.entry(h).or_insert_with(|| lower.clone());

    if lower.ends_with(".dds") {
        let slash = lower.rfind('/').map(|i| i + 1).unwrap_or(0);
        let dir = &lower[..slash];
        let fname = &lower[slash..];
        let v2x = format!("{}2x_{}", dir, fname);
        let v4x = format!("{}4x_{}", dir, fname);
        let h2 = xxhash_path(&v2x);
        out.entry(h2).or_insert(v2x);
        let h4 = xxhash_path(&v4x);
        out.entry(h4).or_insert(v4x);
    }
    if lower.ends_with(".bin") {
        let py = format!("{}.py", &lower[..lower.len() - 4]);
        let hp = xxhash_path(&py);
        out.entry(hp).or_insert(py);
    }
}

/// Scan a SKN chunk's submesh table for bone/blend names. Yields
/// `(fnv1a_lower(name), name)` tuples. Empty for any other format.
pub fn scan_chunk_for_bin_names(data: &[u8]) -> Vec<(u32, String)> {
    if data.len() < 12 {
        return Vec::new();
    }
    let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    if magic != 0x0011_2233 {
        return Vec::new();
    }
    let major = u16::from_le_bytes([data[4], data[5]]);
    if major == 0 {
        return Vec::new();
    }
    let count = u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize;
    if count == 0 || count > 256 {
        return Vec::new();
    }

    let mut out = Vec::with_capacity(count);
    let mut pos = 12usize;
    for _ in 0..count {
        if pos + 80 > data.len() {
            break;
        }
        let name_bytes = &data[pos..pos + 64];
        let null_pos = name_bytes.iter().position(|&b| b == 0).unwrap_or(64);
        if let Ok(name) = std::str::from_utf8(&name_bytes[..null_pos]) {
            if !name.is_empty() {
                out.push((fnv1a_lower(name), name.to_string()));
            }
        }
        pos += 80;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xxhash_is_deterministic() {
        // Determinism guard — twox-hash version bumps shouldn't change the
        // seed-0 output for ASCII strings, otherwise the on-disk overlay
        // becomes incompatible with prior writes (and with Quartz).
        let a = xxhash_path("assets/characters/aatrox/skins/skin0.bin");
        let b = xxhash_path("assets/characters/aatrox/skins/skin0.bin");
        assert_eq!(a, b);
        assert_ne!(a, xxhash_path("assets/characters/aatrox/skins/skin1.bin"));
    }

    #[test]
    fn fnv1a_lower_known_value() {
        // FNV1a-32 of "" (the empty string) is the offset basis.
        assert_eq!(fnv1a_lower(""), 0x811c_9dc5);
        // FNV1a-32 of "a" lowercase, computed by hand: 0xe40c292c.
        assert_eq!(fnv1a_lower("a"), 0xe40c_292c);
        // Lowercasing happens internally.
        assert_eq!(fnv1a_lower("A"), fnv1a_lower("a"));
    }

    #[test]
    fn rejects_non_prop_chunks() {
        assert!(scan_chunk_for_paths(b"OggS").is_empty());
        assert!(scan_chunk_for_bin_names(b"PROP\x00\x00\x00\x00\x00\x00\x00\x00").is_empty());
    }

    #[test]
    fn validate_path_shape_rejects_noise() {
        assert!(!validate_path_shape("/foo.dds"));
        assert!(!validate_path_shape(".foo.dds"));
        assert!(!validate_path_shape("a//b.dds"));
        assert!(!validate_path_shape("___/x.dds"));
        assert!(!validate_path_shape("foo/.dds"));
        assert!(validate_path_shape("foo/bar.dds"));
        assert!(validate_path_shape("assets/x/y.dds"));
    }

    #[test]
    fn ends_with_known_ext_basic() {
        assert!(ends_with_known_ext("foo/bar.dds"));
        assert!(ends_with_known_ext("foo/bar.LUAOBJ"));
        assert!(!ends_with_known_ext("foo/bar"));
        assert!(!ends_with_known_ext(".dds"));
    }

    #[test]
    fn free_ascii_pass_catches_unrooted_paths() {
        // PROP magic + filler, then an unrooted path that the
        // length-prefixed allowlist scan would skip but the free-form
        // scan catches via the .dds extension. Surrounded by null
        // bytes so the run boundary is unambiguous.
        let mut buf: Vec<u8> = b"PROP".to_vec();
        buf.extend_from_slice(&[0u8; 8]);
        buf.extend_from_slice(b"\x00\x00characters/aatrox/skins/skin0_textures/diffuse.dds\x00\x00");
        buf.extend_from_slice(&[0u8; 4]);
        let hits = scan_chunk_for_paths(&buf);
        assert!(
            hits.iter().any(|(_, p)| p == "characters/aatrox/skins/skin0_textures/diffuse.dds"),
            "expected unrooted .dds path to be enrolled, got: {:?}",
            hits
        );
        // .dds derivatives still emitted.
        assert!(hits.iter().any(|(_, p)| p.starts_with("2x_") || p.contains("/2x_")));
    }

    #[test]
    fn length_prefixed_pass_still_works() {
        // Rooted path through the classic u16 length-prefixed pass.
        let path = b"assets/characters/aatrox/skins/skin0.bin";
        let len = (path.len() as u16).to_le_bytes();
        let mut buf: Vec<u8> = b"PROP".to_vec();
        buf.extend_from_slice(&[0u8; 8]);
        buf.extend_from_slice(&len);
        buf.extend_from_slice(path);
        let hits = scan_chunk_for_paths(&buf);
        assert!(hits.iter().any(|(_, p)| p == "assets/characters/aatrox/skins/skin0.bin"));
        // .bin derivative emitted.
        assert!(hits.iter().any(|(_, p)| p == "assets/characters/aatrox/skins/skin0.py"));
    }
}
