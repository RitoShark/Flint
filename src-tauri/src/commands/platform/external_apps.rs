use flint_core::path_slash::to_slash;
use std::path::{Path, PathBuf};
use std::process::Command;
use serde::{Serialize, Deserialize};

#[tauri::command]
pub async fn detect_jade_installation() -> Result<Option<String>, String> {
    let search_locations = get_jade_search_locations();

    for path in search_locations {
        if path.exists() && path.is_file() {
            tracing::info!("[external_apps] Found Jade at: {}", path.display());
            return Ok(Some(to_slash(&path)));
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
            return Ok(Some(to_slash(&path)));
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

// =============================================================================
// RubyRe (VFX previewer) — detection is fully automatic, no configured path.
// Resolution order mirrors Quartz's `resolve_ruby` in jade.rs: Start-menu
// "RubyRe.lnk", then "Ruby.lnk" (both names are in the wild), then a fallback
// scan of the usual install folders.
// =============================================================================

/// Result of an attempt to reach RubyRe. `launched: None` with a `warning` is
/// a normal "not installed" outcome, not an error — same contract as Quartz's
/// `ruby_open`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RubyLaunchResult {
    pub launched: Option<String>,
    pub warning: Option<String>,
}

#[cfg(target_os = "windows")]
fn start_menu_shortcut(name: &str) -> Option<PathBuf> {
    let leaf = format!("{name}.lnk");
    let user = std::env::var_os("APPDATA").map(PathBuf::from).map(|root| {
        root.join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join(&leaf)
    });
    let machine = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .map(|root| {
            root.join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join(&leaf)
        });
    user.into_iter().chain(machine).find(|path| path.is_file())
}

/// Non-recursive scan of a folder for the first `.exe` in it — RubyRe's
/// installer names its binary after the product, but we don't assume the
/// exact casing/name here, just that it's the only exe an install folder has.
#[cfg(target_os = "windows")]
fn scan_dir_for_exe(dir: &Path) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    walkdir::WalkDir::new(dir)
        .max_depth(1)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .find(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        })
        .map(|entry| entry.path().to_path_buf())
}

#[cfg(target_os = "windows")]
fn ruby_install_scan() -> Option<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        dirs.push(PathBuf::from(&localappdata).join("RubyRe"));
        dirs.push(PathBuf::from(&localappdata).join("Programs").join("RubyRe"));
    }
    dirs.push(PathBuf::from("C:\\Program Files\\RubyRe"));
    dirs.push(PathBuf::from("C:\\Program Files (x86)\\RubyRe"));
    dirs.into_iter().find_map(|dir| scan_dir_for_exe(&dir))
}

#[cfg(target_os = "windows")]
fn resolve_ruby() -> Option<PathBuf> {
    start_menu_shortcut("RubyRe")
        .or_else(|| start_menu_shortcut("Ruby"))
        .or_else(ruby_install_scan)
}

#[cfg(not(target_os = "windows"))]
fn resolve_ruby() -> Option<PathBuf> {
    None
}

#[tauri::command]
pub async fn detect_ruby_installation() -> Result<Option<String>, String> {
    match resolve_ruby() {
        Some(path) => {
            tracing::info!("[external_apps] Found RubyRe at: {}", path.display());
            Ok(Some(to_slash(&path)))
        }
        None => {
            tracing::info!("[external_apps] RubyRe not found in any search location");
            Ok(None)
        }
    }
}

fn validate_ruby_bin_path(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !path.is_file() {
        return Err(format!("BIN path was not found: {}", path.display()));
    }
    let supported = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "bin" | "py" | "ritobin"));
    if !supported {
        return Err("RubyRe can only open .bin, .py, or .ritobin files.".to_string());
    }
    // Canonicalize to resolve `..` and symlinks, then DROP the `\\?\` prefix it adds
    // on Windows. RubyRe derives its project root from this path and appends asset
    // paths to it; `\\?\` paths are used verbatim by the filesystem, so a forward
    // slash in an appended asset path never resolves. See Quartz's jade.rs for the
    // full story (an unstripped `\\?\` path opened the bin but showed no textures).
    let canonical = std::fs::canonicalize(&path).unwrap_or(path);
    Ok(strip_extended_prefix(canonical))
}

/// Drop a Windows extended-length `\\?\` prefix, leaving `\\?\UNC\...` alone
/// (stripping that yields `UNC\server\...`, which is not a usable path).
fn strip_extended_prefix(path: PathBuf) -> PathBuf {
    let stripped = {
        let text = path.to_string_lossy();
        text.strip_prefix(r"\\?\")
            .filter(|rest| !rest.starts_with("UNC\\"))
            .map(PathBuf::from)
    };
    stripped.unwrap_or(path)
}

#[cfg(target_os = "windows")]
fn shell_open_ruby(target: &Path, bin_path: Option<&Path>) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let to_wide = |s: &std::ffi::OsStr| -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    };
    let verb = to_wide(std::ffi::OsStr::new("open"));
    let file = to_wide(target.as_os_str());
    let params = bin_path.map(|path| {
        let quoted = format!("\"{}\"", path.display());
        to_wide(std::ffi::OsStr::new(&quoted))
    });

    // SAFETY: all PCWSTRs point at null-terminated buffers that outlive the call.
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            params.as_ref().map_or(PCWSTR::null(), |value| PCWSTR(value.as_ptr())),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW returns an HINSTANCE > 32 on success; <= 32 is an error code.
    if result.0 as usize > 32 {
        Ok(())
    } else {
        Err(format!(
            "Windows could not start RubyRe (ShellExecute code {}).",
            result.0 as usize
        ))
    }
}

#[cfg(not(target_os = "windows"))]
fn shell_open_ruby(_target: &Path, _bin_path: Option<&Path>) -> Result<(), String> {
    Err("Opening RubyRe is currently supported on Windows only.".to_string())
}

/// Sends a BIN to RubyRe, or just launches RubyRe standalone when `file_path`
/// is `None`. Mirrors Quartz's `ruby_open`: "not installed" comes back as
/// `launched: None` + a `warning`, not an `Err`, so the caller can show a
/// prompt instead of a failure toast.
#[tauri::command]
pub async fn launch_ruby(file_path: Option<String>) -> Result<RubyLaunchResult, String> {
    let bin_path = file_path.as_deref().map(validate_ruby_bin_path).transpose()?;

    let Some(target) = resolve_ruby() else {
        return Ok(RubyLaunchResult {
            launched: None,
            warning: Some("RubyRe is not installed.".to_string()),
        });
    };

    shell_open_ruby(&target, bin_path.as_deref())?;
    Ok(RubyLaunchResult {
        launched: Some(target.to_string_lossy().into_owned()),
        warning: None,
    })
}

/// Detected install/storage path of each external app Flint integrates with,
/// or `None` when the app isn't found.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalAppsDetection {
    pub jade: Option<String>,
    pub quartz: Option<String>,
    pub ltk_manager: Option<String>,
    pub celestial: Option<String>,
    pub ruby: Option<String>,
}

#[tauri::command]
pub async fn detect_external_apps(app: tauri::AppHandle) -> ExternalAppsDetection {
    use crate::commands::ltk_manager::{get_ltk_manager_mod_path, get_celestial_mod_path};

    let (jade, quartz, ltk, celestial, ruby) = tokio::join!(
        detect_jade_installation(),
        detect_quartz_installation(),
        get_ltk_manager_mod_path(),
        get_celestial_mod_path(app),
        detect_ruby_installation(),
    );

    ExternalAppsDetection {
        jade: jade.ok().flatten(),
        quartz: quartz.ok().flatten(),
        ltk_manager: ltk.ok().flatten(),
        celestial: celestial.ok().flatten(),
        ruby: ruby.ok().flatten(),
    }
}
