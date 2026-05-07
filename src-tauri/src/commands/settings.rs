use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Current schema version — bump when the settings shape changes
const SCHEMA_VERSION: u32 = 1;

/// All user-facing settings, persisted to `%APPDATA%/Flint/settings.json`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlintSettings {
    /// Schema version for future migrations
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,

    // League paths
    pub league_path: Option<String>,
    pub league_path_pbe: Option<String>,
    pub default_project_path: Option<String>,

    // User info
    pub creator_name: Option<String>,
    #[serde(default)]
    pub creator_description: Option<String>,
    #[serde(default)]
    pub creator_home: Option<String>,
    #[serde(default)]
    pub creator_tip: Option<String>,

    // Update preferences
    #[serde(default = "default_true")]
    pub auto_update_enabled: bool,
    pub skipped_update_version: Option<String>,

    // Recent / saved projects
    #[serde(default)]
    pub recent_projects: Vec<serde_json::Value>,
    #[serde(default)]
    pub saved_projects: Vec<serde_json::Value>,

    // LTK Manager
    pub ltk_manager_mod_path: Option<String>,
    #[serde(default)]
    pub auto_sync_to_launcher: bool,

    // Celestial launcher
    #[serde(default)]
    pub celestial_mod_path: Option<String>,
    /// Which launcher Flint should sync into when "Sync to Launcher" runs.
    /// Values: "ltk" | "celestial". Falls back to whichever has a path set.
    #[serde(default)]
    pub preferred_launcher: Option<String>,

    // BIN converter
    #[serde(default = "default_bin_engine")]
    pub bin_converter_engine: String,
    pub jade_path: Option<String>,
    pub quartz_path: Option<String>,

    // Theme
    pub selected_theme: Option<String>,
}

fn default_schema_version() -> u32 { SCHEMA_VERSION }
fn default_true() -> bool { true }
fn default_bin_engine() -> String { "jade".to_string() }

impl Default for FlintSettings {
    fn default() -> Self {
        let default_projects = get_flint_home()
            .map(|h| h.join("projects").to_string_lossy().into_owned())
            .ok();
        Self {
            schema_version: SCHEMA_VERSION,
            league_path: None,
            league_path_pbe: None,
            default_project_path: default_projects,
            creator_name: None,
            creator_description: None,
            creator_home: None,
            creator_tip: None,
            auto_update_enabled: true,
            skipped_update_version: None,
            recent_projects: vec![],
            saved_projects: vec![],
            ltk_manager_mod_path: None,
            auto_sync_to_launcher: false,
            celestial_mod_path: None,
            preferred_launcher: None,
            bin_converter_engine: "jade".to_string(),
            jade_path: None,
            quartz_path: None,
            selected_theme: None,
        }
    }
}

// =============================================================================
// App home directory
// =============================================================================

/// Returns `%APPDATA%/Flint` — the canonical app home.
pub fn get_flint_home() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "APPDATA environment variable not found".to_string())?;
    Ok(PathBuf::from(appdata).join("Flint"))
}

/// Ensures the full folder scaffold exists under `%APPDATA%/Flint/`.
pub fn ensure_folder_structure() -> Result<PathBuf, String> {
    let home = get_flint_home()?;
    let dirs = [
        home.join("projects"),
        home.join("themes"),
        home.join("cache").join("images"),
        home.join("logs"),
        home.join("backups"),
    ];
    for dir in &dirs {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    }
    Ok(home)
}

/// Path to the settings file.
fn settings_path() -> Result<PathBuf, String> {
    Ok(get_flint_home()?.join("settings.json"))
}

// =============================================================================
// Read / Write
// =============================================================================

fn read_settings_from_disk() -> Result<FlintSettings, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(FlintSettings::default());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read settings: {}", e))?;
    let settings: FlintSettings = serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse settings: {}", e))?;
    Ok(settings)
}

fn write_settings_to_disk(settings: &FlintSettings) -> Result<(), String> {
    let path = settings_path()?;
    // Ensure parent exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write settings: {}", e))?;
    Ok(())
}

// =============================================================================
// Startup initialization
// =============================================================================

/// Called once from `main.rs` setup — creates folder scaffold.
pub fn initialize_app_home() -> Result<PathBuf, String> {
    let home = ensure_folder_structure()?;
    tracing::info!("Flint home: {}", home.display());
    Ok(home)
}

// =============================================================================
// Tauri commands
// =============================================================================

/// Returns the Flint home directory path.
#[tauri::command]
pub fn get_app_home() -> Result<String, String> {
    get_flint_home().map(|p| p.to_string_lossy().into_owned())
}

/// Load settings from disk. Returns defaults if file doesn't exist yet.
#[tauri::command]
pub fn get_settings() -> Result<FlintSettings, String> {
    read_settings_from_disk()
}

/// Persist settings to disk.
#[tauri::command]
pub fn save_settings(settings: FlintSettings) -> Result<(), String> {
    write_settings_to_disk(&settings)
}

/// Migrate projects from old `%APPDATA%/RitoShark/Flint/Projects` to new `%APPDATA%/Flint/projects/`.
/// Moves each project folder, then updates paths in settings.json (saved/recent projects, defaultProjectPath).
/// Skips projects that already exist in the destination. Safe to call multiple times.
#[tauri::command]
pub fn migrate_projects() -> Result<MigrateProjectsResult, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "APPDATA not found".to_string())?;
    let old_dir = PathBuf::from(&appdata).join("RitoShark").join("Flint").join("Projects");
    let new_dir = get_flint_home()?.join("projects");

    let mut moved = 0u32;
    let mut skipped = 0u32;

    if !old_dir.exists() {
        return Ok(MigrateProjectsResult { moved, skipped });
    }

    std::fs::create_dir_all(&new_dir)
        .map_err(|e| format!("Failed to create projects dir: {}", e))?;

    // Move each sub-directory (each is a project)
    let entries: Vec<_> = std::fs::read_dir(&old_dir)
        .map_err(|e| format!("Failed to read old projects dir: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();

    for entry in &entries {
        let name = entry.file_name();
        let dest = new_dir.join(&name);

        if dest.exists() {
            skipped += 1;
            continue;
        }

        // Try rename (fast, same volume). Fall back to copy+delete.
        if std::fs::rename(entry.path(), &dest).is_err() {
            copy_dir_recursive(&entry.path(), &dest)?;
            std::fs::remove_dir_all(entry.path()).ok(); // best-effort cleanup
        }
        moved += 1;
    }

    // Update paths in settings.json
    if moved > 0 {
        let old_prefix = old_dir.to_string_lossy().replace('\\', "/");
        let new_prefix = new_dir.to_string_lossy().replace('\\', "/");

        if let Ok(mut settings) = read_settings_from_disk() {
            // Update defaultProjectPath
            if let Some(ref dp) = settings.default_project_path {
                let normalized = dp.replace('\\', "/");
                if normalized == old_prefix || normalized.starts_with(&format!("{}/", old_prefix)) {
                    settings.default_project_path = Some(normalized.replacen(&old_prefix, &new_prefix, 1));
                }
            }

            // Update recent/saved project paths
            let rewrite_path = |val: &mut serde_json::Value| {
                if let Some(obj) = val.as_object_mut() {
                    if let Some(p) = obj.get_mut("path") {
                        if let Some(s) = p.as_str() {
                            let normalized = s.replace('\\', "/");
                            if normalized.starts_with(&format!("{}/", old_prefix)) {
                                *p = serde_json::Value::String(
                                    normalized.replacen(&old_prefix, &new_prefix, 1),
                                );
                            }
                        }
                    }
                }
            };
            for rp in &mut settings.recent_projects {
                rewrite_path(rp);
            }
            for sp in &mut settings.saved_projects {
                rewrite_path(sp);
            }
            write_settings_to_disk(&settings).ok();
        }

        tracing::info!("Project migration: moved {} projects, skipped {}", moved, skipped);
    }

    Ok(MigrateProjectsResult { moved, skipped })
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrateProjectsResult {
    pub moved: u32,
    pub skipped: u32,
}

fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create dir {}: {}", dest.display(), e))?;
    for entry in std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read dir {}: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            std::fs::copy(&src_path, &dest_path)
                .map_err(|e| format!("Failed to copy {}: {}", src_path.display(), e))?;
        }
    }
    Ok(())
}

// =============================================================================
// Theme commands
// =============================================================================

/// A theme file from `%APPDATA%/Flint/themes/`
#[derive(Debug, Clone, Serialize)]
pub struct ThemeInfo {
    /// Filename without extension (e.g. "midnight-blue")
    pub id: String,
    /// Display name from the JSON `name` field, or id if missing
    pub name: String,
}

/// List all `.json` theme files in the themes directory.
#[tauri::command]
pub fn list_themes() -> Result<Vec<ThemeInfo>, String> {
    let themes_dir = get_flint_home()?.join("themes");
    if !themes_dir.exists() {
        return Ok(vec![]);
    }

    let mut themes = Vec::new();
    for entry in std::fs::read_dir(&themes_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            let id = path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();

            // Try to read `name` from JSON, fall back to filename
            let name = std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
                .unwrap_or_else(|| id.clone());

            themes.push(ThemeInfo { id, name });
        }
    }

    Ok(themes)
}

/// Read a theme JSON file. Returns the full JSON object.
#[tauri::command]
pub fn load_theme(theme_id: String) -> Result<serde_json::Value, String> {
    let path = get_flint_home()?.join("themes").join(format!("{}.json", theme_id));
    if !path.exists() {
        return Err(format!("Theme '{}' not found", theme_id));
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read theme: {}", e))?;
    serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse theme: {}", e))
}

/// Seed the 5 built-in preset themes into the themes directory if they don't
/// already exist. Idempotent — won't overwrite a user's edits.
///
/// Called from the first-time setup wizard so the theme picker has real
/// JSON files to bind to instead of synthetic in-memory presets.
#[tauri::command]
pub fn seed_builtin_themes() -> Result<(), String> {
    let themes_dir = get_flint_home()?.join("themes");
    std::fs::create_dir_all(&themes_dir).map_err(|e| e.to_string())?;

    // Rename legacy presets that have since been re-branded.
    let lily = themes_dir.join("lilypad.json");
    let froggy = themes_dir.join("froggy.json");
    if lily.exists() && !froggy.exists() {
        let _ = std::fs::rename(&lily, &froggy);
    }
    // Flint is now the *default* (lives in index.css :root) — no JSON file
    // needed. Nuke any legacy `flint.json` we seeded earlier so the picker's
    // "Flint" card resolves to setSelectedTheme(null) → bare defaults.
    let legacy_flint = themes_dir.join("flint.json");
    if legacy_flint.exists() {
        let _ = std::fs::remove_file(&legacy_flint);
    }

    let presets: [(&str, serde_json::Value); 4] = [
        // Each theme keeps the bg scale near-neutral dark with only a faint
        // tint, so the accent does the heavy lifting and the surface doesn't
        // feel saturated. Hex values picked to sit visually next to the
        // default Flint #111111 / #181818 / #1e1e1e / #252525 ladder.
        ("celestial", serde_json::json!({
            "name": "Celestial",
            "colors": {
                "--accent-primary": "#A05CF6",
                "--accent-hover": "#884ED1",
                "--accent-secondary": "#C084FC",
                "--accent-muted": "#5B2C9C",
                "--accent-gold": "#dcb67a",
                "--button-primary": "#A05CF6",
                "--button-secondary": "#1c1a22",
                "--bg-primary": "#111014",
                "--bg-secondary": "#15141a",
                "--bg-tertiary": "#1c1a22",
                "--bg-hover": "#22202a",
                "--border": "#2a2832",
                "--text-primary": "#dcdce6",
                "--text-secondary": "#9d9aac",
                "--text-muted": "#6c697a",
                "--input-bg": "#15141a",
                "--input-border": "#2a2832",
                "--selection-bg": "#2a1f3c",
                "--current-line": "#1a181f",
                "--scrollbar-track": "#111014",
                "--scrollbar-thumb": "#2c2a36",
                "--scrollbar-thumb-hover": "#3a3848"
            }
        })),
        ("jade", serde_json::json!({
            "name": "Jade",
            "colors": {
                "--accent-primary": "#06B6D4",
                "--accent-hover": "#0891B2",
                "--accent-secondary": "#22D3EE",
                "--accent-muted": "#155E75",
                "--accent-gold": "#dcb67a",
                "--button-primary": "#06B6D4",
                "--button-secondary": "#181d20",
                "--bg-primary": "#101316",
                "--bg-secondary": "#13171b",
                "--bg-tertiary": "#181d20",
                "--bg-hover": "#1f2528",
                "--border": "#262d31",
                "--text-primary": "#d8e1e6",
                "--text-secondary": "#9aa6ad",
                "--text-muted": "#697279",
                "--input-bg": "#13171b",
                "--input-border": "#262d31",
                "--selection-bg": "#1c2e35",
                "--current-line": "#181c20",
                "--scrollbar-track": "#101316",
                "--scrollbar-thumb": "#283036",
                "--scrollbar-thumb-hover": "#384248"
            }
        })),
        ("froggy", serde_json::json!({
            "name": "Froggy",
            "colors": {
                "--accent-primary": "#22C55E",
                "--accent-hover": "#16A34A",
                "--accent-secondary": "#4ADE80",
                "--accent-muted": "#15803D",
                "--accent-gold": "#dcb67a",
                "--button-primary": "#22C55E",
                "--button-secondary": "#181d18",
                "--bg-primary": "#10130f",
                "--bg-secondary": "#141813",
                "--bg-tertiary": "#181d18",
                "--bg-hover": "#1f261f",
                "--border": "#262d26",
                "--text-primary": "#d8e1d8",
                "--text-secondary": "#9aa69a",
                "--text-muted": "#697269",
                "--input-bg": "#141813",
                "--input-border": "#262d26",
                "--selection-bg": "#1d3326",
                "--current-line": "#171c17",
                "--scrollbar-track": "#10130f",
                "--scrollbar-thumb": "#283028",
                "--scrollbar-thumb-hover": "#384238"
            }
        })),
        ("quartz", serde_json::json!({
            "name": "Quartz",
            "colors": {
                "--accent-primary": "#EC4899",
                "--accent-hover": "#DB2777",
                "--accent-secondary": "#F472B6",
                "--accent-muted": "#9D174D",
                "--accent-gold": "#dcb67a",
                "--button-primary": "#EC4899",
                "--button-secondary": "#1d1a1c",
                "--bg-primary": "#131013",
                "--bg-secondary": "#171417",
                "--bg-tertiary": "#1d1a1c",
                "--bg-hover": "#262226",
                "--border": "#2d292c",
                "--text-primary": "#e1d8de",
                "--text-secondary": "#a69aa1",
                "--text-muted": "#726972",
                "--input-bg": "#171417",
                "--input-border": "#2d292c",
                "--selection-bg": "#321c2c",
                "--current-line": "#1c181b",
                "--scrollbar-track": "#131013",
                "--scrollbar-thumb": "#302830",
                "--scrollbar-thumb-hover": "#423842"
            }
        })),
    ];

    // Always overwrite the built-in presets — they're shipped, not user-
    // authored. Users wanting customization should use `create_default_theme`
    // which writes a separate `custom.json`.
    for (id, json) in presets.iter() {
        let path = themes_dir.join(format!("{}.json", id));
        let pretty = serde_json::to_string_pretty(json)
            .map_err(|e| format!("Failed to serialize {}: {}", id, e))?;
        std::fs::write(&path, pretty)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
        tracing::debug!("Wrote built-in theme: {}", id);
    }
    Ok(())
}

/// Write a default theme template to the themes directory for users to customize.
#[tauri::command]
pub fn create_default_theme() -> Result<String, String> {
    let path = get_flint_home()?.join("themes").join("custom.json");
    if path.exists() {
        return Ok(path.to_string_lossy().into_owned());
    }

    let template = serde_json::json!({
        "name": "Custom Theme",
        "colors": {
            "--accent-primary": "#EF4444",
            "--accent-hover": "#DC2626",
            "--accent-secondary": "#F87171",
            "--accent-muted": "#991B1B",
            "--button-primary": "#EF4444",
            "--bg-primary": "#111111",
            "--bg-secondary": "#111111",
            "--bg-tertiary": "#181818",
            "--bg-hover": "#1e1e1e",
            "--border": "#252525",
            "--text-primary": "#c0c0c0",
            "--text-secondary": "#a0a0a0",
            "--text-muted": "#707070",
            "--input-bg": "#1a1a1a",
            "--input-border": "#252525",
            "--success": "#3FB950",
            "--warning": "#D29922",
            "--error": "#F85149"
        }
    });

    let json = serde_json::to_string_pretty(&template)
        .map_err(|e| format!("Failed to serialize template: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write theme: {}", e))?;

    Ok(path.to_string_lossy().into_owned())
}

/// One-time migration: frontend sends the old localStorage blob,
/// we merge it into settings.json (only if settings.json doesn't exist yet).
#[tauri::command]
pub fn migrate_from_localstorage(legacy_json: String) -> Result<(), String> {
    let path = settings_path()?;

    // Only migrate if settings.json doesn't exist yet
    if path.exists() {
        tracing::debug!("settings.json already exists, skipping localStorage migration");
        return Ok(());
    }

    // Parse the Zustand persist blob — it wraps state in { state: { ... }, version: N }
    let blob: serde_json::Value = serde_json::from_str(&legacy_json)
        .map_err(|e| format!("Failed to parse localStorage blob: {}", e))?;

    let state = blob.get("state").unwrap_or(&blob);

    let settings = FlintSettings {
        schema_version: SCHEMA_VERSION,
        league_path: state.get("leaguePath").and_then(|v| v.as_str()).map(String::from),
        league_path_pbe: state.get("leaguePathPbe").and_then(|v| v.as_str()).map(String::from),
        default_project_path: state.get("defaultProjectPath").and_then(|v| v.as_str()).map(String::from),
        creator_name: state.get("creatorName").and_then(|v| v.as_str()).map(String::from),
        creator_description: state.get("creatorDescription").and_then(|v| v.as_str()).map(String::from),
        creator_home: state.get("creatorHome").and_then(|v| v.as_str()).map(String::from),
        creator_tip: state.get("creatorTip").and_then(|v| v.as_str()).map(String::from),
        auto_update_enabled: state.get("autoUpdateEnabled").and_then(|v| v.as_bool()).unwrap_or(true),
        skipped_update_version: state.get("skippedUpdateVersion").and_then(|v| v.as_str()).map(String::from),
        recent_projects: state.get("recentProjects").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
        saved_projects: state.get("savedProjects").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
        ltk_manager_mod_path: state.get("ltkManagerModPath").and_then(|v| v.as_str()).map(String::from),
        auto_sync_to_launcher: state.get("autoSyncToLauncher").and_then(|v| v.as_bool()).unwrap_or(false),
        celestial_mod_path: state.get("celestialModPath").and_then(|v| v.as_str()).map(String::from),
        preferred_launcher: state.get("preferredLauncher").and_then(|v| v.as_str()).map(String::from),
        bin_converter_engine: state.get("binConverterEngine").and_then(|v| v.as_str()).unwrap_or("ltk").to_string(),
        jade_path: state.get("jadePath").and_then(|v| v.as_str()).map(String::from),
        quartz_path: state.get("quartzPath").and_then(|v| v.as_str()).map(String::from),
        selected_theme: None, // localStorage never had this field
    };

    // Backup the raw blob
    let backup_dir = get_flint_home()?.join("backups");
    std::fs::create_dir_all(&backup_dir).ok();
    let backup_path = backup_dir.join("pre-migration-localstorage.json");
    std::fs::write(&backup_path, &legacy_json).ok();

    write_settings_to_disk(&settings)?;
    tracing::info!("Migrated localStorage settings to {}", path.display());
    Ok(())
}
