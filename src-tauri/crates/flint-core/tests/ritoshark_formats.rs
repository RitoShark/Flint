//! Round-trip + readable-layer smoke tests for rs_troybin / rs_luabin pulled in via the
//! `ritoshark` dependency, exercised against the real Riot sample files.

use ritoshark::prelude::{Parse, Serialize};

const SAMPLE_DIR: &str = r"E:\RitoShark\RitoShark - Crate\RitoShark-Crates\Sample-Files";

fn read_sample(name: &str) -> Option<Vec<u8>> {
    std::fs::read(format!("{SAMPLE_DIR}\\{name}")).ok()
}

#[test]
fn troybin_round_trips_real_files() {
    use ritoshark::troybin::Troybin;
    let mut tested = 0;
    for name in ["sru_baron_spawn_sound.troybin", "sru_airdragon_ba_impact.troybin"] {
        let Some(bytes) = read_sample(name) else { continue };
        let parsed = Troybin::from_bytes(&bytes).unwrap_or_else(|e| panic!("{name}: parse failed: {e:?}"));
        let written = parsed.to_bytes().unwrap_or_else(|e| panic!("{name}: write failed: {e:?}"));
        assert_eq!(written, bytes, "{name}: troybin did not round-trip byte-exact");
        tested += 1;
    }
    assert!(tested > 0, "no troybin sample files found");
}

#[test]
fn troybin_readable_layer_resolves_and_edits() {
    use ritoshark::troybin::{Troybin, TroybinBody, ScalarValue};
    let Some(bytes) = read_sample("sru_airdragon_ba_impact.troybin")
        .or_else(|| read_sample("sru_baron_spawn_sound.troybin")) else { return };
    let mut parsed = Troybin::from_bytes(&bytes).expect("parse");

    // Only v2 carries value typing; v1 has none.
    let TroybinBody::V2(_) = &parsed.body else {
        eprintln!("sample troybin is v1 (no value typing) — skipping readable-layer asserts");
        return;
    };

    // Flatten all (hash, value) and count how many resolve to a human name.
    let resolver = parsed.resolver();
    let (mut total, mut resolved) = (0usize, 0usize);
    let mut first_i32: Option<(u32, i32)> = None;
    if let TroybinBody::V2(body) = &parsed.body {
        for (hash, value) in body.iter() {
            total += 1;
            if resolver.name(hash).is_some() { resolved += 1; }
            if first_i32.is_none() {
                if let ScalarValue::I32(v) = value { first_i32 = Some((hash, v)); }
            }
        }
    }
    eprintln!("troybin: {resolved}/{total} hashes resolved to names");
    assert!(total > 0, "v2 troybin had no properties");

    // Edit one i32 by hash via the flattened setter, then round-trip and confirm it stuck.
    if let Some((hash, old)) = first_i32 {
        if let TroybinBody::V2(body) = &mut parsed.body {
            let changed = body.set(hash, ScalarValue::I32(old.wrapping_add(1))).expect("set");
            assert!(changed, "set should report the hash existed");
        }
        let rewritten = parsed.to_bytes().expect("rewrite");
        let reparsed = Troybin::from_bytes(&rewritten).expect("reparse");
        if let TroybinBody::V2(body) = &reparsed.body {
            assert_eq!(body.get(hash), Some(ScalarValue::I32(old.wrapping_add(1))), "edit did not persist");
        }
    }
}

#[test]
fn luabin_round_trips_real_files() {
    use ritoshark::luabin::LuaBin;
    let mut tested = 0;
    for name in ["electrocute.luabin64", "perksglobalbuff.luabin64", "charscriptazirsundisc.luabin64"] {
        let Some(bytes) = read_sample(name) else { continue };
        let parsed = LuaBin::from_bytes(&bytes).unwrap_or_else(|e| panic!("{name}: parse failed: {e:?}"));
        let written = parsed.to_bytes().unwrap_or_else(|e| panic!("{name}: write failed: {e:?}"));
        assert_eq!(written, bytes, "{name}: luabin did not round-trip byte-exact");
        tested += 1;
    }
    assert!(tested > 0, "no luabin sample files found");
}

#[test]
fn luabin_readable_layer_globals_and_edit() {
    use ritoshark::luabin::{LuaBin, LuaConstant};
    // Try each sample; use the first that yields at least one global assignment.
    for name in ["perksglobalbuff.luabin64", "electrocute.luabin64", "charscriptazirsundisc.luabin64"] {
        let Some(bytes) = read_sample(name) else { continue };
        let mut bin = LuaBin::from_bytes(&bytes).expect("parse");

        let total_consts = bin.iter_constants().count();
        let assigns = bin.global_assignments();
        eprintln!("{name}: {} constants, {} global assignments", total_consts, assigns.len());
        for a in assigns.iter().take(8) {
            eprintln!("  {} = {:?}", a.name, bin.constant(&a.value));
        }

        // Find a global whose value is a number, bump it, confirm width-preserving + persists.
        let numeric = assigns.iter()
            .find(|a| matches!(bin.constant(&a.value), Some(LuaConstant::Number(_))))
            .cloned();
        if let Some(a) = numeric {
            let before_len = bin.to_bytes().expect("write").len();
            let old = bin.number(&a.value).expect("number");
            bin.set_number(&a.value, old + 1.0).expect("set_number");
            let rewritten = bin.to_bytes().expect("rewrite");
            assert_eq!(rewritten.len(), before_len, "number edit must preserve file length");
            let reparsed = LuaBin::from_bytes(&rewritten).expect("reparse");
            let now = reparsed.number(&a.value).expect("number after");
            assert!((now - (old + 1.0)).abs() < 1e-6, "global '{}' edit did not persist ({old} -> {now})", a.name);
            return; // success on this file
        }
    }
    eprintln!("no luabin sample exposed a numeric global assignment — readable-layer edit not asserted");
}
