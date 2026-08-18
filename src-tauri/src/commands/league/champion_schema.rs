use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::state::LmdbCacheState;
use flint_core::bin::codec::{read_bin, MAX_BIN_SIZE};
use flint_core::bin::get_cached_bin_hashes;
use flint_core::bin::{classify_bin, BinCategory};
use flint_core::hash::{get_hash_dir, resolve_hashes_lmdb_bulk, ResolvedHashes};
use flint_core::hash::HashMapper;
use flint_core::bin::{BinType, BinValue};
use flint_core::wad::adapter::WadHandle as WadReader;

const SAMPLE_LIMIT_COMPLEX: usize = 3;
const SAMPLE_LIMIT_SCALAR: usize = 1;
// One sample entry per root class: every entry renders the same aggregated
// class schema, so more keys would just duplicate the identical block.
const ENTRY_KEY_LIMIT_PER_CLASS: usize = 1;
const LINKED_PATH_SAMPLE_LIMIT: usize = 8;
// Polymorphic list cap: gathers one sample per distinct concrete class up to
// this bound so driver lists (like mDrivers) showcase every driver variant seen
// across the install while preventing runaway growth.
const POLYMORPHIC_LIST_CLASS_LIMIT: usize = 16;
const MAP_CLASS_LIMIT: usize = 12;

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

/** A field merged across every instance of its class seen in every scanned bin.
Captures distinct concrete subclasses across all champions for pointer/embed fields
and lists/maps, so polymorphic hierarchies (e.g. material drivers, augments, rig modifiers)
render one clean exemplar of every distinct class without duplicate boilerplate. */
struct FieldSchema {
    type_str: String,
    samples: Vec<BinValue>,
    sample_limit: usize,
    /// For scalar pointer/embed fields: distinct concrete classes seen across all bins.
    seen_classes: Vec<u32>,
    /// For list[pointer] / list2[pointer] / list[embed] / list2[embed]:
    /// At most one sample item per distinct concrete class.
    list_items: Vec<BinValue>,
    list_classes: HashSet<u32>,
    list_classless: usize,
    /// For map[k, v]:
    /// At most one entry per distinct value class.
    map_entries: Vec<(BinValue, BinValue)>,
    map_classes: HashSet<u32>,
    map_classless: usize,
}

struct EntrySample {
    key_repr: String,
}

// =============================================================================
// Type description
// =============================================================================

fn kind_str(kind: BinType) -> &'static str {
    match kind {
        BinType::None => "none",
        BinType::Bool => "bool",
        BinType::I8 => "i8",
        BinType::U8 => "u8",
        BinType::I16 => "i16",
        BinType::U16 => "u16",
        BinType::I32 => "i32",
        BinType::U32 => "u32",
        BinType::I64 => "i64",
        BinType::U64 => "u64",
        BinType::F32 => "f32",
        BinType::Vec2 => "vec2",
        BinType::Vec3 => "vec3",
        BinType::Vec4 => "vec4",
        BinType::Mtx44 => "mtx44",
        BinType::Rgba => "rgba",
        BinType::String => "string",
        BinType::Hash => "hash",
        BinType::File => "file",
        BinType::List => "list",
        BinType::List2 => "list2",
        BinType::Pointer => "pointer",
        BinType::Embed => "embed",
        BinType::Link => "link",
        BinType::Option => "option",
        BinType::Map => "map",
        BinType::Flag => "flag",
    }
}

fn describe_type(value: &BinValue) -> String {
    match value {
        BinValue::Pointer { .. } => "pointer".to_string(),
        BinValue::Embed { .. } => "embed".to_string(),
        BinValue::List { is_list2, item, .. } => {
            if *is_list2 {
                format!("list2[{}]", kind_str(*item))
            } else {
                format!("list[{}]", kind_str(*item))
            }
        }
        BinValue::Map { key, value, .. } => {
            format!("map[{},{}]", kind_str(*key), kind_str(*value))
        }
        BinValue::Option { item, .. } => format!("option[{}]", kind_str(*item)),
        other => kind_str(other.ty()).to_string(),
    }
}

fn is_scalar_value(v: &BinValue) -> bool {
    matches!(
        v,
        BinValue::Bool(_)
            | BinValue::Flag(_)
            | BinValue::I8(_)
            | BinValue::U8(_)
            | BinValue::I16(_)
            | BinValue::U16(_)
            | BinValue::I32(_)
            | BinValue::U32(_)
            | BinValue::I64(_)
            | BinValue::U64(_)
            | BinValue::F32(_)
            | BinValue::Vec2(_)
            | BinValue::Vec3(_)
            | BinValue::Vec4(_)
            | BinValue::Mtx44(_)
            | BinValue::Rgba(_)
            | BinValue::String(_)
            | BinValue::Hash(_)
            | BinValue::Link(_)
            | BinValue::File(_)
    )
}

/// The concrete class a pointer/embed value instantiates, if it is one and is not null.
fn class_of(value: &BinValue) -> Option<u32> {
    match value {
        BinValue::Pointer { class, .. } | BinValue::Embed { class, .. } if *class != 0 => {
            Some(*class)
        }
        _ => None,
    }
}

// =============================================================================
// Aggregation: walk every property, merge into the global schema
// =============================================================================

fn process_class(
    class_hash: u32,
    fields: &IndexMap<u32, BinValue>,
    schema: &mut HashMap<u32, ClassSchema>,
) {
    if class_hash == 0 {
        return;
    }

    let class = schema.entry(class_hash).or_insert_with(|| ClassSchema {
        fields: IndexMap::new(),
    });

    for (name_hash, value) in fields {
        let type_str = describe_type(value);
        let limit = if is_scalar_value(value) {
            SAMPLE_LIMIT_SCALAR
        } else {
            SAMPLE_LIMIT_COMPLEX
        };

        let field = class.fields.entry(*name_hash).or_insert_with(|| FieldSchema {
            type_str: type_str.clone(),
            samples: Vec::new(),
            sample_limit: limit,
            seen_classes: Vec::new(),
            list_items: Vec::new(),
            list_classes: HashSet::new(),
            list_classless: 0,
            map_entries: Vec::new(),
            map_classes: HashSet::new(),
            map_classless: 0,
        });

        if field.type_str.is_empty() {
            field.type_str = type_str;
        }
        if limit > field.sample_limit {
            field.sample_limit = limit;
        }

        // Track distinct concrete subclasses for scalar pointer/embed
        if let Some(ch) = class_of(value) {
            if !field.seen_classes.contains(&ch) {
                field.seen_classes.push(ch);
            }
        }

        if field.samples.len() < field.sample_limit {
            field.samples.push(value.clone());
        }

        match value {
            BinValue::List { items, .. } => {
                merge_list_items(field, items);
            }
            BinValue::Map { entries, .. } => {
                merge_map_entries(field, entries);
            }
            _ => {}
        }
    }

    let mut nested: Vec<(u32, IndexMap<u32, BinValue>)> = Vec::new();
    for value in fields.values() {
        collect_nested(value, &mut nested);
    }
    for (ch, props) in nested {
        process_class(ch, &props, schema);
    }
}

/** Merges list items across bins keeping one sample per distinct concrete class.
Prevents duplicate identical structs in homogeneous lists while allowing polymorphic lists
(like `mDrivers: list[pointer]`) to show all driver subclasses across the install. */
fn merge_list_items(field: &mut FieldSchema, items: &[BinValue]) {
    for item in items {
        let keep = match class_of(item) {
            Some(class) => {
                field.list_classes.len() < POLYMORPHIC_LIST_CLASS_LIMIT
                    && field.list_classes.insert(class)
            }
            None => {
                if field.list_classless < SAMPLE_LIMIT_COMPLEX {
                    if !field.list_items.contains(item) {
                        field.list_classless += 1;
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
        };
        if keep {
            field.list_items.push(item.clone());
        }
    }
}

/** Keeps the first entry seen for each distinct value class in maps. */
fn merge_map_entries(field: &mut FieldSchema, entries: &[(BinValue, BinValue)]) {
    for (key, value) in entries {
        let keep = match class_of(value) {
            Some(class) => {
                field.map_classes.len() < MAP_CLASS_LIMIT && field.map_classes.insert(class)
            }
            None => {
                let room = field.map_classless < SAMPLE_LIMIT_COMPLEX;
                if room {
                    field.map_classless += 1;
                }
                room
            }
        };
        if keep {
            field.map_entries.push((key.clone(), value.clone()));
        }
    }
}

fn collect_nested(value: &BinValue, out: &mut Vec<(u32, IndexMap<u32, BinValue>)>) {
    match value {
        BinValue::Pointer { class, fields } | BinValue::Embed { class, fields } if *class != 0 => {
            out.push((*class, fields.clone()));
        }
        BinValue::List { items, .. } => {
            for item in items {
                collect_nested(item, out);
            }
        }
        BinValue::Map { entries, .. } => {
            for (_k, v) in entries {
                collect_nested(v, out);
            }
        }
        BinValue::Option {
            value: Some(inner), ..
        } => collect_nested(inner, out),
        _ => {}
    }
}

// =============================================================================
// Hash resolution helper
// =============================================================================

fn resolve_name(hash: u32, provider: &HashMapper) -> Option<String> {
    provider.get(hash as u64).map(|n| n.to_string())
}

fn resolve_entry_key(hash: u32, provider: &HashMapper) -> String {
    if let Some(name) = provider.get(hash as u64) {
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

fn render_value(
    value: &BinValue,
    schema: &HashMap<u32, ClassSchema>,
    provider: &HashMapper,
    visited: &mut HashSet<u32>,
    indent: usize,
    out: &mut String,
) {
    use std::fmt::Write;

    match value {
        BinValue::None => out.push_str("null"),
        BinValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        BinValue::Flag(b) => out.push_str(if *b { "true" } else { "false" }),
        BinValue::I8(n) => write!(out, "{}", n).unwrap(),
        BinValue::U8(n) => write!(out, "{}", n).unwrap(),
        BinValue::I16(n) => write!(out, "{}", n).unwrap(),
        BinValue::U16(n) => write!(out, "{}", n).unwrap(),
        BinValue::I32(n) => write!(out, "{}", n).unwrap(),
        BinValue::U32(n) => write!(out, "{}", n).unwrap(),
        BinValue::I64(n) => write!(out, "{}", n).unwrap(),
        BinValue::U64(n) => write!(out, "{}", n).unwrap(),
        BinValue::F32(n) => out.push_str(&fmt_f32(*n)),
        BinValue::Vec2(a) => {
            write!(out, "{{ {}, {} }}", fmt_f32(a[0]), fmt_f32(a[1])).unwrap();
        }
        BinValue::Vec3(a) => {
            write!(
                out,
                "{{ {}, {}, {} }}",
                fmt_f32(a[0]),
                fmt_f32(a[1]),
                fmt_f32(a[2])
            )
            .unwrap();
        }
        BinValue::Vec4(a) => {
            write!(
                out,
                "{{ {}, {}, {}, {} }}",
                fmt_f32(a[0]),
                fmt_f32(a[1]),
                fmt_f32(a[2]),
                fmt_f32(a[3])
            )
            .unwrap();
        }
        BinValue::Mtx44(_) => out.push_str("{ /* mat4 */ }"),
        BinValue::Rgba(a) => {
            write!(out, "{{ {}, {}, {}, {} }}", a[0], a[1], a[2], a[3]).unwrap();
        }
        BinValue::String(s) => {
            write!(out, "\"{}\"", escape_str(s)).unwrap();
        }
        BinValue::Hash(h) => match resolve_name(*h, provider) {
            Some(name) => write!(out, "\"{}\"", escape_str(&name)).unwrap(),
            None => write!(out, "0x{:08x}", h).unwrap(),
        },
        BinValue::Link(h) => match resolve_name(*h, provider) {
            Some(name) => write!(out, "\"{}\"", escape_str(&name)).unwrap(),
            None => write!(out, "0x{:08x}", h).unwrap(),
        },
        BinValue::File(h) => {
            write!(out, "0x{:016x}", h).unwrap();
        }
        BinValue::Pointer { class, .. } | BinValue::Embed { class, .. } => {
            let class_name =
                resolve_name(*class, provider).unwrap_or_else(|| format!("0x{:08x}", class));
            write!(out, "{} ", class_name).unwrap();
            render_class_block(*class, schema, provider, visited, indent, out);
        }
        BinValue::List { items, .. } => {
            render_container(items, schema, provider, visited, indent, out);
        }
        BinValue::Map { entries, .. } => {
            let sampled: Vec<&(BinValue, BinValue)> =
                entries.iter().take(SAMPLE_LIMIT_COMPLEX).collect();
            render_map_entries(&sampled, schema, provider, visited, indent, out);
        }
        BinValue::Option { value: inner, .. } => match inner {
            Some(boxed) => render_value(boxed, schema, provider, visited, indent, out),
            None => out.push_str("null"),
        },
    }
}

fn render_container(
    items: &[BinValue],
    schema: &HashMap<u32, ClassSchema>,
    provider: &HashMapper,
    visited: &mut HashSet<u32>,
    indent: usize,
    out: &mut String,
) {
    use std::fmt::Write;

    if items.is_empty() {
        out.push_str("{}");
        return;
    }

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

    out.push_str("{\n");
    let inner_indent = indent_str(indent + 1);
    for it in items.iter() {
        out.push_str(&inner_indent);
        render_value(it, schema, provider, visited, indent + 1, out);
        out.push('\n');
    }
    write!(out, "{}}}", indent_str(indent)).unwrap();
}

fn render_map_entries(
    entries: &[&(BinValue, BinValue)],
    schema: &HashMap<u32, ClassSchema>,
    provider: &HashMapper,
    visited: &mut HashSet<u32>,
    indent: usize,
    out: &mut String,
) {
    use std::fmt::Write;

    if entries.is_empty() {
        out.push_str("{}");
        return;
    }

    out.push_str("{\n");
    let inner_indent = indent_str(indent + 1);
    for (k, v) in entries.iter() {
        out.push_str(&inner_indent);
        render_value(k, schema, provider, visited, indent + 1, out);
        out.push_str(" = ");
        render_value(v, schema, provider, visited, indent + 1, out);
        out.push('\n');
    }
    write!(out, "{}}}", indent_str(indent)).unwrap();
}

fn render_class_block(
    class_hash: u32,
    schema: &HashMap<u32, ClassSchema>,
    provider: &HashMapper,
    visited: &mut HashSet<u32>,
    indent: usize,
    out: &mut String,
) {
    use std::fmt::Write;

    if !visited.insert(class_hash) {
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

        // For scalar pointer/embed fields with multiple observed concrete subclasses,
        // emit a comment listing alternative variants.
        if field.seen_classes.len() > 1 && field.list_items.is_empty() && field.map_entries.is_empty() {
            let alt_names: Vec<String> = field
                .seen_classes
                .iter()
                .filter_map(|&ch| resolve_name(ch, provider))
                .collect();
            if !alt_names.is_empty() {
                let _ = writeln!(
                    out,
                    "{}# {}: pointer variants seen: {}",
                    inner_indent,
                    field_name,
                    alt_names.join(", ")
                );
            }
        }

        write!(out, "{}{}: {} = ", inner_indent, field_name, field.type_str).unwrap();

        if !field.list_items.is_empty() {
            render_container(&field.list_items, schema, provider, visited, indent + 1, out);
        } else if !field.map_entries.is_empty() {
            let entries: Vec<&(BinValue, BinValue)> = field.map_entries.iter().collect();
            render_map_entries(&entries, schema, provider, visited, indent + 1, out);
        } else if let Some(sample) = field.samples.first() {
            render_value(sample, schema, provider, visited, indent + 1, out);
        } else {
            out.push_str("null");
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

    let hash_dir = get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let env_opt = lmdb.get_env(&hash_dir);

    let mut schema: HashMap<u32, ClassSchema> = HashMap::new();
    let mut entries_by_class: HashMap<u32, Vec<EntrySample>> = HashMap::new();
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
                None => continue,
            };

            let resolved_lower = resolved.to_lowercase();
            if !resolved_lower.ends_with(".bin") {
                continue;
            }

            // Accept both ChampionRoot (Characters/{Champion}/{Champion}.bin) and LinkedData (Skins, Spells, CAC)
            match classify_bin(resolved) {
                BinCategory::LinkedData | BinCategory::ChampionRoot => {}
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

            if linked_samples.len() < LINKED_PATH_SAMPLE_LIMIT {
                for dep in &bin.linked {
                    if linked_samples.len() >= LINKED_PATH_SAMPLE_LIMIT {
                        break;
                    }
                    if !linked_samples.contains(dep) {
                        linked_samples.push(dep.clone());
                    }
                }
            }

            for entry in &bin.entries {
                let entries_list = entries_by_class.entry(entry.class_hash).or_default();
                if !root_class_order.contains(&entry.class_hash) {
                    root_class_order.push(entry.class_hash);
                }
                if entries_list.len() < ENTRY_KEY_LIMIT_PER_CLASS {
                    let key_repr = resolve_entry_key(entry.path_hash, &get_cached_bin_hashes().read());
                    if !entries_list.iter().any(|e| e.key_repr == key_repr) {
                        entries_list.push(EntrySample { key_repr });
                    }
                }

                process_class(entry.class_hash, &entry.fields, &mut schema);
            }

            bins_parsed += 1;
        }
    }

    let provider = get_cached_bin_hashes().read();
    let total_fields: usize = schema.values().map(|c| c.fields.len()).sum();

    let mut output = String::with_capacity(2 * 1024 * 1024);
    use std::fmt::Write;

    let _ = writeln!(output, "# Champion BIN Schema Reference — Flint");
    let _ = writeln!(output, "# Generated: {}", chrono::Utc::now().to_rfc3339());
    let _ = writeln!(
        output,
        "# WADs: {} | Champion BINs parsed: {} | Failed: {}",
        total_wads, bins_parsed, bins_failed
    );
    let _ = writeln!(output, "# Classes: {} | Fields: {}", schema.len(), total_fields);
    let _ = writeln!(
        output,
        "# One sample entry per root class, polymorphic lists collect distinct concrete subclasses."
    );
    let _ = writeln!(output, "#");
    let _ = writeln!(output, "# Format: real ritobin block syntax — copy any block straight into a .ritobin file.");
    let _ = writeln!(output);

    let _ = writeln!(output, "#PROP_text");
    let _ = writeln!(output, "type: string = \"PROP\"");
    let _ = writeln!(output, "version: u32 = 3");

    let _ = writeln!(output, "linked: list[string] = {{");
    for path in &linked_samples {
        let _ = writeln!(output, "    \"{}\"", escape_str(path));
    }
    let _ = writeln!(output, "}}");

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

    let output_path = get_hash_dir()
        .map(|p| {
            p.parent()
                .unwrap_or(&p)
                .join("champion-bin-schema.ritobin")
        })
        .unwrap_or_else(|_| std::path::PathBuf::from("champion-bin-schema.ritobin"));

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

#[cfg(test)]
mod tests {
    use super::*;

    fn field() -> FieldSchema {
        FieldSchema {
            type_str: "list[pointer]".to_string(),
            samples: Vec::new(),
            sample_limit: SAMPLE_LIMIT_COMPLEX,
            seen_classes: Vec::new(),
            list_items: Vec::new(),
            list_classes: HashSet::new(),
            list_classless: 0,
            map_entries: Vec::new(),
            map_classes: HashSet::new(),
            map_classless: 0,
        }
    }

    fn driver_ptr(class: u32) -> BinValue {
        BinValue::Pointer {
            class,
            fields: IndexMap::new(),
        }
    }

    #[test]
    fn polymorphic_list_sampling_keeps_one_sample_per_distinct_class() {
        let mut f = field();
        merge_list_items(
            &mut f,
            &[
                driver_ptr(0x1111), // HasBuff
                driver_ptr(0x1111), // Duplicate HasBuff from same bin
                driver_ptr(0x2222), // CompareSkinId
                driver_ptr(0x3333), // Cooldown
                driver_ptr(0x1111), // Duplicate
            ],
        );

        assert_eq!(f.list_items.len(), 3);
        let classes: Vec<u32> = f
            .list_items
            .iter()
            .filter_map(class_of)
            .collect();
        assert_eq!(classes, vec![0x1111, 0x2222, 0x3333]);
    }

    #[test]
    fn homogeneous_list_collapses_to_single_exemplar() {
        let mut f = field();
        let duplicates: Vec<BinValue> = (0..10).map(|_| driver_ptr(0xaaaa)).collect();
        merge_list_items(&mut f, &duplicates);

        assert_eq!(f.list_items.len(), 1);
    }

    #[test]
    fn multi_bin_driver_aggregation_gathers_all_distinct_classes() {
        let mut f = field();
        // Bin 1: Aatrox (HasBuff)
        merge_list_items(&mut f, &[driver_ptr(0xaaaa)]);
        // Bin 2: Kayn (CompareSkinId, HasBuff)
        merge_list_items(&mut f, &[driver_ptr(0xbbbb), driver_ptr(0xaaaa)]);
        // Bin 3: Zed (NotMaterialDriver)
        merge_list_items(&mut f, &[driver_ptr(0xcccc)]);

        assert_eq!(f.list_items.len(), 3);
        let classes: Vec<u32> = f
            .list_items
            .iter()
            .filter_map(class_of)
            .collect();
        assert_eq!(classes, vec![0xaaaa, 0xbbbb, 0xcccc]);
    }

    #[test]
    fn scalar_list_deduplicates_and_caps() {
        let mut f = field();
        let strings = vec![
            BinValue::String("Aatrox".into()),
            BinValue::String("Aatrox".into()),
            BinValue::String("Kayn".into()),
            BinValue::String("Zed".into()),
            BinValue::String("Yasuo".into()),
        ];
        merge_list_items(&mut f, &strings);

        assert_eq!(f.list_items.len(), SAMPLE_LIMIT_COMPLEX);
        assert_eq!(f.list_items[0], BinValue::String("Aatrox".into()));
        assert_eq!(f.list_items[1], BinValue::String("Kayn".into()));
        assert_eq!(f.list_items[2], BinValue::String("Zed".into()));
    }
}
