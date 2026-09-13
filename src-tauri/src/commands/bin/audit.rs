use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use flint_core::bin::{AuditReport, CheckIssue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct WadMissingRefs {
    pub wad: String,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ProjectMissingReport {
    pub wads: Vec<WadMissingRefs>,
    pub total_missing: usize,
    pub bins_scanned: usize,
    pub bins_failed: usize,
    /// Crash-risk findings across every WAD, criticals first.
    pub issues: Vec<CheckIssue>,
    pub total_critical: usize,
}

/** Audits an unpacked `.wad.client` folder: which referenced assets are absent, and
which present files nothing references. The walk parses every BIN in the tree, so it
runs on a blocking thread. */
#[tauri::command]
pub async fn audit_wad_folder(app: tauri::AppHandle, folder_path: String) -> Result<AuditReport, String> {
    super::meta_schema::refresh(&app).await;
    tokio::task::spawn_blocking(move || {
        flint_core::bin::audit_wad_folder(std::path::Path::new(&folder_path))
    })
    .await
    .map_err(|e| format!("Audit task failed: {}", e))?
}

/** Audits every `.wad.client` folder an export would ship, keeping only the missing
references. Runs before packaging so an author can stop and fix a broken skin instead of
shipping one that loads magenta. */
#[tauri::command]
pub async fn audit_project_missing_refs(app: tauri::AppHandle, project_path: String) -> Result<ProjectMissingReport, String> {
    super::meta_schema::refresh(&app).await;
    tokio::task::spawn_blocking(move || {
        let folders =
            flint_core::export::project_wad_folders(std::path::Path::new(&project_path))?;

        use rayon::prelude::*;
        let audits: Vec<(String, Result<AuditReport, String>)> = folders
            .par_iter()
            .map(|folder| {
                let wad = folder
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                (wad, flint_core::bin::audit_wad_folder(folder))
            })
            .collect();

        let mut report = ProjectMissingReport::default();
        for (wad, audit) in audits {
            let audit = audit?;

            report.bins_scanned += audit.bins_scanned;
            report.bins_failed += audit.bins_failed;
            report.total_missing += audit.missing.len();
            for mut issue in audit.issues {
                issue.file = format!("{wad}/{}", issue.file);
                report.issues.push(issue);
            }
            if !audit.missing.is_empty() {
                report.wads.push(WadMissingRefs {
                    wad,
                    missing: audit.missing,
                });
            }
        }

        report.issues.sort_by(|a, b| {
            a.severity
                .cmp(&b.severity)
                .then_with(|| a.file.cmp(&b.file))
                .then_with(|| a.code.cmp(b.code))
        });
        report.total_critical = report
            .issues
            .iter()
            .filter(|i| i.severity == flint_core::bin::Severity::Critical)
            .count();

        Ok(report)
    })
    .await
    .map_err(|e| format!("Audit task failed: {}", e))?
}

/** Re-checks one project file after an edit, so a fix clears its tag without waiting for
the next project-wide sweep.

`rel` is `<wad folder>/<path inside it>` — the same shape `issue.file` carries, so the
frontend can hand back exactly what it was given. */
#[tauri::command]
pub async fn recheck_project_file(
    app: tauri::AppHandle,
    project_path: String,
    rel: String,
) -> Result<Vec<CheckIssue>, String> {
    super::meta_schema::refresh(&app).await;
    tokio::task::spawn_blocking(move || {
        let rel = rel.replace('\\', "/");
        let Some((wad, inner)) = rel.split_once('/') else {
            return Ok(Vec::new());
        };
        let folder = std::path::Path::new(&project_path)
            .join("content")
            .join("base")
            .join(wad);
        if !folder.is_dir() {
            return Ok(Vec::new());
        }
        let mut issues = flint_core::bin::check_one_file(&folder, inner)?;
        for issue in &mut issues {
            issue.file = format!("{wad}/{}", issue.file);
        }
        Ok(issues)
    })
    .await
    .map_err(|e| format!("Recheck task failed: {}", e))?
}

/// One declaration retype an audit finding says is safe to apply.
#[derive(Debug, Clone, Deserialize)]
pub struct RetypeRequest {
    /// Folder-relative path, exactly as `CheckIssue.file` carries it.
    pub file: String,
    pub field: String,
    pub from: String,
    pub to: String,
    pub lines: Vec<u32>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RetypeReport {
    pub files_changed: usize,
    pub declarations_changed: usize,
    /// Lines that no longer declared what the finding saw, as `<file>:<line>`.
    pub stale: Vec<String>,
    pub errors: Vec<String>,
    /// Name of the restore point taken before anything was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
}

/**
Applies every retype in `fixes` to the bins under `folder_path`.

Grouped by file so a bin is rendered, rewritten and saved ONCE however many findings it
carries. The write goes through the editor's own save path (`encode_capturing_names` then
`merge_into_files_txt`): a `string` to `file` retype hashes the path, and that is the only
thing that records the readable name beside the mod. Editing the tree directly would be
correct for the client and would lose the name everywhere else.
*/
#[tauri::command]
pub async fn fix_bin_retypes(
    app: tauri::AppHandle,
    folder_path: String,
    fixes: Vec<RetypeRequest>,
) -> Result<RetypeReport, String> {
    let _t = crate::core::ipc_trace::enter("fix_bin_retypes");
    if fixes.is_empty() {
        return Ok(RetypeReport::default());
    }

    let folder = PathBuf::from(&folder_path);
    let checkpoint = restore_point(&app, &folder, fixes.len()).await;

    tokio::task::spawn_blocking(move || {
        let mut by_file: BTreeMap<String, Vec<RetypeRequest>> = BTreeMap::new();
        for fix in fixes {
            by_file.entry(fix.file.clone()).or_default().push(fix);
        }

        let mut report = RetypeReport {
            checkpoint,
            ..Default::default()
        };
        for (file, fixes) in by_file {
            match retype_one_bin(&folder.join(&file), &fixes) {
                Ok(outcome) => {
                    if outcome.changed > 0 {
                        report.files_changed += 1;
                        report.declarations_changed += outcome.changed;
                    }
                    report
                        .stale
                        .extend(outcome.stale.iter().map(|line| format!("{file}:{line}")));
                }
                Err(e) => report.errors.push(format!("{file}: {e}")),
            }
        }
        Ok(report)
    })
    .await
    .map_err(|e| format!("Retype task failed: {}", e))?
}

struct RetypeOutcome {
    changed: usize,
    stale: Vec<u32>,
}

fn retype_one_bin(path: &Path, fixes: &[RetypeRequest]) -> Result<RetypeOutcome, String> {
    let data = std::fs::read(path).map_err(|e| format!("Failed to read: {e}"))?;
    let bin = flint_core::bin::read_bin(&data).map_err(|e| format!("{e}"))?;
    let mut text = flint_core::bin::render_bin_text(&bin, path).map_err(|e| format!("{e}"))?;

    let mut changed = 0usize;
    let mut stale = Vec::new();
    for fix in fixes {
        let result = flint_core::bin::apply_type_fix(&text, &fix.field, &fix.from, &fix.to, &fix.lines);
        changed += result.changed.len();
        stale.extend(result.stale);
        text = result.text;
    }
    if changed == 0 {
        return Ok(RetypeOutcome { changed, stale });
    }

    let (bytes, trailer) = super::bin::encode_capturing_names(&text)?;
    crate::core::write_echo::mark(path);
    std::fs::write(path, &bytes).map_err(|e| format!("Failed to write: {e}"))?;
    super::bin::merge_into_files_txt(path, &trailer);
    flint_core::bin::forget_mod_root(path);

    Ok(RetypeOutcome { changed, stale })
}

/// One restore point before the batch. A folder outside a Flint project has nowhere to
/// put one, which is reported rather than treated as a failure.
async fn restore_point(app: &tauri::AppHandle, folder: &Path, count: usize) -> Option<String> {
    let project = flint_core::mesh::discovery::find_project_root(folder)?;
    let message = format!(
        "Before fixing {count} declaration{}",
        if count == 1 { "" } else { "s" }
    );
    match crate::commands::checkpoint::create_checkpoint(
        app.clone(),
        project.to_string_lossy().to_string(),
        message,
        vec!["fix".to_string()],
    )
    .await
    {
        Ok(checkpoint) => Some(checkpoint.id),
        Err(e) => {
            tracing::warn!("retype fix: could not create a restore point: {e}");
            None
        }
    }
}
