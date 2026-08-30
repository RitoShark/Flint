//! Manual probe: `FLINT_AUDIT_DIR=<wad folder> cargo test -p flint-bin --test audit_real_folder -- --ignored --nocapture`

#[test]
#[ignore]
fn audit_a_real_wad_folder() {
    let dir = std::env::var("FLINT_AUDIT_DIR").expect("set FLINT_AUDIT_DIR");
    let report = flint_bin::audit_wad_folder(std::path::Path::new(&dir)).expect("audit");
    println!(
        "files={} bins={} failed={} missing={} issues={}",
        report.files_scanned,
        report.bins_scanned,
        report.bins_failed,
        report.missing.len(),
        report.issues.len()
    );
    for m in report.missing.iter().take(20) {
        println!("  MISSING {m}");
    }
    for i in &report.issues {
        println!("  [{:?}] {} {} — {}", i.severity, i.code, i.file, i.message);
    }
}
