use std::collections::HashMap;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::state::LmdbCacheState;
use flint_core::hash::{get_hash_dir, resolve_hashes_lmdb_bulk, ResolvedHashes};
use flint_core::wad_jade::adapter::WadHandle as WadReader;

// =============================================================================
// Progress / public stats
// =============================================================================

#[derive(Debug, Clone, Serialize)]
struct LuabinExtractProgress {
    phase: String,
    current: usize,
    total: usize,
    bins_parsed: usize,
    bins_failed: usize,
    classes_found: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct LuabinExtractStats {
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

fn is_luabin_path(resolved: &str) -> bool {
    let lower = resolved.to_lowercase();
    lower.ends_with(".luabin") || lower.ends_with(".luabin64")
}


// =============================================================================
// Tauri command
// =============================================================================

#[tauri::command]
pub async fn extract_all_luabins(
    app: AppHandle,
    league_path: String,
    lmdb: tauri::State<'_, LmdbCacheState>,
) -> Result<LuabinExtractStats, String> {
    let game_path = std::path::Path::new(&league_path).join("Game");
    let data_path = game_path.join("DATA").join("FINAL");

    if !data_path.exists() {
        return Err(format!(
            "DATA/FINAL directory not found: {} — make sure this is the League installation folder",
            data_path.display()
        ));
    }

    let output_path_buf = get_hash_dir()
        .map(|p| p.parent().unwrap_or(&p).join("luabin-schema.lua"))
        .unwrap_or_else(|_| std::path::PathBuf::from("luabin-schema.lua"));

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
    tracing::info!("Luabin aggregator: scanning {} WADs", total_wads);

    let hash_dir = get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let env_opt = lmdb.get_env(&hash_dir);

    let mut bins_parsed: usize = 0;
    let mut bins_failed: usize = 0;

    let mut global_schema: HashMap<String, flint_core::luabin::LuaValue> = HashMap::new();

    for (wad_idx, wad_path) in wad_paths.iter().enumerate() {
        let _ = app.emit(
            "luabin-extract-progress",
            LuabinExtractProgress {
                phase: "scanning".to_string(),
                current: wad_idx + 1,
                total: total_wads,
                bins_parsed,
                bins_failed,
                classes_found: global_schema.len(),
            },
        );

        let mut reader = match WadReader::open(wad_path) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("Luabin aggregator: failed to open {}: {}", wad_path, e);
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

            if !is_luabin_path(resolved) {
                continue;
            }

            let data = match reader.wad_mut().load_chunk_decompressed(chunk) {
                Ok(d) => d,
                Err(_) => {
                    bins_failed += 1;
                    continue;
                }
            };

            let globals = match flint_core::luabin::parse_luabin_globals(&data) {
                Ok(g) => g,
                Err(e) => {
                    tracing::debug!(
                        "Luabin aggregator: failed to parse {:016x}: {}",
                        path_hash,
                        e
                    );
                    bins_failed += 1;
                    continue;
                }
            };

            for (name, val) in globals {
                if let Some(existing) = global_schema.get_mut(&name) {
                    existing.merge(val);
                } else {
                    global_schema.insert(name, val);
                }
            }

            bins_parsed += 1;
        }
    }

    let mut output = String::new();
    let mut total_fields = 0;

    let mut keys: Vec<_> = global_schema.keys().collect();
    keys.sort();

    for key in keys {
        let val = &global_schema[key];

        if let flint_core::luabin::LuaValue::Table(entries) = val {
            total_fields += entries.len();
        } else {
            total_fields += 1;
        }

        output.push_str(&format!("{} = {}\n", key, val.to_lua_source(0)));
    }

    if let Err(e) = std::fs::write(&output_path_buf, &output) {
        return Err(format!("Failed to write schema to {}: {}", output_path, e));
    }

    tracing::info!(
        "Luabin schema complete: {} classes (globals), {} WADs scanned → {}",
        global_schema.len(),
        total_wads,
        output_path
    );

    let _ = app.emit(
        "luabin-extract-progress",
        LuabinExtractProgress {
            phase: "complete".to_string(),
            current: total_wads,
            total: total_wads,
            bins_parsed,
            bins_failed,
            classes_found: global_schema.len(),
        },
    );

    Ok(LuabinExtractStats {
        wads_scanned: total_wads,
        bins_parsed,
        bins_failed,
        classes_found: global_schema.len(),
        total_fields,
        output_path,
    })
}
