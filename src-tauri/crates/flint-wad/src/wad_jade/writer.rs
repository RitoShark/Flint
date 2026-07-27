//! Minimal WAD v3.4 serializer used by the in-memory edit pipeline.
//! v3.1 WADs are upgraded to v3.4 on write.
//!
//! Layout (header is 272 bytes, TOC entry is 32 bytes per chunk):
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
//! compressed payload is at least 5% smaller than the source; otherwise
//! the chunk goes in uncompressed.

use flint_hash::error::{Error, Result};
use crate::wad_jade::format::WadCompression;
use byteorder::{LittleEndian, WriteBytesExt};
use std::io::{Cursor, Write};

const MAGIC_RW: u16 = 0x5752;
const HEADER_SIZE: usize = 2 + 1 + 1 + 256 + 8 + 4; // 272 bytes
const TOC_ENTRY_SIZE_V34: usize = 8 + 4 + 4 + 4 + 1 + 3 + 8; // 32 bytes
const ZSTD_LEVEL: i32 = 17;
const ZSTD_MIN_INPUT: usize = 512;
const ZSTD_KEEP_RATIO: f64 = 0.95;

/// `bytes` is the *decompressed* payload — the writer decides whether to
/// zstd it. `force_uncompressed` forces byte-exact uncompressed output.
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

#[derive(Debug, Clone, Copy)]
pub struct WriteStats {
    pub chunk_count: usize,
    pub total_compressed: u64,
    pub total_uncompressed: u64,
}

/// Serialize entries into a WAD v3.4 binary buffer. Entries are sorted by
/// path_hash so the TOC is hash-ascending; duplicate hashes are
/// deduplicated last-wins.
pub fn write_wad(entries: Vec<EntryToWrite>) -> Result<(Vec<u8>, WriteStats)> {
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

    use rayon::prelude::*;
    let encoded: Vec<EncodedEntry> = entries
        .into_par_iter()
        .map(encode_one)
        .collect::<Result<Vec<_>>>()?;

    let data_total: u64 = encoded.iter().map(|e| e.compressed.len() as u64).sum();
    let total_size = data_start as u64 + data_total;
    let mut buf: Vec<u8> = Vec::with_capacity(total_size as usize);
    let mut cursor = Cursor::new(&mut buf);

    cursor.write_u16::<LittleEndian>(MAGIC_RW)?;
    cursor.write_u8(3)?;
    cursor.write_u8(4)?;
    cursor.write_all(&[0u8; 256])?;
    cursor.write_u64::<LittleEndian>(0)?;
    cursor.write_i32::<LittleEndian>(chunk_count as i32)?;

    let mut offset = data_start as u64;
    let mut total_uncompressed: u64 = 0;
    let mut total_compressed: u64 = 0;
    for e in &encoded {
        if offset > u32::MAX as u64 {
            // v3.4 stores data_offset as a u32.
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
        let type_byte = e.compression as u8;
        cursor.write_u8(type_byte)?;
        // start_frame: 24-bit.
        cursor.write_u8(0)?;
        cursor.write_u8(0)?;
        cursor.write_u8(0)?;
        cursor.write_u64::<LittleEndian>(e.checksum)?;

        offset += e.compressed.len() as u64;
        total_uncompressed += e.uncompressed_size;
        total_compressed += e.compressed.len() as u64;
    }

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

    // xxh3-64 of the compressed payload.
    let checksum = xxhash_rust::xxh3::xxh3_64(&data);

    Ok(EncodedEntry {
        path_hash: entry.path_hash,
        compressed: data,
        uncompressed_size,
        compression,
        checksum,
    })
}
