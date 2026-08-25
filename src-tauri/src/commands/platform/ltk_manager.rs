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

/// LTK Manager can live in Local or Roaming, under different dev/prod identifiers.
const LTK_DIR_NAMES: [&str; 4] = [
    "dev.leaguetoolkit.manager",
    "dev.leaguetoolkit.ltk-manager",
    "com.leaguetoolkit.ltk-manager",
    "LTK Manager",
];

/// The first LTK Manager data directory that holds a readable `settings.json`,
/// with those settings.
fn ltk_settings() -> Option<(PathBuf, LtkManagerSettings)> {
    let roots = ["APPDATA", "LOCALAPPDATA"]
        .iter()
        .filter_map(|var| std::env::var_os(var).map(PathBuf::from));

    for root in roots {
        for name in LTK_DIR_NAMES {
            let data_dir = root.join(name);
            let settings_path = data_dir.join("settings.json");
            if !settings_path.is_file() {
                continue;
            }
            match fs::read_to_string(&settings_path)
                .ok()
                .and_then(|contents| serde_json::from_str::<LtkManagerSettings>(&contents).ok())
            {
                Some(settings) => return Some((data_dir, settings)),
                None => tracing::warn!("Could not parse {}", settings_path.display()),
            }
        }
    }

    None
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// The workshop directory LTK Manager scans for authored projects, if one is set.
fn ltk_workshop_dir() -> Option<PathBuf> {
    let (_, settings) = ltk_settings()?;
    non_empty(settings.workshop_path).map(PathBuf::from)
}

#[tauri::command]
pub async fn get_ltk_manager_mod_path() -> Result<Option<String>, String> {
    let Some((data_dir, settings)) = ltk_settings() else {
        tracing::warn!("LTK Manager settings file not found in any of the expected locations");
        return Ok(None);
    };

    // No modStoragePath set — LTK Manager falls back to its app data directory.
    let storage = non_empty(settings.mod_storage_path)
        .unwrap_or_else(|| data_dir.to_string_lossy().to_string());
    tracing::info!("LTK Manager mod storage path: {}", storage);
    Ok(Some(storage))
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

/// Where a sync landed, so the toast can name it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherSyncResult {
    /// `"workshop"` or `"library"`.
    pub target: String,
    /// The workshop project directory, or the library mod id.
    pub location: String,
    pub files_copied: usize,
    pub files_removed: usize,
}

/**
Hand a Flint project to LTK Manager.

The **workshop** is LTK Manager's authoring side — the projects a user is making — and the
**library** is the other side, the mods they installed. A project open in Flint is being
authored, so it belongs in the workshop; the library only gets it once it ships. So the
workshop wins whenever `workshopPath` is set, and the old package-and-install path is the
fallback for a user who has never configured one.

A workshop project and a Flint project are the same thing on disk — `mod.config.json` beside
a `content/<layer>/` tree — so this mirrors the folder rather than packaging anything.
*/
#[tauri::command]
pub async fn sync_project_to_launcher(
    project_path: String,
    ltk_storage_path: String,
) -> Result<LauncherSyncResult, String> {
    let sync_start = Instant::now();
    let project_path_buf = PathBuf::from(&project_path);

    let project = flint_core::project::open_project(&project_path_buf)
        .map_err(|e| format!("Failed to open project: {}", e))?;

    tracing::info!("Syncing project {} v{}", project.name, project.version);

    if let Some(workshop) = ltk_workshop_dir() {
        let result = mirror_project_to_workshop(&project_path_buf, &project.name, &workshop)?;
        tracing::info!(
            "Synced to workshop {} ({} copied, {} removed) in {:.2}s",
            result.location,
            result.files_copied,
            result.files_removed,
            sync_start.elapsed().as_secs_f32()
        );
        return Ok(result);
    }

    tracing::info!("No workshop path configured — installing into the LTK Manager library");

    let fantome_path = std::env::temp_dir().join(format!("{}.fantome", project.name));
    package_project(&project_path_buf, &fantome_path)
        .map_err(|e| format!("Failed to package project: {}", e))?;

    let mod_id = install_to_ltk_manager(&fantome_path, &PathBuf::from(&ltk_storage_path))
        .map_err(|e| format!("Failed to install to LTK Manager: {}", e))?;

    let _ = fs::remove_file(&fantome_path);

    tracing::info!(
        "Installed to the LTK Manager library as {} in {:.2}s",
        mod_id,
        sync_start.elapsed().as_secs_f32()
    );

    Ok(LauncherSyncResult {
        target: "library".to_string(),
        location: mod_id,
        files_copied: 0,
        files_removed: 0,
    })
}

/// LTK Manager's own rule for a project directory name: lowercase alphanumeric and hyphens.
fn workshop_slug(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.extend(ch.to_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "flint-project".to_string()
    } else {
        slug
    }
}

fn is_wad_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".wad.client") || lower.ends_with(".wad") || lower.ends_with(".wad.mobile")
}

/**
Every file to mirror, as `(source, destination-relative path)`.

Older Flint projects put the WAD straight under `content/` with no layer directory. LTK
Manager reads each child of `content/` AS a layer, so that shape would show up as a layer
named `yone.wad.client` holding the game's own tree. Those are rehomed under `content/base/`,
which is what `mod.config.json` already declares.
*/
fn workshop_mirror_plan(project_root: &std::path::Path) -> Result<Vec<(PathBuf, String)>, String> {
    let mut plan = Vec::new();

    for name in ["mod.config.json", "flint.json", "thumbnail.webp", "thumbnail.png"] {
        let path = project_root.join(name);
        if path.is_file() {
            plan.push((path, name.to_string()));
        }
    }

    let content = project_root.join("content");
    if !content.is_dir() {
        return Err("Project has no content/ directory".to_string());
    }

    let legacy = fs::read_dir(&content)
        .map_err(|e| format!("Failed to read content/: {}", e))?
        .filter_map(|e| e.ok())
        .any(|e| e.path().is_dir() && is_wad_name(&e.file_name().to_string_lossy()));

    for entry in walkdir::WalkDir::new(&content).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(&content)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace(char::from(92), "/");
        let dest = if legacy {
            format!("content/base/{rel}")
        } else {
            format!("content/{rel}")
        };
        plan.push((entry.path().to_path_buf(), dest));
    }

    Ok(plan)
}

/// Whether the mirrored copy is already current: same size, and not older than the source.
///
/// `fs::copy` stamps the destination with the time of the copy, so an untouched file always
/// reads as newer than its source on the next pass and an edited one always reads as older.
fn up_to_date(source: &std::path::Path, dest: &std::path::Path) -> bool {
    let (Ok(a), Ok(b)) = (fs::metadata(source), fs::metadata(dest)) else {
        return false;
    };
    if a.len() != b.len() {
        return false;
    }
    match (a.modified(), b.modified()) {
        (Ok(source_time), Ok(dest_time)) => dest_time >= source_time,
        _ => false,
    }
}

/**
Copy the project into `<workshop>/<slug>/`, then drop whatever `content/` still holds that
the project no longer has.

Incremental on purpose: the auto-sync watcher fires on every save and a champion project is
a few hundred megabytes, so unchanged files are skipped on size + mtime. Pruning is confined
to `content/` — LTK Manager keeps its own per-project state beside the config, and a sync
must not delete it.
*/
fn mirror_project_to_workshop(
    project_root: &std::path::Path,
    project_name: &str,
    workshop: &std::path::Path,
) -> Result<LauncherSyncResult, String> {
    let dest_root = workshop.join(workshop_slug(project_name));
    let plan = workshop_mirror_plan(project_root)?;

    fs::create_dir_all(&dest_root)
        .map_err(|e| format!("Failed to create {}: {}", dest_root.display(), e))?;

    let mut copied = 0usize;
    let mut wanted = std::collections::HashSet::new();

    for (source, rel) in &plan {
        let dest = dest_root.join(rel);
        wanted.insert(dest.clone());

        if up_to_date(source, &dest) {
            continue;
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
        }
        fs::copy(source, &dest)
            .map_err(|e| format!("Failed to copy {}: {}", source.display(), e))?;
        copied += 1;
    }

    let mut removed = 0usize;
    let dest_content = dest_root.join("content");
    if dest_content.is_dir() {
        for entry in walkdir::WalkDir::new(&dest_content)
            .contents_first(true)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() && !wanted.contains(entry.path()) {
                if fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            } else if entry.file_type().is_dir() {
                let _ = fs::remove_dir(entry.path());
            }
        }
    }

    Ok(LauncherSyncResult {
        target: "workshop".to_string(),
        location: dest_root.to_string_lossy().to_string(),
        files_copied: copied,
        files_removed: removed,
    })
}

fn package_project(project_path: &std::path::Path, output_path: &std::path::Path) -> Result<(), String> {
    use flint_core::export::build_wad_from_directory;
    use flint_core::project::{ModProject, ModProjectAuthor};
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

/* LANDMINE — `extra` is what stops a sync from deleting LTK Manager's own data. `library.json`
   carries fields Flint has no reason to model (`version`, `folders`, `folderOrder`, a profile's
   `layerStates`), and this struct is read-modify-WRITE, so anything not captured here is dropped
   on the next sync. Never remove the flattened maps. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryIndex {
    mods: Vec<LibraryModEntry>,
    profiles: Vec<Profile>,
    active_profile_id: String,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryModEntry {
    id: String,
    installed_at: String,
    format: String,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
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
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
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
            extra: serde_json::Map::new(),
        };
        Self {
            mods: Vec::new(),
            profiles: vec![default_profile.clone()],
            active_profile_id: default_profile.id,
            extra: serde_json::Map::new(),
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
            extra: serde_json::Map::new(),
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

#[cfg(test)]
mod workshop_tests {
    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "flint-ltk-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn write(&self, rel: &str, body: &str) -> PathBuf {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, body).unwrap();
            path
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn a_slug_is_lowercase_alphanumeric_and_hyphens() {
        assert_eq!(workshop_slug("AngelSteel Kayn"), "angelsteel-kayn");
        assert_eq!(workshop_slug("HEARTSTEEL Kayn Chromas"), "heartsteel-kayn-chromas");
        assert_eq!(workshop_slug("Saya-Evelynn"), "saya-evelynn");
        assert_eq!(workshop_slug("project-yone"), "project-yone");
        assert_eq!(workshop_slug("  Travis  Scott  Jhin  "), "travis-scott-jhin");
        assert_eq!(workshop_slug("Skin_69"), "skin-69");
        assert_eq!(workshop_slug("!!!"), "flint-project");
    }

    /// The layer directory is what LTK Manager reads as a layer, so a legacy project whose WAD
    /// sits straight under `content/` has to be rehomed or the WAD's own name becomes the layer.
    #[test]
    fn a_legacy_project_is_rehomed_under_base() {
        let root = TempRoot::new("legacy");
        root.write("mod.config.json", "{}");
        root.write("content/yone.wad.client/data/x.bin", "x");

        let plan = workshop_mirror_plan(&root.0).unwrap();
        let dests: Vec<&str> = plan.iter().map(|(_, d)| d.as_str()).collect();

        assert!(dests.contains(&"mod.config.json"));
        assert!(dests.contains(&"content/base/yone.wad.client/data/x.bin"), "{dests:?}");
    }

    #[test]
    fn a_layered_project_is_mirrored_as_is() {
        let root = TempRoot::new("layered");
        root.write("mod.config.json", "{}");
        root.write("flint.json", "{}");
        root.write("thumbnail.webp", "img");
        root.write("content/base/kayn.wad.client/data/x.bin", "x");
        root.write("content/cacoon/kayn.wad.client/data/y.bin", "y");

        let plan = workshop_mirror_plan(&root.0).unwrap();
        let dests: Vec<&str> = plan.iter().map(|(_, d)| d.as_str()).collect();

        assert!(dests.contains(&"content/base/kayn.wad.client/data/x.bin"), "{dests:?}");
        assert!(dests.contains(&"content/cacoon/kayn.wad.client/data/y.bin"), "{dests:?}");
        assert!(dests.contains(&"thumbnail.webp"));
        assert!(dests.contains(&"flint.json"));
        assert!(dests.iter().all(|d| !d.contains("content/base/base")));
    }

    #[test]
    fn a_second_sync_copies_only_what_changed_and_drops_what_went_away() {
        let source = TempRoot::new("mirror-src");
        let workshop = TempRoot::new("mirror-dst");
        source.write("mod.config.json", "{}");
        source.write("content/base/a.wad.client/one.bin", "one");
        source.write("content/base/a.wad.client/two.bin", "two");

        let first = mirror_project_to_workshop(&source.0, "My Skin", &workshop.0).unwrap();
        assert_eq!(first.target, "workshop");
        assert_eq!(first.files_copied, 3);
        assert_eq!(first.files_removed, 0);

        let dest = workshop.0.join("my-skin");
        assert!(dest.join("content/base/a.wad.client/one.bin").is_file());

        // Nothing touched: the mirror must not re-copy a single file.
        let second = mirror_project_to_workshop(&source.0, "My Skin", &workshop.0).unwrap();
        assert_eq!(second.files_copied, 0, "unchanged files were re-copied");
        assert_eq!(second.files_removed, 0);

        // One edited, one gone.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        source.write("content/base/a.wad.client/one.bin", "one-edited");
        fs::remove_file(source.0.join("content/base/a.wad.client/two.bin")).unwrap();

        let third = mirror_project_to_workshop(&source.0, "My Skin", &workshop.0).unwrap();
        assert_eq!(third.files_copied, 1, "the edit did not travel");
        assert_eq!(third.files_removed, 1, "the deletion did not travel");
        assert_eq!(
            fs::read_to_string(dest.join("content/base/a.wad.client/one.bin")).unwrap(),
            "one-edited"
        );
        assert!(!dest.join("content/base/a.wad.client/two.bin").exists());
    }

    /// LTK Manager keeps its own per-project state beside the config; a sync must not sweep it.
    #[test]
    fn pruning_never_reaches_outside_content() {
        let source = TempRoot::new("prune-src");
        let workshop = TempRoot::new("prune-dst");
        source.write("mod.config.json", "{}");
        source.write("content/base/a.wad.client/one.bin", "one");

        mirror_project_to_workshop(&source.0, "keep", &workshop.0).unwrap();

        let dest = workshop.0.join("keep");
        fs::write(dest.join("editor-state.json"), "ltk's own").unwrap();

        let again = mirror_project_to_workshop(&source.0, "keep", &workshop.0).unwrap();
        assert_eq!(again.files_removed, 0);
        assert!(dest.join("editor-state.json").is_file(), "LTK Manager's own file was deleted");
    }

    /**
    `library.json` is read-modify-write, and the live file carries fields Flint does not model.
    Without the flattened `extra` maps a sync silently deleted the user's folder layout, their
    profiles' layer states and the schema version.
    */
    #[test]
    fn installing_into_the_library_keeps_fields_flint_does_not_model() {
        let storage = TempRoot::new("library");
        let original = serde_json::json!({
            "version": 1,
            "mods": [{ "id": "abc", "installedAt": "2026-05-19T14:31:50Z", "format": "fantome", "pinned": true }],
            "profiles": [{
                "id": "p1", "name": "Default", "slug": "default",
                "enabledMods": [], "modOrder": ["abc"], "layerStates": { "abc": { "base": true } },
                "createdAt": "2026-03-06T15:23:18Z", "lastUsed": "2026-03-06T15:23:18Z"
            }],
            "activeProfileId": "p1",
            "folders": [{ "id": "root", "name": "", "modIds": ["abc"] }],
            "folderOrder": ["root"]
        });
        fs::write(
            storage.0.join("library.json"),
            serde_json::to_string_pretty(&original).unwrap(),
        )
        .unwrap();

        update_library_index(&storage.0, "new-mod", "fantome").unwrap();

        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(storage.0.join("library.json")).unwrap())
                .unwrap();

        assert_eq!(after["version"], 1);
        assert_eq!(after["folders"], original["folders"]);
        assert_eq!(after["folderOrder"], original["folderOrder"]);
        assert_eq!(after["profiles"][0]["layerStates"], original["profiles"][0]["layerStates"]);
        assert_eq!(after["mods"][0]["pinned"], true);
        assert_eq!(after["mods"].as_array().unwrap().len(), 2);
    }
}
