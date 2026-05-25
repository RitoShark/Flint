//! Tauri commands for map projects.
//!
//! Mirrors the surface of `commands/project.rs` but routes through the
//! `flint_ltk::map` module. See `MAP_PROJECT_PLAN.md` at the repo root for
//! the full design.

use crate::state::LmdbCacheState;
use flint_ltk::hash::resolve_hashes_lmdb_bulk;
use flint_ltk::map::{
    self, MapEntry, MapProjectResult, MapVariant,
};
use flint_ltk::project::Project;
use serde::Serialize;
use std::path::PathBuf;
use tauri::Emitter;

/// Listing returned to the frontend. Hides the absolute paths the core
/// module carries — the UI only needs id / display name / whether a
/// LEVELS WAD exists alongside.
#[derive(Debug, Clone, Serialize)]
pub struct MapEntryView {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "hasLevels")]
    pub has_levels: bool,
}

impl From<MapEntry> for MapEntryView {
    fn from(m: MapEntry) -> Self {
        Self {
            has_levels: m.levels_wad_path.is_some(),
            id: m.id,
            display_name: m.display_name,
        }
    }
}

#[tauri::command]
pub async fn list_available_maps(league_path: String) -> Result<Vec<MapEntryView>, String> {
    let path = PathBuf::from(&league_path);
    if !path.exists() {
        return Err(format!("League path does not exist: {}", league_path));
    }
    tokio::task::spawn_blocking(move || {
        map::list_available_maps(&path)
            .map(|v| v.into_iter().map(MapEntryView::from).collect())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn list_map_variants(
    league_path: String,
    map_id: String,
    lmdb: tauri::State<'_, LmdbCacheState>,
) -> Result<Vec<MapVariant>, String> {
    let path = PathBuf::from(&league_path);
    if !path.exists() {
        return Err(format!("League path does not exist: {}", league_path));
    }

    let hash_dir = flint_ltk::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let env_arc = lmdb.prime(&hash_dir).ok_or_else(||
        "Hash databases not found. Run hash download first.".to_string()
    )?;

    tokio::task::spawn_blocking(move || {
        let env = env_arc;
        let resolve = move |hashes: &[u64]| resolve_hashes_lmdb_bulk(hashes, &env);
        map::list_map_variants(&path, &map_id, resolve).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_map_project(
    name: String,
    map_id: String,
    include_levels: bool,
    league_path: String,
    output_path: String,
    creator_name: Option<String>,
    // extract_mode: "variant" (default) only pulls the chosen variant + its
    // referenced kit-piece textures + the matching LEVELS lightmaps. "full"
    // mirrors the legacy whole-WAD dump.
    extract_mode: Option<String>,
    // variant_name: required when extract_mode == "variant".
    variant_name: Option<String>,
    lmdb: tauri::State<'_, LmdbCacheState>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    tracing::info!(
        "Frontend requested map project creation: name='{}' map='{}' levels={} mode={:?} variant={:?}",
        name, map_id, include_levels, extract_mode, variant_name
    );

    let league_path_buf = PathBuf::from(&league_path);
    let output_path_buf = PathBuf::from(&output_path);
    if !league_path_buf.exists() {
        return Err(format!("League folder does not exist at '{}'.", league_path));
    }

    let _ = app.emit("project-create-progress", serde_json::json!({
        "phase": "init",
        "message": "Initializing..."
    }));

    let hash_dir = flint_ltk::hash::get_hash_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let env_arc = lmdb.prime(&hash_dir).ok_or_else(||
        "Hash databases not found. Run hash download first.".to_string()
    )?;

    let mode = match extract_mode.as_deref().unwrap_or("variant") {
        "full" => map::MapExtractMode::Full,
        "variant" => map::MapExtractMode::Variant,
        other => return Err(format!("Unknown extract_mode '{}': expected 'variant' or 'full'", other)),
    };
    if matches!(mode, map::MapExtractMode::Variant) && variant_name.as_deref().unwrap_or("").is_empty() {
        return Err("variant_name is required when extract_mode is 'variant'".into());
    }
    let variant_for_extract = variant_name.clone();

    let app_for_progress = app.clone();
    let result: Result<MapProjectResult, String> = tokio::task::spawn_blocking(move || {
        let env = env_arc;
        let resolve = move |hashes: &[u64]| resolve_hashes_lmdb_bulk(hashes, &env);
        let progress = |phase: &str, message: &str| {
            let _ = app_for_progress.emit("project-create-progress", serde_json::json!({
                "phase": phase,
                "message": message,
            }));
        };
        map::create_map_project(
            &name,
            &map_id,
            include_levels,
            &league_path_buf,
            &output_path_buf,
            creator_name,
            mode,
            variant_for_extract.as_deref(),
            resolve,
            progress,
        ).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?;

    match result {
        Ok(r) => {
            tracing::info!(
                "Map project created: main={} levels={}",
                r.main_extracted, r.levels_extracted
            );
            let _ = app.emit("project-create-progress", serde_json::json!({
                "phase": "complete",
                "message": "Project created successfully!"
            }));
            Ok(r.project)
        }
        Err(e) => {
            tracing::error!("Map project creation failed: {}", e);
            Err(e)
        }
    }
}
