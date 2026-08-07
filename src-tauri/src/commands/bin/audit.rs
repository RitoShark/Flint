use flint_core::bin::AuditReport;
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

        let mut report = ProjectMissingReport::default();
        for folder in folders {
            let wad = folder
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let audit = flint_core::bin::audit_wad_folder(&folder)?;

            report.bins_scanned += audit.bins_scanned;
            report.bins_failed += audit.bins_failed;
            report.total_missing += audit.missing.len();
            if !audit.missing.is_empty() {
                report.wads.push(WadMissingRefs {
                    wad,
                    missing: audit.missing,
                });
            }
        }
        Ok(report)
    })
    .await
    .map_err(|e| format!("Audit task failed: {}", e))?
}
