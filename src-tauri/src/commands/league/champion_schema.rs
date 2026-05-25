//! Champion BIN Schema Aggregator
//!
//! Walks every WAD, picks only `LinkedData` BINs (skin BINs and the data BINs they
//! link to — excludes champion-root, animation, and corrupt BINs via `classify_bin`),
//! merges every property of every class globally, then emits ONE synthetic ritobin
//! file containing every entry / class / field / sample value the game ships.
//!
//! Output is real ritobin syntax (block style with `{ }`) so users can copy-paste
//! values straight into their own BINs.

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::state::LmdbCacheState;
use flint_ltk::bin::ltk_bridge::{get_cached_bin_hashes, read_bin, MAX_BIN_SIZE};
use flint_ltk::bin::{classify_bin, BinCategory};
use flint_ltk::hash::{get_hash_dir, resolve_hashes_lmdb_bulk, ResolvedHashes};
use flint_ltk::ltk_types::HashProvider;
use flint_ltk::ltk_types::{values, BinProperty, PropertyKind, PropertyValueEnum};
use flint_ltk::wad_jade::adapter::WadHandle as WadReader;

const SAMPLE_LIMIT_COMPLEX: usize = 3;
const SAMPLE_LIMIT_SCALAR: usize = 1;
const ENTRY_KEY_LIMIT_PER_CLASS: usize = 3;
const LINKED_PATH_SAMPLE_LIMIT: usize = 8;

// =============================================================================
// Progress / public stats
// =============================================================================

#[derive(Debug, Clone, Serialize)]
struct ChampionSchemaProgress {
    phase: String,
    current: usize,
    total: usize,
    bins_parsed: usize,
    bins_failed: usize,
    classes_found: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChampionSchemaStats {
    pub wads_scanned: usize,
    pub bins_parsed: usize,
    pub bins_failed: usize,
    pub classes_found: usize,
    pub total_fields: usize,
    pub output_path: String,
}

// =============================================================================
// Internal schema representation
// =============================================================================

struct ClassSchema {
    fields: IndexMap<u32, FieldSchema>,
}

struct FieldSchema {
    type_str: String,
    samples: Vec<PropertyValueEnum>,
    sample_limit: usize,
}

/// One root-level entry sample: the entry key (resolved string or hex). Up to
/// N keys per class are kept (class hash is the map key in `entries_by_class`).
struct EntrySample {
    key_repr: String,
}

// =============================================================================
// Type description (mirrors dev.rs::describe_value but no class-hash side channel
// — class info comes from the sample value itself when rendering)
// =============================================================================

fn kind_str(kind: PropertyKind) -> &'static str {
    match kind {
        PropertyKind::None => "none",
        PropertyKind::Bool => "bool",
        PropertyKind::I8 => "i8",
        PropertyKind::U8 => "u8",
        PropertyKind::I16 => "i16",
        PropertyKind::U16 => "u16",
        PropertyKind::I32 => "i32",
        PropertyKind::U32 => "u32",
        PropertyKind::I64 => "i64",
        PropertyKind::U64 => "u64",
        PropertyKind::F32 => "f32",
        PropertyKind::Vector2 => "vec2",
        PropertyKind::Vector3 => "vec3",
        PropertyKind::Vector4 => "vec4",
        PropertyKind::Matrix44 => "mtx44",
        PropertyKind::Color => "rgba",
        PropertyKind::String => "string",
        PropertyKind::Hash => "hash",
        PropertyKind::WadChunkLink => "file",
        PropertyKind::Container => "list",
        PropertyKind::UnorderedContainer => "list2",
        PropertyKind::Struct => "pointer",
        PropertyKind::Embedded => "embed",
        PropertyKind::ObjectLink => "link",
        PropertyKind::Optional => "option",
        PropertyKind::Map => "map",
        PropertyKind::BitBool => "flag",
    }
}

fn describe_type(value: &PropertyValueEnum) -> String {
    match value {
        PropertyValueEnum::Struct(_) => "pointer".to_string(),
        PropertyValueEnum::Embedded(_) => "embed".to_string(),
        PropertyValueEnum::Container(c) => format!("list[{}]", kind_str(c.item_kind())),
        PropertyValueEnum::UnorderedContainer(uc) => format!("list2[{}]", kind_str(uc.0.item_kind())),
        PropertyValueEnum::Map(m) => format!("map[{},{}]", kind_str(m.key_kind()), kind_str(m.value_kind())),
        PropertyValueEnum::Optional(o) => format!("option[{}]", kind_str(o.item_kind())),
        other => kind_str(other.kind()).to_string(),
    }
}

fn is_scalar_value(v: &PropertyValueEnum) -> bool {
    matches!(
        v,
        PropertyValueEnum::Bool(_)
            | PropertyValueEnum::BitBool(_)
            | PropertyValueEnum::I8(_)
            | PropertyValueEnum::U8(_)
            | PropertyValueEnum::I16(_)
            | PropertyValueEnum::U16(_)
            | PropertyValueEnum::I32(_)
            | PropertyValueEnum::U32(_)
            | PropertyValueEnum::I64(_)
            | PropertyValueEnum::U64(_)
            | PropertyValueEnum::F32(_)
            | PropertyValueEnum::Vector2(_)
            | PropertyValueEnum::Vector3(_)
            | PropertyValueEnum::Vector4(_)
            | PropertyValueEnum::Matrix44(_)
            | PropertyValueEnum::Color(_)
            | PropertyValueEnum::String(_)
            | PropertyValueEnum::Hash(_)
            | PropertyValueEnum::ObjectLink(_)
            | PropertyValueEnum::WadChunkLink(_)
    )
}

// =============================================================================
// Aggregation: walk every property, merge into the global schema
// =============================================================================

fn process_class(
    class_hash: u32,
    properties: &IndexMap<u32, BinProperty>,
    schema: &mut HashMap<u32, ClassSchema>,
) {
    if class_hash == 0 {
        return;
    }

    let class = schema.entry(class_hash).or_insert_with(|| ClassSchema {
        fields: IndexMap::new(),
    });

    for prop in properties.values() {
        let type_str = describe_type(&prop.value);
        let limit = if is_scalar_value(&prop.value) {
            SAMPLE_LIMIT_SCALAR
        } else {
            SAMPLE_LIMIT_COMPLEX
        };

        let field = class.fields.entry(prop.name_hash).or_insert_with(|| FieldSchema {
            type_str: type_str.clone(),
            samples: Vec::new(),
            sample_limit: limit,
        });

        // Prefer a non-empty type_str in case the first sample was uninformative.
        if field.type_str.is_empty() {
            field.type_str = type_str;
        }
        // Bump the limit if a complex value is later seen for what was assumed scalar.
        if limit > field.sample_limit {
            field.sample_limit = limit;
        }
        if field.samples.len() < field.sample_limit {
            field.samples.push(prop.value.clone());
        }
    }

    // Recurse into nested classes (collect first to avoid borrow conflicts).
    let mut nested: Vec<(u32, IndexMap<u32, BinProperty>)> = Vec::new();
    for prop in properties.values() {
        collect_nested(&prop.value, &mut nested);
    }
    for (ch, props) in nested {
        process_class(ch, &props, schema);
    }
}

fn collect_nested(value: &PropertyValueEnum, out: &mut Vec<(u32, IndexMap<u32, BinProperty>)>) {
    match value {
        PropertyValueEnum::Struct(s) if s.class_hash != 0 => {
            out.push((s.class_hash, s.properties.clone()));
        }
        PropertyValueEnum::Embedded(e) if e.0.class_hash != 0 => {
            out.push((e.0.class_hash, e.0.properties.clone()));
        }
        PropertyValueEnum::Container(c) => collect_nested_container(c, out),
        PropertyValueEnum::UnorderedContainer(uc) => collect_nested_container(&uc.0, out),
        PropertyValueEnum::Map(m) => {
            for (_k, v) in m.entries() {
                match v {
                    PropertyValueEnum::Struct(s) if s.class_hash != 0 => {
                        out.push((s.class_hash, s.properties.clone()));
                    }
                    PropertyValueEnum::Embedded(e) if e.0.class_hash != 0 => {
                        out.push((e.0.class_hash, e.0.properties.clone()));
                    }
                    _ => {}
                }
            }
        }
        PropertyValueEnum::Optional(o) => match o {
            values::Optional::Struct(Some(s)) if s.class_hash != 0 => {
                out.push((s.class_hash, s.properties.clone()));
            }
            values::Optional::Embedded(Some(e)) if e.0.class_hash != 0 => {
                out.push((e.0.class_hash, e.0.properties.clone()));
            }
            _ => {}
        },
        _ => {}
    }
}

fn collect_nested_container(c: &values::Container, out: &mut Vec<(u32, IndexMap<u32, BinProperty>)>) {
    match c {
        values::Container::Struct { items, .. } => {
            for s in items {
                if s.class_hash != 0 {
                    out.push((s.class_hash, s.properties.clone()));
                }
            }
        }
        values::Container::Embedded { items, .. } => {
            for e in items {
                if e.0.class_hash != 0 {
                    out.push((e.0.class_hash, e.0.properties.clone()));
                }
            }
        }
        _ => {}
    }
}

// =============================================================================
// Hash resolution helper
// =============================================================================

fn resolve_name(hash: u32, provider: &flint_ltk::ltk_types::HashMapProvider) -> Option<String> {
    if let Some(n) = provider.lookup_type(hash) {
        return Some(n.to_string());
    }
    if let Some(n) = provider.lookup_field(hash) {
        return Some(n.to_string());
    }
    if let Some(n) = provider.lookup_entry(hash) {
        return Some(n.to_string());
    }
    if let Some(n) = provider.lookup_hash(hash) {
        return Some(n.to_string());
    }
    None
}

fn resolve_entry_key(hash: u32, provider: &flint_ltk::ltk_types::HashMapProvider) -> String {
    if let Some(name) = provider.lookup_entry(hash).or_else(|| provider.lookup_hash(hash)) {
        format!("\"{}\"", escape_str(name))
    } else {
        format!("0x{:08x}", hash)
    }
}

// =============================================================================
// Ritobin-style rendering
// =============================================================================

fn fmt_f32(v: f32) -> String {
    if v.is_nan() {
        return "0".to_string();
    }
    if v == v.trunc() && v.abs() < 1.0e10 {
        return format!("{}", v as i64);
    }
    let s = format!("{:.4}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() {
        "0".to_string()
    } else {
        s.to_string()
    }
}

fn escape_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn indent_str(level: usize) -> String {
    "    ".repeat(level)
}

/// Renders a single value into ritobin syntax. For struct/embed it dispatches
/// to `render_class_block` which uses the merged global schema (so nested classes
/// always show every field they ever had, not just what this sample carried).
fn render_value(
    value: &PropertyValueEnum,
    schema: &HashMap<u32, ClassSchema>,
    provider: &flint_ltk::ltk_types::HashMapProvider,
    visited: &mut HashSet<u32>,
    indent: usize,
    out: &mut String,
) {
    use std::fmt::Write;

    match value {
        PropertyValueEnum::None(_) => out.push_str("null"),
        PropertyValueEnum::Bool(v) => out.push_str(if v.value { "true" } else { "false" }),
        PropertyValueEnum::BitBool(v) => out.push_str(if v.value { "true" } else { "false" }),
        PropertyValueEnum::I8(v) => write!(out, "{}", v.value).unwrap(),
        PropertyValueEnum::U8(v) => write!(out, "{}", v.value).unwrap(),
        PropertyValueEnum::I16(v) => write!(out, "{}", v.value).unwrap(),
        PropertyValueEnum::U16(v) => write!(out, "{}", v.value).unwrap(),
        PropertyValueEnum::I32(v) => write!(out, "{}", v.value).unwrap(),
        PropertyValueEnum::U32(v) => write!(out, "{}", v.value).unwrap(),
        PropertyValueEnum::I64(v) => write!(out, "{}", v.value).unwrap(),
        PropertyValueEnum::U64(v) => write!(out, "{}", v.value).unwrap(),
        PropertyValueEnum::F32(v) => out.push_str(&fmt_f32(v.value)),
        PropertyValueEnum::Vector2(v) => {
            write!(out, "{{ {}, {} }}", fmt_f32(v.value.x), fmt_f32(v.value.y)).unwrap();
        }
        PropertyValueEnum::Vector3(v) => {
            write!(
                out,
                "{{ {}, {}, {} }}",
                fmt_f32(v.value.x),
                fmt_f32(v.value.y),
                fmt_f32(v.value.z)
            )
            .unwrap();
        }
        PropertyValueEnum::Vector4(v) => {
            write!(
                out,
                "{{ {}, {}, {}, {} }}",
                fmt_f32(v.value.x),
                fmt_f32(v.value.y),
                fmt_f32(v.value.z),
                fmt_f32(v.value.w)
            )
            .unwrap();
        }
        PropertyValueEnum::Matrix44(_) => out.push_str("{ /* mat4 */ }"),
        PropertyValueEnum::Color(v) => {
            write!(out, "{{ {}, {}, {}, {} }}", v.value.r, v.value.g, v.value.b, v.value.a).unwrap();
        }
        PropertyValueEnum::String(v) => {
            write!(out, "\"{}\"", escape_str(&v.value)).unwrap();
        }
        PropertyValueEnum::Hash(v) => match resolve_name(v.value, provider) {
            Some(name) => write!(out, "\"{}\"", escape_str(&name)).unwrap(),
            None => write!(out, "0x{:08x}", v.value).unwrap(),
        },
        PropertyValueEnum::ObjectLink(v) => match resolve_name(v.value, provider) {
            Some(name) => write!(out, "\"{}\"", escape_str(&name)).unwrap(),
            None => write!(out, "0x{:08x}", v.value).unwrap(),
        },
        PropertyValueEnum::WadChunkLink(v) => {
            write!(out, "0x{:016x}", v.value).unwrap();
        }
        PropertyValueEnum::Struct(s) => {
            let class_name = resolve_name(s.class_hash, provider)
                .unwrap_or_else(|| format!("0x{:08x}", s.class_hash));
            write!(out, "{} ", class_name).unwrap();
            render_class_block(s.class_hash, schema, provider, visited, indent, out);
        }
        PropertyValueEnum::Embedded(e) => {
            let class_name = resolve_name(e.0.class_hash, provider)
                .unwrap_or_else(|| format!("0x{:08x}", e.0.class_hash));
            write!(out, "{} ", class_name).unwrap();
            render_class_block(e.0.class_hash, schema, provider, visited, indent, out);
        }
        PropertyValueEnum::Container(c) => {
            render_container(c, schema, provider, visited, indent, out);
        }
        PropertyValueEnum::UnorderedContainer(uc) => {
            render_container(&uc.0, schema, provider, visited, indent, out);
        }
        PropertyValueEnum::Map(m) => {
            render_map(m, schema, provider, visited, indent, out);
        }
        PropertyValueEnum::Optional(o) => match o {
            values::Optional::None(_) => out.push_str("null"),
            values::Optional::Bool(Some(v)) => render_value(
                &PropertyValueEnum::Bool(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::Bool(None) => out.push_str("null"),
            values::Optional::I8(Some(v)) => render_value(
                &PropertyValueEnum::I8(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::I8(None) => out.push_str("null"),
            values::Optional::U8(Some(v)) => render_value(
                &PropertyValueEnum::U8(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::U8(None) => out.push_str("null"),
            values::Optional::I16(Some(v)) => render_value(
                &PropertyValueEnum::I16(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::I16(None) => out.push_str("null"),
            values::Optional::U16(Some(v)) => render_value(
                &PropertyValueEnum::U16(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::U16(None) => out.push_str("null"),
            values::Optional::I32(Some(v)) => render_value(
                &PropertyValueEnum::I32(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::I32(None) => out.push_str("null"),
            values::Optional::U32(Some(v)) => render_value(
                &PropertyValueEnum::U32(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::U32(None) => out.push_str("null"),
            values::Optional::I64(Some(v)) => render_value(
                &PropertyValueEnum::I64(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::I64(None) => out.push_str("null"),
            values::Optional::U64(Some(v)) => render_value(
                &PropertyValueEnum::U64(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::U64(None) => out.push_str("null"),
            values::Optional::F32(Some(v)) => render_value(
                &PropertyValueEnum::F32(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::F32(None) => out.push_str("null"),
            values::Optional::Vector2(Some(v)) => render_value(
                &PropertyValueEnum::Vector2(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::Vector2(None) => out.push_str("null"),
            values::Optional::Vector3(Some(v)) => render_value(
                &PropertyValueEnum::Vector3(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::Vector3(None) => out.push_str("null"),
            values::Optional::Vector4(Some(v)) => render_value(
                &PropertyValueEnum::Vector4(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::Vector4(None) => out.push_str("null"),
            values::Optional::Color(Some(v)) => render_value(
                &PropertyValueEnum::Color(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::Color(None) => out.push_str("null"),
            values::Optional::String(Some(v)) => render_value(
                &PropertyValueEnum::String(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::String(None) => out.push_str("null"),
            values::Optional::Hash(Some(v)) => render_value(
                &PropertyValueEnum::Hash(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::Hash(None) => out.push_str("null"),
            values::Optional::ObjectLink(Some(v)) => render_value(
                &PropertyValueEnum::ObjectLink(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::ObjectLink(None) => out.push_str("null"),
            values::Optional::WadChunkLink(Some(v)) => render_value(
                &PropertyValueEnum::WadChunkLink(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::WadChunkLink(None) => out.push_str("null"),
            values::Optional::Struct(Some(s)) => render_value(
                &PropertyValueEnum::Struct(s.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::Struct(None) => out.push_str("null"),
            values::Optional::Embedded(Some(e)) => render_value(
                &PropertyValueEnum::Embedded(e.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::Embedded(None) => out.push_str("null"),
            values::Optional::BitBool(Some(v)) => render_value(
                &PropertyValueEnum::BitBool(v.clone()),
                schema,
                provider,
                visited,
                indent,
                out,
            ),
            values::Optional::BitBool(None) => out.push_str("null"),
            _ => out.push_str("null"),
        },
    }
}

fn render_container(
    c: &values::Container,
    schema: &HashMap<u32, ClassSchema>,
    provider: &flint_ltk::ltk_types::HashMapProvider,
    visited: &mut HashSet<u32>,
    indent: usize,
    out: &mut String,
) {
    use std::fmt::Write;

    // Take up to N samples from this container.
    let limit = SAMPLE_LIMIT_COMPLEX;
    let items: Vec<PropertyValueEnum> = c.clone().into_items().take(limit).collect();

    if items.is_empty() {
        out.push_str("{}");
        return;
    }

    // Inline-format scalar containers (short).
    let all_scalar = items.iter().all(is_scalar_value);
    if all_scalar && items.len() <= 4 {
        out.push_str("{ ");
        for (i, it) in items.iter().enumerate() {
            if i > 0 {
                out.push_str(", ");
            }
            render_value(it, schema, provider, visited, indent, out);
        }
        out.push_str(" }");
        return;
    }

    // Multi-line block format.
    out.push_str("{\n");
    let inner_indent = indent_str(indent + 1);
    for it in &items {
        out.push_str(&inner_indent);
        render_value(it, schema, provider, visited, indent + 1, out);
        out.push('\n');
    }
    write!(out, "{}}}", indent_str(indent)).unwrap();
}

fn render_map(
    m: &values::Map,
    schema: &HashMap<u32, ClassSchema>,
    provider: &flint_ltk::ltk_types::HashMapProvider,
    visited: &mut HashSet<u32>,
    indent: usize,
    out: &mut String,
) {
    use std::fmt::Write;

    let entries = m.entries();
    if entries.is_empty() {
        out.push_str("{}");
        return;
    }

    let limit = SAMPLE_LIMIT_COMPLEX;
    out.push_str("{\n");
    let inner_indent = indent_str(indent + 1);
    for (k, v) in entries.iter().take(limit) {
        out.push_str(&inner_indent);
        render_value(k, schema, provider, visited, indent + 1, out);
        out.push_str(" = ");
        render_value(v, schema, provider, visited, indent + 1, out);
        out.push('\n');
    }
    write!(out, "{}}}", indent_str(indent)).unwrap();
}

/// Renders the body `{ field: type = value ... }` for a class hash, looking up
/// fields in the global merged schema. Cycle-safe via `visited`.
fn render_class_block(
    class_hash: u32,
    schema: &HashMap<u32, ClassSchema>,
    provider: &flint_ltk::ltk_types::HashMapProvider,
    visited: &mut HashSet<u32>,
    indent: usize,
    out: &mut String,
) {
    use std::fmt::Write;

    if !visited.insert(class_hash) {
        // Already expanding this class on the current path → emit empty body
        // with a comment so the file stays valid ritobin and copy-paste safe.
        out.push_str("{ /* recursive */ }");
        return;
    }

    let class = match schema.get(&class_hash) {
        Some(c) => c,
        None => {
            out.push_str("{}");
            visited.remove(&class_hash);
            return;
        }
    };

    if class.fields.is_empty() {
        out.push_str("{}");
        visited.remove(&class_hash);
        return;
    }

    out.push_str("{\n");
    let inner_indent = indent_str(indent + 1);
    for (name_hash, field) in &class.fields {
        let field_name = resolve_name(*name_hash, provider)
            .unwrap_or_else(|| format!("0x{:08x}", name_hash));
        write!(out, "{}{}: {} = ", inner_indent, field_name, field.type_str).unwrap();
        if let Some(sample) = field.samples.first() {
            render_value(sample, schema, provider, visited, indent + 1, out);
        } else {
            // Fallback when no sample was captured (shouldn't usually happen).
            out.push_str("...");
        }
        out.push('\n');
    }
    write!(out, "{}}}", indent_str(indent)).unwrap();

    visited.remove(&class_hash);
}

// =============================================================================
// Tauri command
// =============================================================================

#[tauri::command]
pub async fn aggregate_champion_bin_schema(
    app: AppHandle,
    league_path: String,
    lmdb: tauri::State<'_, LmdbCacheState>,
) -> Result<ChampionSchemaStats, String> {
    let game_path = std::path::Path::new(&league_path).join("Game");
    let champions_path = game_path.join("DATA").join("FINAL").join("Champions");

    if !champions_path.exists() {
        return Err(format!(
            "Champions WAD directory not found: {} — make sure this is the League installation folder",
            champions_path.display()
        ));
    }

    // 1. Find every WAD under DATA/FINAL/Champions (skip non-champion WADs — they
    //    bloat the schema with unrelated entries like menu / loadingscreen).
    let wad_paths: Vec<String> = WalkDir::new(&champions_path)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            let name = e.file_name().to_string_lossy();
            name.ends_with(".wad.client") || name.ends_with(".wad")
        })
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();

    let total_wads = wad_paths.len();
    tracing::info!("Champion schema: scanning {} WADs", total_wads);

    // 2. Hash resolution resources.
    let hash_dir = get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let env_opt = lmdb.get_env(&hash_dir);

    // 3. Walk every WAD, parse every LinkedData BIN, merge into the schema.
    let mut schema: HashMap<u32, ClassSchema> = HashMap::new();
    // class_hash -> sample entry keys (root-level entries that map to this class)
    let mut entries_by_class: HashMap<u32, Vec<EntrySample>> = HashMap::new();
    // Order in which root classes were first seen — keeps output deterministic.
    let mut root_class_order: Vec<u32> = Vec::new();
    let mut linked_samples: Vec<String> = Vec::new();
    let mut bins_parsed: usize = 0;
    let mut bins_failed: usize = 0;

    for (wad_idx, wad_path) in wad_paths.iter().enumerate() {
        let _ = app.emit(
            "champion-schema-progress",
            ChampionSchemaProgress {
                phase: "scanning".to_string(),
                current: wad_idx + 1,
                total: total_wads,
                bins_parsed,
                bins_failed,
                classes_found: schema.len(),
            },
        );

        let mut reader = match WadReader::open(wad_path) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("Champion schema: failed to open {}: {}", wad_path, e);
                continue;
            }
        };

        let chunks: Vec<_> = reader.chunks().iter().cloned().collect();
        let hash_u64s: Vec<u64> = chunks.iter().map(|c| c.path_hash).collect();
        let resolved_map: ResolvedHashes = if let Some(ref env) = env_opt {
            resolve_hashes_lmdb_bulk(&hash_u64s, env)
        } else {
            ResolvedHashes::default()
        };

        for chunk in &chunks {
            let path_hash = chunk.path_hash;
            let resolved = match resolved_map.get(&path_hash) {
                Some(p) => p,
                // Skip unresolved chunks — we need the path to classify_bin properly.
                None => continue,
            };

            let resolved_lower = resolved.to_lowercase();
            if !resolved_lower.ends_with(".bin") {
                continue;
            }

            // Belt-and-suspenders root.bin skip. `classify_bin` already returns
            // ChampionRoot for any file named root.bin, but callers asked for
            // this to be explicit.
            if resolved_lower.ends_with("/root.bin") || resolved_lower == "root.bin" {
                continue;
            }

            // Filter via classify_bin: keep ONLY LinkedData — skips
            // ChampionRoot (e.g. Kayn.bin), Animation (animations/skin8.bin),
            // root.bin, and Ignore (corrupt/recursive).
            match classify_bin(resolved) {
                BinCategory::LinkedData => {}
                _ => continue,
            }

            let data = match reader.wad_mut().load_chunk_decompressed(chunk) {
                Ok(d) => d,
                Err(_) => {
                    bins_failed += 1;
                    continue;
                }
            };

            if data.len() < 4 || (&data[..4] != b"PROP" && &data[..4] != b"PTCH") {
                bins_failed += 1;
                continue;
            }
            if data.len() > MAX_BIN_SIZE {
                bins_failed += 1;
                continue;
            }

            let bin = match read_bin(&data) {
                Ok(b) => b,
                Err(_) => {
                    bins_failed += 1;
                    continue;
                }
            };

            // Sample a few linked-paths from the first BINs we successfully parse.
            if linked_samples.len() < LINKED_PATH_SAMPLE_LIMIT {
                for dep in &bin.dependencies {
                    if linked_samples.len() >= LINKED_PATH_SAMPLE_LIMIT {
                        break;
                    }
                    if !linked_samples.contains(dep) {
                        linked_samples.push(dep.clone());
                    }
                }
            }

            // Each top-level object becomes a root entry.
            for obj in bin.objects.values() {
                let entries_list = entries_by_class.entry(obj.class_hash).or_default();
                if !root_class_order.contains(&obj.class_hash) {
                    root_class_order.push(obj.class_hash);
                }
                if entries_list.len() < ENTRY_KEY_LIMIT_PER_CLASS {
                    // path_hash on BinObject is u32 (entry hash).
                    let key_repr = resolve_entry_key(obj.path_hash, &get_cached_bin_hashes().read());
                    if !entries_list.iter().any(|e| e.key_repr == key_repr) {
                        entries_list.push(EntrySample { key_repr });
                    }
                }

                process_class(obj.class_hash, &obj.properties, &mut schema);
            }

            bins_parsed += 1;
        }
    }

    // 4. Build the synthetic ritobin file.
    let provider = get_cached_bin_hashes().read();
    let total_fields: usize = schema.values().map(|c| c.fields.len()).sum();

    let mut output = String::with_capacity(2 * 1024 * 1024);
    use std::fmt::Write;

    let _ = writeln!(output, "// Champion BIN Schema Reference — Flint");
    let _ = writeln!(output, "// Generated: {}", chrono::Utc::now().to_rfc3339());
    let _ = writeln!(
        output,
        "// WADs: {} | LinkedData BINs parsed: {} | Failed: {}",
        total_wads, bins_parsed, bins_failed
    );
    let _ = writeln!(output, "// Classes: {} | Fields: {}", schema.len(), total_fields);
    let _ = writeln!(output, "// Up to {} sample entries per root class, up to {} samples per container/map.",
        ENTRY_KEY_LIMIT_PER_CLASS, SAMPLE_LIMIT_COMPLEX);
    let _ = writeln!(output, "//");
    let _ = writeln!(output, "// Format: real ritobin block syntax — copy any block straight into a .ritobin file.");
    let _ = writeln!(output);

    // Header lines (matches what real ritobin emits).
    let _ = writeln!(output, "#PROP_text");
    let _ = writeln!(output, "type: string = \"PROP\"");
    let _ = writeln!(output, "version: u32 = 3");

    // linked: list[string] — sample dependencies seen across BINs.
    let _ = writeln!(output, "linked: list[string] = {{");
    for path in &linked_samples {
        let _ = writeln!(output, "    \"{}\"", escape_str(path));
    }
    let _ = writeln!(output, "}}");

    // entries: map[hash, embed] — every unique root class with up to N sample keys.
    let _ = writeln!(output, "entries: map[hash,embed] = {{");
    for class_hash in &root_class_order {
        let class_name = resolve_name(*class_hash, &provider)
            .unwrap_or_else(|| format!("0x{:08x}", class_hash));
        let samples = match entries_by_class.get(class_hash) {
            Some(v) if !v.is_empty() => v,
            _ => continue,
        };
        for entry in samples {
            let mut visited: HashSet<u32> = HashSet::new();
            let mut block = String::new();
            render_class_block(*class_hash, &schema, &provider, &mut visited, 1, &mut block);
            let _ = writeln!(output, "    {} = {} {}", entry.key_repr, class_name, block);
        }
    }
    let _ = writeln!(output, "}}");

    // 5. Write the file alongside bin-schema.txt.
    let output_path = get_hash_dir()
        .map(|p| {
            p.parent()
                .unwrap_or(&p)
                .join("champion-bin-schema.ritobin.txt")
        })
        .unwrap_or_else(|_| std::path::PathBuf::from("champion-bin-schema.ritobin.txt"));

    std::fs::write(&output_path, &output)
        .map_err(|e| format!("Failed to write schema file: {}", e))?;

    tracing::info!(
        "Champion schema complete: {} classes, {} fields, {} BINs from {} WADs → {}",
        schema.len(),
        total_fields,
        bins_parsed,
        total_wads,
        output_path.display()
    );

    let _ = app.emit(
        "champion-schema-progress",
        ChampionSchemaProgress {
            phase: "complete".to_string(),
            current: total_wads,
            total: total_wads,
            bins_parsed,
            bins_failed,
            classes_found: schema.len(),
        },
    );

    Ok(ChampionSchemaStats {
        wads_scanned: total_wads,
        bins_parsed,
        bins_failed,
        classes_found: schema.len(),
        total_fields,
        output_path: output_path.to_string_lossy().to_string(),
    })
}
