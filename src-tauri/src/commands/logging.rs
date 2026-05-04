//! Logging commands — runtime log level switching
//!
//! Provides commands to switch between normal and verbose logging modes:
//! - Normal mode (info): Shows important app events and user-facing operations
//! - Verbose mode (debug): Shows detailed internal operations and diagnostics

use parking_lot::Mutex;

type ReloadFn = Box<dyn Fn(&str) -> Result<(), String> + Send>;

static RELOAD_FN: Mutex<Option<ReloadFn>> = Mutex::new(None);

/// Store the reload function (called once from main before any commands run).
pub fn set_reload_fn(f: ReloadFn) {
    *RELOAD_FN.lock() = Some(f);
}

/// Switch between normal (`info`) and verbose (`debug`) log levels.
///
/// # Arguments
/// * `verbose` - If true, enables verbose (debug) logging; if false, uses normal (info) logging
///
/// # Log Levels
/// - **Normal mode** (verbose=false): Shows important operations (info/warn/error)
///   - Project operations (create, open, save)
///   - Export operations
///   - Error conditions
///
/// - **Verbose mode** (verbose=true): Shows everything above plus:
///   - File operations (read, write, hash lookups)
///   - WAD chunk parsing
///   - BIN conversion details
///   - Cache operations
#[tauri::command]
pub async fn set_log_level(verbose: bool) -> Result<(), String> {
    // In release builds, `tracing::debug!` is compile-time stripped via the
    // `release_max_level_info` feature on the tracing crate (see
    // src-tauri/Cargo.toml). Lifting the EnvFilter to "debug" wouldn't
    // produce any output anyway, so we clamp the toggle to `info` and tell
    // the frontend we did. Dev builds honor the toggle as before.
    let verbose_effective = if cfg!(debug_assertions) { verbose } else { false };

    let filter_str = if verbose_effective { "debug" } else { "info" };
    let mode_name = if verbose_effective {
        "verbose (debug)"
    } else if verbose && !cfg!(debug_assertions) {
        "normal (info) — debug logs are dev-only in release"
    } else {
        "normal (info)"
    };

    let guard = RELOAD_FN.lock();
    let reload = guard.as_ref().ok_or("Reload handle not initialized")?;
    reload(filter_str)?;

    tracing::info!("Log level changed to: {}", mode_name);

    // Emit a test log at each level to verify the filter is working
    if verbose_effective {
        tracing::debug!("Verbose logging enabled - you will see detailed debug information");
        tracing::info!("Info logs visible");
        tracing::warn!("Warning logs visible");
    } else {
        tracing::info!("Normal logging enabled - only important events will be shown");
        tracing::warn!("Warning logs visible");
        // Debug log won't be shown in normal mode (and won't compile in release)
        tracing::debug!("This debug message should NOT appear in normal mode");
    }

    Ok(())
}

/// Emit test logs at all levels to verify the logging system is working
///
/// This is useful for testing that the frontend is receiving logs from the backend
/// and that the log level filter is working correctly.
#[tauri::command]
pub async fn test_logging() -> Result<(), String> {
    tracing::debug!("🧪 Test DEBUG log - only visible in verbose mode");
    tracing::info!("🧪 Test INFO log - visible in normal and verbose modes");
    tracing::warn!("🧪 Test WARN log - visible in all modes");
    tracing::error!("🧪 Test ERROR log - visible in all modes");
    Ok(())
}
