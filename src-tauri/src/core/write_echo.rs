//! Write-echo suppression for the project file watcher.
//!
//! Before writing a file, a command marks the target paths as "expected
//! echoes". The watcher drops matching events whose timestamp is still within
//! `SUPPRESSION_WINDOW`, so a command's own writes don't look like external
//! changes. Paths are stored canonicalized (with a lexical-absolute fallback
//! when the file doesn't exist yet); the watcher canonicalizes the same way.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long an entry stays "expected" after being marked.
const SUPPRESSION_WINDOW: Duration = Duration::from_millis(1500);

static PENDING: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Best-effort canonicalization, falling back to the input if the file does
/// not exist yet. On Windows, strips the `\\?\` prefix `fs::canonicalize` adds
/// (which `notify` events do not carry).
fn normalize(path: &Path) -> PathBuf {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    strip_unc(&canonical)
}

#[cfg(windows)]
fn strip_unc(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        // Keep true UNC paths (\\?\UNC\server\share) intact.
        if rest.starts_with("UNC\\") {
            path.to_path_buf()
        } else {
            PathBuf::from(rest)
        }
    } else {
        path.to_path_buf()
    }
}

#[cfg(not(windows))]
fn strip_unc(path: &Path) -> PathBuf {
    path.to_path_buf()
}

/// Mark a path as an expected self-write, immediately before writing the file.
/// Watcher events for this path within `SUPPRESSION_WINDOW` will be dropped.
pub fn mark<P: AsRef<Path>>(path: P) {
    let key = normalize(path.as_ref());
    let mut map = pending().lock().unwrap();
    map.insert(key, Instant::now());
}

/// Returns true if the path was recently marked as a self-write and the mark
/// hasn't expired. Drops the entry on hit, so one mark consumes one echo.
pub fn consume<P: AsRef<Path>>(path: P) -> bool {
    let key = normalize(path.as_ref());
    let mut map = pending().lock().unwrap();

    let now = Instant::now();
    map.retain(|_, t| now.duration_since(*t) < SUPPRESSION_WINDOW);

    if let Some(t) = map.remove(&key) {
        if now.duration_since(t) < SUPPRESSION_WINDOW {
            return true;
        }
    }
    false
}
