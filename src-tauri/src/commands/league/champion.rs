use flint_ltk::champion::{
    discover_champions as core_discover_champions,
    get_champion_skins as core_get_champion_skins,
    ChampionInfo, SkinInfo,
};
use std::path::PathBuf;

#[tauri::command]
pub async fn discover_champions(league_path: String) -> Result<Vec<ChampionInfo>, String> {
    tracing::info!("Frontend requested champion discovery for: {}", league_path);

    let path = PathBuf::from(league_path);

    tokio::task::spawn_blocking(move || core_discover_champions(&path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_champion_skins(
    league_path: String,
    champion: String,
) -> Result<Vec<SkinInfo>, String> {
    tracing::info!("Frontend requested skins for: {}", champion);

    let path = PathBuf::from(league_path);

    tokio::task::spawn_blocking(move || core_get_champion_skins(&path, &champion))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
        .map_err(|e| e.to_string())
}

