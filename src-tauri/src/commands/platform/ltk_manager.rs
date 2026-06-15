//! LTK Manager integration commands
//!
//! These commands provide integration with LTK Manager for syncing projects to the launcher.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtkManagerSettings {
    pub league_path: Option<String>,
    pub mod_storage_path: Option<String>,
    pub workshop_path: Option<String>,
    pub first_run_complete: bool,
    pub theme: String,
}

#[tauri::command]
pub async fn get_ltk_manager_mod_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tracing::info!("Reading LTK Manager settings...");

    let app_data = app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let roaming_dir = app_data
        .parent()
        .ok_or_else(|| "Failed to get parent directory".to_string())?;

    let local_dir = roaming_dir
        .parent()
        .ok_or_else(|| "Failed to get AppData parent directory".to_string())?
        .join("Local");

    // LTK Manager can live in Local or Roaming, under different dev/prod identifiers.
    let search_configs = [
        (roaming_dir, "dev.leaguetoolkit.manager"),
        (roaming_dir, "dev.leaguetoolkit.ltk-manager"),
        (roaming_dir, "com.leaguetoolkit.ltk-manager"),
        (local_dir.as_path(), "LTK Manager"),
        (local_dir.as_path(), "dev.leaguetoolkit.manager"),
        (local_dir.as_path(), "dev.leaguetoolkit.ltk-manager"),
        (local_dir.as_path(), "com.leaguetoolkit.ltk-manager"),
    ];

    for (base_dir, dir_name) in &search_configs {
        let ltk_settings_path = base_dir.join(dir_name).join("settings.json");

        tracing::info!("Looking for LTK Manager settings at: {:?}", ltk_settings_path);

        if ltk_settings_path.exists() {
            let contents = fs::read_to_string(&ltk_settings_path)
                .map_err(|e| format!("Failed to read LTK Manager settings: {}", e))?;

            let settings: LtkManagerSettings = serde_json::from_str(&contents)
                .map_err(|e| format!("Failed to parse LTK Manager settings: {}", e))?;

            if let Some(mod_path) = settings.mod_storage_path {
                tracing::info!("Found LTK Manager mod storage path: {}", mod_path);
                return Ok(Some(mod_path));
            } else {
                // No modStoragePath set — LTK Manager falls back to its app data directory.
                let ltk_data_dir = base_dir.join(dir_name);
                tracing::info!("Using LTK Manager default data directory: {:?}", ltk_data_dir);
                return Ok(Some(ltk_data_dir.to_string_lossy().to_string()));
            }
        }
    }

    tracing::warn!("LTK Manager settings file not found in any of the expected locations");
    Ok(None)
}

/// Detect the Celestial launcher's mod storage path.
///
/// Defaults to `%APPDATA%\com.divineskins.celestial\storage`; if storage was
/// moved, falls back to the launcher's data directory.
#[tauri::command]
pub async fn get_celestial_mod_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tracing::info!("Looking for Celestial launcher install...");

    let app_data = app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    let roaming_dir = app_data
        .parent()
        .ok_or_else(|| "Failed to get parent directory".to_string())?;

    // Old installs lived under `Celestial Launcher`.
    let celestial_root = roaming_dir.join("com.divineskins.celestial");
    let legacy_root = roaming_dir.join("Celestial Launcher");

    for root in [&celestial_root, &legacy_root] {
        if !root.exists() { continue; }

        let settings_path = root.join("settings.json");
        if settings_path.exists() {
            if let Ok(contents) = fs::read_to_string(&settings_path) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) {
                    if let Some(p) = value.get("modStoragePath").and_then(|v| v.as_str()) {
                        if !p.is_empty() {
                            tracing::info!("Found Celestial mod path from settings: {}", p);
                            return Ok(Some(p.to_string()));
                        }
                    }
                }
            }
        }

        let storage = root.join("storage");
        if storage.exists() {
            return Ok(Some(storage.to_string_lossy().to_string()));
        }

        return Ok(Some(root.to_string_lossy().to_string()));
    }

    tracing::warn!("Celestial launcher not found in expected locations");
    Ok(None)
}

/// Sync a Flint project to the Celestial launcher by handing it the project
/// path via a `celestial://import-flint?path=...` deep link (Celestial reads the
/// raw project folder itself, so nothing is packaged).
///
/// Returns the absolute project path that was handed over.
#[tauri::command]
pub async fn sync_project_to_celestial(project_path: String) -> Result<String, String> {
    let project_buf = PathBuf::from(&project_path);

    if !project_buf.join("flint.json").is_file() {
        return Err(format!(
            "Not a Flint project (no flint.json found at {})",
            project_path
        ));
    }

    let abs = project_buf
        .canonicalize()
        .unwrap_or(project_buf)
        .to_string_lossy()
        .to_string();
    // Strip the Windows `\\?\` verbatim prefix `canonicalize` adds — the shell
    // and Celestial want a plain path.
    let abs = abs.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(abs);
    let encoded = encode_path_component(&abs);
    let deep_link = format!("celestial://import-flint?path={}", encoded);

    tracing::info!("Launching Celestial deep link: {}", deep_link);
    launch_url(&deep_link)
        .map_err(|e| format!("Failed to launch Celestial. Is it installed? ({})", e))?;

    Ok(abs)
}

/// Percent-encode a filesystem path for use as a URL query value. Mirrors
/// JavaScript's `encodeURIComponent` for the byte set we care about — anything
/// outside the unreserved set (`A-Z a-z 0-9 - _ . ~`) is `%XX`-escaped. The
/// matching decoder lives in Celestial's `percent_decode_path`.
fn encode_path_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Launch a URL (or protocol deep link) through the OS shell.
///
/// On Windows we call `ShellExecuteW` directly instead of `opener::open` — the
/// latter shells out via `cmd /c start`, which flashes a console window every
/// time. `ShellExecuteW` resolves the protocol handler with no console window.
#[cfg(windows)]
fn launch_url(url: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let to_wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let verb = to_wide("open");
    let file = to_wide(url);

    // SAFETY: all PCWSTRs point at null-terminated buffers that outlive the call.
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW returns an HINSTANCE > 32 on success; <= 32 is an error code.
    if result.0 as usize > 32 {
        Ok(())
    } else {
        Err(format!("ShellExecuteW failed (code {})", result.0 as usize))
    }
}

#[cfg(not(windows))]
fn launch_url(url: &str) -> Result<(), String> {
    opener::open(url).map_err(|e| e.to_string())
}

/// Package a Flint project as `.fantome`, install it into LTK Manager's
/// library, and return the installed mod ID.
#[tauri::command]
pub async fn sync_project_to_launcher(
    project_path: String,
    ltk_storage_path: String,
) -> Result<String, String> {
    let sync_start = Instant::now();
    tracing::info!("Syncing project to launcher: {}", project_path);

    let project_path_buf = PathBuf::from(&project_path);
    let ltk_storage_buf = PathBuf::from(&ltk_storage_path);

    let project = flint_ltk::project::open_project(&project_path_buf)
        .map_err(|e| format!("Failed to open project: {}", e))?;

    tracing::info!("Loaded project: {} v{}", project.name, project.version);

    let package_start = Instant::now();
    let temp_dir = std::env::temp_dir();
    let fantome_filename = format!("{}.fantome", project.name);
    let fantome_path = temp_dir.join(&fantome_filename);

    tracing::info!("Packaging project to: {:?}", fantome_path);

    package_project(&project_path_buf, &fantome_path)
        .map_err(|e| format!("Failed to package project: {}", e))?;

    tracing::info!("Successfully packaged project as .fantome in {:.2}s", package_start.elapsed().as_secs_f32());

    let install_start = Instant::now();
    let mod_id = install_to_ltk_manager(&fantome_path, &ltk_storage_buf)
        .map_err(|e| format!("Failed to install to LTK Manager: {}", e))?;

    tracing::info!("Successfully installed to LTK Manager with ID: {} in {:.2}s", mod_id, install_start.elapsed().as_secs_f32());
    tracing::info!("Total sync time: {:.2}s", sync_start.elapsed().as_secs_f32());

    let _ = fs::remove_file(&fantome_path);

    Ok(mod_id)
}

fn package_project(project_path: &std::path::Path, output_path: &std::path::Path) -> Result<(), String> {
    use flint_ltk::export::build_wad_from_directory;
    use flint_ltk::ltk_types::{ModProject, ModProjectAuthor};
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    let mod_config_path = project_path.join("mod.config.json");
    let config_data = std::fs::read_to_string(&mod_config_path)
        .map_err(|e| format!("Failed to read mod.config.json: {}", e))?;

    let mod_project: ModProject = serde_json::from_str(&config_data)
        .map_err(|e| format!("Failed to parse mod.config.json: {}", e))?;

    let content_base = project_path.join("content").join("base");
    if !content_base.exists() {
        return Err("Project content/base directory not found".to_string());
    }

    let file = std::fs::File::create(output_path)
        .map_err(|e| format!("Failed to create output file: {}", e))?;
    let mut zip = ZipWriter::new(file);

    for entry in std::fs::read_dir(&content_base)
        .map_err(|e| format!("Failed to read content/base: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_dir()
            && path
                .file_name()
                .map(|n| n.to_string_lossy().ends_with(".wad.client"))
                .unwrap_or(false)
        {
            let wad_name = path.file_name().unwrap().to_string_lossy().to_string();
            let wad_bytes = build_wad_from_directory(&path)?;

            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file(format!("WAD/{}", wad_name), options)
                .map_err(|e| format!("Failed to create WAD entry: {}", e))?;
            zip.write_all(&wad_bytes)
                .map_err(|e| format!("Failed to write WAD: {}", e))?;

            tracing::info!("Packed WAD/{} ({} bytes)", wad_name, wad_bytes.len());
        }
    }

    let author_str = if mod_project.authors.is_empty() {
        "Unknown".to_string()
    } else {
        mod_project.authors.iter().map(|a| match a {
            ModProjectAuthor::Name(name) => name.clone(),
            ModProjectAuthor::Role { name, .. } => name.clone(),
        }).collect::<Vec<_>>().join(", ")
    };

    let info = serde_json::json!({
        "Name": mod_project.display_name,
        "Author": author_str,
        "Version": mod_project.version,
        "Description": mod_project.description,
    });

    let meta_options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("META/info.json", meta_options)
        .map_err(|e| format!("Failed to create info.json: {}", e))?;
    zip.write_all(
        serde_json::to_string_pretty(&info)
            .map_err(|e| format!("Failed to serialize info.json: {}", e))?
            .as_bytes(),
    )
    .map_err(|e| format!("Failed to write info.json: {}", e))?;

    zip.finish()
        .map_err(|e| format!("Failed to finalize ZIP: {}", e))?;

    Ok(())
}

fn install_to_ltk_manager(
    fantome_path: &std::path::Path,
    ltk_storage_path: &std::path::Path,
) -> Result<String, String> {
    use uuid::Uuid;
    use std::io::Read;

    let fantome_file = fs::File::open(fantome_path)
        .map_err(|e| format!("Failed to open fantome: {}", e))?;
    let mut archive = zip::ZipArchive::new(fantome_file)
        .map_err(|e| format!("Failed to read fantome ZIP: {}", e))?;

    let mod_name = {
        let mut info_file = archive.by_name("META/info.json")
            .map_err(|e| format!("Failed to find META/info.json in fantome: {}", e))?;
        let mut info_str = String::new();
        info_file.read_to_string(&mut info_str)
            .map_err(|e| format!("Failed to read info.json: {}", e))?;
        let info: serde_json::Value = serde_json::from_str(&info_str)
            .map_err(|e| format!("Failed to parse info.json: {}", e))?;
        info.get("Name").and_then(|n| n.as_str()).unwrap_or("Unknown").to_string()
    };

    let library_path = ltk_storage_path.join("library.json");
    let existing_mod_id = if library_path.exists() {
        let contents = fs::read_to_string(&library_path)
            .map_err(|e| format!("Failed to read library.json: {}", e))?;
        let library: LibraryIndex = serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse library.json: {}", e))?;

        library.mods.iter()
            .find(|m| {
                let mod_dir = ltk_storage_path.join("mods").join(&m.id);
                if let Ok(config_contents) = fs::read_to_string(mod_dir.join("mod.config.json")) {
                    if let Ok(config) = serde_json::from_str::<serde_json::Value>(&config_contents) {
                        if let Some(name) = config.get("name").and_then(|n| n.as_str()) {
                            return name == mod_name;
                        }
                    }
                }
                false
            })
            .map(|m| m.id.clone())
    } else {
        None
    };

    let (mod_id, _is_update) = if let Some(existing_id) = existing_mod_id {
        tracing::info!("Updating existing mod with ID: {}", existing_id);
        (existing_id, true)
    } else {
        let new_id = Uuid::new_v4().to_string();
        tracing::info!("Creating new mod with ID: {}", new_id);
        (new_id, false)
    };

    let archives_dir = ltk_storage_path.join("archives");
    fs::create_dir_all(&archives_dir)
        .map_err(|e| format!("Failed to create archives directory: {}", e))?;

    let archive_dest = archives_dir.join(format!("{}.fantome", mod_id));
    fs::copy(fantome_path, &archive_dest)
        .map_err(|e| format!("Failed to copy fantome to archives: {}", e))?;

    let mods_dir = ltk_storage_path.join("mods").join(&mod_id);
    fs::create_dir_all(&mods_dir)
        .map_err(|e| format!("Failed to create mods metadata directory: {}", e))?;

    let fantome_file2 = fs::File::open(fantome_path)
        .map_err(|e| format!("Failed to reopen fantome: {}", e))?;
    let mut archive2 = zip::ZipArchive::new(fantome_file2)
        .map_err(|e| format!("Failed to re-read fantome ZIP: {}", e))?;

    let mod_config = {
        let mut info_file = archive2.by_name("META/info.json")
            .map_err(|e| format!("Failed to find META/info.json: {}", e))?;
        let mut info_str = String::new();
        info_file.read_to_string(&mut info_str)
            .map_err(|e| format!("Failed to read info.json: {}", e))?;
        let info: serde_json::Value = serde_json::from_str(&info_str)
            .map_err(|e| format!("Failed to parse info.json: {}", e))?;

        serde_json::json!({
            "name": info.get("Name").and_then(|n| n.as_str()).unwrap_or("Unknown"),
            "display_name": info.get("Name").and_then(|n| n.as_str()).unwrap_or("Unknown"),
            "version": info.get("Version").and_then(|v| v.as_str()).unwrap_or("1.0.0"),
            "description": info.get("Description").and_then(|d| d.as_str()).unwrap_or(""),
            "authors": [info.get("Author").and_then(|a| a.as_str()).unwrap_or("Unknown")],
        })
    };

    let config_json = serde_json::to_string_pretty(&mod_config)
        .map_err(|e| format!("Failed to serialize project config: {}", e))?;

    fs::write(mods_dir.join("mod.config.json"), config_json)
        .map_err(|e| format!("Failed to write mod.config.json: {}", e))?;

    update_library_index(ltk_storage_path, &mod_id, "fantome")
        .map_err(|e| format!("Failed to update library index: {}", e))?;

    Ok(mod_id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryIndex {
    mods: Vec<LibraryModEntry>,
    profiles: Vec<Profile>,
    active_profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryModEntry {
    id: String,
    installed_at: String,
    format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    name: String,
    slug: String,
    enabled_mods: Vec<String>,
    mod_order: Vec<String>,
    created_at: String,
    last_used: String,
}

impl Default for LibraryIndex {
    fn default() -> Self {
        use uuid::Uuid;
        let default_profile = Profile {
            id: Uuid::new_v4().to_string(),
            name: "Default".to_string(),
            slug: "default".to_string(),
            enabled_mods: Vec::new(),
            mod_order: Vec::new(),
            created_at: Utc::now().to_rfc3339(),
            last_used: Utc::now().to_rfc3339(),
        };
        Self {
            mods: Vec::new(),
            profiles: vec![default_profile.clone()],
            active_profile_id: default_profile.id,
        }
    }
}

fn update_library_index(ltk_storage_path: &std::path::Path, mod_id: &str, format: &str) -> Result<(), String> {
    let library_path = ltk_storage_path.join("library.json");

    let mut library: LibraryIndex = if library_path.exists() {
        let contents = fs::read_to_string(&library_path)
            .map_err(|e| format!("Failed to read library.json: {}", e))?;
        serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse library.json: {}", e))?
    } else {
        LibraryIndex::default()
    };

    let existing_mod = library.mods.iter_mut().find(|m| m.id == mod_id);

    if let Some(existing) = existing_mod {
        existing.installed_at = Utc::now().to_rfc3339();
        tracing::info!("Updated existing mod entry in library");
    } else {
        library.mods.push(LibraryModEntry {
            id: mod_id.to_string(),
            installed_at: Utc::now().to_rfc3339(),
            format: format.to_string(),
        });
        tracing::info!("Added new mod entry to library");

        if let Some(profile) = library.profiles.iter_mut().find(|p| p.id == library.active_profile_id) {
            profile.mod_order.push(mod_id.to_string());
        }
    }

    let contents = serde_json::to_string_pretty(&library)
        .map_err(|e| format!("Failed to serialize library index: {}", e))?;

    fs::write(&library_path, contents)
        .map_err(|e| format!("Failed to write library.json: {}", e))?;

    Ok(())
}
