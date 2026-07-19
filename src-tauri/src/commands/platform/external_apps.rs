use std::path::{Path, PathBuf};
use std::process::Command;
use serde::{Serialize, Deserialize};

#[tauri::command]
pub async fn detect_jade_installation() -> Result<Option<String>, String> {
    let search_locations = get_jade_search_locations();

    for path in search_locations {
        if path.exists() && path.is_file() {
            tracing::info!("[external_apps] Found Jade at: {}", path.display());
            return Ok(Some(path.to_string_lossy().to_string()));
        }
    }

    tracing::info!("[external_apps] Jade not found in any search location");
    Ok(None)
}

fn get_jade_search_locations() -> Vec<PathBuf> {
    let mut locations = Vec::new();

    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        locations.push(PathBuf::from(&localappdata).join("Programs").join("Jade").join("Jade.exe"));
        locations.push(PathBuf::from(&localappdata).join("Jade").join("Jade.exe"));
        locations.push(PathBuf::from(&localappdata).join("Programs").join("Jade").join("jade-rust.exe"));
        locations.push(PathBuf::from(&localappdata).join("Jade").join("jade-rust.exe"));
        locations.push(PathBuf::from(&localappdata).join("Programs").join("jade-rust").join("jade-rust.exe"));
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        locations.push(PathBuf::from(&appdata).join("LeagueToolkit").join("Jade").join("Jade.exe"));
        locations.push(PathBuf::from(&appdata).join("LeagueToolkit").join("Jade").join("jade-rust.exe"));
    }

    locations.push(PathBuf::from("C:\\Program Files\\Jade\\Jade.exe"));
    locations.push(PathBuf::from("C:\\Program Files (x86)\\Jade\\Jade.exe"));
    locations.push(PathBuf::from("C:\\Program Files\\Jade\\jade-rust.exe"));
    locations.push(PathBuf::from("C:\\Program Files (x86)\\Jade\\jade-rust.exe"));

    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        locations.push(PathBuf::from(&userprofile).join("Desktop").join("Jade.exe"));
        locations.push(PathBuf::from(&userprofile).join("Desktop").join("jade-rust.exe"));
    }

    tracing::debug!("[external_apps] Searching {} Jade locations", locations.len());
    locations
}

#[tauri::command]
pub async fn detect_quartz_installation() -> Result<Option<String>, String> {
    let search_locations = get_quartz_search_locations();

    for path in search_locations {
        if path.exists() && path.is_file() {
            tracing::info!("[external_apps] Found Quartz at: {}", path.display());
            return Ok(Some(path.to_string_lossy().to_string()));
        }
    }

    tracing::info!("[external_apps] Quartz not found in any search location");
    Ok(None)
}

fn get_quartz_search_locations() -> Vec<PathBuf> {
    let mut locations = Vec::new();

    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        locations.push(PathBuf::from(&localappdata).join("Programs").join("Quartz").join("Quartz.exe"));
        locations.push(PathBuf::from(&localappdata).join("Quartz").join("Quartz.exe"));
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        locations.push(PathBuf::from(&appdata).join("LeagueToolkit").join("Quartz").join("Quartz.exe"));
    }

    locations.push(PathBuf::from("C:\\Program Files\\Quartz\\Quartz.exe"));
    locations.push(PathBuf::from("C:\\Program Files (x86)\\Quartz\\Quartz.exe"));

    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        locations.push(PathBuf::from(&userprofile).join("Desktop").join("Quartz.exe"));
    }

    locations
}

#[tauri::command]
pub async fn launch_jade(file_path: String, jade_path: String) -> Result<(), String> {
    let jade_exe = Path::new(&jade_path);
    let file = Path::new(&file_path);

    if !jade_exe.exists() {
        return Err(format!("Jade executable not found: {}", jade_path));
    }

    if !file.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    tracing::info!("[external_apps] Launching Jade with file: {}", file_path);

    Command::new(jade_exe)
        .arg(&file_path)
        .spawn()
        .map_err(|e| format!("Failed to launch Jade: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn launch_quartz(file_path: String, quartz_path: String) -> Result<(), String> {
    let quartz_exe = Path::new(&quartz_path);
    let file = Path::new(&file_path);

    if !quartz_exe.exists() {
        return Err(format!("Quartz executable not found: {}", quartz_path));
    }

    if !file.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    tracing::info!("[external_apps] Launching Quartz in paint mode with file: {}", file_path);

    // Hand the bin off via a CLI argument (Quartz's `--paint-bin` contract).
    // Quartz's single-instance forwards it to a running instance or opens fresh;
    // no interop temp files or directory polling.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;

        Command::new(quartz_exe)
            .args(["--paint-bin", &file_path])
            .creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to launch Quartz: {}", e))?;
    }

    #[cfg(not(windows))]
    {
        Command::new(quartz_exe)
            .args(["--paint-bin", &file_path])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to launch Quartz: {}", e))?;
    }

    Ok(())
}

/// Detected install/storage path of each external app Flint integrates with,
/// or `None` when the app isn't found.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalAppsDetection {
    pub jade: Option<String>,
    pub quartz: Option<String>,
    pub ltk_manager: Option<String>,
    pub celestial: Option<String>,
}

#[tauri::command]
pub async fn detect_external_apps(app: tauri::AppHandle) -> ExternalAppsDetection {
    use crate::commands::ltk_manager::{get_ltk_manager_mod_path, get_celestial_mod_path};

    let (jade, quartz, ltk, celestial) = tokio::join!(
        detect_jade_installation(),
        detect_quartz_installation(),
        get_ltk_manager_mod_path(app.clone()),
        get_celestial_mod_path(app),
    );

    ExternalAppsDetection {
        jade: jade.ok().flatten(),
        quartz: quartz.ok().flatten(),
        ltk_manager: ltk.ok().flatten(),
        celestial: celestial.ok().flatten(),
    }
}
