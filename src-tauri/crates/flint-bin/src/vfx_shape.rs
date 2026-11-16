use crate::{meta_schema::Schema, Bin, BinValue};
use indexmap::IndexMap;
use ritoshark::hash::fnv1a;

const NEW_SHAPE: u32 = 0x3bf0b4ed;
const NEW_TRANSLATION: u32 = 0x563d4a22;

pub fn fix_shapes(bin: &mut Bin, schema: &Schema) -> Result<usize, String> {
    let mut updated = bin.clone();
    let mut changed = 0;
    for entry in &mut updated.entries {
        if entry.class_hash == fnv1a("VfxSystemDefinitionData") {
            for value in entry.fields.values_mut() {
                walk(value, schema, &mut changed)?;
            }
        }
    }
    *bin = updated;
    Ok(changed)
}

fn walk(value: &mut BinValue, schema: &Schema, changed: &mut usize) -> Result<(), String> {
    match value {
        BinValue::Pointer { class, fields } | BinValue::Embed { class, fields } => {
            if [
                "VfxEmitterDefinitionData",
                "ComplexEmitterDefinitionData",
                "SimpleEmitterDefinitionData",
                "ParticleEmitterProperties",
            ]
            .iter()
            .any(|name| *class == fnv1a(name))
            {
                *changed += fix_emitter(*class, fields, schema)? as usize;
            }
            for value in fields.values_mut() {
                walk(value, schema, changed)?;
            }
        }
        BinValue::List { items, .. } => {
            for value in items {
                walk(value, schema, changed)?;
            }
        }
        BinValue::Option {
            value: Some(value), ..
        } => walk(value, schema, changed)?,
        BinValue::Map { entries, .. } => {
            for (key, value) in entries {
                walk(key, schema, changed)?;
                walk(value, schema, changed)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn fix_emitter(
    class: u32,
    fields: &mut IndexMap<u32, BinValue>,
    schema: &Schema,
) -> Result<bool, String> {
    let old_shape = fnv1a("shape");
    let Some(
        BinValue::Embed {
            class: shape_class,
            fields: shape,
        }
        | BinValue::Pointer {
            class: shape_class,
            fields: shape,
        },
    ) = fields.get(&old_shape)
    else {
        return Ok(false);
    };
    if ![
        "birthTranslation",
        "emitOffset",
        "emitRotationAngles",
        "emitRotationAxes",
    ]
    .iter()
    .any(|name| shape.contains_key(&fnv1a(name)))
    {
        return Ok(false);
    }
    if *shape_class != fnv1a("VfxShape") {
        return Err("The old shape has an unrecognized class; no changes applied.".into());
    }
    if fields.contains_key(&NEW_SHAPE)
        || (shape.contains_key(&fnv1a("birthTranslation")) && fields.contains_key(&NEW_TRANSLATION))
    {
        return Err("An emitter already has a modern shape or birth translation; no values were overwritten.".into());
    }
    let mut shape = shape.clone();
    let mut replacements = IndexMap::new();
    if let Some(translation) = shape.shift_remove(&fnv1a("birthTranslation")) {
        replacements.insert(NEW_TRANSLATION, translation);
    }
    replacements.insert(
        NEW_SHAPE,
        BinValue::Pointer {
            class: fnv1a("VfxShapeLegacy"),
            fields: shape,
        },
    );
    schema.validate_fields(class, &replacements)?;
    fields.shift_remove(&old_shape);
    fields.extend(replacements);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BinEntry, BinType};

    const META: &[u8] = include_bytes!("tables/vfx_shape_meta_16.22.json");

    fn vector() -> BinValue {
        BinValue::Embed {
            class: fnv1a("ValueVector3"),
            fields: [
                (fnv1a("constantValue"), BinValue::Vec3([1.0, 2.0, 3.0])),
                (
                    fnv1a("dynamics"),
                    BinValue::Pointer {
                        class: 0x4d3a3598,
                        fields: [(
                            0x34474c3b,
                            BinValue::List {
                                is_list2: true,
                                item: BinType::Vec3,
                                items: vec![BinValue::Vec3([4.0, 5.0, 6.0])],
                            },
                        )]
                        .into_iter()
                        .collect(),
                    },
                ),
            ]
            .into_iter()
            .collect(),
        }
    }

    fn emitter() -> BinValue {
        BinValue::Embed {
            class: fnv1a("VfxEmitterDefinitionData"),
            fields: [(
                fnv1a("shape"),
                BinValue::Embed {
                    class: fnv1a("VfxShape"),
                    fields: [
                        (fnv1a("birthTranslation"), vector()),
                        (fnv1a("emitOffset"), vector()),
                        (
                            fnv1a("emitRotationAngles"),
                            BinValue::List {
                                is_list2: false,
                                item: BinType::Embed,
                                items: vec![BinValue::Embed {
                                    class: fnv1a("ValueFloat"),
                                    fields: [(fnv1a("constantValue"), BinValue::F32(45.0))]
                                        .into_iter()
                                        .collect(),
                                }],
                            },
                        ),
                        (
                            fnv1a("emitRotationAxes"),
                            BinValue::List {
                                is_list2: false,
                                item: BinType::Vec3,
                                items: vec![BinValue::Vec3([0.0, 1.0, 0.0])],
                            },
                        ),
                    ]
                    .into_iter()
                    .collect(),
                },
            )]
            .into_iter()
            .collect(),
        }
    }

    fn bin(items: Vec<BinValue>) -> Bin {
        let mut bin = Bin::new();
        bin.entries.push(BinEntry {
            path_hash: 1,
            class_hash: fnv1a("VfxSystemDefinitionData"),
            fields: [(
                fnv1a("complexEmitterDefinitionData"),
                BinValue::List {
                    is_list2: false,
                    item: BinType::Embed,
                    items,
                },
            )]
            .into_iter()
            .collect(),
        });
        bin
    }

    fn fields(value: &mut BinValue) -> &mut IndexMap<u32, BinValue> {
        match value {
            BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => fields,
            _ => panic!("object expected"),
        }
    }

    #[test]
    fn preserves_animated_vectors_and_axes_and_is_idempotent() {
        let schema = Schema::parse(META).unwrap();
        let mut original = emitter();
        let mut expected = original.clone();
        let mut shape = fields(&mut original).shift_remove(&fnv1a("shape")).unwrap();
        let translation = fields(&mut shape)
            .shift_remove(&fnv1a("birthTranslation"))
            .unwrap();
        let output = fields(&mut expected);
        output.clear();
        output.insert(NEW_TRANSLATION, translation);
        output.insert(
            NEW_SHAPE,
            BinValue::Pointer {
                class: fnv1a("VfxShapeLegacy"),
                fields: fields(&mut shape).clone(),
            },
        );
        let mut actual = bin(vec![emitter()]);
        assert_eq!(fix_shapes(&mut actual, &schema).unwrap(), 1);
        assert_eq!(actual, bin(vec![expected]));
        assert_eq!(fix_shapes(&mut actual, &schema).unwrap(), 0);
        assert!(!crate::check_bin_hazards(&actual, "test.bin", None)
            .iter()
            .any(|i| i.code == "bin.old-vfx-shape"));
        let bytes = crate::write_bin(&actual).unwrap();
        assert_eq!(crate::read_bin(&bytes).unwrap(), actual);
    }

    #[test]
    fn conflicting_or_unknown_fields_leave_every_emitter_untouched() {
        let schema = Schema::parse(META).unwrap();
        for field in [NEW_SHAPE, NEW_TRANSLATION, 42] {
            let mut bad = emitter();
            if field == 42 {
                fields(fields(&mut bad).get_mut(&fnv1a("shape")).unwrap())
                    .insert(field, BinValue::Bool(true));
            } else {
                fields(&mut bad).insert(field, BinValue::Bool(true));
            }
            let mut actual = bin(vec![emitter(), bad]);
            let before = actual.clone();
            assert!(fix_shapes(&mut actual, &schema).is_err());
            assert_eq!(actual, before);
        }
    }

    #[test]
    fn future_type_or_class_changes_block_the_fix() {
        for replacement in ["Embed", "U32"] {
            let mut dump: serde_json::Value = serde_json::from_slice(META).unwrap();
            dump["classes"]["0x9cde442"]["properties"]["0x3bf0b4ed"]["value_type"] =
                replacement.into();
            assert_blocked(&dump);
        }
        let mut dump: serde_json::Value = serde_json::from_slice(META).unwrap();
        dump["classes"]["0x4f4e2ed7"]["base"] = serde_json::Value::Null;
        assert_blocked(&dump);
        dump["classes"]
            .as_object_mut()
            .unwrap()
            .remove("0x4f4e2ed7");
        assert_blocked(&dump);
    }

    #[test]
    fn nested_class_changes_block_the_fix() {
        let mut dump: serde_json::Value = serde_json::from_slice(META).unwrap();
        dump["classes"]["0x68dc32b6"]["properties"]["0xbc037de7"]["other_class"] =
            "0x5c4922b6".into();
        assert_blocked(&dump);
    }

    #[test]
    fn uses_inherited_metadata_and_ignores_non_vfx_entries() {
        let mut dump: serde_json::Value = serde_json::from_slice(META).unwrap();
        let class = fnv1a("ComplexEmitterDefinitionData");
        dump["classes"][format!("0x{class:x}")] = serde_json::json!({
            "base": "0x9cde442", "properties": {}
        });
        let schema = Schema::parse(&serde_json::to_vec(&dump).unwrap()).unwrap();
        let mut value = emitter();
        if let BinValue::Embed { class: id, .. } = &mut value {
            *id = class;
        }
        let mut actual = bin(vec![value]);
        let mut unrelated = actual.entries[0].clone();
        unrelated.class_hash = 42;
        actual.entries.push(unrelated.clone());
        assert_eq!(fix_shapes(&mut actual, &schema).unwrap(), 1);
        assert_eq!(actual.entries[1], unrelated);
    }

    fn assert_blocked(dump: &serde_json::Value) {
        let schema = Schema::parse(&serde_json::to_vec(dump).unwrap()).unwrap();
        let mut actual = bin(vec![emitter()]);
        let before = actual.clone();
        assert!(fix_shapes(&mut actual, &schema).is_err());
        assert_eq!(actual, before);
    }
}
