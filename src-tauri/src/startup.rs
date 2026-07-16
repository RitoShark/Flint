use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(debug_assertions))]
use std::sync::atomic::AtomicU64;
#[cfg(not(debug_assertions))]
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(not(debug_assertions))]
use tauri_plugin_updater::{Update, UpdaterExt};

#[cfg(not(debug_assertions))]
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(12);
#[cfg(not(debug_assertions))]
const UPDATE_INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const MIN_STARTUP_VISIBLE: Duration = Duration::from_millis(1800);

#[derive(Default)]
pub struct StartupGate {
    started: AtomicBool,
    launch_allowed: AtomicBool,
    frontend_ready: AtomicBool,
    resolved: AtomicBool,
}

impl StartupGate {
    pub fn is_resolved(&self) -> bool {
        self.resolved.load(Ordering::Acquire)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupStatus {
    text: String,
    percent: Option<f32>,
}

fn emit_status(app: &AppHandle, text: impl Into<String>, percent: Option<f32>) {
    let _ = app.emit_to(
        "updater",
        "startup-status",
        StartupStatus { text: text.into(), percent },
    );
}

fn pending_update_path() -> Option<std::path::PathBuf> {
    crate::commands::settings::get_flint_home()
        .ok()
        .map(|home| home.join("pending-update"))
}

#[cfg(not(debug_assertions))]
fn remember_installed_update(version: &str) {
    let Some(path) = pending_update_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(error) = std::fs::write(path, version) {
        tracing::warn!("could not record installed update: {error}");
    }
}

fn try_reveal_main(app: &AppHandle) {
    let Some(gate) = app.try_state::<StartupGate>() else {
        tracing::error!("startup gate state is unavailable");
        return;
    };
    if !gate.launch_allowed.load(Ordering::Acquire) || !gate.frontend_ready.load(Ordering::Acquire) {
        return;
    }
    let Some(main) = app.get_webview_window("main") else {
        tracing::error!("startup gate could not find the main window");
        return;
    };
    if gate.resolved.swap(true, Ordering::AcqRel) {
        return;
    }

    tracing::info!("startup gates resolved; revealing the fully initialized main window");
    emit_status(app, "Flint is ready", Some(100.0));
    if let Err(error) = main.show() {
        gate.resolved.store(false, Ordering::Release);
        tracing::error!("startup gate could not show the main window: {error}");
        return;
    }
    let _ = main.unminimize();
    let _ = main.set_focus();

    if let Some(updater) = app.get_webview_window("updater") {
        if let Err(error) = updater.close() {
            tracing::warn!("failed to close startup window: {error}");
            let _ = updater.hide();
        }
    }
}

fn allow_main_launch(app: &AppHandle) {
    if let Some(gate) = app.try_state::<StartupGate>() {
        gate.launch_allowed.store(true, Ordering::Release);
        tracing::info!("startup update gate resolved");
    }
    try_reveal_main(app);
}

async fn finish_without_update(app: &AppHandle, text: &str, started: Instant) {
    emit_status(app, text, Some(92.0));
    let remaining = MIN_STARTUP_VISIBLE
        .checked_sub(started.elapsed())
        .unwrap_or(Duration::from_millis(280));
    tokio::time::sleep(remaining).await;
    allow_main_launch(app);
}

#[cfg(not(debug_assertions))]
async fn install_checked_update(app: &AppHandle, update: Update) -> Result<String, String> {
    let version = update.version.clone();
    let total = Arc::new(AtomicU64::new(0));
    let downloaded = Arc::new(AtomicU64::new(0));
    let callback_app = app.clone();
    let callback_total = Arc::clone(&total);
    let callback_downloaded = Arc::clone(&downloaded);
    let callback_version = version.clone();
    let finished_app = app.clone();
    let finished_version = version.clone();

    emit_status(app, format!("Preparing Flint v{version}..."), Some(0.0));
    let download = update.download_and_install(
        move |chunk_length, content_length| {
            if let Some(length) = content_length {
                callback_total.store(length, Ordering::Relaxed);
            }
            let current = callback_downloaded.fetch_add(chunk_length as u64, Ordering::Relaxed)
                + chunk_length as u64;
            let length = callback_total.load(Ordering::Relaxed);
            let percent = (length > 0).then(|| (current as f32 / length as f32) * 100.0);
            emit_status(&callback_app, format!("Downloading Flint v{callback_version}..."), percent);
        },
        move || {
            emit_status(&finished_app, format!("Installing Flint v{finished_version}..."), Some(100.0));
        },
    );

    tokio::time::timeout(UPDATE_INSTALL_TIMEOUT, download)
        .await
        .map_err(|_| "The update download timed out. Please try again later.".to_string())?
        .map_err(|error| format!("Update installation failed: {error}"))?;

    Ok(version)
}

async fn run_startup(app: AppHandle) {
    let started = Instant::now();
    emit_status(&app, "Loading Flint settings...", Some(16.0));
    tokio::time::sleep(Duration::from_millis(130)).await;
    emit_status(&app, "Preparing Flint workspace...", Some(34.0));
    tokio::time::sleep(Duration::from_millis(130)).await;

    #[cfg(debug_assertions)]
    {
        finish_without_update(&app, "Preparing Flint interface...", started).await;
        return;
    }

    #[cfg(not(debug_assertions))]
    {
        if !crate::commands::settings::auto_update_enabled() {
            tracing::info!("automatic startup updates are disabled in Settings");
            finish_without_update(&app, "Preparing Flint interface...", started).await;
            return;
        }

        emit_status(&app, "Checking for updates...", None);
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(error) => {
                tracing::warn!("startup updater unavailable: {error}");
                finish_without_update(&app, "Starting Flint offline...", started).await;
                return;
            }
        };

        match tokio::time::timeout(UPDATE_CHECK_TIMEOUT, updater.check()).await {
            Ok(Ok(Some(update))) => {
                tracing::info!("startup update available: {}", update.version);
                match install_checked_update(&app, update).await {
                    Ok(version) => {
                        remember_installed_update(&version);
                        emit_status(&app, format!("Flint v{version} installed - restarting..."), Some(100.0));
                        tokio::time::sleep(Duration::from_millis(700)).await;
                        app.restart();
                    }
                    Err(error) => {
                        tracing::warn!("automatic startup update failed: {error}");
                        finish_without_update(&app, "Update could not be installed - starting Flint...", started).await;
                    }
                }
            }
            Ok(Ok(None)) => finish_without_update(&app, "Flint is up to date", started).await,
            Ok(Err(error)) => {
                tracing::warn!("startup update check failed: {error}");
                finish_without_update(&app, "Starting Flint offline...", started).await;
            }
            Err(_) => {
                tracing::warn!("startup update check timed out after {} seconds", UPDATE_CHECK_TIMEOUT.as_secs());
                finish_without_update(&app, "Update check timed out - starting Flint...", started).await;
            }
        }
    }
}

#[tauri::command]
pub fn startup_window_ready(app_handle: AppHandle, gate: State<'_, StartupGate>) {
    if gate.started.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move { run_startup(app_handle).await; });
}

#[tauri::command]
pub fn startup_main_ready(app_handle: AppHandle, gate: State<'_, StartupGate>) {
    gate.frontend_ready.store(true, Ordering::Release);
    tracing::info!("startup frontend-ready handshake received");
    try_reveal_main(&app_handle);
}

#[tauri::command]
pub fn startup_continue(app_handle: AppHandle) {
    tracing::info!("startup fallback continued by the user");
    allow_main_launch(&app_handle);
}

#[tauri::command]
pub fn startup_take_installed_update() -> Option<String> {
    let path = pending_update_path()?;
    let version = std::fs::read_to_string(&path).ok()?.trim().to_string();
    let _ = std::fs::remove_file(path);
    (!version.is_empty()).then_some(version)
}
