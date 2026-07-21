//! Flint-facing serde types the Tauri layer serializes straight to the UI.

use serde::{Deserialize, Serialize};

/// One entry in the fix catalog (from the loaded config).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    /// `low` | `medium` | `high` | `critical`.
    pub severity: String,
    /// Whether the fix is enabled by default in the config.
    pub enabled: bool,
    /// `true` for WAD-level fixes, `false` for BIN-level.
    pub wad_level: bool,
}

/// A single fix that fired during a scan / run, with how many changes it made.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixOutcome {
    pub fix_id: String,
    pub fix_name: String,
    /// Detection count (scan) or applied-change count (run).
    pub changes: u32,
    pub file_path: String,
}

/// The per-project result of a scan or a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFixReport {
    /// The project path this report is for.
    pub project: String,
    /// Fixes that fired (detected on scan, or applied on run).
    pub outcomes: Vec<FixOutcome>,
    /// Total fixes applied (0 on a pure scan — scan reports detections).
    pub fixes_applied: u32,
    pub fixes_failed: u32,
    pub files_removed: u32,
    /// Non-fatal engine messages surfaced to the user.
    pub errors: Vec<String>,
    /// Detected champion, if the engine identified one.
    pub champion: Option<String>,
    pub skin_number: Option<u32>,
    /// Set when the WHOLE project failed (e.g. missing hashes, unreadable dir).
    pub error: Option<String>,
}

impl ProjectFixReport {
    /// A report representing a project that failed outright.
    pub fn failed(project: impl Into<String>, error: impl Into<String>) -> Self {
        ProjectFixReport {
            project: project.into(),
            outcomes: Vec::new(),
            fixes_applied: 0,
            fixes_failed: 0,
            files_removed: 0,
            errors: Vec::new(),
            champion: None,
            skin_number: None,
            error: Some(error.into()),
        }
    }
}

/// Progress event payload emitted during a run (mirrors `ProgressSink`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixProgress {
    pub project: String,
    /// A coarse stage label (e.g. "Extracting…", "Rebuilding WAD…").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    /// A fix-applied name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
    /// Count paired with `fix`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    /// A free-form note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_round_trips_through_json() {
        let r = ProjectFixReport {
            project: "C:/mods/aatrox".into(),
            outcomes: vec![FixOutcome {
                fix_id: "healthbar_fix".into(),
                fix_name: "Missing HP Bar".into(),
                changes: 3,
                file_path: "data/characters/aatrox/skins/skin0.bin".into(),
            }],
            fixes_applied: 1,
            fixes_failed: 0,
            files_removed: 0,
            errors: vec![],
            champion: Some("aatrox".into()),
            skin_number: Some(0),
            error: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        let back: ProjectFixReport = serde_json::from_str(&json).unwrap();
        assert_eq!(back.project, r.project);
        assert_eq!(back.outcomes.len(), 1);
        assert_eq!(back.outcomes[0].fix_id, "healthbar_fix");
        assert_eq!(back.champion.as_deref(), Some("aatrox"));
    }

    #[test]
    fn failed_report_carries_error() {
        let r = ProjectFixReport::failed("C:/mods/x", "hashes missing");
        assert_eq!(r.error.as_deref(), Some("hashes missing"));
        assert_eq!(r.fixes_applied, 0);
    }
}
