//! Minimal WAD v3.4 serializer used by the in-memory edit pipeline.
//!
//! The reader side already covers v3.1 / v3.4 parsing. This writer is
//! v3.4 only — it's the version League ships today (since 14.x) and the
//! only one mod managers exercise. Older WADs that come in as v3.1 are
//! upgraded to v3.4 on write; the chunk records carry strictly more
//! information in the newer layout.
//!
//! Layout (header is 266 bytes, TOC entry is 32 bytes per chunk):
//!
//! ```text
//! Header
//!   magic              u16     "RW" (0x5752)
//!   major              u8      = 3
//!   minor              u8      = 4
//!   ecdsa_signature   [u8;256] (left zero — League doesn't verify)
//!   data_checksum      u64     (left zero)
//!   chunk_count        i32
//! TOC × chunk_count
//!   path_hash          u64
//!   data_offset        u32
//!   compressed_size    u32
//!   uncompressed_size  u32
//!   type_frame_count   u8      (frame_count << 4 | compression_byte)
//!   start_frame[3]     u8×3    (24-bit, hi/lo/mi)
//!   checksum           u64
//! Data section (concatenated chunk bytes — order matches TOC)
//! ```
//!
//! Compression strategy: zstd everything bigger than 512 bytes when the
//! compressed payload is at least 5% smaller than the source. Otherwise
//! the chunk goes in uncompressed. This matches Riot's heuristic in
//! their own client.bin writer and is what every other modding tool
//! (Obsidian/Fantome/Quartz) does.

use crate::error::{Error, Result};
use crate::wad_jade::format::WadCompression;
use byteorder::{LittleEndian, WriteBytesExt};
use std::io::{Cursor, Write};

const MAGIC_RW: u16 = 0x5752;
const HEADER_SIZE: usize = 2 + 1 + 1 + 256 + 8 + 4; // 272 bytes
const TOC_ENTRY_SIZE_V34: usize = 8 + 4 + 4 + 4 + 1 + 3 + 8; // 32 bytes
const ZSTD_LEVEL: i32 = 17;
const ZSTD_MIN_INPUT: usize = 512;
const ZSTD_KEEP_RATIO: f64 = 0.95;

/// One entry the caller wants serialized. `bytes` is the *decompressed*
/// payload — the writer decides whether to zstd it. `force_uncompressed`
/// is for callers (e.g. test fixtures) that need byte-exact output.
pub struct EntryToWrite {
    pub path_hash: u64,
    pub bytes: Vec<u8>,
    pub force_uncompressed: bool,
}

impl EntryToWrite {
    pub fn new(path_hash: u64, bytes: Vec<u8>) -> Self {
        Self { path_hash, bytes, force_uncompressed: false }
    }
}

/// Tally returned by `write_wad`. Mostly for the UI to surface "wrote N
/// chunks, M bytes" — we don't otherwise care about the numbers.
#[derive(Debug, Clone, Copy)]
pub struct WriteStats {
    pub chunk_count: usize,
    pub total_compressed: u64,
    pub total_uncompressed: u64,
}

/// Serialize entries into a WAD v3.4 binary buffer.
///
/// Entries are sorted by path_hash before writing so the TOC is in
/// hash-ascending order. This matches what League's tooling produces and
/// makes the binary diff-stable across edits that touch the same chunks.
///
/// Duplicate hashes are deduplicated by taking the *last* entry — the
/// caller is expected to have already merged any pending edits over the
/// originals, so duplicates here are a usage bug, not a feature.
pub fn write_wad(entries: Vec<EntryToWrite>) -> Result<(Vec<u8>, WriteStats)> {
    // Dedup-by-hash, last-wins. We compact via HashMap rather than sort+dedup
    // so the caller doesn't have to guarantee ordering.
    let mut map: std::collections::HashMap<u64, EntryToWrite> =
        std::collections::HashMap::with_capacity(entries.len());
    for e in entries {
        map.insert(e.path_hash, e);
    }
    let mut entries: Vec<EntryToWrite> = map.into_values().collect();
    entries.sort_by_key(|e| e.path_hash);

    let chunk_count = entries.len();
    let toc_bytes = chunk_count
        .checked_mul(TOC_ENTRY_SIZE_V34)
        .ok_or_else(|| Error::Wad {
            message: format!("Chunk count overflows TOC size: {}", chunk_count),
            path: None,
        })?;
    let data_start = HEADER_SIZE + toc_bytes;

    // Pre-encode every chunk so we know its compressed size before we
    // write the TOC. Memory: roughly 2× total chunk bytes (raw + zstd
    // buffer) during this step. For typical champion WADs (~200 MB) that
    // peaks at ~400 MB resident — acceptable for an interactive editor.
    let mut encoded: Vec<EncodedEntry> = Vec::with_capacity(entries.len());
    for entry in entries {
        encoded.push(encode_one(entry)?);
    }

    let data_total: u64 = encoded.iter().map(|e| e.compressed.len() as u64).sum();
    let total_size = data_start as u64 + data_total;
    let mut buf: Vec<u8> = Vec::with_capacity(total_size as usize);
    let mut cursor = Cursor::new(&mut buf);

    // Header
    cursor.write_u16::<LittleEndian>(MAGIC_RW)?;
    cursor.write_u8(3)?;
    cursor.write_u8(4)?;
    cursor.write_all(&[0u8; 256])?; // ECDSA signature — zeros
    cursor.write_u64::<LittleEndian>(0)?; // data checksum — zero
    cursor.write_i32::<LittleEndian>(chunk_count as i32)?;

    // TOC — emit while accumulating the running data offset.
    let mut offset = data_start as u64;
    let mut total_uncompressed: u64 = 0;
    let mut total_compressed: u64 = 0;
    for e in &encoded {
        if offset > u32::MAX as u64 {
            // v3.4 stores data_offset as u32. WADs that big would need a
            // version bump; we error rather than silently truncate.
            return Err(Error::Wad {
                message: format!(
                    "WAD too large for v3.4 (data offset {} exceeds u32::MAX)",
                    offset
                ),
                path: None,
            });
        }
        cursor.write_u64::<LittleEndian>(e.path_hash)?;
        cursor.write_u32::<LittleEndian>(offset as u32)?;
        cursor.write_u32::<LittleEndian>(e.compressed.len() as u32)?;
        cursor.write_u32::<LittleEndian>(e.uncompressed_size as u32)?;

        // type_frame_count: frame_count (high nibble) << 4 | compression (low nibble).
        // We never write multi-frame chunks (the multi-frame compression
        // type is for streamed audio; League's tooling only emits it for
        // sound banks). frame_count = 0.
        let type_byte = (0u8 << 4) | (e.compression as u8);
        cursor.write_u8(type_byte)?;
        // start_frame: 24-bit, ordered hi / lo / mi as the reader expects.
        cursor.write_u8(0)?;
        cursor.write_u8(0)?;
        cursor.write_u8(0)?;
        cursor.write_u64::<LittleEndian>(e.checksum)?;

        offset += e.compressed.len() as u64;
        total_uncompressed += e.uncompressed_size;
        total_compressed += e.compressed.len() as u64;
    }

    // Data section — emit in TOC order.
    for e in &encoded {
        cursor.write_all(&e.compressed)?;
    }

    Ok((
        buf,
        WriteStats {
            chunk_count,
            total_compressed,
            total_uncompressed,
        },
    ))
}

struct EncodedEntry {
    path_hash: u64,
    compressed: Vec<u8>,
    uncompressed_size: u64,
    compression: WadCompression,
    checksum: u64,
}

fn encode_one(entry: EntryToWrite) -> Result<EncodedEntry> {
    let uncompressed_size = entry.bytes.len() as u64;

    let (data, compression) = if entry.force_uncompressed || entry.bytes.len() < ZSTD_MIN_INPUT {
        (entry.bytes, WadCompression::None)
    } else {
        let raw_len = entry.bytes.len();
        match zstd::stream::encode_all(&entry.bytes[..], ZSTD_LEVEL) {
            Ok(zbytes) => {
                if (zbytes.len() as f64) < (raw_len as f64) * ZSTD_KEEP_RATIO {
                    (zbytes, WadCompression::Zstd)
                } else {
                    // Zstd didn't save enough — store raw so the reader
                    // doesn't pay decompression cost for a no-op.
                    (entry.bytes, WadCompression::None)
                }
            }
            Err(e) => {
                tracing::warn!(
                    "zstd encode failed for hash {:016x}: {} — storing uncompressed",
                    entry.path_hash, e
                );
                (entry.bytes, WadCompression::None)
            }
        }
    };

    // Checksum is xxh3-64 of the compressed payload. Riot's writer uses
    // this value; the client tolerates zero, but other modding tools
    // verify it, so we compute it properly.
    let checksum = xxhash_rust::xxh3::xxh3_64(&data);

    Ok(EncodedEntry {
        path_hash: entry.path_hash,
        compressed: data,
        uncompressed_size,
        compression,
        checksum,
    })
}

// The blanket `impl From<std::io::Error> for Error` already lives in
// `error.rs`, so Cursor write failures auto-convert here. No extra impl
// is needed.
