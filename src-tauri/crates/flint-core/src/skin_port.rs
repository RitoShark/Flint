use crate::bin::{read_bin, write_bin};
use crate::loadscreen_banner::fnv1a_32;
use ritoshark::bin::{Bin, BinValue};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PortOutcome {
    pub written: Vec<u32>,
    pub skipped: Vec<u32>,
}

pub fn jade_character_name(champion: &str) -> String {
    if champion.len() > 5 && champion[..5].eq_ignore_ascii_case("jade_") {
        champion.to_string()
    } else {
        format!("Jade_{champion}")
    }
}

fn scdp_path(character: &str, skin_id: u32) -> String {
    format!("Characters/{character}/Skins/Skin{skin_id}")
}

fn resolver_path(character: &str, skin_id: u32) -> String {
    format!("Characters/{character}/Skins/Skin{skin_id}/Resources")
}

fn rekey_entry(bin: &mut Bin, old: u32, new: u32) -> Result<(), String> {
    if old == new {
        return Ok(());
    }
    let idx = bin
        .entries
        .iter()
        .position(|e| e.path_hash == old)
        .ok_or_else(|| format!("entry {old:#010x} not found while rekeying"))?;
    bin.entries[idx].path_hash = new;
    Ok(())
}

/// Rewrite `source` so its skin entries address `<character>/Skins/Skin<skin_id>`.
///
/// The entry key, the `ResourceResolver` key and the `mResourceResolver` link
/// must all agree with the `skin<N>.bin` filename or the game does not resolve
/// the skin.
pub fn retarget_skin_bin(source: &Bin, character: &str, skin_id: u32) -> Result<Bin, String> {
    let scdp_class = fnv1a_32("SkinCharacterDataProperties");
    let resolver_class = fnv1a_32("ResourceResolver");
    let resolver_field = fnv1a_32("mResourceResolver");

    let old_scdp = source
        .entries
        .iter()
        .find(|e| e.class_hash == scdp_class)
        .map(|e| e.path_hash)
        .ok_or_else(|| "No SkinCharacterDataProperties entry in the source BIN".to_string())?;
    let old_resolver = source
        .entries
        .iter()
        .find(|e| e.class_hash == resolver_class)
        .map(|e| e.path_hash);

    let mut bin = source.clone();

    let new_scdp = fnv1a_32(&scdp_path(character, skin_id));
    rekey_entry(&mut bin, old_scdp, new_scdp)?;

    let mut new_resolver = None;
    if let Some(old) = old_resolver {
        let hash = fnv1a_32(&resolver_path(character, skin_id));
        rekey_entry(&mut bin, old, hash)?;
        new_resolver = Some(hash);
    }

    if let Some(entry) = bin.entries.iter_mut().find(|e| e.path_hash == new_scdp) {
        if let Some(value) = entry.fields.get_mut(&resolver_field) {
            *value = match value {
                BinValue::String(_) => BinValue::String(resolver_path(character, skin_id)),
                _ => match new_resolver {
                    Some(hash) => BinValue::Link(hash),
                    None => value.clone(),
                },
            };
        }
    }

    Ok(bin)
}

/// Write one retargeted copy of `source_bin` per entry in `targets`, into
/// `dest_skins_dir` as `skin<N>.bin`. Existing files are never overwritten.
pub fn port_skin_bin(
    source_bin: &Path,
    dest_skins_dir: &Path,
    dest_character: &str,
    targets: &[u32],
) -> Result<PortOutcome, String> {
    let bytes = std::fs::read(source_bin)
        .map_err(|e| format!("Failed to read {}: {e}", source_bin.display()))?;
    let source = read_bin(&bytes).map_err(|e| format!("Failed to parse the source BIN: {e}"))?;

    std::fs::create_dir_all(dest_skins_dir)
        .map_err(|e| format!("Failed to create {}: {e}", dest_skins_dir.display()))?;

    let mut outcome = PortOutcome::default();
    for &skin_id in targets {
        let out = dest_skins_dir.join(format!("skin{skin_id}.bin"));
        if out.exists() {
            outcome.skipped.push(skin_id);
            continue;
        }
        let ported = retarget_skin_bin(&source, dest_character, skin_id)?;
        let encoded = write_bin(&ported).map_err(|e| format!("Failed to write skin{skin_id}: {e}"))?;
        std::fs::write(&out, encoded)
            .map_err(|e| format!("Failed to write {}: {e}", out.display()))?;
        outcome.written.push(skin_id);
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    use ritoshark::bin::BinEntry;

    fn source_bin(champion: &str, skin_id: u32) -> Bin {
        let resolver_hash = fnv1a_32(&resolver_path(champion, skin_id));
        let mut scdp_fields: IndexMap<u32, BinValue> = IndexMap::new();
        scdp_fields.insert(
            fnv1a_32("championSkinName"),
            BinValue::String("test".to_string()),
        );
        scdp_fields.insert(fnv1a_32("mResourceResolver"), BinValue::Link(resolver_hash));

        let mut bin = Bin::new();
        bin.entries.push(BinEntry {
            path_hash: fnv1a_32(&scdp_path(champion, skin_id)),
            class_hash: fnv1a_32("SkinCharacterDataProperties"),
            fields: scdp_fields,
        });
        bin.entries.push(BinEntry {
            path_hash: resolver_hash,
            class_hash: fnv1a_32("ResourceResolver"),
            fields: Default::default(),
        });
        bin
    }

    #[test]
    fn jade_name_is_idempotent() {
        assert_eq!(jade_character_name("Ahri"), "Jade_Ahri");
        assert_eq!(jade_character_name("Jade_Ahri"), "Jade_Ahri");
        assert_eq!(jade_character_name("jade_ahri"), "jade_ahri");
    }

    #[test]
    fn entry_keys_match_the_target_skin_and_character() {
        let src = source_bin("Ahri", 1);
        let out = retarget_skin_bin(&src, "Jade_Ahri", 301).unwrap();

        let scdp = out
            .entries
            .iter()
            .find(|e| e.class_hash == fnv1a_32("SkinCharacterDataProperties"))
            .unwrap();
        assert_eq!(scdp.path_hash, fnv1a_32("Characters/Jade_Ahri/Skins/Skin301"));

        let resolver = out
            .entries
            .iter()
            .find(|e| e.class_hash == fnv1a_32("ResourceResolver"))
            .unwrap();
        assert_eq!(
            resolver.path_hash,
            fnv1a_32("Characters/Jade_Ahri/Skins/Skin301/Resources")
        );

        assert_eq!(
            scdp.fields.get(&fnv1a_32("mResourceResolver")),
            Some(&BinValue::Link(resolver.path_hash)),
            "mResourceResolver must point at the retargeted resolver"
        );
    }

    #[test]
    fn a_string_resolver_link_stays_a_string() {
        let mut src = source_bin("Ahri", 1);
        let field = fnv1a_32("mResourceResolver");
        for e in src.entries.iter_mut() {
            if let Some(v) = e.fields.get_mut(&field) {
                *v = BinValue::String("Characters/Ahri/Skins/Skin1/Resources".to_string());
            }
        }

        let out = retarget_skin_bin(&src, "Jade_Ahri", 301).unwrap();
        let scdp = out
            .entries
            .iter()
            .find(|e| e.class_hash == fnv1a_32("SkinCharacterDataProperties"))
            .unwrap();
        assert_eq!(
            scdp.fields.get(&field),
            Some(&BinValue::String(
                "Characters/Jade_Ahri/Skins/Skin301/Resources".to_string()
            ))
        );
    }

    #[test]
    fn retargeting_preserves_everything_else() {
        let src = source_bin("Ahri", 1);
        let out = retarget_skin_bin(&src, "Jade_Ahri", 301).unwrap();
        assert_eq!(out.entries.len(), src.entries.len());
        let scdp = out
            .entries
            .iter()
            .find(|e| e.class_hash == fnv1a_32("SkinCharacterDataProperties"))
            .unwrap();
        assert_eq!(
            scdp.fields.get(&fnv1a_32("championSkinName")),
            Some(&BinValue::String("test".to_string()))
        );
    }

    #[test]
    fn a_bin_without_a_skin_entry_is_rejected() {
        let bin = Bin::new();
        assert!(retarget_skin_bin(&bin, "Jade_Ahri", 301).is_err());
    }
}
