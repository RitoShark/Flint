use std::collections::HashMap;

use indexmap::IndexMap;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use flint_ltk::bin::ltk_bridge::{get_cached_bin_hashes, read_bin, MAX_BIN_SIZE};
use flint_ltk::hash::{get_hash_dir, resolve_hashes_lmdb_bulk, ResolvedHashes};
use flint_ltk::wad_jade::adapter::WadHandle as WadReader;
use crate::state::LmdbCacheState;

use flint_ltk::ltk_types::{BinType, BinValue};
use flint_ltk::ltk_types::HashMapper;

// =============================================================================
// Schema data structures
// =============================================================================

#[derive(Debug, Clone, Serialize)]
struct SchemaProgress {
    phase: String,
    current: usize,
    total: usize,
    bins_parsed: usize,
    bins_failed: usize,
    classes_found: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SchemaStats {
    pub wads_scanned: usize,
    pub bins_parsed: usize,
    pub bins_failed: usize,
    pub classes_found: usize,
    pub total_fields: usize,
    pub output_path: String,
}

/// Internal representation during aggregation
struct ClassSchema {
    class_hash: u32,
    fields: HashMap<u32, FieldSchema>,
}

struct FieldSchema {
    name_hash: u32,
    types: Vec<String>,
    nested_class_hash: Option<u32>,
    occurrences: u32,
    value_range: ValueRange,
}

// =============================================================================
// Value range tracking (min/max across all BINs)
// =============================================================================

enum ValueRange {
    None,
    Bool(bool, bool),            // (seen_true, seen_false)
    Int(i64, i64),               // min, max
    Float(f64, f64),             // min, max
    Vec2([f64; 2], [f64; 2]),    // min[x,y], max[x,y]
    Vec3([f64; 3], [f64; 3]),    // min[x,y,z], max[x,y,z]
    Vec4([f64; 4], [f64; 4]),    // min[x,y,z,w], max[x,y,z,w]
    Color([u8; 4], [u8; 4]),     // min[r,g,b,a], max[r,g,b,a]
}

impl ValueRange {
    fn merge(&mut self, other: &ValueRange) {
        match (self, other) {
            (ValueRange::Bool(st, sf), ValueRange::Bool(ot, of)) => {
                *st = *st || *ot;
                *sf = *sf || *of;
            }
            (ValueRange::Int(smin, smax), ValueRange::Int(omin, omax)) => {
                *smin = (*smin).min(*omin);
                *smax = (*smax).max(*omax);
            }
            (ValueRange::Float(smin, smax), ValueRange::Float(omin, omax)) => {
                *smin = smin.min(*omin);
                *smax = smax.max(*omax);
            }
            (ValueRange::Vec2(smin, smax), ValueRange::Vec2(omin, omax)) => {
                for i in 0..2 { smin[i] = smin[i].min(omin[i]); smax[i] = smax[i].max(omax[i]); }
            }
            (ValueRange::Vec3(smin, smax), ValueRange::Vec3(omin, omax)) => {
                for i in 0..3 { smin[i] = smin[i].min(omin[i]); smax[i] = smax[i].max(omax[i]); }
            }
            (ValueRange::Vec4(smin, smax), ValueRange::Vec4(omin, omax)) => {
                for i in 0..4 { smin[i] = smin[i].min(omin[i]); smax[i] = smax[i].max(omax[i]); }
            }
            (ValueRange::Color(smin, smax), ValueRange::Color(omin, omax)) => {
                for i in 0..4 { smin[i] = smin[i].min(omin[i]); smax[i] = smax[i].max(omax[i]); }
            }
            _ => {}
        }
    }
}

fn extract_range(value: &BinValue) -> ValueRange {
    match value {
        BinValue::Bool(b) => ValueRange::Bool(*b, !*b),
        BinValue::Flag(b) => ValueRange::Bool(*b, !*b),
        BinValue::I8(n) => ValueRange::Int(*n as i64, *n as i64),
        BinValue::U8(n) => ValueRange::Int(*n as i64, *n as i64),
        BinValue::I16(n) => ValueRange::Int(*n as i64, *n as i64),
        BinValue::U16(n) => ValueRange::Int(*n as i64, *n as i64),
        BinValue::I32(n) => ValueRange::Int(*n as i64, *n as i64),
        BinValue::U32(n) => ValueRange::Int(*n as i64, *n as i64),
        BinValue::I64(n) => ValueRange::Int(*n, *n),
        BinValue::U64(n) => ValueRange::Int(*n as i64, *n as i64),
        BinValue::F32(n) => ValueRange::Float(*n as f64, *n as f64),
        BinValue::Vec2(a) => {
            let a = [a[0] as f64, a[1] as f64];
            ValueRange::Vec2(a, a)
        }
        BinValue::Vec3(a) => {
            let a = [a[0] as f64, a[1] as f64, a[2] as f64];
            ValueRange::Vec3(a, a)
        }
        BinValue::Vec4(a) => {
            let a = [a[0] as f64, a[1] as f64, a[2] as f64, a[3] as f64];
            ValueRange::Vec4(a, a)
        }
        BinValue::Rgba(a) => {
            let a = [a[0], a[1], a[2], a[3]];
            ValueRange::Color(a, a)
        }
        _ => ValueRange::None,
    }
}

// =============================================================================
// Type description helpers
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

/// Returns (ritobin-style type_string, optional nested class_hash).
///
/// For embed/pointer: type_str is "embed" or "pointer", nested class from the struct itself.
/// For list/list2/map/option containing embed/pointer: nested class from first item with a class.
fn describe_value(value: &BinValue) -> (String, Option<u32>) {
    match value {
        BinValue::Pointer { class, .. } => ("pointer".to_string(), Some(*class)),
        BinValue::Embed { class, .. } => ("embed".to_string(), Some(*class)),
        BinValue::List {
            is_list2,
            item,
            items,
        } => {
            let item_type = kind_str(*item);
            let nested = find_nested_class_in_container(items);
            if *is_list2 {
                (format!("list2[{}]", item_type), nested)
            } else {
                (format!("list[{}]", item_type), nested)
            }
        }
        BinValue::Map {
            key,
            value,
            entries,
        } => {
            let key_type = kind_str(*key);
            let val_type = kind_str(*value);
            let nested = entries.iter().find_map(|(_k, v)| nested_class_of(v));
            (format!("map[{}, {}]", key_type, val_type), nested)
        }
        BinValue::Option { item, value: inner } => {
            let inner_type = kind_str(*item);
            let nested = inner.as_deref().and_then(nested_class_of);
            (format!("option[{}]", inner_type), nested)
        }
        other => (kind_str(other.ty()).to_string(), None),
    }
}

/// Returns the class hash if `v` is a `Pointer`/`Embed` with a nonzero class.
fn nested_class_of(v: &BinValue) -> Option<u32> {
    match v {
        BinValue::Pointer { class, .. } | BinValue::Embed { class, .. } if *class != 0 => {
            Some(*class)
        }
        _ => None,
    }
}

/// Helper to find the first nested class hash among a container's items.
fn find_nested_class_in_container(items: &[BinValue]) -> Option<u32> {
    items.iter().find_map(nested_class_of)
}

// =============================================================================
// Schema processing (recursive)
// =============================================================================

fn process_properties(
    class_hash: u32,
    fields: &IndexMap<u32, BinValue>,
    schema: &mut HashMap<u32, ClassSchema>,
) {
    let class = schema.entry(class_hash).or_insert_with(|| ClassSchema {
        class_hash,
        fields: HashMap::new(),
    });

    for (name_hash, value) in fields.iter() {
        let (type_str, nested_class_hash) = describe_value(value);

        let range = extract_range(value);

        let field = class.fields.entry(*name_hash).or_insert_with(|| FieldSchema {
            name_hash: *name_hash,
            types: Vec::new(),
            nested_class_hash: None,
            occurrences: 0,
            value_range: ValueRange::None,
        });

        if !field.types.contains(&type_str) {
            field.types.push(type_str);
        }

        if field.nested_class_hash.is_none() {
            field.nested_class_hash = nested_class_hash;
        }

        // Merge value range (expand min/max bounds)
        if matches!(field.value_range, ValueRange::None) {
            field.value_range = range;
        } else {
            field.value_range.merge(&range);
        }

        field.occurrences += 1;
    }

    // Second pass: recurse into complex types (separate to avoid borrow conflict)
    let recurse_targets: Vec<_> = fields
        .values()
        .filter_map(|value| match value {
            BinValue::Pointer { class, fields } | BinValue::Embed { class, fields }
                if *class != 0 =>
            {
                Some((*class, fields.clone()))
            }
            _ => None,
        })
        .collect();

    for (ch, props) in recurse_targets {
        process_properties(ch, &props, schema);
    }

    // Recurse into List/Map/Option container items
    for value in fields.values() {
        recurse_container_items(value, schema);
    }
}

fn recurse_container_items(value: &BinValue, schema: &mut HashMap<u32, ClassSchema>) {
    match value {
        BinValue::List { items, .. } => {
            process_nested_struct_items(items.iter(), schema);
        }
        BinValue::Map { entries, .. } => {
            process_nested_struct_items(entries.iter().map(|(_k, v)| v), schema);
        }
        BinValue::Option {
            value: Some(inner), ..
        } => {
            process_nested_struct_items(std::iter::once(inner.as_ref()), schema);
        }
        _ => {}
    }
}

/// Processes each `Pointer`/`Embed` (with nonzero class) in an iterator of values.
fn process_nested_struct_items<'a, I>(items: I, schema: &mut HashMap<u32, ClassSchema>)
where
    I: Iterator<Item = &'a BinValue>,
{
    for item in items {
        match item {
            BinValue::Pointer { class, fields } | BinValue::Embed { class, fields }
                if *class != 0 =>
            {
                process_properties(*class, &fields.clone(), schema);
            }
            _ => {}
        }
    }
}

fn resolve_hash_name(hash: u32, bin_hashes: &HashMapper) -> Option<String> {
    bin_hashes.get(hash as u64).map(|name| name.to_string())
}

// =============================================================================
// Range formatting for ritobin-style output
// =============================================================================

fn fmt_f(v: f64) -> String {
    // Show up to 3 decimal places, trimming trailing zeros but keeping at least one
    let s = format!("{:.3}", v);
    let s = s.trim_end_matches('0');
    let s = s.trim_end_matches('.');
    s.to_string()
}

fn fmt_range_f(min: f64, max: f64) -> String {
    if (min - max).abs() < 1e-6 { fmt_f(min) } else { format!("{}..{}", fmt_f(min), fmt_f(max)) }
}

fn fmt_range_i(min: i64, max: i64) -> String {
    if min == max { format!("{}", min) } else { format!("{}..{}", min, max) }
}

fn format_range(range: &ValueRange, type_str: &str) -> String {
    match range {
        ValueRange::Bool(t, f) => {
            match (*t, *f) {
                (true, true) => "true | false".to_string(),
                (true, false) => "true".to_string(),
                (false, true) => "false".to_string(),
                _ => "false".to_string(),
            }
        }
        ValueRange::Int(min, max) => fmt_range_i(*min, *max),
        ValueRange::Float(min, max) => fmt_range_f(*min, *max),
        ValueRange::Vec2(min, max) => {
            format!("{{ {}, {} }}", fmt_range_f(min[0], max[0]), fmt_range_f(min[1], max[1]))
        }
        ValueRange::Vec3(min, max) => {
            format!("{{ {}, {}, {} }}",
                fmt_range_f(min[0], max[0]), fmt_range_f(min[1], max[1]), fmt_range_f(min[2], max[2]))
        }
        ValueRange::Vec4(min, max) => {
            format!("{{ {}, {}, {}, {} }}",
                fmt_range_f(min[0], max[0]), fmt_range_f(min[1], max[1]),
                fmt_range_f(min[2], max[2]), fmt_range_f(min[3], max[3]))
        }
        ValueRange::Color(min, max) => {
            let fmt = |i: usize| -> String {
                if min[i] == max[i] { format!("{}", min[i]) } else { format!("{}..{}", min[i], max[i]) }
            };
            format!("{{ {}, {}, {}, {} }}", fmt(0), fmt(1), fmt(2), fmt(3))
        }
        ValueRange::None => {
            // Fallback based on type
            if type_str == "string" { "\"...\"".to_string() }
            else if type_str == "hash" || type_str == "link" || type_str == "file" { "0x...".to_string() }
            else if type_str.starts_with("list") || type_str.starts_with("map") || type_str.starts_with("option") { "{}".to_string() }
            else { "...".to_string() }
        }
    }
}

// =============================================================================
// Main Tauri command
// =============================================================================

#[tauri::command]
pub async fn aggregate_bin_schema(
    app: AppHandle,
    league_path: String,
    lmdb: tauri::State<'_, LmdbCacheState>,
) -> Result<SchemaStats, String> {
    let game_path = std::path::Path::new(&league_path).join("Game");
    let data_path = game_path.join("DATA").join("FINAL");

    if !data_path.exists() {
        return Err(format!(
            "WAD directory not found: {} — make sure this is the League installation folder",
            data_path.display()
        ));
    }

    // 1. Scan all WAD files
    let wad_paths: Vec<String> = WalkDir::new(&data_path)
        .max_depth(5)
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
    tracing::info!("Schema aggregator: found {} WADs to scan", total_wads);

    // 2. Get hash resolution resources
    let hash_dir = get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let env_opt = lmdb.get_env(&hash_dir);

    // 3. Process all WADs
    let mut schema: HashMap<u32, ClassSchema> = HashMap::new();
    let mut bins_parsed: usize = 0;
    let mut bins_failed: usize = 0;

    for (wad_idx, wad_path) in wad_paths.iter().enumerate() {
        // Emit progress every WAD
        let _ = app.emit("schema-progress", SchemaProgress {
            phase: "scanning".to_string(),
            current: wad_idx + 1,
            total: total_wads,
            bins_parsed,
            bins_failed,
            classes_found: schema.len(),
        });

        // Open WAD
        let mut reader = match WadReader::open(wad_path) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("Failed to open WAD {}: {}", wad_path, e);
                continue;
            }
        };

        // Resolve chunk hashes to find .bin files
        let chunks: Vec<_> = reader.chunks().iter().cloned().collect();
        let hash_u64s: Vec<u64> = chunks.iter().map(|c| c.path_hash).collect();

        let resolved_map: ResolvedHashes = if let Some(ref env) = env_opt {
            resolve_hashes_lmdb_bulk(&hash_u64s, env)
        } else {
            ResolvedHashes::default()
        };

        // Process each chunk
        for chunk in &chunks {
            let path_hash = chunk.path_hash;

            // Check if this chunk is a .bin file
            let is_bin = resolved_map
                .get(&path_hash)
                .map(|p| p.to_lowercase().ends_with(".bin"))
                .unwrap_or(false);

            if !is_bin {
                // For unresolved hashes, try magic byte detection
                if resolved_map.contains_key(&path_hash) {
                    continue; // resolved but not .bin
                }

                let data = match reader.wad_mut().load_chunk_decompressed(chunk) {
                    Ok(d) => d,
                    Err(_) => continue,
                };

                if data.len() < 4 || (&data[..4] != b"PROP" && &data[..4] != b"PTCH") {
                    continue;
                }

                // It has BIN magic — parse it
                if data.len() <= MAX_BIN_SIZE {
                    match read_bin(&data) {
                        Ok(bin) => {
                            for entry in &bin.entries {
                                process_properties(entry.class_hash, &entry.fields, &mut schema);
                            }
                            bins_parsed += 1;
                        }
                        Err(_) => {
                            bins_failed += 1;
                        }
                    }
                }
                continue;
            }

            // Decompress and parse the known .bin chunk
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

            match read_bin(&data) {
                Ok(bin) => {
                    for entry in &bin.entries {
                        process_properties(entry.class_hash, &entry.fields, &mut schema);
                    }
                    bins_parsed += 1;
                }
                Err(_) => {
                    bins_failed += 1;
                }
            }
        }
    }

    // 4. Build ritobin-style text output
    let bin_hashes = get_cached_bin_hashes().read();
    let total_fields: usize = schema.values().map(|c| c.fields.len()).sum();

    // Sort classes by field count (most fields first)
    let mut classes: Vec<&ClassSchema> = schema.values().collect();
    classes.sort_by(|a, b| b.fields.len().cmp(&a.fields.len()));

    let mut output = String::with_capacity(2 * 1024 * 1024);

    // Header
    use std::fmt::Write;
    let _ = writeln!(output, "// BIN Schema Reference — Flint");
    let _ = writeln!(output, "// Generated: {}", chrono::Utc::now().to_rfc3339());
    let _ = writeln!(
        output,
        "// WADs scanned: {} | BINs parsed: {} | Failed: {}",
        total_wads, bins_parsed, bins_failed
    );
    let _ = writeln!(
        output,
        "// Classes: {} | Fields: {}",
        schema.len(), total_fields
    );

    for class in &classes {
        let class_name = resolve_hash_name(class.class_hash, &bin_hashes)
            .unwrap_or_else(|| format!("0x{:08X}", class.class_hash));

        let _ = writeln!(output);
        let _ = writeln!(output, "// {} (0x{:08X})", class_name, class.class_hash);
        let _ = writeln!(output, "{} {{", class_name);

        // Sort fields by occurrences (most common first)
        let mut fields: Vec<&FieldSchema> = class.fields.values().collect();
        fields.sort_by(|a, b| b.occurrences.cmp(&a.occurrences));

        for field in &fields {
            let field_name = resolve_hash_name(field.name_hash, &bin_hashes)
                .unwrap_or_else(|| format!("0x{:08X}", field.name_hash));

            let type_str = field.types.first().map(|s| s.as_str()).unwrap_or("?");

            if let Some(nested_hash) = field.nested_class_hash {
                let nested_name = resolve_hash_name(nested_hash, &bin_hashes)
                    .unwrap_or_else(|| format!("0x{:08X}", nested_hash));

                if type_str == "embed" || type_str == "pointer" {
                    let _ = writeln!(output, "    {}: {} = {} {{}}", field_name, type_str, nested_name);
                } else if type_str.starts_with("list") || type_str.starts_with("option") {
                    let _ = writeln!(output, "    {}: {} = {{ {} {{}} }}", field_name, type_str, nested_name);
                } else {
                    let _ = writeln!(output, "    {}: {} = {{}}", field_name, type_str);
                }
            } else {
                // Format with value range
                let val = format_range(&field.value_range, type_str);
                let _ = writeln!(output, "    {}: {} = {}", field_name, type_str, val);
            }
        }

        let _ = writeln!(output, "}}");
    }

    let output_path = get_hash_dir()
        .map(|p| {
            p.parent()
                .unwrap_or(&p)
                .join("bin-schema.txt")
        })
        .unwrap_or_else(|_| std::path::PathBuf::from("bin-schema.txt"));

    std::fs::write(&output_path, &output)
        .map_err(|e| format!("Failed to write schema file: {}", e))?;

    tracing::info!(
        "Schema aggregation complete: {} classes, {} fields, {} BINs from {} WADs. Output: {}",
        schema.len(), total_fields, bins_parsed, total_wads, output_path.display()
    );

    let _ = app.emit("schema-progress", SchemaProgress {
        phase: "complete".to_string(),
        current: total_wads,
        total: total_wads,
        bins_parsed,
        bins_failed,
        classes_found: schema.len(),
    });

    Ok(SchemaStats {
        wads_scanned: total_wads,
        bins_parsed,
        bins_failed,
        classes_found: schema.len(),
        total_fields,
        output_path: output_path.to_string_lossy().to_string(),
    })
}
