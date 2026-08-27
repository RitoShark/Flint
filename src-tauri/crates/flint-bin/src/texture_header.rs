/*!
Dimensions and format from a TEX or DDS header, with no mip data read.

Deliberately header-only. `rs_tex`'s full parse walks the whole mip chain, and its
level-count derivation disagrees with a real minority of non-square VFX ramps — of 1741
mipmapped `.tex` files across this machine's projects, 104 do not match it. A full parse
turns "this build can't decode the chain" into a false claim about the file, and costs a
whole texture's worth of allocation to answer "how big is it". Everything here comes from
bytes the format pins down exactly.
*/

use ritoshark::tex::TexFormat;

pub const TEX_MAGIC: [u8; 4] = [b'T', b'E', b'X', 0];
pub const DDS_MAGIC: [u8; 4] = *b"DDS ";

/// `magic u32 | width u16 | height u16 | unknown u8 | format u8 | unknown u8 | mips bool`.
const TEX_HEADER_LEN: usize = 12;
/// The 4-byte magic plus a fixed 124-byte `DDS_HEADER`.
const DDS_HEADER_LEN: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextureContainer {
    Tex,
    Dds,
}

#[derive(Debug, Clone)]
pub struct TextureHeader {
    pub container: TextureContainer,
    pub width: u32,
    pub height: u32,
    /// Human-readable format name — the TEX enum variant, or the DDS FourCC.
    pub format: String,
    /// Whether the payload is stored as 4×4 blocks, which is what makes dimensions matter.
    pub block_compressed: bool,
    /// Set when this build has no name for the declared format at all.
    pub unknown_format: bool,
    pub has_mipmaps: bool,
    /// DDS only: the payload sits behind a `DX10` extension header (BC7/BC5-class formats).
    pub dx10: bool,
}

fn le_u16(data: &[u8], at: usize) -> u32 {
    u16::from_le_bytes([data[at], data[at + 1]]) as u32
}

fn le_u32(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

/// FourCCs whose payload is block-compressed. `DX10` defers to the DXGI format that follows.
const DDS_BLOCK_FOURCC: &[&[u8; 4]] = &[
    b"DXT1", b"DXT2", b"DXT3", b"DXT4", b"DXT5", b"ATI1", b"ATI2", b"BC4U", b"BC4S", b"BC5U",
    b"BC5S",
];

/// BC1…BC7 occupy these runs of `DXGI_FORMAT`.
fn dxgi_is_block_compressed(format: u32) -> bool {
    (70..=84).contains(&format) || (94..=99).contains(&format)
}

/// Reads dimensions and format from a TEX or DDS header, ignoring everything after it.
pub fn read_texture_header(data: &[u8]) -> Result<TextureHeader, String> {
    if data.len() >= 4 && data[..4] == DDS_MAGIC {
        if data.len() < DDS_HEADER_LEN {
            return Err("DDS header is truncated".to_string());
        }
        let four_cc = [data[84], data[85], data[86], data[87]];
        let block_compressed = if &four_cc == b"DX10" {
            data.len() >= DDS_HEADER_LEN + 4 && dxgi_is_block_compressed(le_u32(data, 128))
        } else {
            DDS_BLOCK_FOURCC.contains(&&four_cc)
        };
        let format = match std::str::from_utf8(&four_cc) {
            Ok(name) if name.chars().all(|c| c.is_ascii_graphic()) => name.to_string(),
            _ => "uncompressed".to_string(),
        };
        return Ok(TextureHeader {
            container: TextureContainer::Dds,
            height: le_u32(data, 12),
            width: le_u32(data, 16),
            format,
            block_compressed,
            unknown_format: false,
            has_mipmaps: le_u32(data, 28) > 1,
            dx10: &four_cc == b"DX10",
        });
    }

    if data.len() < TEX_HEADER_LEN || data[..4] != TEX_MAGIC {
        return Err("Not a TEX or DDS file".to_string());
    }

    let format_byte = data[9];
    let format = TexFormat::from_u8(format_byte);
    Ok(TextureHeader {
        container: TextureContainer::Tex,
        width: le_u16(data, 4),
        height: le_u16(data, 6),
        format: match format {
            Some(f) => format!("{f:?}"),
            None => format!("format byte {format_byte}"),
        },
        block_compressed: format.is_some_and(|f| f.block_size() == 4),
        unknown_format: format.is_none(),
        has_mipmaps: data[11] != 0,
        dx10: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tex_header(width: u16, height: u16, format: u8, mips: bool) -> Vec<u8> {
        let mut out = TEX_MAGIC.to_vec();
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.extend_from_slice(&[0, format, 0, mips as u8]);
        out
    }

    #[test]
    fn reads_a_tex_header_without_any_payload() {
        let header = read_texture_header(&tex_header(1024, 512, TexFormat::Bc3.to_u8(), true)).unwrap();
        assert_eq!(header.container, TextureContainer::Tex);
        assert_eq!((header.width, header.height), (1024, 512));
        assert_eq!(header.format, "Bc3");
        assert!(header.block_compressed);
        assert!(header.has_mipmaps);
        assert!(!header.unknown_format);
    }

    #[test]
    fn flags_a_tex_format_byte_this_build_does_not_know() {
        let header = read_texture_header(&tex_header(64, 64, 99, false)).unwrap();
        assert!(header.unknown_format);
        assert!(!header.block_compressed);
        assert_eq!(header.format, "format byte 99");
    }

    /// BGRA8 stores one pixel per block, so dimensions are unconstrained.
    #[test]
    fn an_uncompressed_tex_is_not_block_compressed() {
        let header = read_texture_header(&tex_header(63, 63, TexFormat::Bgra8.to_u8(), false)).unwrap();
        assert!(!header.block_compressed);
    }

    fn dds_header(width: u32, height: u32, four_cc: &[u8; 4], mip_count: u32) -> Vec<u8> {
        let mut out = vec![0u8; DDS_HEADER_LEN];
        out[..4].copy_from_slice(&DDS_MAGIC);
        out[12..16].copy_from_slice(&height.to_le_bytes());
        out[16..20].copy_from_slice(&width.to_le_bytes());
        out[28..32].copy_from_slice(&mip_count.to_le_bytes());
        out[84..88].copy_from_slice(four_cc);
        out
    }

    #[test]
    fn reads_a_dds_header_with_its_fourcc() {
        let header = read_texture_header(&dds_header(256, 128, b"DXT5", 9)).unwrap();
        assert_eq!(header.container, TextureContainer::Dds);
        assert_eq!((header.width, header.height), (256, 128));
        assert_eq!(header.format, "DXT5");
        assert!(header.block_compressed);
        assert!(header.has_mipmaps);
    }

    #[test]
    fn a_dds_with_no_fourcc_is_uncompressed() {
        let header = read_texture_header(&dds_header(256, 128, &[0, 0, 0, 0], 1)).unwrap();
        assert!(!header.block_compressed);
        assert_eq!(header.format, "uncompressed");
        assert!(!header.has_mipmaps);
    }

    #[test]
    fn a_dx10_dds_reads_its_dxgi_format() {
        let mut bc7 = dds_header(64, 64, b"DX10", 1);
        bc7.extend_from_slice(&98u32.to_le_bytes());
        assert!(read_texture_header(&bc7).unwrap().block_compressed);

        let mut rgba = dds_header(64, 64, b"DX10", 1);
        rgba.extend_from_slice(&28u32.to_le_bytes());
        assert!(!read_texture_header(&rgba).unwrap().block_compressed);
    }

    #[test]
    fn rejects_anything_that_is_neither() {
        assert!(read_texture_header(b"\x89PNG\r\n\x1a\n0123").is_err());
        assert!(read_texture_header(&[]).is_err());
    }
}
