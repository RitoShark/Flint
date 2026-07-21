//! Flint's skin-fixer engine — a thin wrapper over Hematite's
//! `hematite-orchestrate`.
//!
//! Flint calls three entry points:
//! - [`list_available_fixes`] — the fix catalog for the modal's checklist.
//! - [`scan_projects`] — detect-only pass, reports which fixes fire per project.
//! - [`run_projects`] — the real fix pass, streaming progress via a callback.
//!
//! Config (fix catalog + champion data) is fetched from GitHub with a cache and
//! an embedded fallback (see [`config`]); hashes reuse Flint's existing LMDB
//! (see [`hashes`]). The engine, providers, and their `rs_*` crates are pinned
//! to match Flint's `ritoshark` rev so exactly one copy of `rs_*` compiles.

mod config;
mod hashes;
mod report;
mod run;

pub use report::{FixEntry, FixOutcome, FixProgress, ProjectFixReport};

use hematite_orchestrate::{LiveGameProvider, ProgressSink};
use std::path::Path;

/// The fix catalog, from the loaded (remote-or-embedded) config.
pub fn list_available_fixes() -> Vec<FixEntry> {
    let cfg = config::load_config();
    hematite_orchestrate::list_fixes(&cfg.fix_config)
        .into_iter()
        .map(|f| FixEntry {
            id: f.id,
            name: f.name,
            description: f.description,
            severity: f.severity,
            enabled: f.enabled,
            wad_level: f.wad_level,
        })
        .collect()
}

/// Detect-only scan of one or more projects. Never writes to disk. Each
/// `(project_dir, label)` pair yields a report of which selected fixes fired.
/// A project that fails (missing hashes, unreadable dir) yields a report with
/// `error` set — the batch never aborts.
pub fn scan_projects(projects: &[(String, String)], fix_ids: &[String]) -> Vec<ProjectFixReport> {
    let cfg = config::load_config();
    let hash_provider = match hashes::hash_provider() {
        Ok(h) => h,
        Err(e) => {
            // No hashes → every project fails the same way.
            return projects
                .iter()
                .map(|(dir, _)| ProjectFixReport::failed(dir.clone(), e.to_string()))
                .collect();
        }
    };
    projects
        .iter()
        .map(|(dir, label)| {
            run::scan_project(
                Path::new(dir),
                label,
                fix_ids,
                &cfg.fix_config,
                &cfg.champions,
                &hash_provider,
            )
        })
        .collect()
}

/// Apply the selected fixes to one or more projects, calling `on_progress` for
/// each engine stage / applied fix. `use_live` enables live-game recovery when
/// a League install is detected (fails open when not). One project failing does
/// not abort the batch.
pub fn run_projects(
    projects: &[(String, String)],
    fix_ids: &[String],
    use_live: bool,
    mut on_progress: impl FnMut(FixProgress) + Send,
) -> Vec<ProjectFixReport> {
    let cfg = config::load_config();
    let hash_provider = match hashes::hash_provider() {
        Ok(h) => h,
        Err(e) => {
            return projects
                .iter()
                .map(|(dir, _)| ProjectFixReport::failed(dir.clone(), e.to_string()))
                .collect();
        }
    };

    let live = if use_live { detect_live() } else { None };

    // The sink is shared across the (sequential) project loop; a Mutex gives it
    // the Send+Sync ProgressSink requires without threading the callback through
    // every call. fix_folder runs synchronously on this thread, so there's no
    // real contention.
    let emit = std::sync::Mutex::new(&mut on_progress);

    projects
        .iter()
        .map(|(dir, label)| {
            let sink = CallbackSink {
                project: label.clone(),
                emit: &emit,
            };
            run::run_fixes(
                Path::new(dir),
                label,
                fix_ids,
                &cfg.fix_config,
                &cfg.champions,
                &hash_provider,
                live.as_ref(),
                &sink,
            )
        })
        .collect()
}

/// Auto-detect a League install for live-game recovery. `None` when no install
/// is found — every live feature then fails open.
fn detect_live() -> Option<LiveGameProvider> {
    let install = hematite_live::detect_league()?;
    Some(LiveGameProvider::new(
        hematite_live::GameIndex::new(&install),
        Box::new(hematite_file::bin_adapter::FileBinProvider::new()),
    ))
}

/// Adapts a Flint progress callback to Hematite's `ProgressSink`. The callback
/// is behind a `Mutex` so the sink is `Send + Sync` as the trait requires;
/// calls are serial in practice (one synchronous `fix_folder` at a time).
struct CallbackSink<'a, F: FnMut(FixProgress) + Send> {
    project: String,
    emit: &'a std::sync::Mutex<&'a mut F>,
}

impl<F: FnMut(FixProgress) + Send> ProgressSink for CallbackSink<'_, F> {
    fn stage(&self, label: &str) {
        self.push(FixProgress {
            project: self.project.clone(),
            stage: Some(label.to_string()),
            fix: None,
            count: None,
            note: None,
        });
    }
    fn fix_applied(&self, name: &str, count: Option<u32>) {
        self.push(FixProgress {
            project: self.project.clone(),
            stage: None,
            fix: Some(name.to_string()),
            count,
            note: None,
        });
    }
    fn note(&self, message: &str) {
        self.push(FixProgress {
            project: self.project.clone(),
            stage: None,
            fix: None,
            count: None,
            note: Some(message.to_string()),
        });
    }
}

impl<F: FnMut(FixProgress) + Send> CallbackSink<'_, F> {
    fn push(&self, p: FixProgress) {
        if let Ok(mut emit) = self.emit.lock() {
            (emit)(p);
        }
    }
}
