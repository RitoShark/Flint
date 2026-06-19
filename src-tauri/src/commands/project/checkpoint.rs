use flint_ltk::checkpoint::{Checkpoint, CheckpointDiff, CheckpointFileContent, CheckpointManager, CheckpointProgress};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn create_checkpoint(
    app: AppHandle,
    project_path: String,
    message: String,
    tags: Vec<String>,
) -> Result<Checkpoint, String> {
    let path = PathBuf::from(project_path);
    let manager = CheckpointManager::new(path);
    manager.init().map_err(|e| e.to_string())?;

    let app_handle = app.clone();
    manager.create_checkpoint_with_progress(
        message,
        tags,
        Some(move |phase: &str, current: u64, total: u64| {
            let _ = app_handle.emit("checkpoint-progress", CheckpointProgress {
                phase: phase.to_string(),
                current,
                total,
            });
        }),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_checkpoints(project_path: String) -> Result<Vec<Checkpoint>, String> {
    let path = PathBuf::from(project_path);
    let manager = CheckpointManager::new(path);
    manager.list_checkpoints().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_checkpoint(project_path: String, checkpoint_id: String) -> Result<(), String> {
    let path = PathBuf::from(project_path);
    let manager = CheckpointManager::new(path);
    manager.init().map_err(|e| e.to_string())?;
    manager.restore_checkpoint(&checkpoint_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn compare_checkpoints(
    project_path: String,
    from_id: String,
    to_id: String,
) -> Result<CheckpointDiff, String> {
    let path = PathBuf::from(project_path);
    let manager = CheckpointManager::new(path);
    manager.compare_checkpoints(&from_id, &to_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_checkpoint(project_path: String, checkpoint_id: String) -> Result<(), String> {
    let path = PathBuf::from(project_path);
    let manager = CheckpointManager::new(path);
    manager.delete_checkpoint(&checkpoint_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_checkpoint_file(
    project_path: String,
    hash: String,
    file_path: String,
) -> Result<CheckpointFileContent, String> {
    let path = PathBuf::from(project_path);
    let manager = CheckpointManager::new(path);
    manager.read_checkpoint_file(&hash, &file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_file_changes(project_path: String) -> Result<HashMap<String, String>, String> {
    let path = PathBuf::from(project_path);
    let manager = CheckpointManager::new(path);
    manager.get_file_changes().map_err(|e| e.to_string())
}

/// Result of `list_checkpoints_with_diffs` — the checkpoint list plus
/// per-pair diffs, keyed by the *newer* checkpoint's id (matches the
/// existing JS pattern `diffs[list[i].id] = compare(list[i+1], list[i])`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointsWithDiffs {
    pub checkpoints: Vec<Checkpoint>,
    pub diffs: HashMap<String, CheckpointDiff>,
}

/// One round-trip replacement for the
/// `list_checkpoints` + N×`compare_checkpoints` loop in
/// [CheckpointTimeline.tsx]. Diffs are computed in parallel via rayon.
#[tauri::command]
pub async fn list_checkpoints_with_diffs(
    project_path: String,
) -> Result<CheckpointsWithDiffs, String> {
    let path = PathBuf::from(&project_path);
    let manager = CheckpointManager::new(path);
    let checkpoints = manager.list_checkpoints().map_err(|e| e.to_string())?;

    let pairs: Vec<(String, String)> = checkpoints
        .windows(2)
        .map(|w| (w[0].id.clone(), w[1].id.clone()))
        .collect();

    let diffs: HashMap<String, CheckpointDiff> = pairs
        .into_par_iter()
        .filter_map(|(newer, older)| {
            let m = CheckpointManager::new(PathBuf::from(&project_path));
            m.compare_checkpoints(&older, &newer)
                .ok()
                .map(|diff| (newer, diff))
        })
        .collect();

    Ok(CheckpointsWithDiffs { checkpoints, diffs })
}
