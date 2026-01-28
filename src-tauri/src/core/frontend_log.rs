//! Frontend Log Layer
//! A custom tracing layer that emits log events to the Tauri frontend via events.

use std::sync::Arc;
use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

/// Log entry sent to frontend
#[derive(Clone, Serialize)]
pub struct LogEvent {
    pub timestamp: i64,
    pub level: String,
    pub target: String,
    pub message: String,
}

/// Shared app handle that can be set after Tauri app starts
static APP_HANDLE: RwLock<Option<Arc<AppHandle>>> = RwLock::new(None);

/// Set the app handle (called from setup)
pub fn set_app_handle(handle: AppHandle) {
    let mut guard = APP_HANDLE.write();
    *guard = Some(Arc::new(handle));
}

/// Custom tracing layer that emits events to frontend
pub struct FrontendLogLayer;

impl<S> Layer<S> for FrontendLogLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        // Get app handle if available
        let handle_guard = APP_HANDLE.read();
        let handle = match handle_guard.as_ref() {
            Some(h) => h.clone(),
            None => return, // App not ready yet, skip
        };
        drop(handle_guard);

        // Extract event data
        let metadata = event.metadata();
        let level = metadata.level().as_str().to_string();
        let target = metadata.target().to_string();
        
        // Build message from fields
        let mut message = String::new();
        let mut visitor = MessageVisitor(&mut message);
        event.record(&mut visitor);

        // Create log event
        let log_event = LogEvent {
            timestamp: chrono::Utc::now().timestamp_millis(),
            level,
            target,
            message,
        };

        // Emit to frontend (ignore errors - frontend might not be listening)
        let _ = handle.emit("log-event", log_event);
    }
}

/// Visitor to extract message from tracing fields
struct MessageVisitor<'a>(&'a mut String);

impl<'a> tracing::field::Visit for MessageVisitor<'a> {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            *self.0 = format!("{:?}", value);
            // Remove surrounding quotes if present
            if self.0.starts_with('"') && self.0.ends_with('"') {
                *self.0 = self.0[1..self.0.len()-1].to_string();
            }
        } else if self.0.is_empty() {
            // Use first field as message if no explicit message
            *self.0 = format!("{:?}", value);
            if self.0.starts_with('"') && self.0.ends_with('"') {
                *self.0 = self.0[1..self.0.len()-1].to_string();
            }
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" || self.0.is_empty() {
            *self.0 = value.to_string();
        }
    }
}
