use flint_ltk::hud::{parse_hud_file, serialize_hud_file, HudData};
use std::fs;
use std::path::PathBuf;

#[tauri::command]
pub async fn parse_hud_ritobin_file(file_path: String) -> Result<HudData, String> {
    tracing::info!("Parsing HUD ritobin file: {}", file_path);

    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let data = parse_hud_file(&content)
        .map_err(|e| format!("Failed to parse HUD file: {}", e))?;

    tracing::info!("Successfully parsed {} HUD entries", data.entries.len());
    Ok(data)
}

#[tauri::command]
pub async fn save_hud_ritobin_file(
    file_path: String,
    data: HudData,
    original_content: String,
) -> Result<(), String> {
    tracing::info!("Saving HUD ritobin file: {}", file_path);

    let serialized = serialize_hud_file(&data, &original_content)
        .map_err(|e| format!("Failed to serialize HUD data: {}", e))?;

    fs::write(&file_path, serialized)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    tracing::info!("Successfully saved HUD file");
    Ok(())
}

#[tauri::command]
pub async fn create_hud_project(
    project_name: String,
    creator_name: String,
    description: String,
    projects_dir: String,
) -> Result<String, String> {
    tracing::info!("Creating HUD project: {}", project_name);

    let safe_name = sanitize_project_name(&project_name);
    let project_path = PathBuf::from(&projects_dir).join(&safe_name);

    if project_path.exists() {
        return Err(format!("Project already exists: {}", safe_name));
    }

    // Create project structure
    fs::create_dir_all(&project_path)
        .map_err(|e| format!("Failed to create project directory: {}", e))?;

    let content_dir = project_path.join("content");
    fs::create_dir_all(&content_dir)
        .map_err(|e| format!("Failed to create content directory: {}", e))?;

    // Create default HUD file structure path
    let hud_base_path = content_dir.join("UI.wad.client/clientstates/loadingscreen/ux/loadingscreenclassic/uibase");
    fs::create_dir_all(&hud_base_path)
        .map_err(|e| format!("Failed to create HUD directory structure: {}", e))?;

    // Create project metadata
    let metadata = serde_json::json!({
        "name": project_name,
        "creator": creator_name,
        "description": description,
        "project_type": "hud_editor",
        "version": "1.0.0",
        "created_at": chrono::Utc::now().to_rfc3339(),
        "hud_file_path": "UI.wad.client/clientstates/loadingscreen/ux/loadingscreenclassic/uibase/uibase.ritobin"
    });

    let config_path = project_path.join("project.json");
    fs::write(
        config_path,
        serde_json::to_string_pretty(&metadata).unwrap(),
    )
    .map_err(|e| format!("Failed to write project config: {}", e))?;

    tracing::info!("Successfully created HUD project at: {}", project_path.display());
    Ok(project_path.to_string_lossy().to_string())
}

fn sanitize_project_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[tauri::command]
pub async fn get_hud_file_stats(file_path: String) -> Result<HudFileStats, String> {
    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let data = parse_hud_file(&content)
        .map_err(|e| format!("Failed to parse HUD file: {}", e))?;

    let mut stats = HudFileStats {
        total_elements: data.entries.len(),
        by_type: std::collections::HashMap::new(),
        by_layer: std::collections::HashMap::new(),
    };

    for entry in data.entries.values() {
        *stats.by_type.entry(entry.entry_type.clone()).or_insert(0) += 1;
        *stats.by_layer.entry(entry.layer).or_insert(0) += 1;
    }

    Ok(stats)
}

#[derive(serde::Serialize)]
pub struct HudFileStats {
    pub total_elements: usize,
    pub by_type: std::collections::HashMap<String, usize>,
    pub by_layer: std::collections::HashMap<u32, usize>,
}
