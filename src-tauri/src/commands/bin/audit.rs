use flint_core::bin::AuditReport;

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
