use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::state::LmdbCacheState;
use flint_ltk::bin::ltk_bridge::{get_cached_bin_hashes, read_bin, MAX_BIN_SIZE};
use flint_ltk::bin::{classify_bin, BinCategory};
use flint_ltk::hash::{get_hash_dir, resolve_hashes_lmdb_bulk, ResolvedHashes};
use flint_ltk::ltk_types::HashMapper;
use flint_ltk::ltk_types::{BinType, BinValue};
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
    samples: Vec<BinValue>,
    sample_limit: usize,
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
    }

    let mut nested: Vec<(u32, IndexMap<u32, BinValue>)> = Vec::new();
    for value in fields.values() {
        collect_nested(value, &mut nested);
    }
    for (ch, props) in nested {
        process_class(ch, &props, schema);
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
            render_map(entries, schema, provider, visited, indent, out);
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

    let limit = SAMPLE_LIMIT_COMPLEX;
    let items: Vec<&BinValue> = items.iter().take(limit).collect();

    if items.is_empty() {
        out.push_str("{}");
        return;
    }

    let all_scalar = items.iter().all(|it| is_scalar_value(it));
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

fn render_map(
    entries: &[(BinValue, BinValue)],
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
        write!(out, "{}{}: {} = ", inner_indent, field_name, field.type_str).unwrap();
        if let Some(sample) = field.samples.first() {
            render_value(sample, schema, provider, visited, indent + 1, out);
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

            if resolved_lower.ends_with("/root.bin") || resolved_lower == "root.bin" {
                continue;
            }

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
