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
}
