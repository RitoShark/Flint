use flint_hash::error::{Error, Result};
use ritoshark::prelude::*;
use ritoshark::wad::{Wad, WadChunk};
#[cfg(test)]
use std::fs::File;
#[cfg(test)]
use std::io::Read;
use std::path::Path;

/// A reader for WAD archive files. Supports WAD versions 3.0 through 3.4+:
/// - WAD 3.0: SHA-256 checksums
/// - WAD 3.1-3.2: xxh3_64bits checksums
/// - WAD 3.3: Subchunked entries (compression type 4 with multiple ZStandard frames)
/// - WAD 3.4+: Extended subchunk indexing
pub struct WadReader {
    wad: Wad,
}

impl WadReader {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        tracing::debug!("Opening WAD file: {}", path.display());

        let wad = Wad::from_path(path)
            .map_err(|e| {
                tracing::error!("Failed to mount WAD file '{}': {}", path.display(), e);
                Error::wad_with_path(format!("Failed to mount WAD file: {}", e), path)
            })?;

        tracing::debug!(
            "Successfully opened WAD '{}' with {} chunks",
            path.display(),
            wad.chunks.len()
        );

        Ok(Self { wad })
    }

    /// Returns the `(major, minor)` version tuple.
    #[cfg(test)]
    fn read_wad_version(path: impl AsRef<Path>) -> Result<(u8, u8)> {
        let mut file = File::open(path.as_ref())
            .map_err(|e| Error::io_with_path(e, path.as_ref()))?;

        // Magic bytes (2 bytes: "RW")
        let mut magic = [0u8; 2];
        file.read_exact(&mut magic)
            .map_err(|e| Error::io_with_path(e, path.as_ref()))?;

        if magic != [0x52, 0x57] {  // "RW"
            return Err(Error::Wad {
                message: format!("Invalid WAD magic bytes: expected 'RW', got '{:?}'", magic),
                path: Some(path.as_ref().to_path_buf()),
            });
        }

        // Version (major, minor)
        let mut version = [0u8; 2];
        file.read_exact(&mut version)
            .map_err(|e| Error::io_with_path(e, path.as_ref()))?;

        Ok((version[0], version[1]))
    }

    pub fn chunks(&self) -> &[WadChunk] {
        &self.wad.chunks
    }

    pub fn get_chunk(&self, path_hash: u64) -> Option<&WadChunk> {
        self.wad.chunk_by_hash(path_hash)
    }

    pub fn chunk_count(&self) -> usize {
        self.wad.chunks.len()
    }

    /// Decompresses and returns the bytes of a single chunk by its path hash.
    ///
    /// # Errors
    /// Returns an error if the chunk is not present in the archive.
    pub fn read_chunk(&self, path_hash: u64) -> Result<Vec<u8>> {
        let chunk = self
            .wad
            .chunk_by_hash(path_hash)
            .ok_or_else(|| Error::Wad {
                message: format!("chunk with hash {:016x} not found", path_hash),
                path: None,
            })?;
        self.wad
            .chunk_data(chunk)
            .map_err(|e| Error::Wad {
                message: format!("Failed to decompress chunk {:016x}: {}", path_hash, e),
                path: None,
            })
    }

    pub fn wad_mut(&mut self) -> &Wad {
        &self.wad
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use tempfile::NamedTempFile;

    #[test]
    fn test_read_wad_version_33() {
        let mut temp_file = NamedTempFile::new().unwrap();

        temp_file.write_all(&[0x52, 0x57]).unwrap(); // "RW" magic
        temp_file.write_all(&[3, 3]).unwrap();        // version 3.3
        temp_file.flush().unwrap();

        let version = WadReader::read_wad_version(temp_file.path()).unwrap();
        assert_eq!(version, (3, 3), "Should detect WAD version 3.3");
    }

    #[test]
    fn test_read_wad_version_31() {
        let mut temp_file = NamedTempFile::new().unwrap();

        temp_file.write_all(&[0x52, 0x57]).unwrap(); // "RW" magic
        temp_file.write_all(&[3, 1]).unwrap();        // version 3.1
        temp_file.flush().unwrap();

        let version = WadReader::read_wad_version(temp_file.path()).unwrap();
        assert_eq!(version, (3, 1), "Should detect WAD version 3.1");
    }

    #[test]
    fn test_read_wad_version_34() {
        let mut temp_file = NamedTempFile::new().unwrap();

        temp_file.write_all(&[0x52, 0x57]).unwrap(); // "RW" magic
        temp_file.write_all(&[3, 4]).unwrap();        // version 3.4
        temp_file.flush().unwrap();

        let version = WadReader::read_wad_version(temp_file.path()).unwrap();
        assert_eq!(version, (3, 4), "Should detect WAD version 3.4");
    }

    #[test]
    fn test_read_wad_version_invalid_magic() {
        let mut temp_file = NamedTempFile::new().unwrap();

        temp_file.write_all(&[0x00, 0x00]).unwrap(); // Invalid magic
        temp_file.write_all(&[3, 3]).unwrap();
        temp_file.flush().unwrap();

        let result = WadReader::read_wad_version(temp_file.path());
        assert!(result.is_err(), "Should fail with invalid magic bytes");

        if let Err(Error::Wad { message, .. }) = result {
            assert!(message.contains("Invalid WAD magic"), "Error should mention invalid magic");
        } else {
            panic!("Expected WAD error with invalid magic message");
        }
    }
}
