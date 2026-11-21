use crate::{
    meta_schema::{self, Schema},
    migration::{self, Conversion},
    Bin, BinType, BinValue,
};
use flint_hash::hash::HashMapper;
use indexmap::IndexMap;
use ritoshark::hash::{fnv1a, xxh3_64, xxh64};

#[derive(Clone, Copy, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepairKind {
    All,
    Types,
    Samplers,
    Shapes,
    Retags,
    Materials,
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
            Some(entry.path_hash),
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
    owner_path_hash: Option<u32>,
    fields: &mut IndexMap<u32, BinValue>,
    schema: &Schema,
    names: &HashMapper,
    kind: RepairKind,
    report: &mut RepairReport,
) {
    if class == fnv1a("StaticMaterialDef")
        && matches!(kind, RepairKind::All | RepairKind::Materials | RepairKind::Types)
        && material_name(owner_path_hash, fields, names)
    {
        report.changed += 1;
        report
            .repaired
            .push("Updated StaticMaterialDef.name to 64-bit XXH3 hash".into());
    }
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
    for value in fields.values_mut() {
        walk(value, schema, names, kind, report);
    }
    let do_type = matches!(kind, RepairKind::All | RepairKind::Types);
    let do_retag = matches!(kind, RepairKind::All | RepairKind::Retags);
    let do_class = matches!(kind, RepairKind::All | RepairKind::Types | RepairKind::Retags);

    if do_type && schema.has_class(class) {
        let mut hoists = Vec::new();
        for (&pf, pv) in fields.iter() {
            let (child_cls, child_fields) = match pv {
                BinValue::Pointer {
                    class: cc,
                    fields: cf_map,
                } if *cc != 0 => (*cc, cf_map),
                BinValue::Embed {
                    class: cc,
                    fields: cf_map,
                } => (*cc, cf_map),
                _ => continue,
            };
            if !schema.has_class(child_cls) {
                continue;
            }
            for &cf in child_fields.keys() {
                if schema.expected(child_cls, cf).is_none() {
                    if let Some((p_ty, p_tgt)) = schema.property_spec(class, cf) {
                        hoists.push((pf, child_cls, cf, p_ty.to_string(), p_tgt));
                    }
                }
            }
        }
        for (pf, child_cls, cf, p_ty, p_tgt) in hoists {
            if fields.contains_key(&cf) {
                report.blocked.push(format!(
                    "{}.{}: {}.{} already exists",
                    label(names, child_cls),
                    label(names, cf),
                    label(names, class),
                    label(names, cf)
                ));
                continue;
            }
            let raw = match fields.get(&pf) {
                Some(
                    BinValue::Pointer { fields: cf_map, .. }
                    | BinValue::Embed { fields: cf_map, .. },
                ) => cf_map.get(&cf).cloned(),
                _ => None,
            };
            let Some(mut candidate) = raw else {
                continue;
            };
            let res = convert(&mut candidate, cf, &p_ty, p_tgt, schema, names, 0).and_then(|()| {
                schema.validate_fields(class, &[(cf, candidate.clone())].into_iter().collect())
            });
            match res {
                Ok(()) => {
                    if let Some(
                        BinValue::Pointer { fields: cf_map, .. }
                        | BinValue::Embed { fields: cf_map, .. },
                    ) = fields.get_mut(&pf)
                    {
                        cf_map.shift_remove(&cf);
                    }
                    fields.insert(cf, candidate);
                    report.changed += 1;
                    report.repaired.push(format!(
                        "Moved {}.{} to {}.{}",
                        label(names, child_cls),
                        label(names, cf),
                        label(names, class),
                        label(names, cf)
                    ));
                }
                Err(e) => report.blocked.push(format!(
                    "{}.{}: {e}",
                    label(names, child_cls),
                    label(names, cf)
                )),
            }
        }
    }

    for (&field, value) in fields.iter_mut() {
        let spec = schema.property_spec(class, field);
        let migration = migration::table().get(&migration::table_key(class, field));
        let needs_retag = do_retag
            && migration.is_some_and(|m| {
                m.conversion == Conversion::Retag && crate::checks::declares_old_type(m, value)
            });
        let needs_type = do_type
            && (spec.is_some_and(|(expected, _)| meta_schema::declared_type(value) != expected)
                || migration.is_some_and(|m| crate::checks::declares_old_type(m, value)));
        let needs_class = do_class
            && spec.is_some_and(|(expected, target)| {
                meta_schema::declared_type(value) == expected
                    && !schema.value_classes_valid(value, target)
            });
        if !needs_retag && !needs_type && !needs_class {
            continue;
        }
        let before = value.clone();
        let mut candidate = before.clone();
        let mut result = Ok(());
        if do_retag {
            if let Some(m) = migration.filter(|m| m.conversion == Conversion::Retag) {
                if let (Some(from), Some(to)) = (m.from_class, m.to_class) {
                    retag(&mut candidate, from, to, &m.to_type);
                }
            }
        }
        if let Some((expected, target)) = spec {
            let dt = meta_schema::declared_type(&candidate);
            if (do_type && dt != expected)
                || (do_class && dt == expected && !schema.value_classes_valid(&candidate, target))
            {
                result = convert(&mut candidate, field, expected, target, schema, names, 0);
            }
        } else if do_type && migration.is_some_and(|m| crate::checks::declares_old_type(m, value)) {
            result = Err("Loaded metadata has no definition for this migrated field".into());
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

    if do_type && schema.has_class(class) {
        let relocations: Vec<(u32, meta_schema::ChildRelocation)> = fields
            .iter()
            .filter_map(|(&field, value)| {
                if schema.expected(class, field).is_some() {
                    return None;
                }
                schema
                    .unique_child_relocation(class, field, value)
                    .map(|reloc| (field, reloc))
            })
            .collect();
        for (field, reloc) in relocations {
            let Some(mut candidate) = fields.get(&field).cloned() else {
                continue;
            };
            if let Err(e) = convert(
                &mut candidate,
                field,
                &reloc.expected_type,
                reloc.expected_target,
                schema,
                names,
                0,
            ) {
                report.blocked.push(format!(
                    "{}.{}: {e}",
                    label(names, class),
                    label(names, field)
                ));
                continue;
            }
            enum SlotState {
                Missing,
                Mergeable(u32),
                Conflict(&'static str),
            }
            let state = match fields.get(&reloc.container_field) {
                None => SlotState::Missing,
                Some(BinValue::Pointer {
                    class: ec,
                    fields: ef,
                }) if *ec != 0
                    && reloc.container_is_pointer
                    && schema.derives_from(*ec, reloc.target_class) =>
                {
                    if ef.contains_key(&field) {
                        SlotState::Conflict("already exists in target struct")
                    } else {
                        SlotState::Mergeable(*ec)
                    }
                }
                Some(BinValue::Embed {
                    class: ec,
                    fields: ef,
                }) if !reloc.container_is_pointer
                    && schema.derives_from(*ec, reloc.target_class) =>
                {
                    if ef.contains_key(&field) {
                        SlotState::Conflict("already exists in target struct")
                    } else {
                        SlotState::Mergeable(*ec)
                    }
                }
                Some(_) => SlotState::Conflict("target struct is null or incompatible"),
            };
            match state {
                SlotState::Conflict(reason) => {
                    report.blocked.push(format!(
                        "{}.{}: {}.{}: {reason}",
                        label(names, class),
                        label(names, field),
                        label(names, class),
                        label(names, reloc.container_field)
                    ));
                }
                SlotState::Missing => {
                    let inner_fields: IndexMap<u32, BinValue> =
                        [(field, candidate)].into_iter().collect();
                    let container = if reloc.container_is_pointer {
                        BinValue::Pointer {
                            class: reloc.target_class,
                            fields: inner_fields,
                        }
                    } else {
                        BinValue::Embed {
                            class: reloc.target_class,
                            fields: inner_fields,
                        }
                    };
                    if let Err(e) = schema.validate_fields(
                        class,
                        &[(reloc.container_field, container.clone())]
                            .into_iter()
                            .collect(),
                    ) {
                        report.blocked.push(format!(
                            "{}.{}: {e}",
                            label(names, class),
                            label(names, field)
                        ));
                        continue;
                    }
                    fields.shift_remove(&field);
                    fields.insert(reloc.container_field, container);
                    report.changed += 1;
                    report.repaired.push(format!(
                        "Moved {}.{} into {}.{}",
                        label(names, class),
                        label(names, field),
                        label(names, class),
                        label(names, reloc.container_field)
                    ));
                }
                SlotState::Mergeable(ec) => {
                    if let Err(e) = schema.validate_fields(
                        ec,
                        &[(field, candidate.clone())].into_iter().collect(),
                    ) {
                        report.blocked.push(format!(
                            "{}.{}: {e}",
                            label(names, class),
                            label(names, field)
                        ));
                        continue;
                    }
                    if let Some(
                        BinValue::Pointer { fields: ef, .. }
                        | BinValue::Embed { fields: ef, .. },
                    ) = fields.get_mut(&reloc.container_field)
                    {
                        ef.insert(field, candidate);
                        fields.shift_remove(&field);
                        report.changed += 1;
                        report.repaired.push(format!(
                            "Moved {}.{} into {}.{}",
                            label(names, class),
                            label(names, field),
                            label(names, class),
                            label(names, reloc.container_field)
                        ));
                    }
                }
            }
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
        } => fields(*class, None, values, schema, names, kind, report),
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

fn bin_type(name: &str) -> Option<BinType> {
    Some(match name {
        "none" => BinType::None,
        "bool" => BinType::Bool,
        "i8" => BinType::I8,
        "u8" => BinType::U8,
        "i16" => BinType::I16,
        "u16" => BinType::U16,
        "i32" => BinType::I32,
        "u32" => BinType::U32,
        "i64" => BinType::I64,
        "u64" => BinType::U64,
        "f32" => BinType::F32,
        "vec2" => BinType::Vec2,
        "vec3" => BinType::Vec3,
        "vec4" => BinType::Vec4,
        "mtx44" => BinType::Mtx44,
        "rgba" => BinType::Rgba,
        "string" => BinType::String,
        "hash" => BinType::Hash,
        "file" => BinType::File,
        "pointer" => BinType::Pointer,
        "embed" => BinType::Embed,
        "link" => BinType::Link,
        "flag" => BinType::Flag,
        _ => return None,
    })
}

fn convert(
    value: &mut BinValue,
    field: u32,
    expected: &str,
    target: Option<u32>,
    schema: &Schema,
    names: &HashMapper,
    depth: u8,
) -> Result<(), String> {
    if depth > 2 {
        return Err(format!(
            "Cannot safely convert `{}` to `{expected}`",
            meta_schema::declared_type(value)
        ));
    }
    if meta_schema::declared_type(value) == expected && schema.value_classes_valid(value, target) {
        return Ok(());
    }
    match (&*value, expected) {
        (BinValue::Bool(b), "flag") => {
            *value = BinValue::Flag(*b);
            return Ok(());
        }
        (BinValue::Flag(b), "bool") => {
            *value = BinValue::Bool(*b);
            return Ok(());
        }
        _ => {}
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
    if matches!(expected, "pointer" | "embed") {
        match value {
            BinValue::Pointer { class: 0, .. } => {
                if expected == "pointer" {
                    return Ok(());
                }
                return Err("Cannot convert a null pointer to an embedded object".into());
            }
            BinValue::Pointer { class, fields } | BinValue::Embed { class, fields } => {
                if let Some(base) = target {
                    let is_embed = expected == "embed";
                    let compatible = if is_embed {
                        *class == base
                    } else {
                        schema.derives_from(*class, base)
                    };
                    if compatible {
                        let new_class = *class;
                        let new_fields = fields.clone();
                        *value = if is_embed {
                            BinValue::Embed {
                                class: new_class,
                                fields: new_fields,
                            }
                        } else {
                            BinValue::Pointer {
                                class: new_class,
                                fields: new_fields,
                            }
                        };
                        return Ok(());
                    }
                    if let Some(new_class) = schema.unique_concrete_retag(base, fields, is_embed) {
                        let new_fields = fields.clone();
                        *value = if is_embed {
                            BinValue::Embed {
                                class: new_class,
                                fields: new_fields,
                            }
                        } else {
                            BinValue::Pointer {
                                class: new_class,
                                fields: new_fields,
                            }
                        };
                        return Ok(());
                    }
                }
            }
            _ => {}
        }
        if let Some(wrapper_class) = target.filter(|&c| schema.is_concrete(c)) {
            if let Some((inner_ty, inner_target)) = schema.property_spec(wrapper_class, field) {
                let mut inner = value.clone();
                if convert(
                    &mut inner,
                    field,
                    inner_ty,
                    inner_target,
                    schema,
                    names,
                    depth + 1,
                )
                .is_ok()
                {
                    let inner_fields: IndexMap<u32, BinValue> =
                        [(field, inner)].into_iter().collect();
                    if schema.validate_fields(wrapper_class, &inner_fields).is_ok() {
                        *value = if expected == "embed" {
                            BinValue::Embed {
                                class: wrapper_class,
                                fields: inner_fields,
                            }
                        } else {
                            BinValue::Pointer {
                                class: wrapper_class,
                                fields: inner_fields,
                            }
                        };
                        return Ok(());
                    }
                }
            }
        }
    }
    if let BinValue::Pointer { fields, .. } | BinValue::Embed { fields, .. } = value {
        if fields.len() == 1 {
            if let Some(inner) = fields.get(&field) {
                let mut candidate = inner.clone();
                if convert(
                    &mut candidate,
                    field,
                    expected,
                    target,
                    schema,
                    names,
                    depth + 1,
                )
                .is_ok()
                {
                    *value = candidate;
                    return Ok(());
                }
            }
        }
    }
    if let Some(inner) = expected.strip_prefix("option[").and_then(|s| s.strip_suffix(']')) {
        if !matches!(value, BinValue::Option { .. }) {
            let item_ty = bin_type(inner).ok_or("Unsupported option conversion")?;
            let mut inner_val = value.clone();
            convert(&mut inner_val, field, inner, target, schema, names, depth + 1)?;
            *value = BinValue::Option {
                item: item_ty,
                value: Some(Box::new(inner_val)),
            };
            return Ok(());
        }
    }
    if let BinValue::Option { value: opt, .. } = value {
        if !expected.starts_with("option[") {
            let Some(boxed) = opt else {
                return Err("Cannot unwrap an unset option into a required value".into());
            };
            let mut inner_val = (**boxed).clone();
            convert(&mut inner_val, field, expected, target, schema, names, depth + 1)?;
            *value = inner_val;
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
                let target_item = bin_type(inner)
                    .or_else(|| {
                        (format!("{item:?}").to_ascii_lowercase() == inner).then_some(*item)
                    })
                    .ok_or("Unsupported list conversion")?;
                for value in items {
                    convert(value, field, inner, target, schema, names, depth + 1)?;
                }
                *item = target_item;
                *is_list2 = outer == "list2";
                return Ok(());
            }
            BinValue::Option { item, value } if outer == "option" => {
                let target_item = bin_type(inner).ok_or("Unsupported option conversion")?;
                if let Some(value) = value {
                    convert(value, field, inner, target, schema, names, depth + 1)?;
                }
                *item = target_item;
                return Ok(());
            }
            BinValue::Map {
                key,
                value: item,
                entries,
            } if outer == "map" => {
                let (k, v) = inner.split_once(',').ok_or("Invalid map declaration")?;
                let kt = bin_type(k)
                    .filter(|t| t.is_primitive())
                    .or_else(|| (format!("{key:?}").to_ascii_lowercase() == k).then_some(*key))
                    .ok_or("Unsupported map key conversion")?;
                let vt = bin_type(v)
                    .or_else(|| (format!("{item:?}").to_ascii_lowercase() == v).then_some(*item))
                    .ok_or("Unsupported map value conversion")?;
                for (key, value) in entries.iter_mut() {
                    convert(key, field, k, None, schema, names, depth + 1)?;
                    convert(value, field, v, target, schema, names, depth + 1)?;
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
    if meta_schema::declared_type(value) == expected {
        return Err(format!(
            "Metadata {} rejects object class in `{expected}`",
            schema.version
        ));
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
        let (expected, target) = schema
            .property_spec(fnv1a("StaticMaterialShaderSamplerDef"), path)
            .ok_or("Metadata has no texturePath definition")?;
        convert(&mut value, path, expected, target, schema, names, 0)?;
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

fn material_name(
    owner_path_hash: Option<u32>,
    fields: &mut IndexMap<u32, BinValue>,
    names: &HashMapper,
) -> bool {
    let Some(value) = fields.get_mut(&fnv1a("name")) else {
        return false;
    };
    match value {
        BinValue::Hash(id32) => {
            let resolved = names
                .get(*id32 as u64)
                .filter(|s| fnv1a(s) == *id32)
                .or_else(|| {
                    owner_path_hash.and_then(|ph| names.get(ph as u64).filter(|s| fnv1a(s) == ph))
                });
            let wide = if let Some(name) = resolved {
                xxh3_64(name)
            } else if *id32 == 0 {
                0
            } else {
                xxh3_64(&format!("0x{id32:08x}"))
            };
            *value = BinValue::Hash64(wide);
            true
        }
        BinValue::String(s) => {
            *value = BinValue::Hash64(xxh3_64(s));
            true
        }
        _ => false,
    }
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
                "0xe":{"value_type":"List2","container":{"value_type":"U8"}},
                "0xf":{"value_type":"Hash"},
                "0x10":{"value_type":"List","container":{"value_type":"Hash"}}
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
    fn hashes_strings_when_metadata_expects_hash() {
        let mut bin = bin(
            1,
            vec![
                (15, BinValue::String("Material_A".into())),
                (
                    16,
                    BinValue::List {
                        is_list2: false,
                        item: BinType::String,
                        items: vec![BinValue::String("Material_B".into())],
                    },
                ),
            ],
        );
        let report = repair(&mut bin, &schema(), &HashMapper::new(), RepairKind::Types);
        assert_eq!(report.changed, 2);
        assert!(report.blocked.is_empty());
        assert_eq!(bin.entries[0].fields[&15], BinValue::Hash(fnv1a("Material_A")));
        assert_eq!(
            bin.entries[0].fields[&16],
            BinValue::List {
                is_list2: false,
                item: BinType::Hash,
                items: vec![BinValue::Hash(fnv1a("Material_B"))],
            }
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
        let s = schema();
        let mut value = BinValue::File(xxh64(path));
        assert!(convert(&mut value, 1, "string", None, &s, &names, 0).is_err());
        names.insert(xxh64(path), "assets/wrong.tex");
        assert!(convert(&mut value, 1, "string", None, &s, &names, 0).is_err());
        names.insert(xxh64(path), path);
        convert(&mut value, 1, "string", None, &s, &names, 0).unwrap();
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

    #[test]
    fn upgrades_narrow_static_material_def_name_hashes_to_xxh3() {
        let mat_name = "Characters/Kayn/Skins/Skin8/Materials/AlphaBlend_Additive_Scroll_Packed_inst";
        let id32 = fnv1a(mat_name);
        let expected64 = xxh3_64(mat_name);

        let mut names = HashMapper::new();
        names.insert(id32 as u64, mat_name);

        let mut bin = Bin::new();
        bin.entries.push(BinEntry {
            path_hash: id32,
            class_hash: fnv1a("StaticMaterialDef"),
            fields: [(fnv1a("name"), BinValue::Hash(id32))]
                .into_iter()
                .collect(),
        });

        let report = repair(&mut bin, &schema(), &names, RepairKind::Materials);
        assert_eq!(report.changed, 1);
        assert_eq!(
            bin.entries[0].fields[&fnv1a("name")],
            BinValue::Hash64(expected64)
        );
        assert_eq!(
            repair(&mut bin, &schema(), &names, RepairKind::Materials).changed,
            0
        );

        let owner_name = "Characters/Kayn/Skins/Skin8/Materials/Custom_Inst";
        let owner_ph = fnv1a(owner_name);
        names.insert(owner_ph as u64, owner_name);
        let mut fallback_bin = Bin::new();
        fallback_bin.entries.push(BinEntry {
            path_hash: owner_ph,
            class_hash: fnv1a("StaticMaterialDef"),
            fields: [(fnv1a("name"), BinValue::Hash(0xdeadbeef))]
                .into_iter()
                .collect(),
        });
        let report_all = repair(&mut fallback_bin, &schema(), &names, RepairKind::All);
        assert_eq!(report_all.changed, 1);
        assert_eq!(
            fallback_bin.entries[0].fields[&fnv1a("name")],
            BinValue::Hash64(xxh3_64(owner_name))
        );
    }

    #[test]
    fn wraps_same_name_field_and_relocates_siblings_in_one_pass() {
        let schema = Schema::parse(
            br#"{"formatVersion":3,"version":"16.22","classes":{
            "0x1":{"properties":{
                "0xa":{"value_type":"Pointer","other_class":"0x2"},
                "0xd":{"value_type":"Pointer","other_class":"0x3"},
                "0xe":{"value_type":"Embed","other_class":"0x4"}
            }},
            "0x2":{"properties":{
                "0xa":{"value_type":"String"},
                "0xb":{"value_type":"Vec2"},
                "0xc":{"value_type":"File"}
            }},
            "0x3":{"properties":{
                "0x10":{"value_type":"List","container":{"value_type":"String"}},
                "0x11":{"value_type":"U8"}
            }},
            "0x4":{"properties":{"0x12":{"value_type":"Flag"}}}
        }}"#,
        )
        .unwrap();
        let mut b = bin(
            1,
            vec![
                (0xa, BinValue::String("assets/grad.tex".into())),
                (0xb, BinValue::Vec2([1.0, 2.0])),
                (0xc, BinValue::String("assets/mask.tex".into())),
                (
                    0xd,
                    BinValue::Pointer {
                        class: 3,
                        fields: [(0x11, BinValue::U8(7))].into_iter().collect(),
                    },
                ),
                (
                    0x10,
                    BinValue::List {
                        is_list2: false,
                        item: BinType::String,
                        items: vec![BinValue::String("tag".into())],
                    },
                ),
                (0x12, BinValue::Bool(true)),
            ],
        );
        let report = repair(&mut b, &schema, &HashMapper::new(), RepairKind::Types);
        assert_eq!(report.changed, 5);
        assert!(report.blocked.is_empty());
        let fields = &b.entries[0].fields;
        assert_eq!(fields.len(), 3);
        let BinValue::Pointer {
            class: 2,
            fields: wrap_fields,
        } = &fields[&0xa]
        else {
            panic!("expected wrapped pointer");
        };
        assert_eq!(wrap_fields[&0xa], BinValue::String("assets/grad.tex".into()));
        assert_eq!(wrap_fields[&0xb], BinValue::Vec2([1.0, 2.0]));
        assert_eq!(wrap_fields[&0xc], BinValue::File(xxh64("assets/mask.tex")));
        let BinValue::Pointer {
            class: 3,
            fields: merged_fields,
        } = &fields[&0xd]
        else {
            panic!("expected merged pointer");
        };
        assert_eq!(merged_fields[&0x11], BinValue::U8(7));
        assert!(merged_fields.contains_key(&0x10));
        assert!(matches!(
            &fields[&0xe],
            BinValue::Embed { class: 4, fields: ef } if ef[&0x12] == BinValue::Flag(true)
        ));
        assert_eq!(
            repair(&mut b, &schema, &HashMapper::new(), RepairKind::Types).changed,
            0
        );
        let bytes = crate::write_bin(&b).unwrap();
        assert_eq!(crate::read_bin(&bytes).unwrap(), b);
    }

    #[test]
    fn relocation_blocks_conflicts_nulls_and_ambiguous_fields() {
        let schema = Schema::parse(
            br#"{"formatVersion":3,"version":"16.22","classes":{
            "0x1":{"properties":{
                "0x2":{"value_type":"Pointer","other_class":"0x20"},
                "0x3":{"value_type":"Pointer","other_class":"0x30"},
                "0x4":{"value_type":"Pointer","other_class":"0x40"}
            }},
            "0x20":{"properties":{"0xa":{"value_type":"U32"},"0xc":{"value_type":"U32"}}},
            "0x30":{"properties":{"0xb":{"value_type":"U32"},"0xc":{"value_type":"U32"}}},
            "0x40":{"properties":{"0xd":{"value_type":"U32"}}}
        }}"#,
        )
        .unwrap();
        let mut b = bin(
            1,
            vec![
                (
                    2,
                    BinValue::Pointer {
                        class: 0x20,
                        fields: [(0xa, BinValue::U32(1))].into_iter().collect(),
                    },
                ),
                (0xa, BinValue::U32(2)),
                (3, BinValue::Pointer { class: 0, fields: IndexMap::new() }),
                (0xb, BinValue::U32(3)),
                (0xc, BinValue::U32(4)),
                (0x99, BinValue::U32(5)),
            ],
        );
        let before = b.clone();
        let report = repair(&mut b, &schema, &HashMapper::new(), RepairKind::Types);
        assert_eq!(report.changed, 0);
        assert_eq!(report.blocked.len(), 2);
        assert_eq!(b, before);
    }

    #[test]
    fn unwraps_hoists_and_converts_bool_embed_option_and_unique_class() {
        let schema = Schema::parse(
            br#"{"formatVersion":3,"version":"16.22","classes":{
            "0x1":{"properties":{
                "0xa":{"value_type":"String"},
                "0xb":{"value_type":"U32"},
                "0xc":{"value_type":"Pointer","other_class":"0x10"},
                "0xd":{"value_type":"Flag"},
                "0xe":{"value_type":"Option","container":{"value_type":"U8"}},
                "0xf":{"value_type":"U16"},
                "0x11":{"value_type":"List","container":{"value_type":"Pointer"},"other_class":"0x20"}
            }},
            "0x10":{"properties":{}},
            "0x20":{"is":{"interface":true},"properties":{}},
            "0x21":{"base":"0x20","properties":{"0x5":{"value_type":"F32"}}},
            "0x22":{"base":"0x20","properties":{"0x6":{"value_type":"String"}}}
        }}"#,
        )
        .unwrap();
        let mut b = bin(
            1,
            vec![
                (
                    0xa,
                    BinValue::Pointer {
                        class: 0x999,
                        fields: [(0xa, BinValue::String("hello".into()))]
                            .into_iter()
                            .collect(),
                    },
                ),
                (
                    0xc,
                    BinValue::Embed {
                        class: 0x10,
                        fields: [(0xb, BinValue::U32(42))].into_iter().collect(),
                    },
                ),
                (0xd, BinValue::Bool(true)),
                (0xe, BinValue::U32(9)),
                (
                    0xf,
                    BinValue::Option {
                        item: BinType::U16,
                        value: Some(Box::new(BinValue::U16(88))),
                    },
                ),
                (
                    0x11,
                    BinValue::List {
                        is_list2: false,
                        item: BinType::Embed,
                        items: vec![BinValue::Embed {
                            class: 0x999,
                            fields: [(5, BinValue::F32(1.25))].into_iter().collect(),
                        }],
                    },
                ),
            ],
        );
        let report = repair(&mut b, &schema, &HashMapper::new(), RepairKind::Types);
        assert_eq!(report.changed, 7);
        assert!(report.blocked.is_empty());
        let fields = &b.entries[0].fields;
        assert_eq!(fields[&0xa], BinValue::String("hello".into()));
        assert_eq!(fields[&0xb], BinValue::U32(42));
        assert!(matches!(fields[&0xc], BinValue::Pointer { class: 0x10, .. }));
        assert_eq!(fields[&0xd], BinValue::Flag(true));
        assert!(matches!(
            &fields[&0xe],
            BinValue::Option { item: BinType::U8, value: Some(v) } if **v == BinValue::U8(9)
        ));
        assert_eq!(fields[&0xf], BinValue::U16(88));
        if let BinValue::List { item, items, .. } = &fields[&0x11] {
            assert_eq!(*item, BinType::Pointer);
            assert!(matches!(items[0], BinValue::Pointer { class: 0x21, .. }));
        } else {
            panic!("expected list");
        }
        let mut unset = bin(
            1,
            vec![(
                0xf,
                BinValue::Option {
                    item: BinType::U16,
                    value: None,
                },
            )],
        );
        let r = repair(&mut unset, &schema, &HashMapper::new(), RepairKind::Types);
        assert_eq!(r.changed, 0);
        assert_eq!(r.blocked.len(), 1);
    }

    #[test]
    #[ignore = "Set FLINT_META_DUMP and FLINT_REPAIR_BIN"]
    fn repairs_real_bin_against_metadata_dump() {
        let dump_bytes = std::fs::read(std::env::var("FLINT_META_DUMP").unwrap()).unwrap();
        let schema = Schema::parse(&dump_bytes).unwrap();
        let bin_bytes = std::fs::read(std::env::var("FLINT_REPAIR_BIN").unwrap()).unwrap();
        let mut bin = crate::read_bin(&bin_bytes).unwrap();
        let before = schema.check(&bin, "test.bin", &HashMapper::new(), None);
        println!("Before issues ({}):", before.len());
        for issue in &before {
            println!("  [{}] {}", issue.code, issue.message);
        }
        let report = repair(&mut bin, &schema, &HashMapper::new(), RepairKind::All);
        println!(
            "Repair report: changed={}, repaired={:?}, blocked={:?}",
            report.changed, report.repaired, report.blocked
        );
        let after = schema.check(&bin, "test.bin", &HashMapper::new(), None);
        println!("After issues ({}):", after.len());
        for issue in &after {
            println!("  [{}] {}", issue.code, issue.message);
        }
        assert!(report.blocked.is_empty());
        assert_eq!(
            repair(&mut bin, &schema, &HashMapper::new(), RepairKind::All).changed,
            0
        );
        let round_trip = crate::write_bin(&bin).unwrap();
        assert_eq!(crate::read_bin(&round_trip).unwrap(), bin);
        assert!(!after
            .iter()
            .any(|i| matches!(
                i.code,
                "bin.schema-type-mismatch" | "bin.schema-field-relocated"
            )));
    }
}
