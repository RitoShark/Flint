//! Logging commands — runtime log level switching.

use parking_lot::Mutex;

type ReloadFn = Box<dyn Fn(&str) -> Result<(), String> + Send>;

static RELOAD_FN: Mutex<Option<ReloadFn>> = Mutex::new(None);

/// Store the reload function (called once from main before any commands run).
pub fn set_reload_fn(f: ReloadFn) {
    *RELOAD_FN.lock() = Some(f);
}

/// Switch between normal (`info`) and verbose (`debug`) log levels. Works in
/// both dev and release builds (the `release_max_level_info` strip feature was
/// removed so verbose logging is available in the shipped app too).
#[tauri::command]
pub async fn set_log_level(verbose: bool) -> Result<(), String> {
    let filter_str = if verbose { "debug" } else { "info" };
    let mode_name = if verbose { "verbose (debug)" } else { "normal (info)" };

    let guard = RELOAD_FN.lock();
    let reload = guard.as_ref().ok_or("Reload handle not initialized")?;
    reload(filter_str)?;

    tracing::info!("Log level changed to: {}", mode_name);

    if verbose {
        tracing::debug!("Verbose logging enabled - you will see detailed debug information");
        tracing::info!("Info logs visible");
        tracing::warn!("Warning logs visible");
    } else {
        tracing::info!("Normal logging enabled - only important events will be shown");
        tracing::warn!("Warning logs visible");
        tracing::debug!("This debug message should NOT appear in normal mode");
    }

    Ok(())
}

#[tauri::command]
pub async fn test_logging() -> Result<(), String> {
    tracing::debug!("🧪 Test DEBUG log - only visible in verbose mode");
    tracing::info!("🧪 Test INFO log - visible in normal and verbose modes");
    tracing::warn!("🧪 Test WARN log - visible in all modes");
    tracing::error!("🧪 Test ERROR log - visible in all modes");
    Ok(())
}
