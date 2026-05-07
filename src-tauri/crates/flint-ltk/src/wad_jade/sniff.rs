//! Lazy magic-byte sniffer for WAD chunks whose path-hash isn't in any
//! hashtable. Adds an extension to the resolved fallback name (e.g.
//! `aabbccddeeff0011` → `aabbccddeeff0011.dds`) so the in-app file
//! browser shows real types and icons instead of treating every
//! unhashed entry as "unknown".
//!
//! Runs once, on demand, after [`super::mount::mount`]. We stream-
//! decompress just the first few bytes of each unresolved chunk
//! (`zstd::Decoder` and `flate2::GzDecoder` both stop pushing output
//! once we read enough, so the cost is one zstd frame header + a small
//! window — ~ms per chunk, fully parallel via rayon).

use crate::wad_jade::extractor::sniff_magic;
use crate::wad_jade::format::{WadChunk, WadCompression};
use crate::wad_jade::mount::{registry_write, with_mount};
use crate::error::{Error, Result};
use memmap2::Mmap;
use rayon::prelude::*;
use std::fs::File;
use std::io::Read;

/// First-byte window we ask the decoder for. 16 covers every magic
/// in [`crate::wad_jade::extractor::sniff_magic`] (longest is the
/// 8-byte r3d2 family) with headroom for future formats.
const PEEK_BYTES: usize = 16;

/// Sniff every chunk in `mount_id` whose resolved path is still the
/// 16-char hex fallback, append the magic-derived extension, and write
/// the result back into the mount's resolved map.
///
/// Returns the number of chunks that gained an extension. Cheap no-op
/// when the mount id is unknown.
pub fn sniff_unknown_in_mount(mount_id: u64) -> Result<usize> {
    // Snapshot under the read lock so the parallel work doesn't pin
    // the registry. Capturing chunks + WAD path is enough — the rest
    // we recompute.
    let snapshot = with_mount(mount_id, |m| {
        // Only chunks whose resolved name equals the hex fallback need
        // a sniff. Anything else already has a real (or extensionless
        // but resolved) name that the user can recognise.
        let mut targets: Vec<(u64, WadChunk)> = Vec::new();
        for c in &m.chunks {
            let hex = format!("{:016x}", c.path_hash);
            match m.resolved.get(&c.path_hash) {
                Some(name) if name == &hex => targets.push((c.path_hash, *c)),
                None => targets.push((c.path_hash, *c)),
                _ => {}
            }
        }
        (m.path.clone(), targets)
    });
    let (wad_path, targets) = match snapshot {
        Some(v) => v,
        None => return Ok(0),
    };
    if targets.is_empty() {
        return Ok(0);
    }

    let mmap = {
        let file = File::open(&wad_path).map_err(|e| Error::io_with_path(e, &wad_path))?;
        // SAFETY: same contract as the extractor — backing file is on
        // local disk and we only read.
        unsafe { Mmap::map(&file).map_err(|e| Error::io_with_path(e, &wad_path))? }
    };
    let mmap_slice: &[u8] = &mmap;

    // Run the peek + sniff in parallel. The result is a Vec of just
    // the chunks where we got a hit — keeps the merge step cheap.
    let updates: Vec<(u64, &'static str)> = targets
        .par_iter()
        .filter_map(|(hash, chunk)| {
            let peek = peek_decompressed(mmap_slice, chunk, PEEK_BYTES)?;
            let ext = sniff_magic(&peek)?;
            Some((*hash, ext))
        })
        .collect();

    if updates.is_empty() {
        return Ok(0);
    }

    // Write-lock the registry exactly once and patch resolved in place.
    let mut count = 0usize;
    let guard = registry_write();
    let mut g = guard.write();
    if let Some(mount) = g.get_mut(&mount_id) {
        for (hash, ext) in updates {
            let hex = format!("{:016x}", hash);
            // Only overwrite the hex fallback — never clobber a real
            // resolved path (the overlay or LMDB might've filled it
            // between snapshot and write).
            let needs_update = match mount.resolved.get(&hash) {
                Some(name) => name == &hex,
                None => true,
            };
            if needs_update {
                mount.resolved.insert(hash, format!("{}{}", hex, ext));
                count += 1;
            }
        }
    }
    Ok(count)
}

/// Decompress (or copy) at most `max_bytes` from the start of the
/// chunk's payload. `None` if the bytes can't be reached for any
/// reason — caller treats that as "extension unknown" and moves on.
fn peek_decompressed(mmap: &[u8], chunk: &WadChunk, max_bytes: usize) -> Option<Vec<u8>> {
    let start = chunk.data_offset as usize;
    let end = start.checked_add(chunk.compressed_size as usize)?;
    if end > mmap.len() {
        return None;
    }
    let raw = &mmap[start..end];

    match chunk.compression {
        WadCompression::None => {
            let take = max_bytes.min(raw.len());
            Some(raw[..take].to_vec())
        }
        WadCompression::Zstd | WadCompression::ZstdMulti => {
            let mut dec = zstd::Decoder::new(raw).ok()?;
            let mut buf = vec![0u8; max_bytes];
            let n = read_exact_or_eof(&mut dec, &mut buf).ok()?;
            buf.truncate(n);
            Some(buf)
        }
        WadCompression::GZip => {
            let mut dec = flate2::read::GzDecoder::new(raw);
            let mut buf = vec![0u8; max_bytes];
            let n = read_exact_or_eof(&mut dec, &mut buf).ok()?;
            buf.truncate(n);
            Some(buf)
        }
        WadCompression::Satellite => None,
    }
}

/// Read into `buf` until full or EOF. Stream decoders sometimes return
/// 0 before the stream actually ends (intermediate frame boundary), so
/// we loop and break only on a truly empty read.
fn read_exact_or_eof<R: Read>(r: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = r.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}
