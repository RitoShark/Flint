//! Project file watcher: auto-sync to the launcher and preview hot reload.
//!
//! Watches the project's content directory for changes and either syncs to the
//! launcher (when auto-sync is enabled) or emits file-changed events for
//! preview hot reload.

use notify_debouncer_full::{new_debouncer, notify::*, DebounceEventResult};
use notify::event::ModifyKind;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, Emitter};
use tokio::sync::mpsc;
use serde::Serialize;

pub struct WatcherState {
    pub watcher: Arc<Mutex<Option<WatcherHandle>>>,
    pub preview_watcher: Arc<Mutex<Option<PreviewWatcherHandle>>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            watcher: Arc::new(Mutex::new(None)),
            preview_watcher: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for WatcherState {
    fn default() -> Self {
        Self::new()
    }
}

pub struct WatcherHandle {
    /// Kept alive so the debouncer keeps running.
    _debouncer: Box<dyn Send>,
    /// Dropping this signals the watcher task to stop.
    _stop_tx: mpsc::UnboundedSender<()>,
}

pub struct PreviewWatcherHandle {
    /// Kept alive so the debouncer keeps running.
    _debouncer: Box<dyn Send>,
}

#[derive(Clone, Serialize)]
pub struct FileChangeEvent {
    pub path: String,
    pub kind: String,
}

/// Start watching a project directory for changes.
#[tauri::command]
pub async fn start_project_watcher(
    app: tauri::AppHandle,
    project_path: String,
    ltk_storage_path: String,
    // "celestial" (deep-link import) or "ltk" (fantome install); defaults to LTK.
    launcher_kind: Option<String>,
) -> std::result::Result<(), String> {
    tracing::info!("Starting project watcher for: {}", project_path);
    let is_celestial = launcher_kind.as_deref() == Some("celestial");

    let watcher_state = app.state::<WatcherState>();
    let mut watcher_guard = watcher_state.watcher.lock().unwrap();

    if watcher_guard.is_some() {
        tracing::info!("Stopping existing watcher before starting new one");
        *watcher_guard = None;
    }

    let content_path = PathBuf::from(&project_path).join("content");
    if !content_path.exists() {
        return Err(format!("Project content directory not found: {}", content_path.display()));
    }

    let (stop_tx, mut stop_rx) = mpsc::unbounded_channel();

    let project_path_clone = project_path.clone();
    let ltk_storage_clone = ltk_storage_path.clone();
    let app_clone = app.clone();

    // 2-second debounce.
    let (tx, mut rx) = mpsc::unbounded_channel();

    let mut debouncer = new_debouncer(
        Duration::from_secs(2),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                for event in &events {
                    tracing::debug!("File event: {:?} - {:?}", event.kind, event.paths);
                }

                let relevant_events: Vec<_> = events.iter()
                    .filter(|e| matches!(
                        e.kind,
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                    ))
                    .collect();

                if !relevant_events.is_empty() {
                    tracing::info!(
                        "Detected {} relevant file change(s), triggering sync in 2s...",
                        relevant_events.len()
                    );
                    let _ = tx.send(());
                }
            }
            Err(e) => {
                tracing::error!("File watcher error: {:?}", e);
            }
        },
    )
    .map_err(|e| format!("Failed to create file watcher: {}", e))?;

    debouncer
        .watch(&content_path, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch directory: {}", e))?;

    tracing::info!("Watching directory: {}", content_path.display());

    tokio::spawn(async move {
        tracing::info!("Auto-sync background task started");
        loop {
            tokio::select! {
                Some(_) = rx.recv() => {
                    tracing::info!("Debounce complete! Starting auto-sync...");

                    // Celestial reads the project folder directly via a deep link; LTK Manager
                    // mirrors it into its workshop, or installs a fantome when it has none.
                    let sync_result = if is_celestial {
                        crate::commands::ltk_manager::sync_project_to_celestial(
                            project_path_clone.clone(),
                        )
                        .await
                    } else {
                        crate::commands::ltk_manager::sync_project_to_launcher(
                            project_path_clone.clone(),
                            ltk_storage_clone.clone(),
                        )
                        .await
                        .map(|result| result.location)
                    };

                    match sync_result {
                        Ok(mod_id) => {
                            tracing::info!("✓ Auto-sync completed successfully: {}", mod_id);
                            let _ = app_clone.emit("auto-sync-complete", mod_id);
                        }
                        Err(e) => {
                            tracing::error!("✗ Auto-sync failed: {}", e);
                            let _ = app_clone.emit("auto-sync-error", e);
                        }
                    }
                }
                _ = stop_rx.recv() => {
                    tracing::info!("Auto-sync background task stopping");
                    break;
                }
            }
        }
        tracing::info!("Auto-sync background task ended");
    });

    *watcher_guard = Some(WatcherHandle {
        _debouncer: Box::new(debouncer),
        _stop_tx: stop_tx,
    });

    Ok(())
}

/// Stop the active project watcher.
#[tauri::command]
pub async fn stop_project_watcher(app: tauri::AppHandle) -> std::result::Result<(), String> {
    let watcher_state = app.state::<WatcherState>();
    let mut watcher_guard = watcher_state.watcher.lock().unwrap();

    if watcher_guard.is_some() {
        *watcher_guard = None;
        tracing::info!("Project watcher stopped");
    }

    Ok(())
}

/// Start watching a project directory for file changes (preview hot reload).
#[tauri::command]
pub async fn start_preview_watcher(
    app: tauri::AppHandle,
    project_path: String,
) -> std::result::Result<(), String> {
    tracing::debug!("Starting preview watcher for: {}", project_path);

    let watcher_state = app.state::<WatcherState>();
    let mut watcher_guard = watcher_state.preview_watcher.lock().unwrap();

    if watcher_guard.is_some() {
        tracing::debug!("Stopping existing preview watcher before starting new one");
        *watcher_guard = None;
    }

    let content_path = PathBuf::from(&project_path).join("content");
    if !content_path.exists() {
        return Err(format!("Project content directory not found: {}", content_path.display()));
    }

    let app_clone = app.clone();
    let project_path_normalized = project_path.replace('\\', "/");
    let content_path_for_closure = content_path.clone();

    // 100ms debounce.
    let mut debouncer = new_debouncer(
        Duration::from_millis(100),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                for event in events {
                    let kind = match &event.kind {
                        EventKind::Modify(ModifyKind::Metadata(_)) => continue,
                        EventKind::Modify(_) => "modify",
                        EventKind::Create(_) => "create",
                        EventKind::Remove(_) => "remove",
                        _ => continue,
                    };

                    for path in &event.paths {
                        // Drop events matching a self-write the app just made.
                        if crate::core::write_echo::consume(path) {
                            tracing::debug!("Suppressed self-write echo: {}", path.display());
                            continue;
                        }

                        if let Ok(relative_path) = path.strip_prefix(&content_path_for_closure) {
                            let file_path = format!(
                                "{}/content/{}",
                                project_path_normalized,
                                relative_path.to_string_lossy().replace('\\', "/")
                            );

                            let event_data = FileChangeEvent {
                                path: file_path.clone(),
                                kind: kind.to_string(),
                            };

                            tracing::debug!("File {}: {}", kind, file_path);
                            let _ = app_clone.emit("file-changed", event_data);
                        }
                    }
                }
            }
            Err(e) => {
                tracing::error!("Preview file watcher error: {:?}", e);
            }
        },
    )
    .map_err(|e| format!("Failed to create preview file watcher: {}", e))?;

    debouncer
        .watch(&content_path, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch directory: {}", e))?;

    tracing::debug!("Preview watcher active for: {}", content_path.display());

    *watcher_guard = Some(PreviewWatcherHandle {
        _debouncer: Box::new(debouncer),
    });

    Ok(())
}

/// Stop the active preview watcher.
#[tauri::command]
pub async fn stop_preview_watcher(app: tauri::AppHandle) -> std::result::Result<(), String> {
    tracing::debug!("Stopping preview watcher");

    let watcher_state = app.state::<WatcherState>();
    let mut watcher_guard = watcher_state.preview_watcher.lock().unwrap();

    if watcher_guard.is_some() {
        *watcher_guard = None;
        tracing::debug!("Preview watcher stopped");
    } else {
        tracing::debug!("No active preview watcher to stop");
    }

    Ok(())
}
