//! Type checks against LeagueToolkit/lol-meta-classes release dumps (the LSP's source).
//! Unknown classes/properties are deliberately skipped: a partial dump is not proof
//! that custom or newer content is invalid. No network or file I/O lives here.
use crate::{checks::TypeFix, Bin, BinType, BinValue, CheckIssue, Severity};
use flint_hash::hash::HashMapper;
use indexmap::IndexMap;
use parking_lot::RwLock;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

static CURRENT: RwLock<Option<Arc<Schema>>> = RwLock::new(None);

#[derive(Deserialize)]
struct Dump {
    #[serde(rename = "formatVersion", default)]
    format_version: u32,
    version: String,
    classes: HashMap<String, Class>,
}
#[derive(Deserialize)]
struct Class {
    base: Option<String>,
    #[serde(default)]
    secondary_bases: HashMap<String, u32>,
    properties: HashMap<String, Property>,
    #[serde(default)]
    is: ClassFlags,
}
#[derive(Deserialize, Default)]
struct ClassFlags {
    #[serde(default)]
    interface: bool,
}
#[derive(Deserialize)]
struct Property {
    other_class: Option<String>,
    value_type: String,
    container: Option<Container>,
    map: Option<Map>,
}
#[derive(Deserialize)]
struct Container {
    value_type: String,
}
#[derive(Deserialize)]
struct Map {
    key_type: String,
    value_type: String,
}
struct ClassTypes {
    bases: Vec<u32>,
    properties: HashMap<u32, String>,
    targets: HashMap<u32, u32>,
    is_interface: bool,
}
pub struct Schema {
    pub version: String,
    classes: HashMap<u32, ClassTypes>,
    subclasses: HashMap<u32, Vec<u32>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildRelocation {
    pub container_field: u32,
    pub container_is_pointer: bool,
    pub target_class: u32,
    pub expected_type: String,
    pub expected_target: Option<u32>,
}

fn hash(s: &str) -> Result<u32, String> {
    u32::from_str_radix(
        s.strip_prefix("0x")
            .ok_or("Expected hexadecimal metadata ID")?,
        16,
    )
    .map_err(|e| e.to_string())
}
fn type_name(s: &str) -> Option<String> {
    Some(match s {
        "Color" | "Rgba" => "rgba".into(),
        "None" | "Bool" | "I8" | "U8" | "I16" | "U16" | "I32" | "U32" | "I64" | "U64" | "F32"
        | "Vec2" | "Vec3" | "Vec4" | "Mtx44" | "String" | "Hash" | "File" | "List" | "List2"
        | "Pointer" | "Embed" | "Link" | "Option" | "Map" | "Flag" => s.to_ascii_lowercase(),
        _ => return None,
    })
}
impl Property {
    fn declaration(&self) -> Option<String> {
        let base = type_name(&self.value_type)?;
        Some(match base.as_str() {
            "list" | "list2" | "option" => format!(
                "{base}[{}]",
                type_name(&self.container.as_ref()?.value_type)?
            ),
            "map" => {
                let m = self.map.as_ref()?;
                format!(
                    "map[{},{}]",
                    type_name(&m.key_type)?,
                    type_name(&m.value_type)?
                )
            }
            _ => base,
        })
    }
}
/// A declared type split into its container and element types: `map[hash,string]` is
/// `("map", ["hash", "string"])` and a plain `u32` is `("", ["u32"])`.
fn shell(ty: &str) -> (&str, Vec<&str>) {
    match ty.split_once('[') {
        Some((base, rest)) => (base, rest.trim_end_matches(']').split(',').collect()),
        None => ("", vec![ty]),
    }
}

const INT_RANGES: &[(&str, i128, i128)] = &[
    ("i8", i8::MIN as i128, i8::MAX as i128),
    ("u8", 0, u8::MAX as i128),
    ("i16", i16::MIN as i128, i16::MAX as i128),
    ("u16", 0, u16::MAX as i128),
    ("i32", i32::MIN as i128, i32::MAX as i128),
    ("u32", 0, u32::MAX as i128),
    ("i64", i64::MIN as i128, i64::MAX as i128),
    ("u64", 0, u64::MAX as i128),
];

fn int_range(ty: &str) -> Option<(i128, i128)> {
    INT_RANGES
        .iter()
        .find(|(name, _, _)| *name == ty)
        .map(|(_, low, high)| (*low, *high))
}

/// Types whose ritobin literal is the same text: a quoted path either way.
fn path_like(ty: &str) -> bool {
    matches!(ty, "string" | "file")
}

fn integers(value: &BinValue, out: &mut Vec<i128>) {
    match value {
        BinValue::U8(v) => out.push(*v as i128),
        BinValue::U16(v) => out.push(*v as i128),
        BinValue::U32(v) => out.push(*v as i128),
        BinValue::U64(v) => out.push(*v as i128),
        BinValue::I8(v) => out.push(*v as i128),
        BinValue::I16(v) => out.push(*v as i128),
        BinValue::I32(v) => out.push(*v as i128),
        BinValue::I64(v) => out.push(*v as i128),
        BinValue::List { items, .. } => items.iter().for_each(|item| integers(item, out)),
        BinValue::Option { value: Some(v), .. } => integers(v, out),
        BinValue::Map { entries, .. } => entries.iter().for_each(|(k, v)| {
            integers(k, out);
            integers(v, out);
        }),
        _ => {}
    }
}

/// Why swapping the declared type keyword alone would not leave a value the client reads.
///
/// `None` means the retype is safe to apply as a text edit. A narrowing that would truncate
/// a value, and anything whose literal has to be rewritten, is reported here instead so the
/// finding carries an explanation and no fix button.
fn swap_blocker(value: &BinValue, from: &str, to: &str) -> Option<String> {
    let (from_shell, from_items) = shell(from);
    let (to_shell, to_items) = shell(to);
    if from_shell != to_shell || from_items.len() != to_items.len() {
        return Some(format!(
            "`{from}` and `{to}` hold their values differently, so the declaration cannot be swapped on its own."
        ));
    }
    for (from_item, to_item) in from_items.iter().zip(to_items.iter()) {
        if from_item == to_item || (path_like(from_item) && path_like(to_item)) {
            continue;
        }
        match (int_range(from_item), int_range(to_item)) {
            (Some(_), Some((low, high))) => {
                let mut found = Vec::new();
                integers(value, &mut found);
                if let Some(bad) = found.into_iter().find(|n| *n < low || *n > high) {
                    return Some(format!(
                        "the value {bad} does not fit `{to_item}`, so retyping it would change the value."
                    ));
                }
            }
            _ => {
                return Some(format!(
                    "a `{from_item}` value cannot be read as `{to_item}` by changing the declaration."
                ))
            }
        }
    }
    None
}

#[derive(Debug)]
struct Finding {
    expected: String,
    count: usize,
    blocker: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum RelocationTarget {
    Child {
        container_field: u32,
        container_is_pointer: bool,
        target_class: u32,
    },
    Parent {
        parent_class: u32,
        expected: String,
    },
}

#[derive(Default)]
struct CheckFindings {
    type_mismatches: BTreeMap<(u32, u32, String), Finding>,
    relocations: BTreeMap<(u32, u32, RelocationTarget, String), usize>,
    class_mismatches: BTreeMap<(u32, u32, u32, String), usize>,
}

fn scalar_compatible(got: &str, expected: &str) -> bool {
    got == expected
        || matches!(
            (got, expected),
            ("bool", "flag")
                | ("flag", "bool")
                | ("string", "file")
                | ("file", "string")
                | ("string", "hash")
                | ("hash", "file")
                | ("embed", "pointer")
                | ("pointer", "embed")
        )
        || (int_range(got).is_some() && int_range(expected).is_some())
}

pub fn declared_type(value: &BinValue) -> String {
    fn name(ty: BinType) -> String {
        format!("{ty:?}").to_ascii_lowercase()
    }
    let base = name(value.ty());
    match value {
        BinValue::List { item, .. } | BinValue::Option { item, .. } => {
            format!("{base}[{}]", name(*item))
        }
        BinValue::Map { key, value, .. } => format!("map[{},{}]", name(*key), name(*value)),
        _ => base,
    }
}
impl Schema {
    /// Retype only explicitly generated fields, preserving their order and values.
    /// Unlike diagnostics, generation must reject missing definitions and unsafe conversions.
    pub fn adapt_entry(&self, entry: &mut crate::BinEntry) -> Result<(), String> {
        let mut fields = entry.fields.clone();
        self.adapt_fields(entry.class_hash, &mut fields)?;
        entry.fields = fields;
        Ok(())
    }

    fn adapt_fields(&self, class: u32, fields: &mut IndexMap<u32, BinValue>) -> Result<(), String> {
        for (&field, value) in fields {
            let expected = self.expected(class, field).ok_or_else(|| format!(
                "Metadata {} has no definition for 0x{class:08x}.0x{field:08x}", self.version
            ))?;
            adapt_value(value, expected).map_err(|e| format!(
                "Metadata {}: 0x{class:08x}.0x{field:08x}: {e}", self.version
            ))?;
            self.adapt_children(value)?;
        }
        Ok(())
    }

    fn adapt_children(&self, value: &mut BinValue) -> Result<(), String> {
        match value {
            BinValue::Pointer { class, fields } | BinValue::Embed { class, fields } => self.adapt_fields(*class, fields)?,
            BinValue::List { items, .. } => for value in items { self.adapt_children(value)?; },
            BinValue::Option { value: Some(value), .. } => self.adapt_children(value)?,
            BinValue::Map { entries, .. } => for (key, value) in entries {
                self.adapt_children(key)?;
                self.adapt_children(value)?;
            },
            _ => {}
        }
        Ok(())
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let dump: Dump = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        // v3 adds hasher metadata; property/container type tags retain their v2 layout.
        if dump.format_version > 3 || dump.classes.is_empty() || dump.version.is_empty() {
            return Err("Unsupported or empty LeagueToolkit metadata dump".into());
        }
        let mut classes = HashMap::new();
        let mut subclasses: HashMap<u32, Vec<u32>> = HashMap::new();
        for (id, class) in dump.classes {
            let class_id = hash(&id)?;
            let mut bases = Vec::new();
            if let Some(base) = class.base {
                bases.push(hash(&base)?);
            }
            for base in class.secondary_bases.keys() {
                bases.push(hash(base)?);
            }
            for &base in &bases {
                subclasses.entry(base).or_default().push(class_id);
            }
            let mut properties = HashMap::new();
            let mut targets = HashMap::new();
            for (id, property) in class.properties {
                let id = hash(&id)?;
                if let Some(target) = &property.other_class {
                    targets.insert(id, hash(target)?);
                }
                if let Some(ty) = property.declaration() {
                    properties.insert(id, ty);
                }
            }
            classes.insert(
                class_id,
                ClassTypes {
                    bases,
                    properties,
                    targets,
                    is_interface: class.is.interface,
                },
            );
        }
        for list in subclasses.values_mut() {
            list.sort_unstable();
            list.dedup();
        }
        Ok(Self {
            version: dump.version,
            classes,
            subclasses,
        })
    }

    pub fn has_class(&self, class: u32) -> bool {
        self.classes.contains_key(&class)
    }

    pub fn is_concrete(&self, class: u32) -> bool {
        self.classes.get(&class).is_some_and(|c| !c.is_interface)
    }

    pub fn property_spec(&self, class: u32, field: u32) -> Option<(&str, Option<u32>)> {
        let mut todo = vec![class];
        let mut visited = HashSet::new();
        while let Some(id) = todo.pop() {
            if !visited.insert(id) {
                continue;
            }
            if let Some(c) = self.classes.get(&id) {
                if let Some(ty) = c.properties.get(&field) {
                    return Some((ty.as_str(), c.targets.get(&field).copied()));
                }
                todo.extend(c.bases.iter().rev());
            }
        }
        None
    }

    pub fn expected(&self, class: u32, field: u32) -> Option<&str> {
        self.property_spec(class, field).map(|(ty, _)| ty)
    }

    pub fn all_properties(&self, class: u32) -> BTreeMap<u32, (&str, Option<u32>)> {
        let mut out = BTreeMap::new();
        let mut todo = vec![class];
        let mut visited = HashSet::new();
        while let Some(id) = todo.pop() {
            if !visited.insert(id) {
                continue;
            }
            if let Some(c) = self.classes.get(&id) {
                for (&field, ty) in &c.properties {
                    out.entry(field)
                        .or_insert_with(|| (ty.as_str(), c.targets.get(&field).copied()));
                }
                todo.extend(c.bases.iter().rev());
            }
        }
        out
    }

    pub fn concrete_subclasses(&self, base: u32) -> Vec<u32> {
        let mut out = Vec::new();
        let mut todo = vec![base];
        let mut visited = HashSet::new();
        while let Some(id) = todo.pop() {
            if !visited.insert(id) {
                continue;
            }
            if self.is_concrete(id) {
                out.push(id);
            }
            if let Some(subs) = self.subclasses.get(&id) {
                todo.extend(subs);
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    pub fn value_classes_valid(&self, value: &BinValue, target: Option<u32>) -> bool {
        match value {
            BinValue::Pointer { class: 0, .. } => true,
            BinValue::Pointer { class, .. } | BinValue::Embed { class, .. } => {
                target.is_none_or(|base| self.derives_from(*class, base))
            }
            BinValue::List { items, .. } => {
                items.iter().all(|v| self.value_classes_valid(v, target))
            }
            BinValue::Option { value: Some(v), .. } => self.value_classes_valid(v, target),
            BinValue::Map { entries, .. } => entries
                .iter()
                .all(|(_, v)| self.value_classes_valid(v, target)),
            _ => true,
        }
    }

    pub fn unique_concrete_retag(
        &self,
        base: u32,
        fields: &IndexMap<u32, BinValue>,
        is_embed: bool,
    ) -> Option<u32> {
        if fields.is_empty() {
            return None;
        }
        if is_embed {
            return (self.is_concrete(base) && self.validate_fields(base, fields).is_ok())
                .then_some(base);
        }
        let mut matches = self
            .concrete_subclasses(base)
            .into_iter()
            .filter(|&c| self.validate_fields(c, fields).is_ok());
        let first = matches.next()?;
        matches.next().is_none().then_some(first)
    }

    fn collect_retag_targets(&self, value: &BinValue, target: u32, out: &mut Vec<u32>) -> bool {
        match value {
            BinValue::Pointer { class: 0, .. } => true,
            BinValue::Pointer { class, fields } => {
                if self.derives_from(*class, target) {
                    true
                } else if let Some(new_cls) = self.unique_concrete_retag(target, fields, false) {
                    out.push(new_cls);
                    true
                } else {
                    false
                }
            }
            BinValue::Embed { class, fields } => {
                if self.derives_from(*class, target) {
                    true
                } else if let Some(new_cls) = self.unique_concrete_retag(target, fields, true) {
                    out.push(new_cls);
                    true
                } else {
                    false
                }
            }
            BinValue::List { items, .. } => items
                .iter()
                .all(|v| self.collect_retag_targets(v, target, out)),
            BinValue::Option { value: Some(v), .. } => self.collect_retag_targets(v, target, out),
            BinValue::Map { entries, .. } => entries
                .iter()
                .all(|(_, v)| self.collect_retag_targets(v, target, out)),
            _ => true,
        }
    }

    pub fn is_compatible_shape(
        &self,
        value: &BinValue,
        expected: &str,
        target: Option<u32>,
    ) -> bool {
        if let Some(inner) = expected.strip_prefix("option[").and_then(|s| s.strip_suffix(']')) {
            if let BinValue::Option { item, value: opt } = value {
                return match opt {
                    Some(v) => self.is_compatible_shape(v, inner, target),
                    None => scalar_compatible(&format!("{item:?}").to_ascii_lowercase(), inner),
                };
            }
            return self.is_compatible_shape(value, inner, target);
        }
        if let BinValue::Option { value: opt, .. } = value {
            return opt
                .as_deref()
                .is_some_and(|v| self.is_compatible_shape(v, expected, target));
        }
        if let Some((outer, inner)) = expected.strip_suffix(']').and_then(|s| s.split_once('[')) {
            return match (outer, value) {
                ("list" | "list2", BinValue::List { item, items, .. }) => {
                    if items.is_empty() {
                        scalar_compatible(&format!("{item:?}").to_ascii_lowercase(), inner)
                    } else {
                        items
                            .iter()
                            .all(|v| self.is_compatible_shape(v, inner, target))
                    }
                }
                (
                    "map",
                    BinValue::Map {
                        key,
                        value: val_ty,
                        entries,
                    },
                ) => {
                    let Some((ek, ev)) = inner.split_once(',') else {
                        return false;
                    };
                    if entries.is_empty() {
                        scalar_compatible(&format!("{key:?}").to_ascii_lowercase(), ek)
                            && scalar_compatible(&format!("{val_ty:?}").to_ascii_lowercase(), ev)
                    } else {
                        entries.iter().all(|(k, v)| {
                            self.is_compatible_shape(k, ek, None)
                                && self.is_compatible_shape(v, ev, target)
                        })
                    }
                }
                _ => false,
            };
        }
        let got = declared_type(value);
        if got == expected {
            return match value {
                BinValue::Pointer { class: 0, .. } => true,
                BinValue::Pointer { class, .. } | BinValue::Embed { class, .. } => {
                    target.is_none_or(|t| self.derives_from(*class, t))
                }
                _ => true,
            };
        }
        match (value, expected) {
            (BinValue::Bool(_), "flag") | (BinValue::Flag(_), "bool") => true,
            (BinValue::String(_), "file" | "hash")
            | (BinValue::File(_), "string")
            | (BinValue::Hash(_), "file") => true,
            (BinValue::Embed { class, .. }, "pointer") => {
                target.is_none_or(|t| self.derives_from(*class, t))
            }
            (BinValue::Pointer { class, .. }, "embed") if *class != 0 => {
                target.is_none_or(|t| *class == t)
            }
            _ if int_range(&got).is_some() && int_range(expected).is_some() => {
                int_range(expected).is_some_and(|(low, high)| {
                    let mut found = Vec::new();
                    integers(value, &mut found);
                    found.into_iter().all(|n| n >= low && n <= high)
                })
            }
            _ => false,
        }
    }

    pub fn unique_child_relocation(
        &self,
        class: u32,
        field: u32,
        value: &BinValue,
    ) -> Option<ChildRelocation> {
        if !self.has_class(class) || self.expected(class, field).is_some() {
            return None;
        }
        let mut candidates = Vec::new();
        for (prop_field, (prop_ty, prop_target)) in self.all_properties(class) {
            if !matches!(prop_ty, "pointer" | "embed") {
                continue;
            }
            let Some(target_class) = prop_target else {
                continue;
            };
            if !self.is_concrete(target_class) {
                continue;
            }
            if let Some((inner_ty, inner_target)) = self.property_spec(target_class, field) {
                if self.is_compatible_shape(value, inner_ty, inner_target) {
                    candidates.push(ChildRelocation {
                        container_field: prop_field,
                        container_is_pointer: prop_ty == "pointer",
                        target_class,
                        expected_type: inner_ty.to_string(),
                        expected_target: inner_target,
                    });
                }
            }
        }
        if candidates.len() == 1 {
            candidates.pop()
        } else {
            None
        }
    }
    pub fn derives_from(&self, class: u32, base: u32) -> bool {
        let mut todo = vec![class];
        let mut visited = HashSet::new();
        while let Some(id) = todo.pop() {
            if !visited.insert(id) { continue; }
            if let Some(c) = self.classes.get(&id) {
                if id == base { return true; }
                todo.extend(&c.bases);
            }
        }
        false
    }

    pub fn validate_fields(&self, class: u32, fields: &IndexMap<u32, BinValue>) -> Result<(), String> {
        if !self.classes.contains_key(&class) {
            return Err(format!("Metadata {} has no class 0x{class:08x}", self.version));
        }
        for (&field, value) in fields {
            let actual = declared_type(value);
            let Some((expected, target)) = self.property_spec(class, field) else {
                return Err(format!("Metadata {} does not accept 0x{class:08x}.0x{field:08x} as {actual}", self.version));
            };
            if expected != actual.as_str() {
                return Err(format!("Metadata {} does not accept 0x{class:08x}.0x{field:08x} as {actual}", self.version));
            }
            self.validate_value(value, target)?;
        }
        Ok(())
    }

    fn validate_value(&self, value: &BinValue, target: Option<u32>) -> Result<(), String> {
        match value {
            BinValue::Pointer { class: 0, fields } if fields.is_empty() => {},
            BinValue::Pointer { class, fields } | BinValue::Embed { class, fields } => {
                let base = target.ok_or_else(|| format!("Metadata {} has no target class", self.version))?;
                if !self.derives_from(*class, base) {
                    return Err(format!("Metadata {} rejects class 0x{class:08x} for 0x{base:08x}", self.version));
                }
                self.validate_fields(*class, fields)?;
            }
            BinValue::List { items, .. } => {
                for item in items { self.validate_value(item, target)?; }
            }
            BinValue::Option { value: Some(value), .. } => self.validate_value(value, target)?,
            BinValue::Map { entries, .. } => {
                for (key, value) in entries {
                    self.validate_value(key, target)?;
                    self.validate_value(value, target)?;
                }
            }
            _ => {},
        }
        Ok(())
    }

    pub fn check(
        &self,
        bin: &Bin,
        file: &str,
        names: &HashMapper,
        text: Option<&str>,
    ) -> Vec<CheckIssue> {
        let mut findings = CheckFindings::default();
        for entry in &bin.entries {
            self.scan(entry.class_hash, &entry.fields, None, &mut findings);
        }
        let label = |id: u32| {
            names
                .get(id as u64)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("0x{id:08x}"))
        };
        let mut out: Vec<CheckIssue> = findings
            .type_mismatches
            .into_iter()
            .map(|((class, field, got), finding)| {
                let class_name = label(class);
                let field_name = label(field);
                let Finding {
                    expected,
                    count,
                    blocker,
                } = finding;
                let mut detail = if got == "string" && expected == "file" {
                    format!("Change `{field_name}: string =` to `{field_name}: file =` and keep the same path. An asset can exist and still fail to load when its reference carries the wrong type, so this shows up as a missing texture or model rather than an error.")
                } else {
                    format!("Change the declaration to `{field_name}: {expected}` and make sure the value matches that type.")
                };
                detail.push_str(&format!(" Checked against LeagueToolkit metadata {}, which can be ahead of or behind your game build. That is why this is a warning.", self.version));
                if let Some(blocker) = &blocker {
                    detail.push_str(&format!(" A declaration-only edit is insufficient: {blocker} The Issues panel can attempt a value-preserving repair."));
                }
                let lines = text
                    .map(|t| crate::checks::declaration_lines(t, class, &field_name, &got))
                    .unwrap_or_default();
                let fix = (blocker.is_none() && !lines.is_empty()).then(|| TypeFix {
                    class: class_name.clone(),
                    field: field_name.clone(),
                    from: got.clone(),
                    to: expected.clone(),
                    lines: lines.clone(),
                });
                CheckIssue {
                    severity: Severity::Warning,
                    code: "bin.schema-type-mismatch",
                    file: file.into(),
                    message: format!(
                        "{class_name}.{field_name} is declared `{got}`, metadata expects `{expected}` ({count} occurrence{})",
                        if count == 1 { "" } else { "s" }
                    ),
                    line: lines.first().copied(),
                    paths: Vec::new(),
                    expected: Some(format!("{field_name}: {expected}")),
                    detail: Some(detail),
                    fix,
                }
            })
            .collect();

        for ((class, field, target, got), count) in findings.relocations {
            let class_name = label(class);
            let field_name = label(field);
            let plural = if count == 1 { "" } else { "s" };
            let lines = text
                .map(|t| crate::checks::declaration_lines(t, class, &field_name, &got))
                .unwrap_or_default();
            let (message, expected, detail) = match target {
                RelocationTarget::Child {
                    container_field,
                    container_is_pointer,
                    target_class,
                } => {
                    let container_name = label(container_field);
                    let target_name = label(target_class);
                    let container_ty = if container_is_pointer {
                        "pointer"
                    } else {
                        "embed"
                    };
                    (
                        format!(
                            "{class_name}.{field_name} moved into {class_name}.{container_name} ({target_name}) ({count} occurrence{plural})"
                        ),
                        format!("{container_name}: {container_ty} ({target_name}.{field_name})"),
                        format!(
                            "Move `{field_name}` into `{container_name}` (`{target_name}`). Checked against LeagueToolkit metadata {}, which can be ahead of or behind your game build. That is why this is a warning. The Issues panel can relocate this field automatically.",
                            self.version
                        ),
                    )
                }
                RelocationTarget::Parent {
                    parent_class,
                    expected,
                } => {
                    let parent_name = label(parent_class);
                    (
                        format!(
                            "{class_name}.{field_name} moved to parent {parent_name}.{field_name} ({count} occurrence{plural})"
                        ),
                        format!("{parent_name}.{field_name}: {expected}"),
                        format!(
                            "Move `{field_name}` up onto `{parent_name}`. Checked against LeagueToolkit metadata {}, which can be ahead of or behind your game build. That is why this is a warning. The Issues panel can relocate this field automatically.",
                            self.version
                        ),
                    )
                }
            };
            out.push(CheckIssue {
                severity: Severity::Warning,
                code: "bin.schema-field-relocated",
                file: file.into(),
                message,
                line: lines.first().copied(),
                paths: Vec::new(),
                expected: Some(expected),
                detail: Some(detail),
                fix: None,
            });
        }

        for ((class, field, retag_class, got), count) in findings.class_mismatches {
            let class_name = label(class);
            let field_name = label(field);
            let retag_name = label(retag_class);
            let plural = if count == 1 { "" } else { "s" };
            let lines = text
                .map(|t| crate::checks::declaration_lines(t, class, &field_name, &got))
                .unwrap_or_default();
            out.push(CheckIssue {
                severity: Severity::Warning,
                code: "bin.schema-class-mismatch",
                file: file.into(),
                message: format!(
                    "{class_name}.{field_name} can migrate to `{retag_name}` ({count} occurrence{plural})"
                ),
                line: lines.first().copied(),
                paths: Vec::new(),
                expected: Some(format!("{field_name}: {got} ({retag_name})")),
                detail: Some(format!(
                    "Change `{field_name}` object class to `{retag_name}`. Checked against LeagueToolkit metadata {}, which can be ahead of or behind your game build. That is why this is a warning. The Issues panel can migrate this class automatically.",
                    self.version
                )),
                fix: None,
            });
        }

        out
    }
    fn scan(
        &self,
        class: u32,
        fields: &IndexMap<u32, BinValue>,
        parent_class: Option<u32>,
        out: &mut CheckFindings,
    ) {
        let known_class = self.has_class(class);
        for (&field, value) in fields {
            if let Some((expected, target)) = self.property_spec(class, field) {
                let got = declared_type(value);
                let migration =
                    crate::migration::table().get(&crate::migration::table_key(class, field));
                let covered = migration.is_some_and(|m| crate::checks::declares_old_type(m, value));
                if got != expected && !covered {
                    let finding = out
                        .type_mismatches
                        .entry((class, field, got.clone()))
                        .or_insert(Finding {
                            expected: expected.into(),
                            count: 0,
                            blocker: None,
                        });
                    finding.count += 1;
                    if finding.blocker.is_none() {
                        finding.blocker = swap_blocker(value, &got, expected);
                    }
                } else if got == expected
                    && !covered
                    && !self.value_classes_valid(value, target)
                {
                    if let Some(target_cls) = target {
                        let mut retags = Vec::new();
                        if self.collect_retag_targets(value, target_cls, &mut retags) {
                            if let Some(&retag_cls) = retags.first() {
                                *out.class_mismatches
                                    .entry((class, field, retag_cls, got))
                                    .or_default() += 1;
                            }
                        }
                    }
                }
            } else if known_class {
                let got = declared_type(value);
                if let Some(reloc) = self.unique_child_relocation(class, field, value) {
                    let target = RelocationTarget::Child {
                        container_field: reloc.container_field,
                        container_is_pointer: reloc.container_is_pointer,
                        target_class: reloc.target_class,
                    };
                    *out.relocations
                        .entry((class, field, target, got))
                        .or_default() += 1;
                } else if let Some(parent) = parent_class {
                    if self.has_class(parent) {
                        if let Some((p_ty, p_tgt)) = self.property_spec(parent, field) {
                            if self.is_compatible_shape(value, p_ty, p_tgt) {
                                let target = RelocationTarget::Parent {
                                    parent_class: parent,
                                    expected: p_ty.into(),
                                };
                                *out.relocations
                                    .entry((class, field, target, got))
                                    .or_default() += 1;
                            }
                        }
                    }
                }
            }
            self.walk(value, Some(class), out);
        }
    }
    fn walk(&self, value: &BinValue, direct_parent: Option<u32>, out: &mut CheckFindings) {
        match value {
            BinValue::Pointer { class, fields } | BinValue::Embed { class, fields } => {
                self.scan(*class, fields, direct_parent, out)
            }
            BinValue::List { items, .. } => {
                for v in items {
                    self.walk(v, None, out);
                }
            }
            BinValue::Map { entries, .. } => {
                for (k, v) in entries {
                    self.walk(k, None, out);
                    self.walk(v, None, out);
                }
            }
            BinValue::Option { value: Some(v), .. } => self.walk(v, None, out),
            _ => {}
        }
    }
}
pub fn install(schema: Schema) {
    *CURRENT.write() = Some(Arc::new(schema));
}
pub fn current() -> Option<Arc<Schema>> {
    CURRENT.read().clone()
}

/// Safe conversions for generated presets. Never truncate numbers or reinterpret hashes.
pub(crate) fn adapt_value(value: &mut BinValue, expected: &str) -> Result<(), String> {
    let got = declared_type(value);
    if got == expected { return Ok(()); }
    if let BinValue::String(text) = value {
        match expected {
            "file" => {
                *value = BinValue::File(ritoshark::hash::xxh64(text));
                return Ok(());
            }
            "hash" => {
                *value = BinValue::Hash(ritoshark::hash::fnv1a(text));
                return Ok(());
            }
            _ => {}
        }
    }
    let number = match value {
        BinValue::U8(v) => Some(*v as i128), BinValue::U16(v) => Some(*v as i128),
        BinValue::U32(v) => Some(*v as i128), BinValue::U64(v) => Some(*v as i128),
        BinValue::I8(v) => Some(*v as i128), BinValue::I16(v) => Some(*v as i128),
        BinValue::I32(v) => Some(*v as i128), BinValue::I64(v) => Some(*v as i128),
        _ => None,
    };
    if let (Some(n), Some((low, high))) = (number, int_range(expected)) {
        if n >= low && n <= high {
            *value = match expected {
                "u8" => BinValue::U8(n as u8), "u16" => BinValue::U16(n as u16),
                "u32" => BinValue::U32(n as u32), "u64" => BinValue::U64(n as u64),
                "i8" => BinValue::I8(n as i8), "i16" => BinValue::I16(n as i16),
                "i32" => BinValue::I32(n as i32), "i64" => BinValue::I64(n as i64),
                _ => unreachable!(),
            };
            return Ok(());
        }
    }
    let (container, items) = shell(expected);
    if let BinValue::List { is_list2, item, items: values } = value {
        if matches!(container, "list" | "list2") && items.len() == 1 {
            // Element declarations with different payloads require explicit conversion.
            let target = match items[0] {
                "file" => BinType::File,
                "hash" => BinType::Hash,
                name if name == format!("{item:?}").to_ascii_lowercase() => *item,
                _ => return Err(format!("Cannot safely convert `{got}` to `{expected}`")),
            };
            for value in values { adapt_value(value, items[0])?; }
            *item = target;
            *is_list2 = container == "list2";
            return Ok(());
        }
    }
    Err(format!("Cannot safely convert `{got}` to `{expected}`"))
}

/// Current downloaded definitions, or the published subset shipped for offline generation.
pub fn generation_schema() -> Arc<Schema> {
    static BUNDLED: std::sync::OnceLock<Arc<Schema>> = std::sync::OnceLock::new();
    current().unwrap_or_else(|| BUNDLED.get_or_init(|| Arc::new(
        Schema::parse(include_bytes!("tables/loadscreen_meta_16.18.json"))
            .expect("bundled loadscreen metadata must be valid")
    )).clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BinEntry;
    #[test]
    fn generation_hashes_asset_paths_but_preserves_literal_strings() {
        let mut entry = BinEntry {
            path_hash: 42, class_hash: 3,
            fields: [(10, BinValue::String("ASSETS/Test.tex".into())),
                (11, BinValue::String("UI_Secondary_Texture".into()))].into_iter().collect(),
        };
        fixture().adapt_entry(&mut entry).unwrap();
        assert!(matches!(entry.fields[&10], BinValue::File(h) if h == ritoshark::hash::xxh64("ASSETS/Test.tex")));
        assert!(matches!(&entry.fields[&11], BinValue::String(s) if s == "UI_Secondary_Texture"));
        assert_eq!(entry.fields.keys().copied().collect::<Vec<_>>(), vec![10, 11]);
    }

    #[test]
    fn generation_is_atomic_and_checks_numeric_bounds() {
        let schema = numeric_fixture();
        let mut entry = numeric_bin(vec![(0x10, BinValue::U32(7)), (0x11, BinValue::U8(3))]).entries.remove(0);
        schema.adapt_entry(&mut entry).unwrap();
        assert!(matches!(entry.fields[&0x10], BinValue::U8(7)));
        assert!(matches!(entry.fields[&0x11], BinValue::U32(3)));
        entry.fields.insert(0x10, BinValue::U32(300));
        assert!(schema.adapt_entry(&mut entry).is_err());
        assert!(matches!(entry.fields[&0x10], BinValue::U32(300)));
        entry.fields.insert(0x10, BinValue::U32(7));
        entry.fields.insert(0xffff, BinValue::Bool(true));
        assert!(schema.adapt_entry(&mut entry).is_err());
        assert!(matches!(entry.fields[&0x10], BinValue::U32(7)));
    }
    fn fixture() -> Schema {
        Schema::parse(br#"{"formatVersion":3,"version":"test-build","classes":{
            "0x1":{"properties":{"0xa":{"value_type":"File"},"0xb":{"value_type":"String"}}},
            "0x2":{"base":"0x1","properties":{"0xc":{"value_type":"Option","container":{"value_type":"File"}}}},
            "0x3":{"secondary_bases":{"0x2":0},"properties":{}},
            "0x4":{"base":"0x4","properties":{}}
        }}"#).unwrap()
    }
    #[test]
    fn inherited_numeric_fields_and_cycles() {
        let s = fixture();
        assert_eq!(s.expected(3, 10), Some("file"));
        assert_eq!(s.expected(3, 12), Some("option[file]"));
        assert_eq!(s.expected(4, 99), None);
        assert_eq!(s.expected(99, 10), None);
    }
    #[test]
    fn nested_hashed_fields_empty_containers_and_legitimate_strings() {
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: 0,
                class_hash: 99,
                fields: IndexMap::from([(
                    1,
                    BinValue::List {
                        is_list2: false,
                        item: BinType::Embed,
                        items: vec![BinValue::Embed {
                            class: 3,
                            fields: IndexMap::from([
                                (10, BinValue::String("assets/exists.tex".into())),
                                (11, BinValue::String("Diffuse_Texture".into())),
                                (
                                    12,
                                    BinValue::Option {
                                        item: BinType::String,
                                        value: None,
                                    },
                                ),
                            ]),
                        }],
                    },
                )]),
            }],
            ..Default::default()
        };
        let text = "\"entry\" = 0x00000063 {\n    0x00000001: list[embed] = {\n        0x00000003 {\n            0x0000000a: string = \"assets/exists.tex\"\n        }\n    }\n}\n";
        let issues = fixture().check(&bin, "skin.bin", &HashMapper::new(), Some(text));
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].line, Some(4));
        assert!(issues[0].detail.as_ref().unwrap().contains("keep the same path"));
        let fix = issues[0].fix.as_ref().expect("a string to file retype is applicable");
        assert_eq!((fix.from.as_str(), fix.to.as_str()), ("string", "file"));
        assert_eq!(fix.lines, vec![4]);
        assert_eq!(
            issues[1].expected.as_deref(),
            Some("0x0000000c: option[file]")
        );
        assert!(issues[1].fix.is_none(), "an unset option has no declaration line in this text");
    }
    /// `0x10` narrows to `u8`, `0x11` widens to `u32`, `0x12` wants a number where the bin
    /// holds a path. Only the first two can be fixed by swapping the keyword, and only when
    /// every value survives the narrower type.
    fn numeric_fixture() -> Schema {
        Schema::parse(br#"{"formatVersion":3,"version":"test-build","classes":{
            "0x5":{"properties":{"0x10":{"value_type":"U8"},"0x11":{"value_type":"U32"},"0x12":{"value_type":"U8"}}}
        }}"#).unwrap()
    }

    fn numeric_bin(fields: Vec<(u32, BinValue)>) -> Bin {
        Bin {
            entries: vec![BinEntry {
                path_hash: 0,
                class_hash: 5,
                fields: fields.into_iter().collect(),
            }],
            ..Default::default()
        }
    }

    const NUMERIC_TEXT: &str = "\"entry\" = 0x00000005 {\n    0x00000010: u32 = 7\n    0x00000011: u8 = 3\n    0x00000012: string = \"assets/a.tex\"\n}\n";

    #[test]
    fn a_narrowing_retype_is_offered_when_every_value_fits() {
        let bin = numeric_bin(vec![
            (0x10, BinValue::U32(7)),
            (0x11, BinValue::U8(3)),
        ]);
        let issues = numeric_fixture().check(&bin, "a.bin", &HashMapper::new(), Some(NUMERIC_TEXT));
        assert_eq!(issues.len(), 2);

        let narrowing = issues[0].fix.as_ref().expect("7 fits u8");
        assert_eq!((narrowing.from.as_str(), narrowing.to.as_str()), ("u32", "u8"));
        assert_eq!(narrowing.lines, vec![2]);

        let widening = issues[1].fix.as_ref().expect("any u8 fits u32");
        assert_eq!((widening.from.as_str(), widening.to.as_str()), ("u8", "u32"));
        assert_eq!(widening.lines, vec![3]);
    }

    #[test]
    fn a_value_that_does_not_fit_the_narrower_type_is_never_retyped() {
        let bin = numeric_bin(vec![(0x10, BinValue::U32(300))]);
        let issues = numeric_fixture().check(&bin, "a.bin", &HashMapper::new(), Some(NUMERIC_TEXT));

        assert_eq!(issues.len(), 1);
        assert!(issues[0].fix.is_none(), "retyping would turn 300 into something else");
        assert!(
            issues[0].detail.as_ref().unwrap().contains("the value 300 does not fit `u8`"),
            "{}",
            issues[0].detail.as_deref().unwrap_or_default()
        );
    }

    /// One value out of range is enough to withdraw the fix for the whole finding, because
    /// the button edits every declaration at once.
    #[test]
    fn one_oversized_value_withdraws_the_fix_for_the_pair() {
        let bin = Bin {
            entries: vec![
                BinEntry { path_hash: 0, class_hash: 5, fields: [(0x10, BinValue::U32(7))].into_iter().collect() },
                BinEntry { path_hash: 1, class_hash: 5, fields: [(0x10, BinValue::U32(9000))].into_iter().collect() },
            ],
            ..Default::default()
        };
        let issues = numeric_fixture().check(&bin, "a.bin", &HashMapper::new(), Some(NUMERIC_TEXT));

        assert_eq!(issues.len(), 1);
        assert!(issues[0].message.contains("2 occurrences"), "{}", issues[0].message);
        assert!(issues[0].fix.is_none());
    }

    #[test]
    fn a_literal_that_would_have_to_be_rewritten_is_never_retyped() {
        let bin = numeric_bin(vec![(0x12, BinValue::String("assets/a.tex".into()))]);
        let issues = numeric_fixture().check(&bin, "a.bin", &HashMapper::new(), Some(NUMERIC_TEXT));

        assert_eq!(issues.len(), 1);
        assert!(issues[0].fix.is_none());
        assert!(
            issues[0].detail.as_ref().unwrap().contains("cannot be read as `u8`"),
            "{}",
            issues[0].detail.as_deref().unwrap_or_default()
        );
    }

    #[test]
    fn a_container_shape_change_is_never_retyped() {
        assert!(swap_blocker(&BinValue::String("x".into()), "string", "list[string]").is_some());
        assert!(swap_blocker(&BinValue::U8(1), "u8", "u16").is_none());
        assert!(swap_blocker(
            &BinValue::List { is_list2: false, item: BinType::String, items: vec![BinValue::String("x".into())] },
            "list[string]",
            "list[file]",
        )
        .is_none());
        assert!(swap_blocker(
            &BinValue::Map { key: BinType::Hash, value: BinType::String, entries: vec![] },
            "map[hash,string]",
            "map[file,string]",
        )
        .is_some(), "an fnv1a key is not an xxh64 key");
    }

    #[test]
    fn rejects_future_or_empty_schema() {
        assert!(Schema::parse(br#"{"formatVersion":4,"version":"x","classes":{}}"#).is_err());
        assert!(Schema::parse(b"not json").is_err());
    }
    #[test]
    fn known_migration_is_not_reported_twice() {
        let class = ritoshark::hash::fnv1a("SkinMeshDataProperties_MaterialOverride");
        let field = ritoshark::hash::fnv1a("texture");
        let s = Schema {
            version: "test".into(),
            subclasses: HashMap::new(),
            classes: HashMap::from([(
                class,
                ClassTypes {
                    bases: vec![],
                    targets: HashMap::new(),
                    properties: HashMap::from([(field, "file".into())]),
                    is_interface: false,
                },
            )]),
        };
        let bin = Bin {
            entries: vec![BinEntry {
                class_hash: class,
                path_hash: 0,
                fields: IndexMap::from([(field, BinValue::String("a.tex".into()))]),
            }],
            ..Default::default()
        };
        assert!(s.check(&bin, "a.bin", &HashMapper::new(), None).is_empty());
        let mut tally = crate::MigrationTally::default();
        tally.add_bin(&bin, "a.bin", None);
        assert_eq!(tally.into_issues().len(), 1);
    }
    #[test]
    #[ignore = "Set FLINT_META_DUMP to a downloaded LeagueToolkit release dump"]
    fn published_dump() {
        let bytes = std::fs::read(std::env::var("FLINT_META_DUMP").unwrap()).unwrap();
        let schema = Schema::parse(&bytes).unwrap();
        let hash = ritoshark::hash::fnv1a;
        assert_eq!(
            schema.expected(hash("StaticMaterialShaderSamplerDef"), hash("TexturePath")),
            Some("file")
        );
        assert_eq!(
            schema.expected(hash("StaticMaterialShaderSamplerDef"), hash("TextureName")),
            Some("string")
        );
        assert_eq!(
            schema.expected(hash("SkinMeshDataProperties"), hash("Texture")),
            Some("file")
        );
        assert!(schema.classes.len() > 1000);
    }

    #[test]
    fn parses_interface_flags_and_resolves_unique_concrete_retag() {
        let schema = Schema::parse(
            br#"{"formatVersion":3,"version":"test","classes":{
            "0x10":{"is":{"interface":true},"properties":{}},
            "0x11":{"base":"0x10","is":{"interface":false},"properties":{"0x1":{"value_type":"String"}}},
            "0x12":{"base":"0x10","properties":{"0x2":{"value_type":"U32"}}}
        }}"#,
        )
        .unwrap();
        assert!(!schema.is_concrete(0x10));
        assert!(schema.is_concrete(0x11));
        assert!(schema.is_concrete(0x12));
        assert_eq!(schema.concrete_subclasses(0x10), vec![0x11, 0x12]);

        let fields_a = IndexMap::from([(1, BinValue::String("a".into()))]);
        assert_eq!(schema.unique_concrete_retag(0x10, &fields_a, false), Some(0x11));
        assert_eq!(schema.unique_concrete_retag(0x10, &IndexMap::new(), false), None);

        let ambiguous = Schema::parse(
            br#"{"formatVersion":3,"version":"test","classes":{
            "0x10":{"is":{"interface":true},"properties":{}},
            "0x11":{"base":"0x10","properties":{"0x1":{"value_type":"String"}}},
            "0x12":{"base":"0x10","properties":{"0x1":{"value_type":"String"}}}
        }}"#,
        )
        .unwrap();
        assert_eq!(ambiguous.unique_concrete_retag(0x10, &fields_a, false), None);
    }

    #[test]
    fn detects_relocated_and_retaggable_fields_without_false_positives() {
        let schema = Schema::parse(
            br#"{"formatVersion":3,"version":"16.22","classes":{
            "0x100":{"properties":{
                "0x1":{"value_type":"Pointer","other_class":"0x200"},
                "0x2":{"value_type":"Pointer","other_class":"0x201"},
                "0x3":{"value_type":"Pointer","other_class":"0x300"},
                "0x4":{"value_type":"U32"}
            }},
            "0x200":{"properties":{"0xa":{"value_type":"String"},"0xc":{"value_type":"U32"}}},
            "0x201":{"properties":{"0xc":{"value_type":"U32"}}},
            "0x300":{"is":{"interface":true},"properties":{}},
            "0x301":{"base":"0x300","properties":{"0xd":{"value_type":"F32"}}}
        }}"#,
        )
        .unwrap();
        let bin = Bin {
            entries: vec![BinEntry {
                path_hash: 0,
                class_hash: 0x100,
                fields: IndexMap::from([
                    (0xa, BinValue::String("tex.tex".into())),
                    (0xc, BinValue::U32(5)),
                    (0x99, BinValue::U32(1)),
                    (
                        0x2,
                        BinValue::Pointer {
                            class: 0x201,
                            fields: IndexMap::from([(0x4, BinValue::U32(9))]),
                        },
                    ),
                    (
                        0x3,
                        BinValue::Pointer {
                            class: 0x999,
                            fields: IndexMap::from([(0xd, BinValue::F32(1.5))]),
                        },
                    ),
                ]),
            }],
            ..Default::default()
        };
        let text = "\"e\" = 0x00000100 {\n    0x0000000a: string = \"tex.tex\"\n    0x0000000c: u32 = 5\n    0x00000099: u32 = 1\n    0x00000002: pointer = 0x00000201 {\n        0x00000004: u32 = 9\n    }\n    0x00000003: pointer = 0x00000999 {\n        0x0000000d: f32 = 1.5\n    }\n}\n";
        let issues = schema.check(&bin, "vfx.bin", &HashMapper::new(), Some(text));
        assert_eq!(issues.len(), 3);
        let reloc_child = issues
            .iter()
            .find(|i| i.code == "bin.schema-field-relocated" && i.line == Some(2))
            .unwrap();
        assert!(reloc_child.message.contains("moved into"));
        let reloc_parent = issues
            .iter()
            .find(|i| i.code == "bin.schema-field-relocated" && i.line == Some(6))
            .unwrap();
        assert!(reloc_parent.message.contains("moved to parent"));
        let class_issue = issues
            .iter()
            .find(|i| i.code == "bin.schema-class-mismatch")
            .unwrap();
        assert_eq!(class_issue.line, Some(8));
        assert!(class_issue.message.contains("0x00000301"));
    }

    #[test]
    fn class_mismatch_skips_migration_retags_and_ambiguous_targets() {
        let schema = Schema::parse(
            br#"{"formatVersion":3,"version":"16.22","classes":{
            "0x3b09052f":{"properties":{"0x99262238":{"value_type":"Pointer","other_class":"0x73b4a2eb"}}},
            "0x73b4a2eb":{"properties":{"0x1":{"value_type":"U32"}}},
            "0x50":{"properties":{"0x10":{"value_type":"Pointer","other_class":"0x60"}}},
            "0x60":{"is":{"interface":true},"properties":{}},
            "0x61":{"base":"0x60","properties":{"0x1":{"value_type":"U32"}}},
            "0x62":{"base":"0x60","properties":{"0x1":{"value_type":"U32"}}}
        }}"#,
        )
        .unwrap();
        let bin = Bin {
            entries: vec![
                BinEntry {
                    path_hash: 1,
                    class_hash: 0x3b09052f,
                    fields: IndexMap::from([(
                        ritoshark::hash::fnv1a("value"),
                        BinValue::Embed {
                            class: 0x999,
                            fields: IndexMap::from([(1, BinValue::U32(1))]),
                        },
                    )]),
                },
                BinEntry {
                    path_hash: 2,
                    class_hash: 0x50,
                    fields: IndexMap::from([(
                        0x10,
                        BinValue::Pointer {
                            class: 0x999,
                            fields: IndexMap::from([(1, BinValue::U32(1))]),
                        },
                    )]),
                },
            ],
            ..Default::default()
        };
        let issues = schema.check(&bin, "a.bin", &HashMapper::new(), None);
        assert!(issues.iter().all(|i| i.code != "bin.schema-class-mismatch"));
    }
}
