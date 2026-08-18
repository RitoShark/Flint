use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::state::LmdbCacheState;
use flint_core::bin::codec::{read_bin, MAX_BIN_SIZE};
use flint_core::bin::get_cached_bin_hashes;
use flint_core::bin::{classify_bin, BinCategory};
use flint_core::bin::{is_blend_key_field, BlendKey};
use flint_core::bin::{BinType, BinValue};
use flint_core::hash::HashMapper;
use flint_core::hash::{get_hash_dir, resolve_hashes_lmdb_bulk, ResolvedHashes};
use flint_core::wad::adapter::WadHandle as WadReader;

const SAMPLE_LIMIT_COMPLEX: usize = 3;
const SAMPLE_LIMIT_SCALAR: usize = 1;
// One sample entry per root class: every entry renders the same aggregated
// class schema, so more keys would just duplicate the identical block.
const ENTRY_KEY_LIMIT_PER_CLASS: usize = 1;
const LINKED_PATH_SAMPLE_LIMIT: usize = 8;
// Map values are sampled by DISTINCT class rather than by position. An animation
// bin's mClipDataMap holds ~64 clips whose first entries are all AtomicClipData,
// so a positional sample would render the same class three times and never show
// SelectorClipData / SequencerClipData / the condition clips at all. Distinctness
// bounds the count on its own — a table of 677 identical TimeBlendData still
// contributes one entry — so this cap only guards a pathological map.
const MAP_CLASS_LIMIT: usize = 12;

// =============================================================================
// Progress / public stats
// =============================================================================

#[derive(Debug, Clone, Serialize)]
struct AnimationSchemaProgress {
    phase: String,
    current: usize,
    total: usize,
    bins_parsed: usize,
    bins_failed: usize,
    classes_found: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnimationSchemaStats {
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
`samples` drives the rendered value for ordinary fields; a map field instead
accumulates `map_entries` — at most one entry per distinct value class, gathered
across ALL bins rather than cloned from whichever bin happened to be read first,
so a clip kind that only one champion uses still reaches the output. */
struct FieldSchema {
    type_str: String,
    samples: Vec<BinValue>,
    sample_limit: usize,
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

/// The class a pointer/embed value instantiates, if it is one and is not null.
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
        if field.samples.len() < field.sample_limit {
            field.samples.push(value.clone());
        }
        if let BinValue::Map { entries, .. } = value {
            merge_map_entries(field, entries);
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

/** Keeps the first entry seen for each distinct value class, so one map renders one
example of every class that can appear in it. Entries whose value carries no class
(a `map[hash,f32]`, say) have nothing to be diverse about and fall back to a
positional sample. */
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

/** Renders one `mBlendDataTable` key. The `u64` is not a number but two FNV1a-32
clip hashes packed into one word, so printing it as an integer would be noise —
`rs_bin`'s own text printer spells it `"from" -> "to"` and this matches. */
fn render_blend_key(key: u64, provider: &HashMapper, out: &mut String) {
    use std::fmt::Write;

    let blend = BlendKey::from_u64(key);
    let half = |h: u32| match resolve_name(h, provider) {
        Some(name) => format!("\"{}\"", escape_str(&name)),
        None => format!("0x{:08x}", h),
    };
    write!(out, "{} -> {}", half(blend.from), half(blend.to)).unwrap();
}

fn render_value(
    value: &BinValue,
    field_hash: u32,
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
            render_container(items, field_hash, schema, provider, visited, indent, out);
        }
        BinValue::Map { entries, .. } => {
            let sampled: Vec<&(BinValue, BinValue)> =
                entries.iter().take(SAMPLE_LIMIT_COMPLEX).collect();
            render_map(&sampled, field_hash, schema, provider, visited, indent, out);
        }
        BinValue::Option { value: inner, .. } => match inner {
            Some(boxed) => render_value(boxed, field_hash, schema, provider, visited, indent, out),
            None => out.push_str("null"),
        },
    }
}

fn render_container(
    items: &[BinValue],
    field_hash: u32,
    schema: &HashMap<u32, ClassSchema>,
    provider: &HashMapper,
    visited: &mut HashSet<u32>,
    indent: usize,
    out: &mut String,
) {
    use std::fmt::Write;

    let limit = SAMPLE_LIMIT_COMPLEX;
    let items: Vec<&BinValue> = items.iter().take(limit).collect();

    if items.is_empty() {
        out.push_str("{}");
        return;
    }

    let all_scalar = items.iter().all(|&it| is_scalar_value(it));
    if all_scalar && items.len() <= 4 {
        out.push_str("{ ");
        for (i, it) in items.iter().enumerate() {
            if i > 0 {
                out.push_str(", ");
            }
            render_value(it, field_hash, schema, provider, visited, indent, out);
        }
        out.push_str(" }");
        return;
    }

    out.push_str("{\n");
    let inner_indent = indent_str(indent + 1);
    for it in items.iter() {
        out.push_str(&inner_indent);
        render_value(it, field_hash, schema, provider, visited, indent + 1, out);
        out.push('\n');
    }
    write!(out, "{}}}", indent_str(indent)).unwrap();
}

fn render_map(
    entries: &[&(BinValue, BinValue)],
    field_hash: u32,
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

    let blend_keys = is_blend_key_field(field_hash);

    out.push_str("{\n");
    let inner_indent = indent_str(indent + 1);
    for (k, v) in entries.iter() {
        out.push_str(&inner_indent);
        match (blend_keys, k) {
            (true, BinValue::U64(raw)) => render_blend_key(*raw, provider, out),
            _ => render_value(k, field_hash, schema, provider, visited, indent + 1, out),
        }
        out.push_str(" = ");
        render_value(v, field_hash, schema, provider, visited, indent + 1, out);
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
        let field_name =
            resolve_name(*name_hash, provider).unwrap_or_else(|| format!("0x{:08x}", name_hash));
        write!(out, "{}{}: {} = ", inner_indent, field_name, field.type_str).unwrap();
        if !field.map_entries.is_empty() {
            let entries: Vec<&(BinValue, BinValue)> = field.map_entries.iter().collect();
            render_map(
                &entries,
                *name_hash,
                schema,
                provider,
                visited,
                indent + 1,
                out,
            );
        } else if let Some(sample) = field.samples.first() {
            render_value(
                sample,
                *name_hash,
                schema,
                provider,
                visited,
                indent + 1,
                out,
            );
        } else {
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
pub async fn aggregate_animation_bin_schema(
    app: AppHandle,
    league_path: String,
    lmdb: tauri::State<'_, LmdbCacheState>,
) -> Result<AnimationSchemaStats, String> {
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
    tracing::info!("Animation schema: scanning {} WADs", total_wads);

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
            "animation-schema-progress",
            AnimationSchemaProgress {
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
                tracing::warn!("Animation schema: failed to open {}: {}", wad_path, e);
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

            match classify_bin(resolved) {
                BinCategory::Animation => {}
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
                    let key_repr =
                        resolve_entry_key(entry.path_hash, &get_cached_bin_hashes().read());
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

    let mut output = String::with_capacity(256 * 1024);
    use std::fmt::Write;

    // `#` is ritobin's comment marker — the parser skips these lines, so the
    // file opens in the BIN editor like any other ritobin text. `//` is NOT
    // valid ritobin and would make the whole file unparseable.
    let _ = writeln!(output, "# Animation BIN Schema Reference — Flint");
    let _ = writeln!(output, "# Generated: {}", chrono::Utc::now().to_rfc3339());
    let _ = writeln!(
        output,
        "# WADs: {} | Animation BINs parsed: {} | Failed: {}",
        total_wads, bins_parsed, bins_failed
    );
    let _ = writeln!(
        output,
        "# Classes: {} | Fields: {}",
        schema.len(),
        total_fields
    );
    let _ = writeln!(
        output,
        "# Each class block is a SUPERSET: every field any instance of that class carried,"
    );
    let _ = writeln!(
        output,
        "# merged across every animation BIN in the install. No single real instance has them all."
    );
    let _ = writeln!(
        output,
        "# Maps sample one entry per DISTINCT value class (up to {}), so mClipDataMap shows",
        MAP_CLASS_LIMIT
    );
    let _ = writeln!(
        output,
        "# one of each clip kind and mEventDataMap one of each event kind."
    );
    let _ = writeln!(
        output,
        "# mBlendDataTable keys are two packed FNV1a clip hashes, printed as \"from\" -> \"to\"."
    );
    let _ = writeln!(output, "#");
    let _ = writeln!(
        output,
        "# Format: real ritobin block syntax — copy any block straight into a .ritobin file."
    );
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
        let class_name =
            resolve_name(*class_hash, &provider).unwrap_or_else(|| format!("0x{:08x}", class_hash));
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
                .join("animation-bin-schema.ritobin")
        })
        .unwrap_or_else(|_| std::path::PathBuf::from("animation-bin-schema.ritobin"));

    std::fs::write(&output_path, &output)
        .map_err(|e| format!("Failed to write schema file: {}", e))?;

    tracing::info!(
        "Animation schema complete: {} classes, {} fields, {} BINs from {} WADs → {}",
        schema.len(),
        total_fields,
        bins_parsed,
        total_wads,
        output_path.display()
    );

    let _ = app.emit(
        "animation-schema-progress",
        AnimationSchemaProgress {
            phase: "complete".to_string(),
            current: total_wads,
            total: total_wads,
            bins_parsed,
            bins_failed,
            classes_found: schema.len(),
        },
    );

    Ok(AnimationSchemaStats {
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
    use flint_core::bin::BLEND_DATA_TABLE;

    fn field() -> FieldSchema {
        FieldSchema {
            type_str: "map[hash,pointer]".to_string(),
            samples: Vec::new(),
            sample_limit: SAMPLE_LIMIT_COMPLEX,
            map_entries: Vec::new(),
            map_classes: HashSet::new(),
            map_classless: 0,
        }
    }

    fn clip(class: u32) -> BinValue {
        BinValue::Pointer {
            class,
            fields: IndexMap::new(),
        }
    }

    fn entry(key: u32, class: u32) -> (BinValue, BinValue) {
        (BinValue::Hash(key), clip(class))
    }

    #[test]
    fn map_sampling_keeps_one_entry_per_distinct_class() {
        let mut f = field();
        merge_map_entries(
            &mut f,
            &[
                entry(1, 0xaaaa),
                entry(2, 0xaaaa),
                entry(3, 0xbbbb),
                entry(4, 0xaaaa),
                entry(5, 0xcccc),
            ],
        );

        assert_eq!(f.map_entries.len(), 3);
        let classes: Vec<u32> = f
            .map_entries
            .iter()
            .filter_map(|(_, v)| class_of(v))
            .collect();
        assert_eq!(classes, vec![0xaaaa, 0xbbbb, 0xcccc]);
    }

    #[test]
    fn map_sampling_collapses_a_uniform_map_to_one_entry() {
        let mut f = field();
        let uniform: Vec<(BinValue, BinValue)> = (0..677).map(|i| entry(i, 0xdddd)).collect();
        merge_map_entries(&mut f, &uniform);

        assert_eq!(f.map_entries.len(), 1);
    }

    #[test]
    fn map_sampling_merges_across_separate_bins() {
        let mut f = field();
        merge_map_entries(&mut f, &[entry(1, 0xaaaa)]);
        merge_map_entries(&mut f, &[entry(2, 0xaaaa), entry(3, 0xbbbb)]);

        let classes: Vec<u32> = f
            .map_entries
            .iter()
            .filter_map(|(_, v)| class_of(v))
            .collect();
        assert_eq!(classes, vec![0xaaaa, 0xbbbb]);
    }

    #[test]
    fn map_sampling_caps_classless_values_positionally() {
        let mut f = field();
        let scalars: Vec<(BinValue, BinValue)> = (0..20)
            .map(|i| (BinValue::Hash(i), BinValue::F32(i as f32)))
            .collect();
        merge_map_entries(&mut f, &scalars);

        assert_eq!(f.map_entries.len(), SAMPLE_LIMIT_COMPLEX);
    }

    #[test]
    fn map_sampling_honours_the_class_cap() {
        let mut f = field();
        let many: Vec<(BinValue, BinValue)> = (0..40).map(|i| entry(i, 0x1000 + i)).collect();
        merge_map_entries(&mut f, &many);

        assert_eq!(f.map_entries.len(), MAP_CLASS_LIMIT);
    }

    #[test]
    fn blend_key_renders_resolved_halves_as_a_transition() {
        let mut provider = HashMapper::new();
        provider.insert(0x1111_1111, "Run");
        provider.insert(0x2222_2222, "Death");

        let mut out = String::new();
        render_blend_key(
            BlendKey {
                from: 0x1111_1111,
                to: 0x2222_2222,
            }
            .to_u64(),
            &provider,
            &mut out,
        );

        assert_eq!(out, "\"Run\" -> \"Death\"");
    }

    #[test]
    fn blend_key_falls_back_per_half() {
        let mut provider = HashMapper::new();
        provider.insert(0x1111_1111, "Run");

        let mut out = String::new();
        render_blend_key(
            BlendKey {
                from: 0x1111_1111,
                to: 0x2222_2222,
            }
            .to_u64(),
            &provider,
            &mut out,
        );

        assert_eq!(out, "\"Run\" -> 0x22222222");
    }

    #[test]
    fn only_the_blend_table_field_gets_transition_keys() {
        let provider = HashMapper::new();
        let schema: HashMap<u32, ClassSchema> = HashMap::new();
        let raw = BlendKey {
            from: 0x1111_1111,
            to: 0x2222_2222,
        }
        .to_u64();
        let pair = (BinValue::U64(raw), BinValue::F32(1.0));
        let entries = vec![&pair];

        // A plain map[u64,f32] keeps integer keys.
        let mut out = String::new();
        let mut visited = HashSet::new();
        render_map(
            &entries,
            0xdead_beef,
            &schema,
            &provider,
            &mut visited,
            0,
            &mut out,
        );
        assert!(out.contains(&raw.to_string()));
        assert!(!out.contains("->"));

        let mut blend_out = String::new();
        let mut blend_visited = HashSet::new();
        render_map(
            &entries,
            BLEND_DATA_TABLE,
            &schema,
            &provider,
            &mut blend_visited,
            0,
            &mut blend_out,
        );
        assert!(blend_out.contains("0x11111111 -> 0x22222222"));
    }
}
