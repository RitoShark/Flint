use flint_core::league::{detect_league_installation, validate_league_path, LeagueInstallation};

#[tauri::command]
pub async fn detect_league() -> Result<LeagueInstallation, String> {
    tracing::info!("Frontend requested League detection");
    
    tokio::task::spawn_blocking(move || {
        detect_league_installation()
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn validate_league(path: String) -> Result<LeagueInstallation, String> {
    tracing::info!("Frontend requested validation for path: {}", path);
    
    tokio::task::spawn_blocking(move || {
        validate_league_path(&path)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
    .map_err(|e| e.to_string())
}
