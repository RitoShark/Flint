//! Commands that build and clear the active project's hash overlay.

use crate::core::ipc_trace;
use crate::state::HashOverlayState;
use flint_ltk::hash::build_overlay;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
pub struct OverlayStats {
    pub wad_entries: usize,
}

/// Build (or reload from cache) the overlay for `project_path` and make it the
/// active one. Runs the walk off the async runtime's blocking pool so a large
/// project does not stall the UI.
#[tauri::command]
pub async fn build_project_hash_overlay(
    project_path: String,
    state: State<'_, HashOverlayState>,
) -> Result<OverlayStats, String> {
    let _t = ipc_trace::enter("build_project_hash_overlay");

    let path = PathBuf::from(&project_path);
    let overlay = tokio::task::spawn_blocking(move || build_overlay(&path))
        .await
        .map_err(|e| format!("overlay build panicked: {}", e))?;

    let stats = OverlayStats { wad_entries: overlay.wad_len() };
    state.set(project_path, Arc::new(overlay));
    Ok(stats)
}

/// Drop the active overlay — called when a project closes.
#[tauri::command]
pub async fn clear_project_hash_overlay(
    state: State<'_, HashOverlayState>,
) -> Result<(), String> {
    let _t = ipc_trace::enter("clear_project_hash_overlay");
    state.clear();
    Ok(())
}
