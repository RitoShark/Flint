//! Differential: league-toolkit (`ltk_anim`) vs RitoShark (`rs_anim`) for skeleton (`.skl`) and
//! animation (`.anm`) parsing. Both decoders run on the same bytes and must agree on structure.
//!
//! Skips entirely unless `FLINT_TEST_ASSETS` points at a directory of real `.skl`/`.anm` files
//! (the path is gitignored — never commit game assets).
//!
//! IMPORTANT nuance: `ltk_anim` *panics* (via `todo!()`) on legacy `r3d2sklt` skeletons, so the
//! LTK side is wrapped in `catch_unwind`. We can't treat a panic as ground truth, so for those
//! cases we only assert that RitoShark fails *gracefully* (returns `Err`, ideally
//! `UnsupportedVersion`) instead of crashing — we do NOT compare against the LTK panic.
//!
//! This test is created as part of the LTK→RitoShark anim migration but is NOT run by the agent
//! (three agents share one target dir; the lead verifies centrally). Run manually with:
//!   cargo test -p flint-ltk --test diff_anim

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

use ltk_anim::{Animation as LtkAnimation, AnimationAsset, RigResource};
use ritoshark::anim::{Animation as RsAnimation, Error as RsError, Skeleton as RsSkeleton};
use ritoshark::prelude::Parse; // for `from_bytes` on Skeleton/Animation

fn assets_dir() -> Option<PathBuf> {
    std::env::var_os("FLINT_TEST_ASSETS")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

/// LTK rig parse, catching the legacy-skeleton panic. Returns:
///   Ok(Some(rig))  — LTK parsed it
///   Ok(None)       — LTK returned an Err (non-panic) — both decoders may legitimately reject
///   Err(())        — LTK panicked (legacy format); RitoShark only needs to fail gracefully
fn ltk_rig(data: &[u8]) -> Result<Option<RigResource>, ()> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut cur = std::io::Cursor::new(data);
        RigResource::from_reader(&mut cur)
    }));
    match result {
        Ok(Ok(rig)) => Ok(Some(rig)),
        Ok(Err(_)) => Ok(None),
        Err(_) => Err(()),
    }
}

/// LTK animation parse, catching any panic. Same convention as `ltk_rig`.
fn ltk_anim(data: &[u8]) -> Result<Option<AnimationAsset>, ()> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut cur = std::io::Cursor::new(data);
        AnimationAsset::from_reader(&mut cur)
    }));
    match result {
        Ok(Ok(asset)) => Ok(Some(asset)),
        Ok(Err(_)) => Ok(None),
        Err(_) => Err(()),
    }
}

#[test]
fn ltk_and_ritoshark_skeleton_match() {
    let Some(dir) = assets_dir() else {
        eprintln!("skip: no FLINT_TEST_ASSETS");
        return;
    };

    let mut matched = 0usize;
    let mut legacy = 0usize;
    for entry in walkdir::WalkDir::new(&dir)
        .into_iter()
        .filter_map(Result::ok)
    {
        let p = entry.path();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("skl") {
            continue;
        }
        let Ok(data) = std::fs::read(p) else { continue };

        let rs = RsSkeleton::from_bytes(&data);

        match ltk_rig(&data) {
            // LTK panicked => legacy skeleton. RitoShark must fail gracefully (no crash),
            // ideally with UnsupportedVersion. We only require an Err here.
            Err(()) => {
                match rs {
                    Err(RsError::UnsupportedVersion(_)) => {}
                    Err(other) => {
                        eprintln!(
                            "note: ltk panicked (legacy) for {:?}; ritoshark err = {:?}",
                            p, other
                        );
                    }
                    Ok(_) => panic!(
                        "ltk panicked (legacy skeleton) but ritoshark parsed it as Ok: {:?}",
                        p
                    ),
                }
                legacy += 1;
            }
            // LTK returned a clean Err — both decoders may legitimately reject. No assertion.
            Ok(None) => {}
            // LTK parsed it — RitoShark must match joint structure.
            Ok(Some(rig)) => {
                let rs = rs.unwrap_or_else(|e| {
                    panic!("ltk parsed but ritoshark failed for {:?}: {:?}", p, e)
                });

                assert_eq!(
                    rig.joints().len(),
                    rs.joints.len(),
                    "joint count differs for {:?}",
                    p
                );

                for (lj, rj) in rig.joints().iter().zip(rs.joints.iter()) {
                    assert_eq!(lj.id(), rj.id, "joint id differs for {:?}", p);
                    assert_eq!(
                        lj.parent_id(),
                        rj.parent_id,
                        "joint parent_id differs for {:?}",
                        p
                    );
                    assert_eq!(lj.name(), rj.name.as_str(), "joint name differs for {:?}", p);
                }

                // Influences: LTK stores i16, RitoShark u16 — compare bit-for-bit.
                let ltk_inf: Vec<i16> = rig.influences().to_vec();
                let rs_inf: Vec<i16> = rs.influences.iter().map(|&i| i as i16).collect();
                assert_eq!(ltk_inf, rs_inf, "influences differ for {:?}", p);

                matched += 1;
            }
        }
    }
    eprintln!("diff_anim (skl): matched {matched} skeletons, {legacy} legacy (ritoshark Err)");
}

#[test]
fn ltk_and_ritoshark_animation_match() {
    let Some(dir) = assets_dir() else {
        eprintln!("skip: no FLINT_TEST_ASSETS");
        return;
    };

    let mut matched = 0usize;
    for entry in walkdir::WalkDir::new(&dir)
        .into_iter()
        .filter_map(Result::ok)
    {
        let p = entry.path();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("anm") {
            continue;
        }
        let Ok(data) = std::fs::read(p) else { continue };

        let rs = RsAnimation::from_bytes(&data);

        match ltk_anim(&data) {
            // LTK panicked — RitoShark just must not crash (Ok or Err both acceptable).
            Err(()) => {
                eprintln!(
                    "note: ltk panicked for {:?}; ritoshark ok = {}",
                    p,
                    rs.is_ok()
                );
            }
            // LTK rejected cleanly — no assertion.
            Ok(None) => {}
            // LTK parsed it — RitoShark must parse and agree on fps + joint-hash set.
            Ok(Some(asset)) => {
                let rs = rs.unwrap_or_else(|e| {
                    panic!("ltk parsed but ritoshark failed for {:?}: {:?}", p, e)
                });

                // fps should match closely (both derive it from frame duration).
                let lfps = asset.fps();
                let rfps = rs.fps;
                assert!(
                    (lfps - rfps).abs() <= 0.5_f32.max(lfps.abs() * 0.01),
                    "fps differs for {:?}: ltk={lfps} rs={rfps}",
                    p
                );

                // The set of animated joint hashes must agree (frame-by-frame float values are
                // decoder-dependent — LTK bakes via `evaluate` sampling, RitoShark decodes
                // natively — so we compare structural identity, not exact keyframes).
                let mut ltk_hashes: Vec<u32> = asset.joints().into_owned();
                ltk_hashes.sort_unstable();
                ltk_hashes.dedup();

                let mut rs_hashes: Vec<u32> =
                    rs.tracks.iter().map(|t| t.joint_hash).collect();
                rs_hashes.sort_unstable();
                rs_hashes.dedup();

                assert_eq!(
                    ltk_hashes, rs_hashes,
                    "animated joint-hash set differs for {:?}",
                    p
                );

                matched += 1;
            }
        }
    }
    eprintln!("diff_anim (anm): matched {matched} animations");
}
