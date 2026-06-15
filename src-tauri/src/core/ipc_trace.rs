//! IPC tracing helper.
//!
//! Drop-in span/timer for Tauri command bodies. Use like:
//!
//! ```ignore
//! #[tauri::command]
//! pub async fn my_command(...) -> Result<X, String> {
//!     let _t = ipc_trace::enter("my_command");
//!     // ... command body ...
//! }
//! ```
//!
//! On `_t` drop, logs the elapsed wall time at info level (warn if it ran
//! longer than `SLOW_THRESHOLD_MS`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

const SLOW_THRESHOLD_MS: u128 = 100;

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct CommandTrace {
    id: u64,
    name: &'static str,
    start: Instant,
}

impl CommandTrace {
    pub fn new(name: &'static str) -> Self {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        tracing::info!("[rs-ipc#{} ▶] {}", id, name);
        Self { id, name, start: Instant::now() }
    }
}

impl Drop for CommandTrace {
    fn drop(&mut self) {
        let ms = self.start.elapsed().as_millis();
        if ms >= SLOW_THRESHOLD_MS {
            tracing::warn!("[rs-ipc#{} ✓] {} {}ms (SLOW)", self.id, self.name, ms);
        } else {
            tracing::info!("[rs-ipc#{} ✓] {} {}ms", self.id, self.name, ms);
        }
    }
}

/// Convenience entry point: `let _t = ipc_trace::enter("my_command");`
#[inline]
pub fn enter(name: &'static str) -> CommandTrace {
    CommandTrace::new(name)
}
