use crate::{
    meta_schema::{self, Schema},
    migration::{self, Conversion},
    Bin, BinType, BinValue,
};
use flint_hash::hash::HashMapper;
use indexmap::IndexMap;
use ritoshark::hash::{fnv1a, xxh64};

#[derive(Clone, Copy, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepairKind {
    All,
    Types,
    Samplers,
    Shapes,
    Retags,
}

#[derive(Default, serde::Serialize)]
pub struct RepairReport {
    pub changed: usize,
    pub repaired: Vec<String>,
    pub blocked: Vec<String>,
}

pub fn repair(
    bin: &mut Bin,
    schema: &Schema,
    names: &HashMapper,
    kind: RepairKind,
) -> RepairReport {
    let mut report = RepairReport::default();
    if matches!(kind, RepairKind::All | RepairKind::Shapes) {
        match crate::vfx_shape::fix_shapes(bin, schema) {
            Ok(count) if count > 0 => {
                report.changed += count;
                report.repaired.push(format!("Migrated {count} VFX shapes"));
            }
            Err(error) => report.blocked.push(format!("VFX shapes: {error}")),
            _ => {}
        }
    }
    for entry in &mut bin.entries {
        fields(
            entry.class_hash,
            &mut entry.fields,
            schema,
            names,
            kind,
            &mut report,
        );
    }
    report.repaired.sort();
    report.repaired.dedup();
    report.blocked.sort();
    report.blocked.dedup();
    report
}

fn label(names: &HashMapper, id: u32) -> String {
    names
        .get(id as u64)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("0x{id:08x}"))
}

fn fields(
    class: u32,
    fields: &mut IndexMap<u32, BinValue>,
    schema: &Schema,
    names: &HashMapper,
    kind: RepairKind,
    report: &mut RepairReport,
) {
    if class == fnv1a("StaticMaterialShaderSamplerDef")
        && matches!(kind, RepairKind::All | RepairKind::Samplers)
    {
        match sampler(fields, schema, names) {
            Ok(true) => {
                report.changed += 1;
                report
                    .repaired
                    .push("Updated material sampler fields".into());
            }
            Err(e) => report.blocked.push(format!("Material sampler: {e}")),
            _ => {}
        }
    }
    for (&field, value) in fields {
        walk(value, schema, names, kind, report);
        let migration = migration::table().get(&migration::table_key(class, field));
        let needs_retag = matches!(kind, RepairKind::All | RepairKind::Retags)
            && migration.is_some_and(|m| {
                m.conversion == Conversion::Retag && crate::checks::declares_old_type(m, value)
            });
        let needs_type = matches!(kind, RepairKind::All | RepairKind::Types)
            && (schema
                .expected(class, field)
                .is_some_and(|expected| meta_schema::declared_type(value) != expected)
                || migration.is_some_and(|m| crate::checks::declares_old_type(m, value)));
        if !needs_retag && !needs_type {
            continue;
        }
        let before = value.clone();
        let mut candidate = before.clone();
        let mut result = Ok(());
        if matches!(kind, RepairKind::All | RepairKind::Retags) {
            if let Some(m) = migration.filter(|m| m.conversion == Conversion::Retag) {
                if let (Some(from), Some(to)) = (m.from_class, m.to_class) {
                    retag(&mut candidate, from, to, &m.to_type);
                }
            }
        }
        if matches!(kind, RepairKind::All | RepairKind::Types) {
            if let Some(expected) = schema.expected(class, field) {
                if meta_schema::declared_type(&candidate) != expected {
                    result = convert(&mut candidate, expected, names);
                }
            } else if migration.is_some_and(|m| crate::checks::declares_old_type(m, value)) {
                result = Err("Loaded metadata has no definition for this migrated field".into());
            }
        }
        if result.is_ok() && candidate != before {
            result =
                schema.validate_fields(class, &[(field, candidate.clone())].into_iter().collect());
        }
        match result {
            Ok(()) if candidate != before => {
                *value = candidate;
                report.changed += 1;
                report.repaired.push(format!(
                    "Updated {}.{}",
                    label(names, class),
                    label(names, field)
                ));
            }
            Err(e) => report.blocked.push(format!(
                "{}.{}: {e}",
                label(names, class),
                label(names, field)
            )),
            _ => {}
        }
    }
}

fn walk(
    value: &mut BinValue,
    schema: &Schema,
    names: &HashMapper,
    kind: RepairKind,
    report: &mut RepairReport,
) {
    match value {
        BinValue::Pointer {
            class,
            fields: values,
        }
        | BinValue::Embed {
            class,
            fields: values,
        } => fields(*class, values, schema, names, kind, report),
        BinValue::List { items, .. } => {
            for value in items {
                walk(value, schema, names, kind, report);
            }
        }
        BinValue::Option {
            value: Some(value), ..
        } => walk(value, schema, names, kind, report),
        BinValue::Map { entries, .. } => {
            for (key, value) in entries {
                walk(key, schema, names, kind, report);
                walk(value, schema, names, kind, report);
            }
        }
        _ => {}
    }
}

fn retag(value: &mut BinValue, from: u32, to: u32, target: &str) {
    match value {
        BinValue::Embed { class, fields } if *class == from => {
            if target == "pointer" {
                *value = BinValue::Pointer {
                    class: to,
                    fields: fields.clone(),
                };
            } else {
                *class = to;
            }
        }
        BinValue::List { items, .. } => {
            for value in items {
                retag(value, from, to, target);
            }
        }
        _ => {}
    }
}

fn scalar_type(name: &str) -> Option<BinType> {
    Some(match name {
        "file" => BinType::File,
        "string" => BinType::String,
        "hash" => BinType::Hash,
        "u8" => BinType::U8,
        "u16" => BinType::U16,
        "u32" => BinType::U32,
        "u64" => BinType::U64,
        "i8" => BinType::I8,
        "i16" => BinType::I16,
        "i32" => BinType::I32,
        "i64" => BinType::I64,
        _ => return None,
    })
}

fn convert(value: &mut BinValue, expected: &str, names: &HashMapper) -> Result<(), String> {
    if meta_schema::declared_type(value) == expected {
        return Ok(());
    }
    if let BinValue::File(id) = value {
        if expected == "string" {
            let path = names
                .get(*id)
                .filter(|path| xxh64(path) == *id)
                .ok_or("Original path is unknown; cannot restore a string from this file hash")?;
            *value = BinValue::String(path.to_owned());
            return Ok(());
        }
    }
    if let BinValue::Hash(id) = value {
        if expected == "file" {
            let path = names
                .get(*id as u64)
                .filter(|s| fnv1a(s) == *id && s.contains('/'))
                .ok_or(
                    "Original asset path is unknown. Restore the path before converting this hash.",
                )?;
            *value = BinValue::File(xxh64(path));
            return Ok(());
        }
    }
    if let Some((outer, inner)) = expected.strip_suffix(']').and_then(|s| s.split_once('[')) {
        match value {
            BinValue::List {
                is_list2,
                item,
                items,
            } if matches!(outer, "list" | "list2") => {
                let target = scalar_type(inner)
                    .or_else(|| {
                        (format!("{item:?}").to_ascii_lowercase() == inner).then_some(*item)
                    })
                    .ok_or("Unsupported list conversion")?;
                for value in items {
                    convert(value, inner, names)?;
                }
                *item = target;
                *is_list2 = outer == "list2";
                return Ok(());
            }
            BinValue::Option { item, value } if outer == "option" => {
                let target = scalar_type(inner).ok_or("Unsupported option conversion")?;
                if let Some(value) = value {
                    convert(value, inner, names)?;
                }
                *item = target;
                return Ok(());
            }
            BinValue::Map {
                key,
                value: item,
                entries,
            } if outer == "map" => {
                let (k, v) = inner.split_once(',').ok_or("Invalid map declaration")?;
                let kt = scalar_type(k)
                    .or_else(|| (format!("{key:?}").to_ascii_lowercase() == k).then_some(*key))
                    .ok_or("Unsupported map key conversion")?;
                let vt = scalar_type(v)
                    .or_else(|| (format!("{item:?}").to_ascii_lowercase() == v).then_some(*item))
                    .ok_or("Unsupported map value conversion")?;
                for (key, value) in entries.iter_mut() {
                    convert(key, k, names)?;
                    convert(value, v, names)?;
                }
                if *key != kt {
                    let mut seen = std::collections::HashSet::new();
                    for (key, _) in entries.iter() {
                        if !seen.insert(format!("{key:?}")) {
                            return Err("Converted map keys would collide".into());
                        }
                    }
                }
                *key = kt;
                *item = vt;
                return Ok(());
            }
            _ => {}
        }
    }
    meta_schema::adapt_value(value, expected)
}

fn sampler(
    fields: &mut IndexMap<u32, BinValue>,
    schema: &Schema,
    names: &HashMapper,
) -> Result<bool, String> {
    let old_name = fnv1a("samplerName");
    let name = fnv1a("textureName");
    let path = fnv1a("texturePath");
    let old_path = matches!(fields.get(&name), Some(BinValue::String(s)) if s.contains('/'));
    if !fields.contains_key(&old_name) && !old_path {
        return Ok(false);
    }
    let mut updated = fields.clone();
    let mut changed = IndexMap::new();
    if old_path {
        if updated.contains_key(&path) {
            return Err(
                "Both old and modern texture paths exist; choose which asset to keep.".into(),
            );
        }
        let mut value = updated.shift_remove(&name).unwrap();
        convert(
            &mut value,
            schema
                .expected(fnv1a("StaticMaterialShaderSamplerDef"), path)
                .ok_or("Metadata has no texturePath definition")?,
            names,
        )?;
        changed.insert(path, value);
    }
    if let Some(value) = updated.shift_remove(&old_name) {
        if updated.contains_key(&name) {
            return Err(
                "Both samplerName and textureName exist; choose which name to keep.".into(),
            );
        }
        changed.insert(name, value);
    }
    schema.validate_fields(fnv1a("StaticMaterialShaderSamplerDef"), &changed)?;
    updated.extend(changed);
    *fields = updated;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BinEntry;
    use serde_json::json;

    fn schema() -> Schema {
        Schema::parse(
            br#"{"formatVersion":3,"version":"test","classes":{
            "0x1":{"properties":{
                "0xa":{"value_type":"U8"},
                "0xb":{"value_type":"File"},
                "0xc":{"value_type":"Option","container":{"value_type":"File"}},
                "0xd":{"value_type":"Map","map":{"key_type":"File","value_type":"String"}},
                "0xe":{"value_type":"List2","container":{"value_type":"U8"}}
            }}
        }}"#,
        )
        .unwrap()
    }

    fn bin(class: u32, values: Vec<(u32, BinValue)>) -> Bin {
        let mut bin = Bin::new();
        bin.entries.push(BinEntry {
            path_hash: 1,
            class_hash: class,
            fields: values.into_iter().collect(),
        });
        bin
    }

    #[test]
    fn fixes_safe_fields_but_preserves_overflow_and_unknown_fields() {
        let mut bin = bin(
            1,
            vec![
                (10, BinValue::U32(300)),
                (11, BinValue::String("assets/a.tex".into())),
                (99, BinValue::U32(42)),
            ],
        );
        let report = repair(&mut bin, &schema(), &HashMapper::new(), RepairKind::Types);
        assert_eq!(report.changed, 1);
        assert_eq!(report.blocked.len(), 1);
        assert_eq!(bin.entries[0].fields[&10], BinValue::U32(300));
        assert_eq!(
            bin.entries[0].fields[&11],
            BinValue::File(xxh64("assets/a.tex"))
        );
        assert_eq!(bin.entries[0].fields[&99], BinValue::U32(42));
        assert_eq!(
            repair(&mut bin, &schema(), &HashMapper::new(), RepairKind::Types).changed,
            0
        );
    }

    #[test]
    fn converts_containers_and_rolls_back_partial_overflow() {
        let list = BinValue::List {
            is_list2: false,
            item: BinType::U32,
            items: vec![BinValue::U32(3), BinValue::U32(300)],
        };
        let mut bin = bin(
            1,
            vec![
                (
                    12,
                    BinValue::Option {
                        item: BinType::String,
                        value: Some(Box::new(BinValue::String("assets/a.tex".into()))),
                    },
                ),
                (14, list.clone()),
            ],
        );
        let report = repair(&mut bin, &schema(), &HashMapper::new(), RepairKind::Types);
        assert_eq!(report.changed, 1);
        assert_eq!(bin.entries[0].fields[&14], list);
        assert!(
            matches!(&bin.entries[0].fields[&12], BinValue::Option { item: BinType::File, value: Some(v) } if **v == BinValue::File(xxh64("assets/a.tex")))
        );
    }

    #[test]
    fn rehash_requires_a_verified_path_and_map_keys_must_stay_unique() {
        let path = "assets/a.tex";
        let id = fnv1a(path);
        let mut names = HashMapper::new();
        let mut bin = bin(1, vec![(11, BinValue::Hash(id))]);
        assert_eq!(
            repair(&mut bin, &schema(), &names, RepairKind::Types).changed,
            0
        );
        names.insert(id as u64, "assets/wrong.tex");
        assert_eq!(
            repair(&mut bin, &schema(), &names, RepairKind::Types).changed,
            0
        );
        names.insert(id as u64, path);
        assert_eq!(
            repair(&mut bin, &schema(), &names, RepairKind::Types).changed,
            1
        );
        let map = BinValue::Map {
            key: BinType::String,
            value: BinType::String,
            entries: vec![
                (
                    BinValue::String(path.into()),
                    BinValue::String("first".into()),
                ),
                (
                    BinValue::String(path.into()),
                    BinValue::String("second".into()),
                ),
            ],
        };
        bin.entries[0].fields.insert(13, map.clone());
        let report = repair(&mut bin, &schema(), &names, RepairKind::Types);
        assert_eq!(report.changed, 0);
        assert_eq!(bin.entries[0].fields[&13], map);
        assert!(report.blocked[0].contains("collide"));
    }

    fn sampler_schema() -> Schema {
        let dump = json!({"formatVersion":3,"version":"test","classes":{
            format!("0x{:x}", fnv1a("StaticMaterialShaderSamplerDef")): {"properties":{
                format!("0x{:x}", fnv1a("textureName")): {"value_type":"String"},
                format!("0x{:x}", fnv1a("texturePath")): {"value_type":"File"}
            }}
        }});
        Schema::parse(&serde_json::to_vec(&dump).unwrap()).unwrap()
    }

    #[test]
    fn renames_sampler_fields_without_losing_the_slot_or_path() {
        let mut bin = bin(
            fnv1a("StaticMaterialShaderSamplerDef"),
            vec![
                (
                    fnv1a("samplerName"),
                    BinValue::String("Diffuse_Texture".into()),
                ),
                (
                    fnv1a("textureName"),
                    BinValue::String("assets/a.tex".into()),
                ),
            ],
        );
        let report = repair(
            &mut bin,
            &sampler_schema(),
            &HashMapper::new(),
            RepairKind::Samplers,
        );
        assert_eq!(report.changed, 1);
        let fields = &bin.entries[0].fields;
        assert_eq!(fields.len(), 2);
        assert_eq!(
            fields[&fnv1a("textureName")],
            BinValue::String("Diffuse_Texture".into())
        );
        assert_eq!(
            fields[&fnv1a("texturePath")],
            BinValue::File(xxh64("assets/a.tex"))
        );
    }

    #[test]
    fn sampler_conflicts_are_never_overwritten() {
        let mut bin = bin(
            fnv1a("StaticMaterialShaderSamplerDef"),
            vec![
                (
                    fnv1a("samplerName"),
                    BinValue::String("Diffuse_Texture".into()),
                ),
                (
                    fnv1a("textureName"),
                    BinValue::String("Other_Texture".into()),
                ),
            ],
        );
        let before = bin.clone();
        let report = repair(
            &mut bin,
            &sampler_schema(),
            &HashMapper::new(),
            RepairKind::All,
        );
        assert_eq!(report.changed, 0);
        assert!(!report.blocked.is_empty());
        assert_eq!(bin, before);
    }

    #[test]
    fn known_embed_to_pointer_migration_is_schema_validated() {
        let dump = json!({"formatVersion":3,"version":"test","classes":{
            "0x3b09052f": {"properties":{
                format!("0x{:x}", fnv1a("value")): {"value_type":"Pointer","other_class":"0x73b4a2eb"}
            }},
            "0x73b4a2eb": {"properties":{}}
        }});
        let schema = Schema::parse(&serde_json::to_vec(&dump).unwrap()).unwrap();
        let mut bin = bin(
            0x3b09052f,
            vec![(
                fnv1a("value"),
                BinValue::Embed {
                    class: 0x73b4a2eb,
                    fields: IndexMap::new(),
                },
            )],
        );
        assert_eq!(
            repair(&mut bin, &schema, &HashMapper::new(), RepairKind::Retags).changed,
            1
        );
        assert!(matches!(
            bin.entries[0].fields[&fnv1a("value")],
            BinValue::Pointer {
                class: 0x73b4a2eb,
                ..
            }
        ));
        let mut unknown = bin.clone();
        unknown.entries[0].fields.insert(
            fnv1a("value"),
            BinValue::Embed {
                class: 0x73b4a2eb,
                fields: [(99, BinValue::Bool(true))].into_iter().collect(),
            },
        );
        let before = unknown.clone();
        let report = repair(
            &mut unknown,
            &schema,
            &HashMapper::new(),
            RepairKind::Retags,
        );
        assert_eq!(report.changed, 0);
        assert!(!report.blocked.is_empty());
        assert_eq!(unknown, before);
    }
    #[test]
    fn restores_file_strings_only_from_verified_names() {
        let path = "assets/custom.tex";
        let mut names = HashMapper::new();
        let mut value = BinValue::File(xxh64(path));
        assert!(convert(&mut value, "string", &names).is_err());
        names.insert(xxh64(path), "assets/wrong.tex");
        assert!(convert(&mut value, "string", &names).is_err());
        names.insert(xxh64(path), path);
        convert(&mut value, "string", &names).unwrap();
        assert_eq!(value, BinValue::String(path.into()));
    }

    #[test]
    fn retags_known_list_items_and_blocks_a_changed_target_class() {
        let mut dump = json!({"formatVersion":3,"version":"test","classes":{
            "0x73b4a2eb": {"properties":{
                format!("0x{:x}", fnv1a("items")): {"value_type":"List2","container":{"value_type":"Embed"},"other_class":"0x3b8d8b3f"}
            }},
            "0x3b8d8b3f": {"properties":{"0x1":{"value_type":"U32"}}}
        }});
        let input = bin(
            0x73b4a2eb,
            vec![(
                fnv1a("items"),
                BinValue::List {
                    is_list2: true,
                    item: BinType::Embed,
                    items: vec![BinValue::Embed {
                        class: 0xa7ca72c,
                        fields: [(1, BinValue::U32(42))].into_iter().collect(),
                    }],
                },
            )],
        );
        let mut output = input.clone();
        let schema = Schema::parse(&serde_json::to_vec(&dump).unwrap()).unwrap();
        assert_eq!(
            repair(&mut output, &schema, &HashMapper::new(), RepairKind::Retags).changed,
            1
        );
        if let BinValue::List { items, .. } = &output.entries[0].fields[&fnv1a("items")] {
            assert!(
                matches!(&items[0], BinValue::Embed { class: 0x3b8d8b3f, fields } if fields[&1] == BinValue::U32(42))
            );
        } else {
            panic!("list expected");
        }
        dump["classes"]["0x73b4a2eb"]["properties"][format!("0x{:x}", fnv1a("items"))]
            ["other_class"] = "0x9999".into();
        let schema = Schema::parse(&serde_json::to_vec(&dump).unwrap()).unwrap();
        let mut output = input.clone();
        assert_eq!(
            repair(&mut output, &schema, &HashMapper::new(), RepairKind::Retags).changed,
            0
        );
        assert_eq!(output, input);
    }
}
