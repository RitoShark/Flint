//! Differential: `ltk_meta` vs `rs_bin` must agree on BIN structure, and `rs_bin`
//! must round-trip byte-exact. Skips unless `FLINT_TEST_ASSETS` points at a dir of
//! real `.bin` files (never committed). This is the correctness oracle for the
//! ltk_meta -> rs_bin migration (Plan 2).

use ritoshark::prelude::*; // Parse / Serialize for from_bytes / to_bytes
use std::path::PathBuf;

fn assets_dir() -> Option<PathBuf> {
    std::env::var_os("FLINT_TEST_ASSETS")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

#[test]
fn ltk_and_rs_bin_agree_and_roundtrip() {
    let Some(dir) = assets_dir() else {
        eprintln!("skip: FLINT_TEST_ASSETS unset");
        return;
    };
    let mut checked = 0usize;
    for entry in walkdir::WalkDir::new(&dir).into_iter().filter_map(Result::ok) {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("bin") {
            continue;
        }
        let data = match std::fs::read(p) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let ltk = ltk_meta::Bin::from_reader(&mut std::io::Cursor::new(&data));
        let rs = ritoshark::bin::Bin::from_bytes(&data);

        match (ltk, rs) {
            (Ok(a), Ok(b)) => {
                // Structural agreement: same set of (path_hash, class_hash).
                let mut la: Vec<(u32, u32)> =
                    a.objects.iter().map(|(h, o)| (*h, o.class_hash)).collect();
                let mut lb: Vec<(u32, u32)> =
                    b.entries.iter().map(|e| (e.path_hash, e.class_hash)).collect();
                la.sort_unstable();
                lb.sort_unstable();
                assert_eq!(la, lb, "entry/class hashes differ for {:?}", p);

                // rs_bin must re-encode byte-exact (the strongest parse-correctness signal).
                let re = b.to_bytes().expect("rs_bin to_bytes");
                assert_eq!(re, data, "rs_bin round-trip not byte-exact for {:?}", p);

                checked += 1;
            }
            (Err(_), Err(_)) => { /* both reject — fine */ }
            (a, b) => panic!(
                "parse disagreement for {:?}: ltk_ok={} rs_ok={}",
                p,
                a.is_ok(),
                b.is_ok()
            ),
        }
    }
    eprintln!("diff_bin: compared {checked} files");
}
