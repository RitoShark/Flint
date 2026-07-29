//! Commands that build and clear the active project's hash overlay.

use crate::core::ipc_trace;
use crate::state::HashOverlayState;
use flint_core::overlay::build_overlay;
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
///
/// The generation is captured *before* the (potentially slow) build starts.
/// If a `clear` or a newer `set_if_current` happened while this build was in
/// flight, `set_if_current` rejects the store — an older build must not
/// resurrect a state it raced with. Concurrent builds triggered for the same
/// project (e.g. from several rapid mutations) are also resolved by this:
/// whichever finishes first wins, and later same-generation finishers are
/// dropped rather than stacking redundant writes.
#[tauri::command]
pub async fn build_project_hash_overlay(
    project_path: String,
    state: State<'_, HashOverlayState>,
) -> Result<OverlayStats, String> {
    let _t = ipc_trace::enter("build_project_hash_overlay");

    let gen = state.current_generation();
    let path = PathBuf::from(&project_path);
    let overlay = tokio::task::spawn_blocking(move || build_overlay(&path))
        .await
        .map_err(|e| format!("overlay build panicked: {}", e))?;

    let stats = OverlayStats { wad_entries: overlay.wad_len() };
    if !state.set_if_current(gen, project_path, Arc::new(overlay)) {
        tracing::debug!(
            "hash overlay build superseded by a newer build or a clear — discarding without storing"
        );
    }
    Ok(stats)
}

/// Drop the active overlay — called when the last open project tab closes.
#[tauri::command]
pub async fn clear_project_hash_overlay(
    state: State<'_, HashOverlayState>,
) -> Result<(), String> {
    let _t = ipc_trace::enter("clear_project_hash_overlay");
    state.clear();
    Ok(())
}
