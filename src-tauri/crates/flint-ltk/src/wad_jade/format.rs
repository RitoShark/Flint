//! WAD format primitives — chunk metadata and compression enum.
//!
//! The parser supports v3.0–v3.4 (the only versions League ships today).
//! v1/v2 carry an ECDSA signature block we'd need to skip but they no
//! longer appear in client.bin distributions; we reject them upfront.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WadCompression {
    None = 0,
    GZip = 1,
    Satellite = 2,
    Zstd = 3,
    ZstdMulti = 4,
}

impl WadCompression {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(WadCompression::None),
            1 => Some(WadCompression::GZip),
            2 => Some(WadCompression::Satellite),
            3 => Some(WadCompression::Zstd),
            4 => Some(WadCompression::ZstdMulti),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            WadCompression::None => "None",
            WadCompression::GZip => "GZip",
            WadCompression::Satellite => "Satellite",
            WadCompression::Zstd => "Zstd",
            WadCompression::ZstdMulti => "ZstdMulti",
        }
    }
}

impl fmt::Display for WadCompression {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Detected WAD version. Major is always 3 in practice; minor changes the
/// chunk record layout slightly — see [`crate::wad_jade::reader`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WadVersion {
    pub major: u8,
    pub minor: u8,
}

impl WadVersion {
    pub fn is_v3_4_plus(&self) -> bool {
        self.major == 3 && self.minor >= 4
    }
}

impl fmt::Display for WadVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

/// One TOC entry. Mirrors League's on-disk layout. Several fields are
/// only consumed during extraction (Phase 3) so they're tagged dead-code-
/// allowed for now.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub struct WadChunk {
    pub path_hash: u64,
    pub data_offset: u64,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub compression: WadCompression,
    /// Number of zstd frames for `ZstdMulti` chunks; 0 otherwise.
    pub frame_count: u8,
    /// Index of the chunk's first frame in the WAD-wide subchunk table.
    /// Only meaningful for v3.4+; stored for Phase 3 use.
    pub start_frame: u32,
    pub is_duplicated: bool,
    pub checksum: u64,
}
