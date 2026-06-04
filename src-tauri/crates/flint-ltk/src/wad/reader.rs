use crate::error::{Error, Result};
use ritoshark::prelude::*;
use ritoshark::wad::{Wad, WadChunk};
#[cfg(test)]
use std::fs::File;
#[cfg(test)]
use std::io::Read;
use std::path::Path;

/// A reader for WAD archive files that provides access to chunk metadata
///
/// Supports WAD versions 3.0 through 3.4+, including:
/// - WAD 3.0: SHA-256 checksums
/// - WAD 3.1-3.2: xxh3_64bits checksums
/// - WAD 3.3: Subchunked entries (compression type 4 with multiple ZStandard frames)
/// - WAD 3.4+: Extended subchunk indexing
///
/// # Legacy Mod Support
///
/// WAD 3.3 is commonly used in legacy League of Legends mods. This reader fully
/// supports loading and extracting WAD 3.3 archives through the underlying
/// `ritoshark::wad` (rs_wad) crate, which handles all version-specific parsing
/// and decompression logic including:
/// - Subchunked ZStandard decompression (type 4)
/// - SHA-256 checksums (v3.0) and xxh3_64bits checksums (v3.1+)
/// - Subchunk Table of Contents (.wad.SubChunkTOC) resolution
pub struct WadReader {
    wad: Wad,
}

impl WadReader {
    /// Opens a WAD file and parses its structure
    ///
    /// Supports WAD format versions 3.0-3.4+, including legacy mods using WAD 3.3.
    /// The archive is memory-mapped and fully parsed up front (rs_wad captures the
    /// data section verbatim), so the `File` handle does not need to be retained.
    ///
    /// # Arguments
    /// * `path` - Path to the WAD file
    ///
    /// # Returns
    /// * `Result<Self>` - A WadReader instance or an error
    ///
    /// # Requirements
    /// Validates: Requirements 3.1
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

    /// Reads the WAD version from a file without fully parsing it
    ///
    /// Returns (major, minor) version tuple
    #[cfg(test)]
    fn read_wad_version(path: impl AsRef<Path>) -> Result<(u8, u8)> {
        let mut file = File::open(path.as_ref())
            .map_err(|e| Error::io_with_path(e, path.as_ref()))?;

        // Read magic bytes (2 bytes: "RW")
        let mut magic = [0u8; 2];
        file.read_exact(&mut magic)
            .map_err(|e| Error::io_with_path(e, path.as_ref()))?;

        if magic != [0x52, 0x57] {  // "RW"
            return Err(Error::Wad {
                message: format!("Invalid WAD magic bytes: expected 'RW', got '{:?}'", magic),
                path: Some(path.as_ref().to_path_buf()),
            });
        }

        // Read version (major, minor)
        let mut version = [0u8; 2];
        file.read_exact(&mut version)
            .map_err(|e| Error::io_with_path(e, path.as_ref()))?;

        Ok((version[0], version[1]))
    }

    /// Returns a reference to all chunks in the WAD archive
    ///
    /// # Returns
    /// * A slice of all [`WadChunk`] entries in the archive
    ///
    /// # Requirements
    /// Validates: Requirements 3.2, 3.3
    pub fn chunks(&self) -> &[WadChunk] {
        &self.wad.chunks
    }

    /// Looks up a specific chunk by its path hash
    ///
    /// # Arguments
    /// * `path_hash` - The hash of the chunk's path
    ///
    /// # Returns
    /// * `Option<&WadChunk>` - The chunk metadata if found, None otherwise
    ///
    /// # Requirements
    /// Validates: Requirements 3.4
    pub fn get_chunk(&self, path_hash: u64) -> Option<&WadChunk> {
        self.wad.chunk_by_hash(path_hash)
    }

    /// Returns the total number of chunks in the WAD
    pub fn chunk_count(&self) -> usize {
        self.wad.chunks.len()
    }

    /// Decompresses and returns the bytes of a single chunk by its path hash.
    ///
    /// Convenience over `get_chunk` + `wad().chunk_data`. Returns an error if the
    /// chunk is not present in the archive.
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

    /// Gets a reference to the underlying [`Wad`].
    ///
    /// rs_wad reads chunk data through `&self` (`chunk_data`), so a shared
    /// reference is sufficient. The name is kept for call-site compatibility.
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
        // Create a mock WAD 3.3 header
        let mut temp_file = NamedTempFile::new().unwrap();

        // Write WAD header: magic "RW" + version 3.3
        temp_file.write_all(&[0x52, 0x57]).unwrap(); // "RW" magic
        temp_file.write_all(&[3, 3]).unwrap();        // version 3.3
        temp_file.flush().unwrap();

        let version = WadReader::read_wad_version(temp_file.path()).unwrap();
        assert_eq!(version, (3, 3), "Should detect WAD version 3.3");
    }

    #[test]
    fn test_read_wad_version_31() {
        // Create a mock WAD 3.1 header
        let mut temp_file = NamedTempFile::new().unwrap();

        temp_file.write_all(&[0x52, 0x57]).unwrap(); // "RW" magic
        temp_file.write_all(&[3, 1]).unwrap();        // version 3.1
        temp_file.flush().unwrap();

        let version = WadReader::read_wad_version(temp_file.path()).unwrap();
        assert_eq!(version, (3, 1), "Should detect WAD version 3.1");
    }

    #[test]
    fn test_read_wad_version_34() {
        // Create a mock WAD 3.4 header
        let mut temp_file = NamedTempFile::new().unwrap();

        temp_file.write_all(&[0x52, 0x57]).unwrap(); // "RW" magic
        temp_file.write_all(&[3, 4]).unwrap();        // version 3.4
        temp_file.flush().unwrap();

        let version = WadReader::read_wad_version(temp_file.path()).unwrap();
        assert_eq!(version, (3, 4), "Should detect WAD version 3.4");
    }

    #[test]
    fn test_read_wad_version_invalid_magic() {
        // Create a file with invalid magic bytes
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
