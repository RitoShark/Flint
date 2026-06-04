//! Differential: LTK vs RitoShark mesh decode must produce identical geometry.
//!
//! For every `.skn` (skinned) and `.scb` (static binary) file under the dir named
//! by `FLINT_TEST_ASSETS`, decode the raw mesh with both `ltk_mesh` and
//! `ritoshark::mesh` and assert the positions / normals / UVs / indices match in
//! both count and value. Skips cleanly when `FLINT_TEST_ASSETS` is unset or not a
//! directory, so it never requires game assets in CI.
//!
//! Note: this compares the two *parsers* directly on raw on-disk attributes — it
//! does NOT apply Flint's mirrorX coordinate transform (that lives in
//! `flint_ltk::mesh::skn`/`scb`, downstream of both decoders).
//!
//! `glam` may be linked as two distinct instances (one via `ltk_mesh`, one via
//! `ritoshark`'s `rs_math`), so vectors are compared component-wise as `f32`
//! rather than by `Vec3` equality, which would be a cross-crate type mismatch.

use std::path::PathBuf;

fn assets_dir() -> Option<PathBuf> {
    std::env::var_os("FLINT_TEST_ASSETS")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

/// Compare two f32 buffers for exact equality, reporting the first divergence.
#[track_caller]
fn assert_f32_eq(label: &str, path: &std::path::Path, a: &[f32], b: &[f32]) {
    assert_eq!(
        a.len(),
        b.len(),
        "{label} count differs for {path:?}: ltk={} rs={}",
        a.len(),
        b.len()
    );
    for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        assert_eq!(
            x.to_bits(),
            y.to_bits(),
            "{label}[{i}] differs for {path:?}: ltk={x} rs={y}"
        );
    }
}

#[test]
fn ltk_and_ritoshark_skn_match() {
    use ltk_mesh::mem::vertex::ElementName;
    use ltk_mesh::SkinnedMesh as LtkSkn;
    use ritoshark::mesh::SkinnedMesh as RsSkn;
    use ritoshark::prelude::Parse; // brings `SkinnedMesh::from_bytes`

    let Some(dir) = assets_dir() else {
        eprintln!("skip: no FLINT_TEST_ASSETS");
        return;
    };

    let mut checked = 0usize;
    for entry in walkdir::WalkDir::new(&dir)
        .into_iter()
        .filter_map(Result::ok)
    {
        let p = entry.path();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("skn") {
            continue;
        }
        let data = std::fs::read(p).unwrap();

        // --- LTK decode (typed accessor buffers) ---
        let ltk = LtkSkn::from_reader(&mut std::io::Cursor::new(&data));

        // --- RitoShark decode (direct vertex fields) ---
        let rs = RsSkn::from_bytes(&data);

        match (ltk, rs) {
            (Ok(l), Ok(r)) => {
                // Positions
                let vb = l.vertex_buffer();
                let ltk_pos: Vec<f32> = vb
                    .accessor::<glam::Vec3>(ElementName::Position)
                    .map(|acc| acc.iter().flat_map(|v| [v.x, v.y, v.z]).collect())
                    .expect("ltk skn missing positions");
                let rs_pos: Vec<f32> = r
                    .vertices()
                    .iter()
                    .flat_map(|v| [v.position.x, v.position.y, v.position.z])
                    .collect();
                assert_f32_eq("position", p, &ltk_pos, &rs_pos);

                // Normals (LTK may synthesize none; only compare when LTK has them)
                if let Some(acc) = vb.accessor::<glam::Vec3>(ElementName::Normal) {
                    let ltk_nrm: Vec<f32> =
                        acc.iter().flat_map(|v| [v.x, v.y, v.z]).collect();
                    let rs_nrm: Vec<f32> = r
                        .vertices()
                        .iter()
                        .flat_map(|v| [v.normal.x, v.normal.y, v.normal.z])
                        .collect();
                    assert_f32_eq("normal", p, &ltk_nrm, &rs_nrm);
                }

                // UVs (Texcoord0)
                if let Some(acc) = vb.accessor::<glam::Vec2>(ElementName::Texcoord0) {
                    let ltk_uv: Vec<f32> = acc.iter().flat_map(|v| [v.x, v.y]).collect();
                    let rs_uv: Vec<f32> = r
                        .vertices()
                        .iter()
                        .flat_map(|v| [v.uv.x, v.uv.y])
                        .collect();
                    assert_f32_eq("uv", p, &ltk_uv, &rs_uv);
                }

                // Indices (u16)
                let ltk_idx: Vec<u16> = l.index_buffer().iter().collect();
                let rs_idx: Vec<u16> = r.indices().to_vec();
                assert_eq!(
                    ltk_idx, rs_idx,
                    "index buffer differs for {p:?}"
                );

                // Material range count
                assert_eq!(
                    l.ranges().len(),
                    r.ranges().len(),
                    "range count differs for {p:?}"
                );

                checked += 1;
            }
            (Err(_), Err(_)) => {} // both reject — fine
            (a, b) => panic!(
                "SKN decode disagreement for {p:?}: ltk_ok={}, rs_ok={}",
                a.is_ok(),
                b.is_ok()
            ),
        }
    }
    eprintln!("diff_mesh(skn): compared {checked} files");
}

#[test]
fn ltk_and_ritoshark_scb_match() {
    use ltk_mesh::StaticMesh as LtkStatic;
    use ritoshark::mesh::StaticMesh as RsStatic;

    let Some(dir) = assets_dir() else {
        eprintln!("skip: no FLINT_TEST_ASSETS");
        return;
    };

    let mut checked = 0usize;
    for entry in walkdir::WalkDir::new(&dir)
        .into_iter()
        .filter_map(Result::ok)
    {
        let p = entry.path();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("scb") {
            continue;
        }
        let data = std::fs::read(p).unwrap();

        let ltk = LtkStatic::from_reader(&mut std::io::Cursor::new(&data));
        let rs = RsStatic::from_scb_reader(&mut std::io::Cursor::new(&data));

        match (ltk, rs) {
            (Ok(l), Ok(r)) => {
                // Vertex positions
                let ltk_pos: Vec<f32> = l
                    .vertices()
                    .iter()
                    .flat_map(|v| [v.x, v.y, v.z])
                    .collect();
                let rs_pos: Vec<f32> = r
                    .positions()
                    .iter()
                    .flat_map(|v| [v.x, v.y, v.z])
                    .collect();
                assert_f32_eq("scb position", p, &ltk_pos, &rs_pos);

                // Faces: count, indices, uvs, material
                assert_eq!(
                    l.faces().len(),
                    r.faces().len(),
                    "scb face count differs for {p:?}"
                );
                for (i, (lf, rf)) in l.faces().iter().zip(r.faces().iter()).enumerate() {
                    assert_eq!(
                        lf.indices, rf.indices,
                        "scb face[{i}] indices differ for {p:?}"
                    );
                    assert_eq!(
                        lf.material, rf.material,
                        "scb face[{i}] material differs for {p:?}"
                    );
                    let lf_uv: Vec<f32> =
                        lf.uvs.iter().flat_map(|v| [v.x, v.y]).collect();
                    let rf_uv: Vec<f32> =
                        rf.uvs.iter().flat_map(|v| [v.x, v.y]).collect();
                    assert_f32_eq("scb face uv", p, &lf_uv, &rf_uv);
                }

                checked += 1;
            }
            (Err(_), Err(_)) => {} // both reject — fine
            (a, b) => panic!(
                "SCB decode disagreement for {p:?}: ltk_ok={}, rs_ok={}",
                a.is_ok(),
                b.is_ok()
            ),
        }
    }
    eprintln!("diff_mesh(scb): compared {checked} files");
}
