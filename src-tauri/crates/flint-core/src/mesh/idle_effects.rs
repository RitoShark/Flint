use std::path::Path;

use indexmap::IndexMap;
use ritoshark::bin::{BinEntry, BinValue};
use ritoshark::hash::fnv1a;
use serde::Serialize;
use serde_json::{json, Value};

use super::materials::{fields_of, items_of, BinIndex};

#[derive(Default, Serialize)]
pub struct IdleEffects {
    pub attachments: Vec<Value>,
    pub warnings: Vec<String>,
}

fn field<'a>(fields: &'a IndexMap<u32, BinValue>, name: &str) -> Option<&'a BinValue> {
    fields.get(&fnv1a(name))
}

fn key(value: &BinValue) -> Option<u32> {
    match value {
        BinValue::Hash(h) | BinValue::Link(h) => Some(*h),
        BinValue::String(s) => Some(fnv1a(s)),
        _ => None,
    }
}

fn plain(value: &BinValue, index: &BinIndex) -> Value {
    match value {
        BinValue::Bool(v) | BinValue::Flag(v) => json!(v),
        BinValue::F32(v) => json!(v),
        BinValue::U8(v) => json!(v),
        BinValue::U16(v) => json!(v),
        BinValue::U32(v) => json!(v),
        BinValue::I16(v) => json!(v),
        BinValue::I32(v) => json!(v),
        BinValue::Vec2(v) => json!(v),
        BinValue::Vec3(v) => json!(v),
        BinValue::Vec4(v) => json!(v),
        BinValue::Rgba(v) => json!(v.map(|c| c as f32 / 255.0)),
        BinValue::String(v) => json!(v),
        BinValue::File(_) => json!(index.asset_path(value)),
        BinValue::List { items, .. } => items.iter().map(|v| plain(v, index)).collect(),
        BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } => {
            let mut out = serde_json::Map::new();
            for name in [
                "constantValue",
                "dynamics",
                "times",
                "values",
                "probabilityTables",
                "keyTimes",
                "keyValues",
            ] {
                if let Some(value) = field(fields, name) {
                    out.insert(name.into(), plain(value, index));
                }
            }
            Value::Object(out)
        }
        _ => Value::Null,
    }
}

fn resolve_system<'a>(entries: &[&'a BinEntry], hash: u32) -> Option<&'a BinEntry> {
    if let Some(entry) = entries
        .iter()
        .find(|e| e.path_hash == hash && e.class_hash == fnv1a("VfxSystemDefinitionData"))
    {
        return Some(entry);
    }
    None
}

pub fn read_idle_effects(mesh: &Path) -> IdleEffects {
    if super::texture::find_skin_bin(mesh).is_none() {
        return IdleEffects::default();
    }
    let mut bins = super::ritobin::mesh_bins(mesh);
    let mut visited = std::collections::HashSet::new();
    let mut cursor = 0;
    while cursor < bins.len() && bins.len() < 128 {
        let links = bins[cursor].0.linked.clone();
        cursor += 1;
        for link in links {
            let Some(path) =
                super::ritobin::resolve_linked_bin_path(mesh, None, &link.replace('\\', "/"))
            else {
                continue;
            };
            if !visited.insert(path.clone()) {
                continue;
            }
            if let Some(bin) = super::ritobin::load_bin(&path) {
                if !bins
                    .iter()
                    .any(|existing| std::sync::Arc::ptr_eq(existing, &bin))
                {
                    bins.push(bin);
                }
            }
        }
    }
    let index = BinIndex::new(bins.iter().map(|b| (&b.0, b.1.clone())));
    let entries: Vec<_> = bins.iter().flat_map(|b| &b.0.entries).collect();
    collect_idle_effects(&entries, &index)
}

fn collect_idle_effects(entries: &[&BinEntry], index: &BinIndex) -> IdleEffects {
    let mut result = IdleEffects::default();
    let Some(skin) = entries
        .iter()
        .find(|e| e.class_hash == fnv1a("SkinCharacterDataProperties"))
    else {
        return result;
    };
    let Some(idle) = field(&skin.fields, "idleParticlesEffects") else {
        return result;
    };
    let mut resolver_keys: Vec<_> = field(&skin.fields, "mResourceResolver")
        .and_then(key)
        .into_iter()
        .collect();
    if let Some(additional) = field(&skin.fields, "mAdditionalResourceResolvers") {
        resolver_keys.extend(items_of(additional).iter().filter_map(key));
    }
    for effect in items_of(idle) {
        let Some(fields) = fields_of(effect) else {
            continue;
        };
        let Some(effect_key) = field(fields, "effectKey").and_then(key) else {
            continue;
        };
        let mapped = resolver_keys.iter().find_map(|hash| {
            let resolver = entries.iter().find(|e| e.path_hash == *hash)?;
            match field(&resolver.fields, "resourceMap") {
                Some(BinValue::Map { entries, .. }) => entries
                    .iter()
                    .find(|(k, _)| key(k) == Some(effect_key))
                    .and_then(|(_, v)| key(v)),
                _ => None,
            }
        });
        let system = resolve_system(&entries, mapped.unwrap_or(effect_key));
        let Some(system) = system else {
            result.warnings.push(format!(
                "Idle effect {effect_key:08x} could not be resolved"
            ));
            continue;
        };
        let mut emitters = Vec::new();
        for list in [
            "complexEmitterDefinitionData",
            "simpleEmitterDefinitionData",
        ] {
            for emitter in field(&system.fields, list)
                .map(items_of)
                .unwrap_or_default()
            {
                let Some(fields) = fields_of(emitter) else {
                    continue;
                };
                let label = field(fields, "emitterName")
                    .map(|v| plain(v, &index))
                    .unwrap_or(json!("Emitter"));
                if let Some(BinValue::Pointer { class, .. }) = field(fields, "primitive") {
                    if *class != 0 && *class != fnv1a("VfxPrimitiveCameraQuad") {
                        result
                            .warnings
                            .push(format!("{label}: unsupported particle shape"));
                        continue;
                    }
                }
                let mut data = serde_json::Map::new();
                for name in [
                    "emitterName",
                    "texture",
                    "rate",
                    "particleLifetime",
                    "isSingleParticle",
                    "birthVelocity",
                    "birthColor",
                    "color",
                    "birthScale0",
                    "scale0",
                    "birthRotation0",
                    "birthRotationalVelocity0",
                    "acceleration",
                    "bindWeight",
                    "emitterLifetime",
                    "birthDelay",
                    "blendMode",
                    "numFrames",
                    "startFrame",
                    "frameRate",
                    "texDiv",
                    "isLocalOrientation",
                    "isGroundLayer",
                    "EmitterPosition",
                    "birthTranslation",
                    "particleLinger",
                    "isDisabled",
                ] {
                    if let Some(value) = field(fields, name) {
                        data.insert(name.into(), plain(value, &index));
                    }
                }
                emitters.push(Value::Object(data));
            }
        }
        let value = |name: &str, default: Value| {
            field(fields, name)
                .map(|v| plain(v, &index))
                .unwrap_or(default)
        };
        result.attachments.push(json!({
            "bone": value("boneName", json!("")),
            "position": value("Position", json!([0, 0, 0])),
            "emitters": emitters,
        }));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bin::Trailer;
    use ritoshark::bin::{Bin, BinType};

    fn fields(values: Vec<(&str, BinValue)>) -> IndexMap<u32, BinValue> {
        values.into_iter().map(|(k, v)| (fnv1a(k), v)).collect()
    }

    fn fixture(target: u32) -> Bin {
        let idle = BinValue::Embed {
            class: 1,
            fields: fields(vec![
                ("effectKey", BinValue::Hash(17)),
                ("boneName", BinValue::String("spine".into())),
                ("Position", BinValue::Vec3([1.0, 2.0, 3.0])),
            ]),
        };
        let emitter = BinValue::Pointer {
            class: fnv1a("VfxEmitterDefinitionData"),
            fields: fields(vec![
                ("texture", BinValue::File(99)),
                (
                    "rate",
                    BinValue::Embed {
                        class: 1,
                        fields: fields(vec![("constantValue", BinValue::F32(4.0))]),
                    },
                ),
            ]),
        };
        Bin {
            entries: vec![
                BinEntry {
                    path_hash: 1,
                    class_hash: fnv1a("SkinCharacterDataProperties"),
                    fields: fields(vec![
                        ("mResourceResolver", BinValue::Link(2)),
                        (
                            "idleParticlesEffects",
                            BinValue::List {
                                is_list2: false,
                                item: BinType::Embed,
                                items: vec![idle],
                            },
                        ),
                    ]),
                },
                BinEntry {
                    path_hash: 2,
                    class_hash: fnv1a("ResourceResolver"),
                    fields: fields(vec![(
                        "resourceMap",
                        BinValue::Map {
                            key: BinType::Hash,
                            value: BinType::Link,
                            entries: vec![(BinValue::Hash(17), BinValue::Link(target))],
                        },
                    )]),
                },
                BinEntry {
                    path_hash: 3,
                    class_hash: fnv1a("VfxSystemDefinitionData"),
                    fields: fields(vec![(
                        "complexEmitterDefinitionData",
                        BinValue::List {
                            is_list2: false,
                            item: BinType::Pointer,
                            items: vec![emitter],
                        },
                    )]),
                },
            ],
            ..Bin::default()
        }
    }

    #[test]
    fn resolves_idle_key_and_hashed_texture_without_requiring_animation() {
        let bin = fixture(3);
        let mut names = Trailer::new();
        names.files.insert(99, "assets/idle.tex".into());
        let index = BinIndex::new([(&bin, names)]);
        let result = collect_idle_effects(&bin.entries.iter().collect::<Vec<_>>(), &index);
        assert!(result.warnings.is_empty());
        assert_eq!(result.attachments[0]["bone"], "spine");
        assert_eq!(result.attachments[0]["position"], json!([1.0, 2.0, 3.0]));
        assert_eq!(
            result.attachments[0]["emitters"][0]["texture"],
            "assets/idle.tex"
        );
        assert_eq!(
            result.attachments[0]["emitters"][0]["rate"]["constantValue"],
            4.0
        );
    }

    #[test]
    fn missing_target_is_reported_instead_of_using_an_unrelated_system() {
        let bin = fixture(400);
        let index = BinIndex::new([(&bin, Trailer::new())]);
        let result = collect_idle_effects(&bin.entries.iter().collect::<Vec<_>>(), &index);
        assert!(result.attachments.is_empty());
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn additional_skin_resolvers_are_used_when_the_primary_misses() {
        let mut bin = fixture(3);
        bin.entries[0]
            .fields
            .insert(fnv1a("mResourceResolver"), BinValue::Link(999));
        bin.entries[0].fields.insert(
            fnv1a("mAdditionalResourceResolvers"),
            BinValue::List {
                is_list2: false,
                item: BinType::Link,
                items: vec![BinValue::Link(2)],
            },
        );
        let index = BinIndex::new([(&bin, Trailer::new())]);
        let result = collect_idle_effects(&bin.entries.iter().collect::<Vec<_>>(), &index);
        assert_eq!(result.attachments.len(), 1);
        assert!(result.warnings.is_empty());
    }
}
