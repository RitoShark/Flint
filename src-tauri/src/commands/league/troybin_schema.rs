//! Troybin Schema Aggregator
//!
//! Walks every WAD under the League installation's `DATA/FINAL/`, parses
//! `.troybin` chunks, and writes an INI-like schema file.

use std::collections::BTreeMap;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::state::LmdbCacheState;
use flint_core::hash::{get_hash_dir, resolve_hashes_lmdb_bulk, ResolvedHashes};
use flint_core::troybin::parse_troybin;
use flint_core::wad_jade::adapter::WadHandle as WadReader;

// =============================================================================
// Progress / public stats
// =============================================================================

#[derive(Debug, Clone, Serialize)]
struct TroybinSchemaProgress {
    phase: String,
    current: usize,
    total: usize,
    bins_parsed: usize,
    bins_failed: usize,
    classes_found: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct TroybinSchemaStats {
    pub wads_scanned: usize,
    pub bins_parsed: usize,
    pub bins_failed: usize,
    pub classes_found: usize,
    pub total_fields: usize,
    pub output_path: String,
}

// =============================================================================
// Helpers
// =============================================================================

fn is_troybin_path(resolved: &str) -> bool {
    resolved.to_lowercase().ends_with(".troybin")
}

// =============================================================================
// Tauri command
// =============================================================================

#[tauri::command]
pub async fn aggregate_troybin_schema(
    app: AppHandle,
    league_path: String,
    lmdb: tauri::State<'_, LmdbCacheState>,
) -> Result<TroybinSchemaStats, String> {
    let game_path = std::path::Path::new(&league_path).join("Game");
    let data_path = game_path.join("DATA").join("FINAL");

    if !data_path.exists() {
        return Err(format!(
            "DATA/FINAL directory not found: {} — make sure this is the League installation folder",
            data_path.display()
        ));
    }

    let output_path_buf = get_hash_dir()
        .map(|p| p.parent().unwrap_or(&p).join("troybin-schema.ini"))
        .unwrap_or_else(|_| std::path::PathBuf::from("troybin-schema.ini"));

    let output_path = output_path_buf.to_string_lossy().into_owned();

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
    tracing::info!("Troybin schema aggregator: scanning {} WADs", total_wads);

    let mut bins_parsed = 0;
    let mut bins_failed = 0;

    let mut schema: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();

    let emit_progress = |app: &AppHandle, current: usize, parsed: usize, failed: usize, classes: usize| {
        let _ = app.emit(
            "troybin-schema-progress",
            TroybinSchemaProgress {
                phase: "Scanning WADs".into(),
                current,
                total: total_wads,
                bins_parsed: parsed,
                bins_failed: failed,
                classes_found: classes,
            },
        );
    };

    let hash_dir = get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let env_opt = lmdb.get_env(&hash_dir);

    for (i, wad_path) in wad_paths.iter().enumerate() {
        if i % 5 == 0 {
            emit_progress(&app, i, bins_parsed, bins_failed, schema.len());
        }

        let mut reader = match WadReader::open(wad_path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let chunks: Vec<_> = reader.chunks().iter().cloned().collect();
        let chunk_hashes: Vec<u64> = chunks.iter().map(|c| c.path_hash).collect();
        let resolved_hashes: ResolvedHashes = if let Some(ref env) = env_opt {
            resolve_hashes_lmdb_bulk(&chunk_hashes, env)
        } else {
            ResolvedHashes::default()
        };

        for chunk in &chunks {
            let path_hash = chunk.path_hash;
            let resolved = match resolved_hashes.get(&path_hash) {
                Some(p) => p,
                None => continue,
            };

            if !is_troybin_path(resolved) {
                continue;
            }

            let data = match reader.wad_mut().load_chunk_decompressed(chunk) {
                Ok(d) => d,
                Err(_) => {
                    bins_failed += 1;
                    continue;
                }
            };

            match parse_troybin(&data) {
                Ok(fixed) => {
                    for group in fixed.values {
                        let group_map = schema.entry(group.name).or_default();
                        for prop in group.properties {
                            group_map.insert(prop.name, prop.value.format_value());
                        }
                    }
                    bins_parsed += 1;
                }
                Err(_) => {
                    bins_failed += 1;
                }
            }
        }
    }

    emit_progress(&app, total_wads, bins_parsed, bins_failed, schema.len());

    let mut out_text = String::new();
    let mut total_fields = 0;

    for (group_name, properties) in &schema {
        out_text.push_str(&format!("[{}]\r\n", group_name));
        for (prop_name, val_str) in properties {
            out_text.push_str(&format!("{}={}\r\n", prop_name, val_str));
            total_fields += 1;
        }
        out_text.push_str("\r\n");
    }

    std::fs::write(&output_path_buf, out_text)
        .map_err(|e| format!("Failed to write schema file: {}", e))?;

    tracing::info!(
        "Troybin schema complete: {} classes, {} fields, {} BINs from {} WADs → {}",
        schema.len(),
        total_fields,
        bins_parsed,
        total_wads,
        output_path_buf.display()
    );

    Ok(TroybinSchemaStats {
        wads_scanned: total_wads,
        bins_parsed,
        bins_failed,
        classes_found: schema.len(),
        total_fields,
        output_path,
    })
}
