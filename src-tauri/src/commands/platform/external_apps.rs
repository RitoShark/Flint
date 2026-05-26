use std::path::{Path, PathBuf};
use std::process::Command;
use std::fs;
use serde::{Serialize, Deserialize};

/// Interop handoff message for communicating with Quartz
#[derive(Debug, Clone, Serialize, Deserialize)]
struct InteropHandoff {
    pub target_app: String,
    pub source_app: String,
    pub action: String,
    pub mode: Option<String>,
    pub bin_path: String,
    pub created_at_unix: u64,
}

/// Get the interop directory for LeagueToolkit apps
fn get_interop_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|e| format!("Failed to get APPDATA: {}", e))?;
    let dir = PathBuf::from(appdata)
        .join("LeagueToolkit")
        .join("Interop");

    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create interop dir: {}", e))?;
    }
    Ok(dir)
}

/// Write an interop handoff message for Quartz
fn write_interop_message(handoff: &InteropHandoff) -> Result<(), String> {
    let dir = get_interop_dir()?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let pid = std::process::id();

    // Use a counter to avoid conflicts if multiple messages are sent rapidly
    static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let seq = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    let filename = format!("handoff-{}-{}-{}.json", ts, pid, seq);
    let path = dir.join(filename);

    let content = serde_json::to_string_pretty(handoff)
        .map_err(|e| format!("Failed to serialize interop handoff: {}", e))?;
    fs::write(&path, content)
        .map_err(|e| format!("Failed to write interop message: {}", e))?;

    tracing::info!("[external_apps] Wrote interop handoff to: {}", path.display());
    Ok(())
}

/// Detect Jade League Bin Editor installation
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

/// Get potential Jade installation paths
fn get_jade_search_locations() -> Vec<PathBuf> {
    let mut locations = Vec::new();

    // LocalAppData\Programs\Jade\Jade.exe or jade-rust.exe (typical Tauri installation)
    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        // Jade.exe locations
        locations.push(PathBuf::from(&localappdata).join("Programs").join("Jade").join("Jade.exe"));
        locations.push(PathBuf::from(&localappdata).join("Jade").join("Jade.exe"));
        // jade-rust.exe locations
        locations.push(PathBuf::from(&localappdata).join("Programs").join("Jade").join("jade-rust.exe"));
        locations.push(PathBuf::from(&localappdata).join("Jade").join("jade-rust.exe"));
        locations.push(PathBuf::from(&localappdata).join("Programs").join("jade-rust").join("jade-rust.exe"));
    }

    // AppData\Roaming\LeagueToolkit\Jade\Jade.exe or jade-rust.exe
    if let Ok(appdata) = std::env::var("APPDATA") {
        locations.push(PathBuf::from(&appdata).join("LeagueToolkit").join("Jade").join("Jade.exe"));
        locations.push(PathBuf::from(&appdata).join("LeagueToolkit").join("Jade").join("jade-rust.exe"));
    }

    // Common installation directories
    locations.push(PathBuf::from("C:\\Program Files\\Jade\\Jade.exe"));
    locations.push(PathBuf::from("C:\\Program Files (x86)\\Jade\\Jade.exe"));
    locations.push(PathBuf::from("C:\\Program Files\\Jade\\jade-rust.exe"));
    locations.push(PathBuf::from("C:\\Program Files (x86)\\Jade\\jade-rust.exe"));

    // Desktop (users sometimes keep executables there)
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        locations.push(PathBuf::from(&userprofile).join("Desktop").join("Jade.exe"));
        locations.push(PathBuf::from(&userprofile).join("Desktop").join("jade-rust.exe"));
    }

    tracing::debug!("[external_apps] Searching {} Jade locations", locations.len());
    locations
}

/// Detect Quartz installation
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

/// Get potential Quartz installation paths
fn get_quartz_search_locations() -> Vec<PathBuf> {
    let mut locations = Vec::new();

    // LocalAppData\Programs\Quartz\Quartz.exe (typical Tauri/Electron installation)
    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        locations.push(PathBuf::from(&localappdata).join("Programs").join("Quartz").join("Quartz.exe"));
        locations.push(PathBuf::from(&localappdata).join("Quartz").join("Quartz.exe"));
    }

    // AppData\Roaming\LeagueToolkit\Quartz\Quartz.exe
    if let Ok(appdata) = std::env::var("APPDATA") {
        locations.push(PathBuf::from(&appdata).join("LeagueToolkit").join("Quartz").join("Quartz.exe"));
    }

    // Common installation directories
    locations.push(PathBuf::from("C:\\Program Files\\Quartz\\Quartz.exe"));
    locations.push(PathBuf::from("C:\\Program Files (x86)\\Quartz\\Quartz.exe"));

    // Desktop
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        locations.push(PathBuf::from(&userprofile).join("Desktop").join("Quartz.exe"));
    }

    locations
}

/// Launch Jade with a file path
#[tauri::command]
pub async fn launch_jade(file_path: String, jade_path: String) -> Result<(), String> {
    let jade_exe = Path::new(&jade_path);
    let file = Path::new(&file_path);

    // Validate Jade executable exists
    if !jade_exe.exists() {
        return Err(format!("Jade executable not found: {}", jade_path));
    }

    // Validate file exists
    if !file.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    tracing::info!("[external_apps] Launching Jade with file: {}", file_path);

    // Launch Jade with the file as argument
    Command::new(jade_exe)
        .arg(&file_path)
        .spawn()
        .map_err(|e| format!("Failed to launch Jade: {}", e))?;

    Ok(())
}

/// Launch Quartz with a file path in paint mode using Jade's interop system
#[tauri::command]
pub async fn launch_quartz(file_path: String, quartz_path: String) -> Result<(), String> {
    let quartz_exe = Path::new(&quartz_path);
    let file = Path::new(&file_path);

    // Validate Quartz executable exists
    if !quartz_exe.exists() {
        return Err(format!("Quartz executable not found: {}", quartz_path));
    }

    // Validate file exists
    if !file.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    tracing::info!("[external_apps] Launching Quartz in paint mode with file: {}", file_path);

    // Create interop handoff message (same as Jade does)
    let created_at_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let handoff = InteropHandoff {
        target_app: "quartz".to_string(),
        source_app: "flint".to_string(),
        action: "open-bin".to_string(),
        mode: Some("paint".to_string()), // Open in paint mode
        bin_path: file_path.clone(),
        created_at_unix,
    };

    // Write interop message
    write_interop_message(&handoff)?;

    // Launch Quartz (it will read the handoff file on startup)
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;

        Command::new(quartz_exe)
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
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to launch Quartz: {}", e))?;
    }

    Ok(())
}

/// Combined detection of every external app Flint knows how to integrate
/// with. Each field is the detected install/storage path, or None when the
/// app isn't found. All four probes run concurrently on the Rust side so
/// the IPC overhead is a single round-trip instead of four.
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

    // tokio::join! runs all four concurrently. Each individual probe handles
    // its own errors and returns `None` on failure, so the merged response
    // never fails as a whole.
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
