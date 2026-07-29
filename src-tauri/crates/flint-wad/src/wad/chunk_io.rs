//! Reading and decompressing a single WAD chunk.

use flint_hash::error::{Error, Result};
use crate::wad::format::{WadChunk, WadCompression};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub fn read_chunk_raw(wad_path: &Path, chunk: &WadChunk) -> Result<Vec<u8>> {
    let mut file = File::open(wad_path).map_err(|e| Error::io_with_path(e, wad_path))?;
    file.seek(SeekFrom::Start(chunk.data_offset))
        .map_err(|e| Error::io_with_path(e, wad_path))?;
    let mut buf = vec![0u8; chunk.compressed_size as usize];
    file.read_exact(&mut buf)
        .map_err(|e| Error::io_with_path(e, wad_path))?;
    Ok(buf)
}

pub fn decompress(raw: &[u8], kind: WadCompression, expected_uncompressed: u64) -> Result<Vec<u8>> {
    match kind {
        WadCompression::None => Ok(raw.to_vec()),
        WadCompression::GZip => {
            let mut decoder = flate2::read::GzDecoder::new(raw);
            let mut out = Vec::with_capacity(expected_uncompressed as usize);
            decoder.read_to_end(&mut out).map_err(|e| Error::Wad {
                message: format!("GZip decode failed: {}", e),
                path: None,
            })?;
            Ok(out)
        }
        WadCompression::Zstd | WadCompression::ZstdMulti => {
            zstd::stream::decode_all(raw).map_err(|e| Error::Wad {
                message: format!("Zstd decode failed: {}", e),
                path: None,
            })
        }
        WadCompression::Satellite => Err(Error::Wad {
            message: "Satellite compression not supported".to_string(),
            path: None,
        }),
    }
}

/// One-shot read + decompress. Heavy enough to warrant the blocking pool.
pub fn read_chunk_decompressed_bytes(wad_path: &Path, chunk: &WadChunk) -> Result<Vec<u8>> {
    let raw = read_chunk_raw(wad_path, chunk)?;
    decompress(&raw, chunk.compression, chunk.uncompressed_size)
}
