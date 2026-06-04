//! Differential: LTK vs RitoShark texture decode must produce identical RGBA.
//! Skips unless FLINT_TEST_ASSETS points at a dir of real .tex/.dds files.
use std::path::PathBuf;

fn assets_dir() -> Option<PathBuf> {
    std::env::var_os("FLINT_TEST_ASSETS").map(PathBuf::from).filter(|p| p.is_dir())
}

#[test]
fn ltk_and_ritoshark_decode_match() {
    use ritoshark::prelude::Parse; // brings `Texture::from_bytes`

    let Some(dir) = assets_dir() else { eprintln!("skip: no FLINT_TEST_ASSETS"); return; };
    let mut checked = 0;
    for entry in walkdir::WalkDir::new(&dir).into_iter().filter_map(Result::ok) {
        let p = entry.path();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !matches!(ext, "tex" | "dds") { continue; }
        let data = std::fs::read(p).unwrap();

        // LTK
        let mut cur = std::io::Cursor::new(&data);
        let ltk = ltk_texture::Texture::from_reader(&mut cur)
            .and_then(|t| t.decode_mipmap(0)).and_then(|s| s.into_rgba_image());
        // RitoShark — its `Texture` is one struct; branch on the 4-byte magic
        // (b"DDS " => from_dds_bytes, otherwise TEX => from_bytes).
        let rs = if data.len() >= 4 && &data[0..4] == b"DDS " {
            ritoshark::tex::Texture::from_dds_bytes(&data).and_then(|t| t.decode_rgba())
        } else {
            ritoshark::tex::Texture::from_bytes(&data).and_then(|t| t.decode_rgba())
        };

        match (ltk, rs) {
            (Ok(a), Ok(b)) => {
                assert_eq!(a.dimensions(), b.dimensions(), "dims differ for {:?}", p);
                assert_eq!(a.as_raw(), b.as_raw(), "pixels differ for {:?}", p);
                checked += 1;
            }
            (Err(_), Err(_)) => {} // both reject — fine
            (a, b) => panic!("decode disagreement for {:?}: ltk_ok={}, rs_ok={}", p, a.is_ok(), b.is_ok()),
        }
    }
    eprintln!("diff_texture: compared {checked} files");
}
