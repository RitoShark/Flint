//! Generate candidate path forms for a linked-BIN reference so recovery can
//! match Riot's rebased shared-bin layout.
//!
//! Riot rebased the shared-bin directory: files that used to live one folder
//! deep with a flat name now live two folders deep with an inserted `_multi_`
//! segment, e.g.
//!   old: data/characters/evelynn/skins/skin0.bin
//!   new: data/characters/evelynn/evelynn_multi_skins_root_skins_skin0_skins...bin
//! We can't know the exact live name, so we emit ordered candidates and let the
//! caller xxhash64 each against the live WAD, taking the first that hits.
//!
//! ## Multi-bins (shared bins for many skins)
//!
//! A "multi-bin" is a single shared bin whose data is used by many skins; its
//! NAME enumerates every member skin, e.g. (old patch)
//!   DATA/Yone_Skins_Root_Skins_Skin0_Skins_Skin1_..._Skins_Skin9.bin
//! On a newer patch Riot (a) moves it 2 folders deeper under
//! `data/characters/<champ>/`, (b) inserts `_multi_` after the champion name, and
//! (c) — critically — the member list GROWS as new skins ship, so the live name
//! contains extra `skinN` tokens the old link never had. A literal-string rebase
//! therefore can never match across patches. Instead we parse the member token
//! SET (`root` + each `skinN`) and find the live multi-bin whose set is the
//! tightest SUPERSET. See [`multi_bin_member_tokens`] and
//! [`best_multi_bin_superset`].

/// Ordered candidate paths for a linked-BIN reference. The original (lowercased,
/// forward-slashed, leading slash trimmed) is always first so an unchanged path
/// still resolves on the cheapest attempt.
pub fn bin_path_variants(path: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push = |s: String, out: &mut Vec<String>| {
        if !s.is_empty() && !out.contains(&s) {
            out.push(s);
        }
    };

    let normalized = path.replace('\\', "/").trim_start_matches('/').to_lowercase();
    push(normalized.clone(), &mut out);

    // Backslash form (some references keep Windows separators).
    push(path.replace('/', "\\").trim_start_matches('\\').to_lowercase(), &mut out);

    // `_multi_` rebase: insert `_multi_` after the champion folder segment for
    // shared/skin bins under data/characters/<champ>/.
    if let Some(rebased) = rebase_multi(&normalized) {
        push(rebased, &mut out);
    }

    out
}

/// Build the rebased `_multi_` candidate for a `data/characters/<champ>/...` path.
/// Returns None for paths that don't match that shape.
fn rebase_multi(normalized: &str) -> Option<String> {
    let rest = normalized.strip_prefix("data/characters/")?;
    let (champ, tail) = rest.split_once('/')?; // e.g. champ + "skins/skin0.bin"
    if champ.is_empty() || tail.is_empty() {
        return None;
    }
    // Drop the `.bin` extension, flatten the tail's separators into `_`, and
    // splice in the `_multi_skins_root_` marker Riot uses.
    let tail_no_ext = tail.strip_suffix(".bin").unwrap_or(tail);
    let flat = tail_no_ext.replace('/', "_");
    Some(format!(
        "data/characters/{champ}/{champ}_multi_skins_root_{flat}.bin"
    ))
}

/// Parse the member-token SET of a multi-bin link, if the path looks like one.
///
/// Accepts both the old flat form (`DATA/Yone_Skins_Root_Skins_Skin0_...bin`)
/// and the live rebased form (`data/characters/yone/yone_multi_skins_root_...bin`).
/// Returns the lowercased member tokens (`"root"`, `"skin0"`, `"skin1"`, …) —
/// the `_skins_` separators and the leading champion/`_multi_` prefix are
/// stripped. Returns `None` when the path has fewer than two members (i.e. it's
/// an ordinary single bin, not a multi-bin).
pub fn multi_bin_member_tokens(path: &str) -> Option<std::collections::BTreeSet<String>> {
    let lower = path.replace('\\', "/").trim_start_matches('/').to_lowercase();
    let stem = lower.rsplit('/').next()?.strip_suffix(".bin")?;
    // Drop a leading `<champ>_multi_` or `<champ>_` prefix: everything up to and
    // including the first `_skins_` (or `skins_` at the very start) is prefix.
    // We normalize by finding the first `skins_` token boundary.
    let body = match stem.find("_skins_") {
        // e.g. "yone_multi" + "_skins_" + "root_skins_skin0..." → keep from "skins_"
        Some(idx) => &stem[idx + 1..], // start at "skins_..."
        None => {
            // Could begin directly with "skins_" (no champ prefix left).
            if stem.starts_with("skins_") { stem } else { return None }
        }
    };
    // body now starts with "skins_<member>_skins_<member>..." Split on "skins_"
    // and collect the non-empty members.
    let mut set = std::collections::BTreeSet::new();
    for part in body.split("skins_") {
        let member = part.trim_matches('_');
        if member.is_empty() {
            continue;
        }
        // A member is `root` or `skin<N>`; ignore anything else (defensive).
        if member == "root" || (member.starts_with("skin") && member[4..].chars().all(|c| c.is_ascii_digit()) && member.len() > 4) {
            set.insert(member.to_string());
        }
    }
    if set.len() < 2 {
        return None;
    }
    Some(set)
}

/// Among `live_paths`, find the live multi-bin whose member set is the tightest
/// SUPERSET of `old_link`'s member set (fewest extra members). Returns the live
/// path. `champion` scopes the search to `data/characters/<champion>/`.
///
/// This is how an old multi-bin link is recovered after Riot moved + renamed it
/// AND grew its member list: we match by member-set containment, not by string.
pub fn best_multi_bin_superset<'a, I>(
    old_link: &str,
    champion: &str,
    live_paths: I,
) -> Option<String>
where
    I: IntoIterator<Item = &'a str>,
{
    let want = multi_bin_member_tokens(old_link)?;
    let champ = champion.to_lowercase();
    let prefix = format!("data/characters/{champ}/{champ}_multi_");

    let mut best: Option<(usize, String)> = None; // (extra_count, path)
    for live in live_paths {
        let live_lower = live.replace('\\', "/").to_lowercase();
        if !live_lower.starts_with(&prefix) {
            continue;
        }
        let Some(have) = multi_bin_member_tokens(&live_lower) else { continue };
        // Must contain every wanted member (superset).
        if !want.iter().all(|m| have.contains(m)) {
            continue;
        }
        let extra = have.len() - want.len();
        match &best {
            Some((best_extra, _)) if *best_extra <= extra => {}
            _ => best = Some((extra, live_lower.clone())),
        }
    }
    best.map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_is_first_and_normalized() {
        let v = bin_path_variants("/Data/Characters/Evelynn/Skins/Skin0.bin");
        assert_eq!(v[0], "data/characters/evelynn/skins/skin0.bin");
    }

    #[test]
    fn emits_multi_rebase_candidate() {
        let v = bin_path_variants("data/characters/evelynn/skins/skin0.bin");
        assert!(
            v.iter().any(|c| c.contains("evelynn_multi_skins_root_skins_skin0")),
            "expected a _multi_ rebased candidate, got {:?}",
            v
        );
    }

    #[test]
    fn non_character_path_has_no_multi_candidate() {
        let v = bin_path_variants("data/shared/global.bin");
        assert!(!v.iter().any(|c| c.contains("_multi_")));
    }

    #[test]
    fn ordinary_single_bin_has_no_member_tokens() {
        assert!(multi_bin_member_tokens("data/characters/yone/skins/skin0.bin").is_none());
        assert!(multi_bin_member_tokens("data/characters/yone/animations/skin0.bin").is_none());
    }

    #[test]
    fn parses_old_flat_multibin_members() {
        let set = multi_bin_member_tokens(
            "DATA/Yone_Skins_Root_Skins_Skin0_Skins_Skin1_Skins_Skin9.bin",
        )
        .expect("multi-bin");
        assert!(set.contains("root"));
        assert!(set.contains("skin0"));
        assert!(set.contains("skin1"));
        assert!(set.contains("skin9"));
        assert_eq!(set.len(), 4);
    }

    #[test]
    fn parses_live_rebased_multibin_members() {
        let set = multi_bin_member_tokens(
            "data/characters/yone/yone_multi_skins_root_skins_skin0_skins_skin1.bin",
        )
        .expect("multi-bin");
        assert!(set.contains("root"));
        assert!(set.contains("skin0"));
        assert!(set.contains("skin1"));
        assert_eq!(set.len(), 3);
    }

    #[test]
    fn superset_match_finds_grown_live_multibin() {
        // The exact real-world case: old link has root+skin0+skin1+skin9; the
        // live multi-bin GREW to also include skin74/75/76. Superset match must
        // still find it.
        let old = "DATA/Yone_Skins_Root_Skins_Skin0_Skins_Skin1_Skins_Skin9.bin";
        let live_match =
            "data/characters/yone/yone_multi_skins_root_skins_skin0_skins_skin1_skins_skin9_skins_skin74_skins_skin75_skins_skin76.bin";
        let live_other = "data/characters/yone/yone_multi_skins_skin45_skins_skin47.bin";
        let live = vec![live_other, live_match, "data/characters/yone/skins/skin0.bin"];
        let found = best_multi_bin_superset(old, "yone", live.iter().copied());
        assert_eq!(found.as_deref(), Some(live_match));
    }

    #[test]
    fn superset_prefers_smallest() {
        let old = "DATA/Yone_Skins_Root_Skins_Skin0.bin";
        let tight = "data/characters/yone/yone_multi_skins_root_skins_skin0_skins_skin1.bin";
        let loose =
            "data/characters/yone/yone_multi_skins_root_skins_skin0_skins_skin1_skins_skin2_skins_skin3.bin";
        // Provide loose first to ensure ordering doesn't decide it.
        let live = vec![loose, tight];
        let found = best_multi_bin_superset(old, "yone", live.iter().copied());
        assert_eq!(found.as_deref(), Some(tight));
    }

    #[test]
    fn no_superset_when_member_missing() {
        // Old wants skin99 which no live bin has → no match.
        let old = "DATA/Yone_Skins_Root_Skins_Skin99.bin";
        let live = vec!["data/characters/yone/yone_multi_skins_root_skins_skin0.bin"];
        assert!(best_multi_bin_superset(old, "yone", live.iter().copied()).is_none());
    }
}
