/*!
`extraCharacterPreloads` — the characters a skin pulls in besides the champion itself
(Zyra's plants, Annie's Tibbers, Anivia's egg). The skin BIN names them, which makes it
the only authority on which sub-characters belong to a skin; globbing the WAD for other
characters that happen to ship a matching `skins/skin{N}.bin` also matches Riot's
`jade_*` classic-mode roster, which belongs to no skin.

Read from the skin BIN itself: `SkinCharacterDataProperties` is keyed by a per-skin path
hash and is never hoisted into a shared linked BIN, so there is nothing to follow.
*/

use ritoshark::bin::{Bin, BinValue};
use ritoshark::hash::fnv1a;

const EXTRA_CHARACTER_PRELOADS: u32 = fnv1a("extraCharacterPreloads");

/// Riot's classic-mode roster (`jade_ahri`, `jade_annie_tibbers`, …) ships full skin trees
/// inside the champion WAD. No skin preloads them, so they are never a sub-character.
pub const ALT_MODE_CHARACTER_PREFIX: &str = "jade_";

/// The declared preloads of a parsed skin BIN, lowercased and deduplicated.
pub fn extra_character_preloads(bin: &Bin) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    for entry in &bin.entries {
        let Some(BinValue::List { items, .. }) = entry.fields.get(&EXTRA_CHARACTER_PRELOADS)
        else {
            continue;
        };
        for item in items {
            let BinValue::String(name) = item else { continue };
            // Riot ships entries with stray whitespace (` ZyraPassive`); an untrimmed
            // name yields a character folder that exists nowhere.
            let normalized = name.trim().to_lowercase();
            if normalized.is_empty() || out.contains(&normalized) {
                continue;
            }
            out.push(normalized);
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use ritoshark::bin::{BinEntry, BinType};

    fn skin_bin(preloads: &[&str]) -> Bin {
        let mut fields = IndexMap::new();
        fields.insert(
            EXTRA_CHARACTER_PRELOADS,
            BinValue::List {
                is_list2: false,
                item: BinType::String,
                items: preloads
                    .iter()
                    .map(|p| BinValue::String((*p).to_string()))
                    .collect(),
            },
        );
        let mut bin = Bin::new();
        bin.entries.push(BinEntry {
            path_hash: 0x1234,
            class_hash: fnv1a("SkinCharacterDataProperties"),
            fields,
        });
        bin
    }

    #[test]
    fn names_are_trimmed_lowercased_and_deduplicated() {
        let bin = skin_bin(&[
            "ZyraThornPlant",
            " ZyraPassive",
            "zyrathornplant",
            "ZyraSeed",
            "   ",
        ]);
        assert_eq!(
            extra_character_preloads(&bin),
            vec!["zyrathornplant", "zyrapassive", "zyraseed"]
        );
    }

    #[test]
    fn a_bin_without_the_field_declares_nothing() {
        let mut bin = Bin::new();
        bin.entries.push(BinEntry {
            path_hash: 0x1234,
            class_hash: fnv1a("SkinCharacterDataProperties"),
            fields: IndexMap::new(),
        });
        assert!(extra_character_preloads(&bin).is_empty());
    }

    #[test]
    fn the_field_hash_is_the_fnv1a_of_the_lowercased_name() {
        assert_eq!(EXTRA_CHARACTER_PRELOADS, fnv1a("extracharacterpreloads"));
    }
}
