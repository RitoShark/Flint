//! Project file watcher for auto-sync to LTK Manager and preview hot reload
//!
//! Watches the project's content directory for changes and:
//! - Automatically syncs to LTK Manager when auto-sync is enabled
//! - Emits file-changed events for preview hot reload

use notify_debouncer_full::{new_debouncer, notify::*, DebounceEventResult};
use notify::event::ModifyKind;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, Emitter};
use tokio::sync::mpsc;
use serde::Serialize;

/// Global watcher state stored in Tauri's managed state
pub struct WatcherState {
    /// Currently active watcher for auto-sync (if any)
    pub watcher: Arc<Mutex<Option<WatcherHandle>>>,
    /// Currently active watcher for preview hot reload (if any)
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

/// Handle to a running file watcher
pub struct WatcherHandle {
    /// The debouncer (must be kept alive)
    _debouncer: Box<dyn Send>,
    /// Sender to stop the watcher task (not read, but dropping it signals the task to stop)
    #[allow(dead_code)]
    stop_tx: mpsc::UnboundedSender<()>,
}

/// Handle to a running preview file watcher
pub struct PreviewWatcherHandle {
    /// The debouncer (must be kept alive)
    _debouncer: Box<dyn Send>,
}

/// File change event payload
#[derive(Clone, Serialize)]
pub struct FileChangeEvent {
    pub path: String,
    pub kind: String,
}

/// Start watching a project directory for changes
#[tauri::command]
pub async fn start_project_watcher(
    app: tauri::AppHandle,
    project_path: String,
    ltk_storage_path: String,
) -> std::result::Result<(), String> {
    tracing::info!("Starting project watcher for: {}", project_path);

    let watcher_state = app.state::<WatcherState>();
    let mut watcher_guard = watcher_state.watcher.lock().unwrap();

    // Stop existing watcher if any
    if watcher_guard.is_some() {
        tracing::info!("Stopping existing watcher before starting new one");
        *watcher_guard = None;
    }

    let content_path = PathBuf::from(&project_path).join("content");
    if !content_path.exists() {
        return Err(format!("Project content directory not found: {}", content_path.display()));
    }

    // Create channel for stopping the watcher task
    let (stop_tx, mut stop_rx) = mpsc::unbounded_channel();

    // Clone values for the async task
    let project_path_clone = project_path.clone();
    let ltk_storage_clone = ltk_storage_path.clone();
    let app_clone = app.clone();

    // Create debounced watcher (2 second debounce)
    let (tx, mut rx) = mpsc::unbounded_channel();

    let mut debouncer = new_debouncer(
        Duration::from_secs(2),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                // Log all received events for debugging
                for event in &events {
                    tracing::debug!("File event: {:?} - {:?}", event.kind, event.paths);
                }

                // Filter out events we don't care about (metadata changes, directory ops)
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

    // Watch the content directory recursively
    debouncer
        .watch(&content_path, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch directory: {}", e))?;

    tracing::info!("Watching directory: {}", content_path.display());

    // Spawn background task to handle sync events
    tokio::spawn(async move {
        tracing::info!("Auto-sync background task started");
        loop {
            tokio::select! {
                Some(_) = rx.recv() => {
                    tracing::info!("Debounce complete! Starting auto-sync to LTK Manager...");

                    // Call the sync command
                    match crate::commands::ltk_manager::sync_project_to_launcher(
                        project_path_clone.clone(),
                        ltk_storage_clone.clone(),
                    )
                    .await
                    {
                        Ok(mod_id) => {
                            tracing::info!("✓ Auto-sync completed successfully: {}", mod_id);
                            // Emit event to frontend
                            let _ = app_clone.emit("auto-sync-complete", mod_id);
                        }
                        Err(e) => {
                            tracing::error!("✗ Auto-sync failed: {}", e);
                            // Emit error event to frontend
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

    // Store the watcher handle
    *watcher_guard = Some(WatcherHandle {
        _debouncer: Box::new(debouncer),
        stop_tx,
    });

    Ok(())
}

/// Stop the active project watcher
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

/// Start watching a project directory for file changes (preview hot reload)
#[tauri::command]
pub async fn start_preview_watcher(
    app: tauri::AppHandle,
    project_path: String,
) -> std::result::Result<(), String> {
    tracing::debug!("Starting preview watcher for: {}", project_path);

    let watcher_state = app.state::<WatcherState>();
    let mut watcher_guard = watcher_state.preview_watcher.lock().unwrap();

    // Stop existing watcher if any
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

    // Create debounced watcher (100ms debounce for quick response)
    let mut debouncer = new_debouncer(
        Duration::from_millis(100),
        None,
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                for event in events {
                    let kind = match &event.kind {
                        // Skip metadata-only changes (timestamps, permissions)
                        EventKind::Modify(ModifyKind::Metadata(_)) => continue,
                        // Catch Data, Name, Any, and other Modify variants
                        EventKind::Modify(_) => "modify",
                        EventKind::Create(_) => "create",
                        EventKind::Remove(_) => "remove",
                        _ => continue,
                    };

                    for path in &event.paths {
                        // Drop events that match a self-write the app just
                        // made (e.g. saving a .bin from the editor). Without
                        // this, every save bounces back as a "file changed
                        // externally" and resets the editor.
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

    // Watch the content directory recursively
    debouncer
        .watch(&content_path, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch directory: {}", e))?;

    tracing::debug!("Preview watcher active for: {}", content_path.display());

    // Store the watcher handle
    *watcher_guard = Some(PreviewWatcherHandle {
        _debouncer: Box::new(debouncer),
    });

    Ok(())
}

/// Stop the active preview watcher
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
