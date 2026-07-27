//! Lazy magic-byte sniffer for WAD chunks whose path-hash isn't in any
//! hashtable. Adds an extension to the resolved fallback name (e.g.
//! `aabbccddeeff0011` → `aabbccddeeff0011.dds`).

use crate::wad_jade::format::{WadChunk, WadCompression};
use crate::wad_jade::mount::{registry_write, with_mount};
use flint_hash::error::{Error, Result};
use memmap2::Mmap;
use rayon::prelude::*;
use std::fs::File;
use std::io::Read;

const PEEK_BYTES: usize = 16;

/// Sniff every chunk in `mount_id` whose resolved path is still the
/// 16-char hex fallback, append the magic-derived extension, and write
/// the result back into the mount's resolved map. Returns the number of
/// chunks that gained an extension.
pub fn sniff_unknown_in_mount(mount_id: u64) -> Result<usize> {
    let snapshot = with_mount(mount_id, |m| {
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

    let mut count = 0usize;
    let guard = registry_write();
    let mut g = guard.write();
    if let Some(mount) = g.get_mut(&mount_id) {
        for (hash, ext) in updates {
            let hex = format!("{:016x}", hash);
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
/// chunk's payload. `None` if the bytes can't be reached.
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

/// Read into `buf` until full or EOF.
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

/// Extension for `data`'s magic bytes, leading dot included.
pub(crate) fn sniff_magic(data: &[u8]) -> Option<&'static str> {
    if data.len() < 4 {
        return None;
    }

    // Eight-byte r3d2-family magics before the four-byte `r3d2` catch-all.
    if data.len() >= 8 && &data[0..4] == b"r3d2" {
        return Some(match &data[0..8] {
            b"r3d2sklt" => ".skl",
            b"r3d2anmd" | b"r3d2canm" => ".anm",
            b"r3d2Mesh" => ".scb",
            b"r3d2aims" => ".aimesh",
            // Other r3d2-prefixed chunks are most often Wwise packages.
            _ => ".wpk",
        });
    }

    // SKN — magic `0x00112233` little-endian as the first u32.
    if u32::from_le_bytes([data[0], data[1], data[2], data[3]]) == 0x0011_2233 {
        return Some(".skn");
    }

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
    // Everything else with a leading `{` in the corpus is JSON-ish.
    if data.starts_with(b"{") {
        return Some(".json");
    }

    None
}
