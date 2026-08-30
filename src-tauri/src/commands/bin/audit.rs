use flint_core::bin::{AuditReport, CheckIssue};
use serde::Serialize;

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
pub async fn audit_wad_folder(folder_path: String) -> Result<AuditReport, String> {
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
pub async fn audit_project_missing_refs(project_path: String) -> Result<ProjectMissingReport, String> {
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
    project_path: String,
    rel: String,
) -> Result<Vec<CheckIssue>, String> {
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
