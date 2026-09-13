//! Type checks against LeagueToolkit/lol-meta-classes release dumps (the LSP's source).
//! Unknown classes/properties are deliberately skipped: a partial dump is not proof
//! that custom or newer content is invalid. No network or file I/O lives here.
use crate::{Bin, BinType, BinValue, CheckIssue, Severity};
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
}
#[derive(Deserialize)]
struct Property {
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
}
pub struct Schema {
    pub version: String,
    classes: HashMap<u32, ClassTypes>,
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
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let dump: Dump = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        // v3 adds hasher metadata; property/container type tags retain their v2 layout.
        if dump.format_version > 3 || dump.classes.is_empty() || dump.version.is_empty() {
            return Err("Unsupported or empty LeagueToolkit metadata dump".into());
        }
        let mut classes = HashMap::new();
        for (id, class) in dump.classes {
            let mut bases = Vec::new();
            if let Some(base) = class.base {
                bases.push(hash(&base)?);
            }
            for base in class.secondary_bases.keys() {
                bases.push(hash(base)?);
            }
            let mut properties = HashMap::new();
            for (id, property) in class.properties {
                let id = hash(&id)?;
                if let Some(ty) = property.declaration() {
                    properties.insert(id, ty);
                }
            }
            classes.insert(hash(&id)?, ClassTypes { bases, properties });
        }
        Ok(Self {
            version: dump.version,
            classes,
        })
    }
    pub fn expected(&self, class: u32, field: u32) -> Option<&str> {
        let mut todo = vec![class];
        let mut visited = HashSet::new();
        while let Some(id) = todo.pop() {
            if !visited.insert(id) {
                continue;
            }
            if let Some(c) = self.classes.get(&id) {
                if let Some(ty) = c.properties.get(&field) {
                    return Some(ty);
                }
                todo.extend(c.bases.iter().rev());
            }
        }
        None
    }
    pub fn check(
        &self,
        bin: &Bin,
        file: &str,
        names: &HashMapper,
        text: Option<&str>,
    ) -> Vec<CheckIssue> {
        // One finding per class/property/actual type, just like the bundled migration tally.
        let mut findings = BTreeMap::new();
        for entry in &bin.entries {
            self.scan(entry.class_hash, &entry.fields, &mut findings);
        }
        findings.into_iter().map(|((class, field, got), (expected, count))| {
            let label = |id: u32| names.get(id as u64).map(str::to_owned).unwrap_or_else(|| format!("0x{id:08x}"));
            let field_name = label(field);
            let remedy = if got == "string" && expected == "file" {
                format!("Change `{field_name}: string =` to `{field_name}: file =` and keep the same path. An existing asset can still fail to load when its reference has the wrong type.")
            } else {
                format!("Update the declaration to `{field_name}: {expected}` and ensure its value matches that type.")
            };
            CheckIssue {
                severity: Severity::Warning, code: "bin.schema-type-mismatch", file: file.into(),
                message: format!("{}.{} uses `{got}`; LeagueToolkit metadata for {} expects `{expected}` ({count} occurrence{}). {remedy}", label(class), field_name, self.version, if count == 1 { "" } else { "s" }),
                line: text.and_then(|t| crate::checks::declaration_line(t, &field_name, &got)),
                expected: Some(format!("{field_name}: {expected}")),
            }
        }).collect()
    }
    fn scan(
        &self,
        class: u32,
        fields: &IndexMap<u32, BinValue>,
        out: &mut BTreeMap<(u32, u32, String), (String, usize)>,
    ) {
        for (&field, value) in fields {
            if let Some(expected) = self.expected(class, field) {
                let got = declared_type(value);
                // The existing migration rule owns this mismatch; don't count it twice.
                let migration =
                    crate::migration::table().get(&crate::migration::table_key(class, field));
                let covered = migration.is_some_and(|m| crate::checks::declares_old_type(m, value));
                if got != expected && !covered {
                    out.entry((class, field, got))
                        .or_insert((expected.into(), 0))
                        .1 += 1;
                }
            }
            self.walk(value, out);
        }
    }
    fn walk(&self, value: &BinValue, out: &mut BTreeMap<(u32, u32, String), (String, usize)>) {
        match value {
            BinValue::Pointer { class, fields } | BinValue::Embed { class, fields } => {
                self.scan(*class, fields, out)
            }
            BinValue::List { items, .. } => {
                for v in items {
                    self.walk(v, out);
                }
            }
            BinValue::Map { entries, .. } => {
                for (k, v) in entries {
                    self.walk(k, out);
                    self.walk(v, out);
                }
            }
            BinValue::Option { value: Some(v), .. } => self.walk(v, out),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BinEntry;
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
        let issues = fixture().check(
            &bin,
            "skin.bin",
            &HashMapper::new(),
            Some("0x0000000a: string = \"assets/exists.tex\""),
        );
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].line, Some(1));
        assert!(issues[0].message.contains("keep the same path"));
        assert_eq!(
            issues[1].expected.as_deref(),
            Some("0x0000000c: option[file]")
        );
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
            classes: HashMap::from([(
                class,
                ClassTypes {
                    bases: vec![],
                    properties: HashMap::from([(field, "file".into())]),
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
}
