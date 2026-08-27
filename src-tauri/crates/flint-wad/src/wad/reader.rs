//! Custom WAD parser — header + TOC only. No decompression.

use crate::wad::format::{WadChunk, WadCompression, WadVersion};
use flint_hash::error::{Error, Result};
use byteorder::{LittleEndian, ReadBytesExt};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct WadToc {
    pub path: PathBuf,
    pub version: WadVersion,
    pub chunks: Vec<WadChunk>,
}

const MAGIC_RW: u16 = 0x5752; // "RW" little-endian: 'R' (0x52) then 'W' (0x57).

pub fn read_wad_toc(path: impl AsRef<Path>) -> Result<WadToc> {
    let path = path.as_ref();
    let file = File::open(path).map_err(|e| Error::io_with_path(e, path))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);

    let magic = reader
        .read_u16::<LittleEndian>()
        .map_err(|e| Error::io_with_path(e, path))?;
    if magic != MAGIC_RW {
        return Err(Error::wad_with_path(
            format!("Bad magic 0x{:04x} (expected 0x{:04x} \"RW\")", magic, MAGIC_RW),
            path,
        ));
    }

    let major = reader
        .read_u8()
        .map_err(|e| Error::io_with_path(e, path))?;
    let minor = reader
        .read_u8()
        .map_err(|e| Error::io_with_path(e, path))?;

    if major != 3 {
        return Err(Error::wad_with_path(
            format!("Unsupported WAD major version {}.{}", major, minor),
            path,
        ));
    }

    // 256-byte ECDSA signature block + 8-byte data checksum before the chunk count.
    reader
        .seek(SeekFrom::Current(256 + 8))
        .map_err(|e| Error::io_with_path(e, path))?;

    let chunk_count = reader
        .read_i32::<LittleEndian>()
        .map_err(|e| Error::io_with_path(e, path))?;
    if chunk_count < 0 {
        return Err(Error::wad_with_path(
            format!("Negative chunk count: {}", chunk_count),
            path,
        ));
    }
    let chunk_count = chunk_count as usize;

    // Both entry layouts are exactly 32 bytes, so the whole TOC is one read and
    // plain slice parsing — per-field reader calls cost ~10 virtual calls per
    // chunk, which dominated whole-game indexing.
    const ENTRY_SIZE: usize = 32;
    let mut buf = vec![0u8; chunk_count * ENTRY_SIZE];
    reader
        .read_exact(&mut buf)
        .map_err(|e| Error::wad_with_path(format!("Truncated TOC ({} chunks): {}", chunk_count, e), path))?;

    let version = WadVersion { major, minor };
    let v3_4 = version.is_v3_4_plus();
    let mut chunks = Vec::with_capacity(chunk_count);
    for entry in buf.chunks_exact(ENTRY_SIZE) {
        chunks.push(parse_chunk(entry, v3_4).map_err(|e| match e {
            Error::Wad { message, .. } => Error::wad_with_path(message, path),
            other => other,
        })?);
    }

    Ok(WadToc {
        path: path.to_path_buf(),
        version,
        chunks,
    })
}

fn parse_chunk(entry: &[u8], v3_4: bool) -> Result<WadChunk> {
    let u32_at = |at: usize| u32::from_le_bytes(entry[at..at + 4].try_into().unwrap());

    let path_hash = u64::from_le_bytes(entry[..8].try_into().unwrap());
    let data_offset = u32_at(8) as u64;
    let (compressed_size, uncompressed_size) = if v3_4 {
        (u32_at(12) as u64, u32_at(16) as u64)
    } else {
        (
            (u32_at(12) as i32).max(0) as u64,
            (u32_at(16) as i32).max(0) as u64,
        )
    };

    let compression_byte = entry[20] & 0x0F;
    let compression = WadCompression::from_u8(compression_byte).ok_or_else(|| Error::Wad {
        message: format!("Unknown compression type {}", compression_byte),
        path: None,
    })?;

    Ok(WadChunk {
        path_hash,
        data_offset,
        compressed_size,
        uncompressed_size,
        compression,
    })
}
