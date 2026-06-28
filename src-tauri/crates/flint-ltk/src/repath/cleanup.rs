//! One-pass import cleanup: unhash leftover files → convert dds/sco → rewrite
//! BIN extensions → strip 2x/4x twins. (Dangling-link prune lives in
//! organize_vfx_in_folder; unused-file cleanup is driven by repath_project.)
//! Ordering: unhash FIRST (later steps see real paths); convert before twin
//! strip so a converted base .tex counts as the base-res guard.

use std::path::Path;

#[derive(Debug, Default, Clone)]
pub struct CleanupReport {
    pub unhashed: usize,
    pub deleted_orphans: usize,
    pub dds_to_tex: usize,
    pub sco_to_scb: usize,
    pub bins_ext_rewritten: usize,
    pub hd_twins_removed: usize,
}

pub fn run_cleanup_pipeline(
    wad_root: &Path,
    resolve: &dyn Fn(&[u64]) -> Vec<String>,
) -> CleanupReport {
    let unhash_res = super::unhash::unhash_project_files(wad_root, resolve);
    let mut report = CleanupReport {
        unhashed: unhash_res.renamed,
        deleted_orphans: unhash_res.deleted_orphans,
        ..CleanupReport::default()
    };
    match super::convert::convert_meshes_and_textures(wad_root) {
        Ok((d, s)) => {
            report.dds_to_tex = d;
            report.sco_to_scb = s;
        }
        Err(e) => tracing::warn!("convert pass failed: {}", e),
    }
    match super::convert::rewrite_bin_extensions(wad_root) {
        Ok(n) => report.bins_ext_rewritten = n,
        Err(e) => tracing::warn!("bin ext rewrite failed: {}", e),
    }
    report.hd_twins_removed = super::texclean::strip_hd_twins(wad_root);
    tracing::info!(
        "Cleanup pipeline: {} unhashed, {} orphans deleted, {} dds->tex, {} sco->scb, {} bins rewritten, {} HD twins removed",
        report.unhashed, report.deleted_orphans, report.dds_to_tex, report.sco_to_scb, report.bins_ext_rewritten, report.hd_twins_removed
    );
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orchestrator_unhashes_converts_and_strips() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // A real (valid) DDS we can convert: build it via ddsfile from RGBA.
        // Use a small DXT5-style decodable DDS by encoding through ritoshark's
        // texture path is overkill; instead craft a minimal uncompressed DDS.
        let dds = make_rgba_dds(8, 8);

        // 1) Hashed DDS that the resolver maps to data/x/body.dds.
        let h = 0x0123456789abcdefu64;
        std::fs::write(root.join(format!("{:016x}.dds", h)), &dds).unwrap();

        // 2) A 2x_ HD twin of a base dds (base = body2.dds, twin = 2x_body2.dds).
        std::fs::create_dir_all(root.join("data/y")).unwrap();
        std::fs::write(root.join("data/y/body2.dds"), &dds).unwrap();
        std::fs::write(root.join("data/y/2x_body2.dds"), &dds).unwrap();

        // 3) A .sco mesh to convert to .scb.
        let sco = b"[ObjectBegin]\nNumVerts=3\n0.0 0.0 0.0\n1.0 0.0 0.0\n0.0 1.0 0.0\nNumFaces=1\n3 0 1 2 mat 0 0 0 0 0 0\n[ObjectEnd]\n";
        std::fs::write(root.join("data/y/mesh.sco"), sco).unwrap();

        let resolve = |hs: &[u64]| -> Vec<String> {
            hs.iter()
                .map(|x| {
                    if *x == h {
                        "data/x/body.dds".to_string()
                    } else {
                        format!("{:016x}", x)
                    }
                })
                .collect()
        };

        let report = run_cleanup_pipeline(root, &resolve);

        // Hashed file got renamed to its real path, then converted to .tex.
        assert!(!root.join(format!("{:016x}.dds", h)).exists());
        assert!(
            root.join("data/x/body.tex").exists(),
            "hashed dds should be renamed and converted to .tex"
        );
        assert_eq!(report.unhashed, 1);

        // DDS converted (body, body2, 2x_body2 = 3); sco converted to scb.
        assert!(report.dds_to_tex >= 1, "at least the unhashed dds converted");
        assert!(root.join("data/y/mesh.scb").exists(), "sco -> scb");
        assert!(!root.join("data/y/mesh.sco").exists());
        assert_eq!(report.sco_to_scb, 1);

        // The 2x_ twin (now 2x_body2.tex) removed because base body2.tex exists.
        assert!(root.join("data/y/body2.tex").exists());
        assert!(
            !root.join("data/y/2x_body2.tex").exists()
                && !root.join("data/y/2x_body2.dds").exists(),
            "HD twin should be stripped"
        );
        assert_eq!(report.hd_twins_removed, 1);
    }

    /// Build a valid DDS of `w`x`h` (opaque grey) via image_dds — the same
    /// encoder the texture-convert command uses, so the convert pass accepts it.
    fn make_rgba_dds(w: u32, h: u32) -> Vec<u8> {
        let rgba = image::RgbaImage::from_pixel(w, h, image::Rgba([0x80, 0x80, 0x80, 0xff]));
        let dds = image_dds::dds_from_image(
            &rgba,
            image_dds::ImageFormat::BC3RgbaUnorm,
            image_dds::Quality::Normal,
            image_dds::Mipmaps::Disabled,
        )
        .unwrap();
        let mut out = Vec::new();
        dds.write(&mut out).unwrap();
        out
    }
}
