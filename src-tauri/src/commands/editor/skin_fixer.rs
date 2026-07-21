//! Skin Fixer commands — drive Hematite's fix engine over Flint projects.
//!
//! `hematite_list_fixes` returns the fix catalog; `hematite_scan_projects` runs
//! a detect-only pass (which fixes fire per project, writes nothing);
//! `hematite_run_fixes` applies the selected fixes and streams progress via the
//! `hematite-fix-progress` event. All heavy work runs on a blocking thread — the
//! engine is sync + CPU/IO heavy.

use hematite_flint::{FixEntry, ProjectFixReport};
use tauri::{AppHandle, Emitter};

/// A `(project_dir, label)` pair. The label is what the report is keyed by in
/// the UI; default it to the dir when the frontend doesn't supply one.
fn pairs(project_paths: Vec<String>) -> Vec<(String, String)> {
    project_paths
        .into_iter()
        .map(|p| {
            let label = std::path::Path::new(&p)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.clone());
            (p, label)
        })
        .collect()
}

#[tauri::command]
pub async fn hematite_list_fixes() -> Result<Vec<FixEntry>, String> {
    tokio::task::spawn_blocking(hematite_flint::list_available_fixes)
        .await
        .map_err(|e| format!("skin-fixer task failed: {e}"))
}

#[tauri::command]
pub async fn hematite_scan_projects(
    project_paths: Vec<String>,
    fix_ids: Vec<String>,
) -> Result<Vec<ProjectFixReport>, String> {
    let projects = pairs(project_paths);
    tokio::task::spawn_blocking(move || hematite_flint::scan_projects(&projects, &fix_ids))
        .await
        .map_err(|e| format!("skin-fixer scan failed: {e}"))
}

#[tauri::command]
pub async fn hematite_run_fixes(
    app: AppHandle,
    project_paths: Vec<String>,
    fix_ids: Vec<String>,
    use_live: bool,
) -> Result<Vec<ProjectFixReport>, String> {
    let projects = pairs(project_paths);
    tokio::task::spawn_blocking(move || {
        hematite_flint::run_projects(&projects, &fix_ids, use_live, |progress| {
            let _ = app.emit("hematite-fix-progress", progress);
        })
    })
    .await
    .map_err(|e| format!("skin-fixer run failed: {e}"))
}
