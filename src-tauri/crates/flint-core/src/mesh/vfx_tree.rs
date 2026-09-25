use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use ritoshark::bin::{BinEntry, BinValue};
use ritoshark::hash::fnv1a;
use serde_json::{json, Value};

use super::materials::BinIndex;

pub(super) fn system(
    entry: &BinEntry,
    entries: &[&BinEntry],
    index: &BinIndex,
    resources: &HashMap<u32, u32>,
) -> Result<Value, String> {
    let mut tree = Tree {
        entries: entries.iter().rev().map(|e| (e.path_hash, *e)).collect(),
        index,
        resources,
        open: HashSet::new(),
        nodes: 0,
    };
    let root = tree.link(entry.path_hash, 0)?;
    Ok(
        json!({"entry": hex(entry.path_hash), "name": null, "classHash": hex(entry.class_hash), "class": null, "root": root, "materials": []}),
    )
}

fn hex(hash: u32) -> String {
    format!("0x{hash:08x}")
}

struct Tree<'a> {
    entries: HashMap<u32, &'a BinEntry>,
    index: &'a BinIndex<'a>,
    resources: &'a HashMap<u32, u32>,
    open: HashSet<u32>,
    nodes: usize,
}

impl Tree<'_> {
    fn link(&mut self, hash: u32, depth: usize) -> Result<Value, String> {
        let Some(entry) = self.entries.get(&hash).copied() else {
            return Ok(json!({"type":"link", "hash":hex(hash), "name":null}));
        };
        if !self.open.insert(hash) {
            return Ok(json!({"type":"link", "hash":hex(hash), "name":null}));
        }
        let node = self.object(entry.class_hash, &entry.fields, Some(hash), depth);
        self.open.remove(&hash);
        node
    }

    fn object(
        &mut self,
        class: u32,
        fields: &IndexMap<u32, BinValue>,
        entry: Option<u32>,
        depth: usize,
    ) -> Result<Value, String> {
        self.charge(depth)?;
        let mut out = Vec::with_capacity(fields.len());
        for (hash, value) in fields {
            let asset_field = [
                "texture",
                "falloffTexture",
                "particleColorTexture",
                "emissionMeshName",
                "mMeshName",
                "mMeshSkeletonName",
                "mSimpleMeshName",
                "textureMult",
                "paletteTexture",
                "erosionMapName",
                "normalMapTexture",
                "reflectionMapTexture",
                "mAnimationName",
                "AnimationName",
                "meshName",
                "skeletonName",
                "texturePath",
                "defaultTexturePath",
            ]
            .iter()
            .any(|name| fnv1a(name) == *hash);
            let node = if asset_field && matches!(value, BinValue::String(_) | BinValue::File(_)) {
                self.charge(depth + 1)?;
                self.asset(value)
            } else if *hash == fnv1a("mAnimationVariants") {
                if let BinValue::List { items, .. } = value {
                    self.charge(depth + 1)?;
                    let mut variants = Vec::with_capacity(items.len());
                    for item in items {
                        variants.push(if matches!(item, BinValue::String(_) | BinValue::File(_)) {
                            self.charge(depth + 2)?;
                            self.asset(item)
                        } else {
                            self.value(item, depth + 2)?
                        });
                    }
                    json!({"type":"container", "items":variants})
                } else {
                    self.value(value, depth + 1)?
                }
            } else if class == fnv1a("VfxChildIdentifier") && *hash == fnv1a("effectKey") {
                if let BinValue::Hash(key) = value {
                    self.link(*self.resources.get(key).unwrap_or(key), depth + 1)?
                } else {
                    self.value(value, depth + 1)?
                }
            } else {
                self.value(value, depth + 1)?
            };
            out.push(json!({"hash":hex(*hash), "name":null, "value":node}));
        }
        Ok(
            json!({"type":"struct", "classHash":hex(class), "class":null, "fields":out, "object":entry.map(|hash| json!({"entry":hex(hash),"name":null}))}),
        )
    }

    fn charge(&mut self, depth: usize) -> Result<(), String> {
        self.nodes += 1;
        if depth > 64 || self.nodes > 500_000 {
            Err("Idle effect exceeds the VFX tree size limit".into())
        } else {
            Ok(())
        }
    }

    fn asset(&self, value: &BinValue) -> Value {
        if matches!(value, BinValue::String(s) if s.is_empty())
            || matches!(value, BinValue::File(0))
        {
            return json!({"type":"asset", "path":"", "asset":null});
        }
        match self.index.asset_path(value) {
            Some(path) => json!({"type":"asset", "path":path, "asset":{"kind":"file","path":path}}),
            None => json!({"type":"asset", "path":format!("{value:?}"), "asset":null}),
        }
    }

    fn value(&mut self, value: &BinValue, depth: usize) -> Result<Value, String> {
        self.charge(depth)?;
        Ok(match value {
            BinValue::None => json!({"type":"none"}),
            BinValue::Bool(v) | BinValue::Flag(v) => json!({"type":"bool","value":v}),
            BinValue::I8(v) => json!({"type":"number","value":v}),
            BinValue::U8(v) => json!({"type":"number","value":v}),
            BinValue::I16(v) => json!({"type":"number","value":v}),
            BinValue::U16(v) => json!({"type":"number","value":v}),
            BinValue::I32(v) => json!({"type":"number","value":v}),
            BinValue::U32(v) => json!({"type":"number","value":v}),
            BinValue::I64(v) => json!({"type":"number","value":v}),
            BinValue::U64(v) => json!({"type":"number","value":v}),
            BinValue::F32(v) => json!({"type":"number","value":v}),
            BinValue::Vec2(v) => json!({"type":"vector","values":v}),
            BinValue::Vec3(v) => json!({"type":"vector","values":v}),
            BinValue::Vec4(v) => json!({"type":"vector","values":v}),
            BinValue::Mtx44(v) => json!({"type":"matrix","values":v}),
            BinValue::Rgba(v) => json!({"type":"vector","values":v.map(|c| c as f32 / 255.0)}),
            BinValue::String(v) => json!({"type":"string","value":v}),
            BinValue::Hash(v) => json!({"type":"hash","hash":hex(*v),"name":null}),
            BinValue::File(_) => self.asset(value),
            BinValue::Link(hash) => self.link(*hash, depth + 1)?,
            BinValue::Pointer { class: 0, .. } => json!({"type":"null"}),
            BinValue::Pointer { class, fields } | BinValue::Embed { class, fields } => {
                self.object(*class, fields, None, depth + 1)?
            }
            BinValue::Option { value, .. } => match value {
                Some(v) => self.value(v, depth + 1)?,
                None => json!({"type":"none"}),
            },
            BinValue::List { items, .. } => {
                json!({"type":"container","items":items.iter().map(|v| self.value(v, depth + 1)).collect::<Result<Vec<_>,_>>()?})
            }
            BinValue::Map { entries, .. } => {
                let mut out = Vec::new();
                for (key, value) in entries {
                    let key = match key {
                        BinValue::String(s) => s.clone(),
                        BinValue::Hash(h) | BinValue::Link(h) => hex(*h),
                        _ => format!("{key:?}"),
                    };
                    out.push(json!({"key":key,"value":self.value(value, depth + 1)?}));
                }
                json!({"type":"map","entries":out})
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bin::Trailer;
    use ritoshark::bin::{Bin, BinType};

    fn fields(values: Vec<(&str, BinValue)>) -> IndexMap<u32, BinValue> {
        values
            .into_iter()
            .map(|(name, value)| (fnv1a(name), value))
            .collect()
    }

    #[test]
    fn preserves_nested_primitives_and_resolves_child_keys_without_expanding_cycles() {
        let parent = BinEntry {
            path_hash: 1,
            class_hash: fnv1a("VfxSystemDefinitionData"),
            fields: fields(vec![
                (
                    "primitive",
                    BinValue::Pointer {
                        class: fnv1a("VfxPrimitiveBeam"),
                        fields: fields(vec![("mSegments", BinValue::U32(12))]),
                    },
                ),
                (
                    "children",
                    BinValue::List {
                        is_list2: false,
                        item: BinType::Embed,
                        items: vec![BinValue::Embed {
                            class: fnv1a("VfxChildIdentifier"),
                            fields: fields(vec![("effectKey", BinValue::Hash(7))]),
                        }],
                    },
                ),
                ("unknownAuthoredField", BinValue::Vec4([1., 2., 3., 4.])),
            ]),
        };
        let child = BinEntry {
            path_hash: 2,
            class_hash: fnv1a("VfxSystemDefinitionData"),
            fields: fields(vec![
                ("back", BinValue::Link(1)),
                ("texture", BinValue::String("".into())),
            ]),
        };
        let bin = Bin {
            entries: vec![parent, child],
            ..Bin::default()
        };
        let index = BinIndex::new([(&bin, Trailer::new())]);
        let output = system(
            &bin.entries[0],
            &bin.entries.iter().collect::<Vec<_>>(),
            &index,
            &HashMap::from([(7, 2)]),
        )
        .unwrap();
        let fields = &output["root"]["fields"];
        assert_eq!(
            fields[0]["value"]["classHash"],
            hex(fnv1a("VfxPrimitiveBeam"))
        );
        assert_eq!(fields[0]["value"]["fields"][0]["value"]["value"], 12);
        assert_eq!(fields[2]["value"]["values"], json!([1., 2., 3., 4.]));
        let child = &fields[1]["value"]["items"][0]["fields"][0]["value"];
        assert_eq!(child["object"]["entry"], "0x00000002");
        assert_eq!(child["fields"][0]["value"]["type"], "link");
        assert_eq!(child["fields"][1]["value"]["path"], "");
    }

    #[test]
    fn resolves_mesh_animation_surface_and_material_assets() {
        let mut values: Vec<(&str, BinValue)> = [
            "mAnimationName",
            "AnimationName",
            "meshName",
            "skeletonName",
            "texturePath",
        ]
        .into_iter()
        .map(|name| (name, BinValue::String(format!("assets/{name}"))))
        .collect();
        values.push((
            "mAnimationVariants",
            BinValue::List {
                is_list2: false,
                item: BinType::String,
                items: vec![BinValue::String("assets/variant.anm".into())],
            },
        ));
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: 1,
                class_hash: 1,
                fields: fields(values),
            }],
            ..Bin::default()
        };
        let index = BinIndex::new([(&bin, Trailer::new())]);
        let output = system(&bin.entries[0], &[&bin.entries[0]], &index, &HashMap::new()).unwrap();
        let projected = output["root"]["fields"].as_array().unwrap();
        for field in &projected[..5] {
            assert_eq!(field["value"]["type"], "asset");
            assert_eq!(field["value"]["asset"]["kind"], "file");
        }
        assert_eq!(
            projected[5]["value"]["items"][0]["path"],
            "assets/variant.anm"
        );
        assert_eq!(output["materials"], json!([]));
    }

    #[test]
    fn rejects_excessive_nesting() {
        let mut value = BinValue::F32(1.);
        for _ in 0..70 {
            value = BinValue::Option {
                item: BinType::F32,
                value: Some(Box::new(value)),
            };
        }
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: 1,
                class_hash: 1,
                fields: fields(vec![("deep", value)]),
            }],
            ..Bin::default()
        };
        let index = BinIndex::new([(&bin, Trailer::new())]);
        assert!(system(&bin.entries[0], &[&bin.entries[0]], &index, &HashMap::new()).is_err());
    }
}
