//! Custom WAD parser — header + TOC only. No decompression.
//!
//! Reads a WAD's table of contents into a flat `Vec<WadChunk>`. Parsing is
//! synchronous and bounded by the chunk count (typical champion WAD is
//! 5–20k chunks ≈ 140–560 KB of TOC). The data section is left unread —
//! Phase 3 will seek + decompress on demand.

use crate::wad_jade::format::{WadChunk, WadCompression, WadVersion};
use crate::error::{Error, Result};
use byteorder::{LittleEndian, ReadBytesExt};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// What `read_wad_toc` returns: version + every chunk in the file. The
/// `path` field is informational — Phase 3 may use it for re-opening the
/// file for extraction.
#[derive(Debug)]
pub struct WadToc {
    pub path: PathBuf,
    pub version: WadVersion,
    pub chunks: Vec<WadChunk>,
}

const MAGIC_RW: u16 = 0x5752; // "RW" little-endian: 'R' (0x52) then 'W' (0x57).

/// Parse a WAD file's TOC. Opens with a 64 KB buffered reader; on a warm
/// disk a 200 MB champion WAD's TOC parses in <30 ms.
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

    // v3 carries a 256-byte ECDSA signature block + 8-byte data checksum
    // before the chunk count. We don't validate either — the launcher does.
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

    let mut chunks = Vec::with_capacity(chunk_count);
    let version = WadVersion { major, minor };
    for i in 0..chunk_count {
        let chunk = if version.is_v3_4_plus() {
            read_chunk_v3_4(&mut reader)
        } else {
            read_chunk_v3_1(&mut reader)
        }
        .map_err(|e| match e {
            Error::Io { source, .. } => Error::wad_with_path(
                format!("Failed reading chunk {}/{}: {}", i + 1, chunk_count, source),
                path,
            ),
            other => other,
        })?;
        chunks.push(chunk);
    }

    Ok(WadToc {
        path: path.to_path_buf(),
        version,
        chunks,
    })
}

fn read_chunk_v3_1<R: Read>(reader: &mut R) -> Result<WadChunk> {
    let path_hash = reader.read_u64::<LittleEndian>()?;
    let data_offset = reader.read_u32::<LittleEndian>()? as u64;
    let compressed_size = reader.read_i32::<LittleEndian>()?.max(0) as u64;
    let uncompressed_size = reader.read_i32::<LittleEndian>()?.max(0) as u64;

    let type_frame_count = reader.read_u8()?;
    let compression_byte = type_frame_count & 0x0F;
    let compression = WadCompression::from_u8(compression_byte).ok_or_else(|| {
        Error::Wad {
            message: format!("Unknown compression type {}", compression_byte),
            path: None,
        }
    })?;

    // Read past is_duplicated (u8), start_frame (u16), checksum (u64) — the
    // extractor doesn't use them but the cursor must advance over them.
    reader.read_u8()?;
    reader.read_u16::<LittleEndian>()?;
    reader.read_u64::<LittleEndian>()?;

    Ok(WadChunk {
        path_hash,
        data_offset,
        compressed_size,
        uncompressed_size,
        compression,
    })
}

fn read_chunk_v3_4<R: Read>(reader: &mut R) -> Result<WadChunk> {
    let path_hash = reader.read_u64::<LittleEndian>()?;
    let data_offset = reader.read_u32::<LittleEndian>()? as u64;
    let compressed_size = reader.read_u32::<LittleEndian>()? as u64;
    let uncompressed_size = reader.read_u32::<LittleEndian>()? as u64;

    let type_frame_count = reader.read_u8()?;
    let compression_byte = type_frame_count & 0x0F;
    let compression = WadCompression::from_u8(compression_byte).ok_or_else(|| {
        Error::Wad {
            message: format!("Unknown compression type {}", compression_byte),
            path: None,
        }
    })?;

    // Read past the 24-bit start_frame (3 bytes) and checksum (u64) — unused by
    // the extractor, but the cursor must advance over them.
    reader.read_u8()?;
    reader.read_u8()?;
    reader.read_u8()?;
    reader.read_u64::<LittleEndian>()?;

    Ok(WadChunk {
        path_hash,
        data_offset,
        compressed_size,
        uncompressed_size,
        compression,
    })
}
