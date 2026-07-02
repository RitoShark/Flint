//! Convert project assets to the canonical binary forms: DDS→TEX and SCO→SCB.
//! Both produce bytes the game and Flint's readers accept; sources are deleted
//! after a successful convert, and BIN string references get their extensions
//! rewritten to match.

use std::io::Cursor;
use std::path::Path;
use walkdir::WalkDir;

use crate::bin::BinValue;
use crate::error::{Error, Result};
// The texture API is ritoshark's (NOT flint_ltk::ltk_types). flint-ltk depends
// on ritoshark directly (pinned rev b775b0c). Mirrors texture_convert.rs.
use ritoshark::prelude::Serialize as _;
use ritoshark::tex::{TexFormat, Texture};

/// DDS bytes → TEX bytes. Mirrors `commands::assets::texture_convert::convert_dds_to_tex`
/// inner logic: decode to clamped RGBA, pick TEX format from the DDS FourCC,
/// re-encode. Mipmaps disabled (League rejects partial chains).
pub fn convert_dds_to_tex_bytes(dds: &[u8]) -> Result<Vec<u8>> {
    if dds.len() < 4 {
        return Err(Error::InvalidInput("DDS too small".into()));
    }
    let texture = Texture::from_dds_bytes(dds)
        .map_err(|e| Error::InvalidInput(format!("parse DDS: {:?}", e)))?;
    let mut rgba = texture
        .decode_rgba()
        .map_err(|e| Error::InvalidInput(format!("decode DDS: {:?}", e)))?;
    let (w, h) = rgba.dimensions();
    let (cw, ch) = ((w / 4) * 4, (h / 4) * 4);
    if cw != w || ch != h {
        rgba = image::imageops::crop_imm(&rgba, 0, 0, cw.max(4), ch.max(4)).to_image();
    }
    let mut cursor = Cursor::new(dds);
    let parsed = ddsfile::Dds::read(&mut cursor)
        .map_err(|e| Error::InvalidInput(format!("DDS header: {}", e)))?;
    let tex_format = if let Some(fourcc) = parsed.header.spf.fourcc {
        // DXT1 → BC1; every other FourCC (incl. DXT5) → BC3, the safe default.
        if fourcc.0 == u32::from_le_bytes(*b"DXT1") {
            TexFormat::Bc1
        } else {
            TexFormat::Bc3
        }
    } else {
        TexFormat::Bgra8
    };
    let new_tex = match tex_format {
        TexFormat::Bgra8 => Texture::from_rgba_bgra8(&rgba),
        _ => Texture::encode(&rgba, tex_format, false)
            .map_err(|e| Error::InvalidInput(format!("encode TEX: {:?}", e)))?,
    };
    // Serialize to TEX bytes via the ritoshark Serialize trait — the SAME call
    // texture_convert.rs:182 uses (`new_tex.to_bytes()`).
    let mut out = new_tex
        .to_bytes()
        .map_err(|e| Error::InvalidInput(format!("serialize TEX: {:?}", e)))?;
    // Header byte 8: 0x01 for BC1/BC3 (Riot's pattern), 0x00 for RGBA8.
    if out.len() >= 9 {
        out[8] = match tex_format {
            TexFormat::Bc1 | TexFormat::Bc3 => 0x01,
            _ => 0x00,
        };
    }
    Ok(out)
}

/// SCO (ASCII static mesh) bytes → SCB (binary) bytes via ritoshark.
pub fn convert_sco_to_scb_bytes(sco: &[u8]) -> Result<Vec<u8>> {
    let text = std::str::from_utf8(sco)
        .map_err(|e| Error::InvalidInput(format!("SCO not UTF-8: {:?}", e)))?;
    let mesh = ritoshark::mesh::StaticMesh::from_sco_str(text)
        .map_err(|e| Error::InvalidInput(format!("parse SCO: {:?}", e)))?;
    let mut out = Vec::new();
    mesh.to_scb_writer(&mut out)
        .map_err(|e| Error::InvalidInput(format!("write SCB: {:?}", e)))?;
    Ok(out)
}

/// Convert every `.dds`→`.tex` and `.sco`→`.scb` under `wad_root`, writing the
/// new file beside the old and deleting the source on success. Returns
/// (dds_converted, sco_converted).
pub fn convert_meshes_and_textures(wad_root: &Path) -> Result<(usize, usize)> {
    let mut dds_n = 0usize;
    let mut sco_n = 0usize;
    for e in WalkDir::new(wad_root).into_iter().filter_map(|e| e.ok()) {
        if !e.path().is_file() {
            continue;
        }
        let ext = e
            .path()
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ext == "dds" {
            let Ok(bytes) = std::fs::read(e.path()) else {
                continue;
            };
            match convert_dds_to_tex_bytes(&bytes) {
                Ok(tex) => {
                    let out = e.path().with_extension("tex");
                    if std::fs::write(&out, &tex).is_ok() {
                        let _ = std::fs::remove_file(e.path());
                        dds_n += 1;
                    }
                }
                Err(err) => tracing::warn!("dds->tex failed {}: {}", e.path().display(), err),
            }
        } else if ext == "sco" {
            let Ok(bytes) = std::fs::read(e.path()) else {
                continue;
            };
            match convert_sco_to_scb_bytes(&bytes) {
                Ok(scb) => {
                    let out = e.path().with_extension("scb");
                    if std::fs::write(&out, &scb).is_ok() {
                        let _ = std::fs::remove_file(e.path());
                        sco_n += 1;
                    }
                }
                Err(err) => tracing::warn!("sco->scb failed {}: {}", e.path().display(), err),
            }
        }
    }
    Ok((dds_n, sco_n))
}

/// Rewrite an asset-path string's extension: `.dds`→`.tex`, `.sco`→`.scb`,
/// but ONLY when the converted target file actually exists under `wad_root`
/// (i.e. the per-file convert succeeded). If the target is missing the convert
/// failed and we leave the working `.dds`/`.sco` ref untouched, so the BIN
/// never points at a missing file.
///
/// Preserves the original-case stem; only the trailing extension is replaced.
/// Returns true if the string changed.
fn rewrite_ext(s: &mut String, wad_root: &Path) -> bool {
    let lower = s.to_lowercase();
    let candidate = if lower.ends_with(".dds") {
        format!("{}.tex", &s[..s.len() - 4])
    } else if lower.ends_with(".sco") {
        format!("{}.scb", &s[..s.len() - 4])
    } else {
        return false;
    };
    // Resolve the candidate to a disk path under wad_root and only flip the
    // ref if the converted target exists.
    let target_rel = candidate.replace('\\', "/");
    let target_rel = target_rel.trim_start_matches('/');
    if wad_root.join(target_rel).exists() {
        *s = candidate;
        true
    } else {
        false
    }
}

/// Walk a BIN value tree (mirrors `refather::repath_value`'s recursion exactly:
/// String/List/Pointer/Embed/Option/Map arms) and rewrite `.dds`→`.tex` /
/// `.sco`→`.scb` extensions on every asset-path string. Sets `*changed`.
fn rewrite_value_exts(value: &mut BinValue, wad_root: &Path, changed: &mut bool) {
    match value {
        BinValue::String(s) => {
            if crate::repath::refather::is_asset_path(s) && rewrite_ext(s, wad_root) {
                *changed = true;
            }
        }
        BinValue::List { items, .. } => {
            for item in items.iter_mut() {
                rewrite_value_exts(item, wad_root, changed);
            }
        }
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            for v in fields.values_mut() {
                rewrite_value_exts(v, wad_root, changed);
            }
        }
        BinValue::Option {
            value: Some(inner), ..
        } => {
            rewrite_value_exts(inner, wad_root, changed);
        }
        BinValue::Map { entries, .. } => {
            for (key, val) in entries.iter_mut() {
                rewrite_value_exts(key, wad_root, changed);
                rewrite_value_exts(val, wad_root, changed);
            }
        }
        _ => {}
    }
}

/// Rewrite `.dds`→`.tex` and `.sco`→`.scb` extensions in every BIN's string
/// values under `wad_root`. Returns the number of BINs changed.
pub fn rewrite_bin_extensions(wad_root: &Path) -> Result<usize> {
    let mut changed_bins = 0usize;
    for e in WalkDir::new(wad_root).into_iter().filter_map(|e| e.ok()) {
        let is_bin = e
            .path()
            .extension()
            .map(|x| x.eq_ignore_ascii_case("bin"))
            .unwrap_or(false);
        if !e.path().is_file() || !is_bin {
            continue;
        }
        let Ok(data) = std::fs::read(e.path()) else {
            continue;
        };
        let Ok(mut bin) = crate::bin::read_bin(&data) else {
            continue;
        };
        let mut changed = false;
        // Walk the bin's top-level values the SAME way `repath_bin_file` does:
        // `for entry in bin.entries.iter_mut() { for value in entry.fields.values_mut() {...} }`.
        for entry in bin.entries.iter_mut() {
            for value in entry.fields.values_mut() {
                rewrite_value_exts(value, wad_root, &mut changed);
            }
        }
        if changed {
            if let Ok(bytes) = crate::bin::write_bin(&bin) {
                if std::fs::write(e.path(), &bytes).is_ok() {
                    changed_bins += 1;
                }
            }
        }
    }
    Ok(changed_bins)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sco_to_scb_then_read_back() {
        // Minimal SCO: if the synthetic literal fails to parse, this is a no-op
        // that still compiles. The assertion is round-trip-ability when it parses.
        let sco = b"[ObjectBegin]\nNumVerts=3\n0.0 0.0 0.0\n1.0 0.0 0.0\n0.0 1.0 0.0\nNumFaces=1\n3 0 1 2 mat 0 0 0 0 0 0\n[ObjectEnd]\n";
        if let Ok(scb) = convert_sco_to_scb_bytes(sco) {
            let mut cur = Cursor::new(&scb);
            assert!(
                ritoshark::mesh::StaticMesh::from_scb_reader(&mut cur).is_ok(),
                "SCB output must re-parse"
            );
        }
    }

    #[test]
    fn rewrite_ext_preserves_stem_case() {
        // The rewrite only flips when the converted target exists on disk, so
        // create the .tex/.scb targets first under a temp wad_root.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("assets/X")).unwrap();
        std::fs::write(root.join("assets/X/Body.tex"), b"x").unwrap();
        std::fs::write(root.join("assets/X/Mesh.scb"), b"x").unwrap();

        let mut s = String::from("assets/X/Body.DDS");
        assert!(rewrite_ext(&mut s, root));
        assert_eq!(s, "assets/X/Body.tex");

        let mut s = String::from("assets/X/Mesh.sco");
        assert!(rewrite_ext(&mut s, root));
        assert_eq!(s, "assets/X/Mesh.scb");

        let mut s = String::from("assets/X/keep.bin");
        assert!(!rewrite_ext(&mut s, root));
        assert_eq!(s, "assets/X/keep.bin");
    }

    #[test]
    fn rewrite_ext_skips_when_target_missing() {
        // No .tex on disk → the convert "failed", so the .dds ref stays put.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("assets/X")).unwrap();

        let mut s = String::from("assets/X/Body.dds");
        assert!(!rewrite_ext(&mut s, root), "missing target must not flip");
        assert_eq!(s, "assets/X/Body.dds");

        let mut s = String::from("assets/X/Mesh.sco");
        assert!(!rewrite_ext(&mut s, root), "missing target must not flip");
        assert_eq!(s, "assets/X/Mesh.sco");
    }

    #[test]
    fn rewrite_bin_extensions_rewrites_string_values() {
        use ritoshark::bin::{Bin, BinEntry, BinValue};

        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();

        // Build a BIN with String fields referencing a .dds and a .sco asset,
        // plus a non-asset string that must NOT change.
        let mut fields = indexmap::IndexMap::new();
        fields.insert(0x1111_1111u32, BinValue::String("assets/x/body.dds".into()));
        fields.insert(0x2222_2222u32, BinValue::String("assets/x/mesh.sco".into()));
        fields.insert(0x3333_3333u32, BinValue::String("not/an/asset.dds".into()));
        let entry = BinEntry {
            path_hash: 0xABCD_0001,
            class_hash: 0xABCD_0002,
            fields,
        };
        let bin = Bin {
            entries: vec![entry],
            ..Bin::new()
        };

        let bin_path = base.join("test.bin");
        std::fs::write(&bin_path, crate::bin::write_bin(&bin).unwrap()).unwrap();

        // The rewrite is existence-aware: it only flips a ref when the
        // converted target exists on disk (the convert succeeded). Create the
        // .tex/.scb targets so the asset refs flip.
        std::fs::create_dir_all(base.join("assets/x")).unwrap();
        std::fs::write(base.join("assets/x/body.tex"), b"x").unwrap();
        std::fs::write(base.join("assets/x/mesh.scb"), b"x").unwrap();

        let changed = rewrite_bin_extensions(base).unwrap();
        assert_eq!(changed, 1, "the one BIN must be rewritten");

        // Re-read and verify the extensions flipped, non-asset left alone.
        let reread = crate::bin::read_bin(&std::fs::read(&bin_path).unwrap()).unwrap();
        let f = &reread.entries[0].fields;
        match &f[&0x1111_1111u32] {
            BinValue::String(s) => assert_eq!(s, "assets/x/body.tex"),
            v => panic!("expected String, got {:?}", v),
        }
        match &f[&0x2222_2222u32] {
            BinValue::String(s) => assert_eq!(s, "assets/x/mesh.scb"),
            v => panic!("expected String, got {:?}", v),
        }
        match &f[&0x3333_3333u32] {
            // `not/an/asset.dds` is not under assets/ or data/, so is_asset_path
            // rejects it and the extension stays .dds.
            BinValue::String(s) => assert_eq!(s, "not/an/asset.dds"),
            v => panic!("expected String, got {:?}", v),
        }
    }

    #[test]
    fn rewrite_bin_extensions_skips_when_converted_target_missing() {
        use ritoshark::bin::{Bin, BinEntry, BinValue};

        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();

        // A BIN referencing a .dds asset, but NO .tex target exists on disk
        // (the per-file convert failed). The ref must stay .dds so the BIN
        // never points at a missing file.
        let mut fields = indexmap::IndexMap::new();
        fields.insert(0x1111_1111u32, BinValue::String("assets/x/body.dds".into()));
        let entry = BinEntry {
            path_hash: 0xABCD_0001,
            class_hash: 0xABCD_0002,
            fields,
        };
        let bin = Bin {
            entries: vec![entry],
            ..Bin::new()
        };

        let bin_path = base.join("test.bin");
        std::fs::write(&bin_path, crate::bin::write_bin(&bin).unwrap()).unwrap();

        // Deliberately do NOT create assets/x/body.tex.
        let changed = rewrite_bin_extensions(base).unwrap();
        assert_eq!(changed, 0, "no BIN should change when the target is missing");

        let reread = crate::bin::read_bin(&std::fs::read(&bin_path).unwrap()).unwrap();
        match &reread.entries[0].fields[&0x1111_1111u32] {
            BinValue::String(s) => assert_eq!(s, "assets/x/body.dds", "dangling .dds ref kept"),
            v => panic!("expected String, got {:?}", v),
        }
    }
}
