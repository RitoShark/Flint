use flint_core::bin::{
    apply_names, capture_names, meta_schema, text_to_tree, tree_to_text_cached, vfx_shape,
};

#[derive(serde::Serialize)]
pub struct ShapeFixResult {
    text: String,
    changed: usize,
    metadata_version: String,
}

#[tauri::command]
pub async fn fix_vfx_shapes(app: tauri::AppHandle, text: String) -> Result<ShapeFixResult, String> {
    super::meta_schema::refresh(&app).await;
    let schema = meta_schema::current()
        .ok_or("Class metadata is unavailable. Connect to the internet and try again.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut bin = text_to_tree(&text).map_err(|e| e.to_string())?;
        let names = capture_names(&bin, &text);
        let changed = vfx_shape::fix_shapes(&mut bin, &schema)?;
        let text = if changed == 0 {
            text
        } else {
            apply_names(
                tree_to_text_cached(&bin).map_err(|e| e.to_string())?,
                &names,
            )
        };
        Ok(ShapeFixResult {
            text,
            changed,
            metadata_version: schema.version.clone(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct BinRepairResult {
    text: String,
    report: flint_core::bin::repair::RepairReport,
    metadata_version: String,
}

#[tauri::command]
pub async fn repair_bin_issues(
    app: tauri::AppHandle,
    text: String,
    kind: flint_core::bin::repair::RepairKind,
) -> Result<BinRepairResult, String> {
    super::meta_schema::refresh(&app).await;
    let schema = meta_schema::current().unwrap_or_else(meta_schema::generation_schema);
    tauri::async_runtime::spawn_blocking(move || {
        let mut bin = text_to_tree(&text).map_err(|e| e.to_string())?;
        let captured = capture_names(&bin, &text);
        let mut dictionary = flint_core::bin::get_cached_bin_hashes().read().clone();
        for (id, name) in &captured.names {
            dictionary.insert(*id as u64, name.clone());
        }
        for (id, name) in &captured.files {
            dictionary.insert(*id, name.clone());
        }
        let report = flint_core::bin::repair::repair(&mut bin, &schema, &dictionary, kind);
        let text = if report.changed == 0 {
            text
        } else {
            let names = capture_names(&bin, &text);
            apply_names(
                tree_to_text_cached(&bin).map_err(|e| e.to_string())?,
                &names,
            )
        };
        Ok(BinRepairResult {
            text,
            report,
            metadata_version: schema.version.clone(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
