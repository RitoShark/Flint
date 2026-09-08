//! Creating, loading, and saving Flint mod projects in the league-mod format.

use crate::error::{Error, Result};
use chrono::{DateTime, Utc};
use ltk_mod_project::{ModProject, ModProjectAuthor, ModProjectLayer, default_layers};
use serde::{Deserialize, Deserializer, Serialize};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};

const PROJECT_FILE: &str = "mod.config.json";

const FLINT_FILE: &str = "flint.json";

/// Drives which fields in `flint.json` are meaningful. Persisted as kebab-case
/// (`"skin" | "map" | "loading-screen" | "tft"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectKind {
    #[default]
    Skin,
    Map,
    LoadingScreen,
    Tft,
}

impl ProjectKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProjectKind::Skin => "skin",
            ProjectKind::Map => "map",
            ProjectKind::LoadingScreen => "loading-screen",
            ProjectKind::Tft => "tft",
        }
    }
}

fn is_zero_u32(v: &u32) -> bool { *v == 0 }
fn is_empty_string(s: &str) -> bool { s.is_empty() }

fn is_false(v: &bool) -> bool { !*v }

/// Where the project's assets came from. Everything here is fixed at creation
/// and is what later passes need to reason about the project: which patch the
/// bytes were pulled from, whether it was Live or PBE, and which slice of the
/// WAD was taken.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FlintSource {
    /// Champion internal name (e.g. "Ahri"). Skin projects only.
    #[serde(default, skip_serializing_if = "is_empty_string")]
    pub champion: String,

    /// Skin ID, or the chroma's skin number when a chroma was picked.
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub skin_id: u32,

    /// Map id (e.g. "map11"). Map projects only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_id: Option<String>,

    /// Map variant base name (e.g. "srx_baseworld"). Map projects only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,

    /// Full game build the assets were extracted from, e.g. "16.17.8104348",
    /// read from `Game/content-metadata.json`. Riot retypes BIN fields between
    /// patches, so a checker needs to know what the project was built against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_version: Option<String>,

    /// "live" or "pbe".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// What the extraction actually pulled, so a later pass can tell the difference
/// between "the mod does not touch sounds" and "the sounds were left stock".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FlintExtract {
    #[serde(default, skip_serializing_if = "is_false")]
    pub sfx: bool,

    #[serde(default, skip_serializing_if = "is_false")]
    pub vo: bool,
}

pub const FLINT_SCHEMA: u32 = 2;

/// Flint-specific metadata, stored beside mod.config.json. Schema 1 was a flat
/// bag that also carried an absolute `league_path`; those files still load, but
/// the path is never written back — it went stale whenever League moved and it
/// leaked the user's Windows account name into anything they shared.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlintMetadata {
    #[serde(default)]
    pub schema: u32,

    /// Stable project id (UUID v4); the index tracks moves/renames by it.
    #[serde(default)]
    pub pid: String,

    /// Older files default to Skin.
    #[serde(default)]
    pub kind: ProjectKind,

    #[serde(default)]
    pub source: FlintSource,

    /// The `ASSETS/<creator>/<project>` segment the repath actually wrote.
    /// Renames and anything resolving an asset path need the value that was
    /// used, not one re-derived from the current name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repath_prefix: Option<String>,

    #[serde(default)]
    pub extract: FlintExtract,

    pub created_at: DateTime<Utc>,

    pub modified_at: DateTime<Utc>,

    // ── schema 1, read so old projects keep their identity, never written ──
    #[serde(default, skip_serializing)]
    pub champion: String,

    #[serde(default, skip_serializing)]
    pub skin_id: u32,

    #[serde(default, skip_serializing)]
    pub map_id: Option<String>,

    #[serde(default, skip_serializing)]
    pub league_path: Option<PathBuf>,
}

impl FlintMetadata {
    /// Schema 1 kept champion/skin/map at the top level. Fold them in so the
    /// rest of the code only ever reads `source`.
    pub fn normalized(mut self) -> Self {
        if self.source.champion.is_empty() && !self.champion.is_empty() {
            self.source.champion = std::mem::take(&mut self.champion);
        }
        if self.source.skin_id == 0 && self.skin_id != 0 {
            self.source.skin_id = self.skin_id;
        }
        if self.source.map_id.is_none() && self.map_id.is_some() {
            self.source.map_id = self.map_id.take();
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    // ===== League-mod compatible fields (from mod.config.json) =====

    /// Slug format, no spaces.
    pub name: String,

    pub display_name: String,

    /// Semver format.
    pub version: String,

    pub description: String,

    #[serde(default = "default_layers")]
    pub layers: Vec<ModProjectLayer>,

    /// Stored as strings for Clone compatibility; the deserializer accepts
    /// both plain strings and ModProjectAuthor objects.
    #[serde(default, deserialize_with = "deserialize_authors")]
    pub authors: Vec<String>,

    /// mod.config.json keys Flint doesn't model (hashtables, license, transformers,
    /// thumbnail, …), carried verbatim so a save never deletes another tool's data.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,

    // ===== Flint-specific fields (from flint.json, populated at runtime) =====

    /// Stable project id (UUID v4), persisting across moves.
    #[serde(default)]
    pub pid: String,

    /// Drives which type-specific fields below are meaningful.
    #[serde(default)]
    pub kind: ProjectKind,

    /// Champion internal name (e.g., "Ahri") - skin projects only.
    #[serde(default)]
    pub champion: String,

    /// Skin ID (0 for base skin) - skin projects only.
    #[serde(default)]
    pub skin_id: u32,

    /// Map id (e.g. "map11") - map projects only.
    #[serde(default)]
    pub map_id: Option<String>,

    #[serde(skip)]
    pub league_path: Option<PathBuf>,

    /// Map variant base name - map projects only.
    #[serde(default)]
    pub variant: Option<String>,

    /// Game build the assets were extracted from.
    #[serde(default)]
    pub game_version: Option<String>,

    /// "live" or "pbe".
    #[serde(default)]
    pub source_branch: Option<String>,

    /// The ASSETS/<creator>/<project> segment the repath wrote.
    #[serde(default)]
    pub repath_prefix: Option<String>,

    #[serde(default)]
    pub extract_sfx: bool,

    #[serde(default)]
    pub extract_vo: bool,

    #[serde(default)]
    pub project_path: PathBuf,

    #[serde(skip)]
    pub created_at: DateTime<Utc>,

    #[serde(skip)]
    pub modified_at: DateTime<Utc>,
}

/// Accepts plain strings, untagged `{name, role}`, and legacy tagged `{Name}` /
/// `{NameAndRole: {name, role}}`, extracting the name in each case.
fn deserialize_authors<'de, D>(deserializer: D) -> std::result::Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let values: Vec<serde_json::Value> = Vec::deserialize(deserializer)?;
    Ok(values.into_iter().filter_map(|v| {
        match &v {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::String(name)) = map.get("name") {
                    return Some(name.clone());
                }
                if let Some(serde_json::Value::String(name)) = map.get("Name") {
                    return Some(name.clone());
                }
                if let Some(serde_json::Value::Object(inner)) = map.get("NameAndRole") {
                    if let Some(serde_json::Value::String(name)) = inner.get("name") {
                        return Some(name.clone());
                    }
                }
                None
            }
            _ => None,
        }
    }).collect())
}

impl Project {
    pub fn new(
        name: impl Into<String>,
        champion: impl Into<String>,
        skin_id: u32,
        league_path: impl Into<PathBuf>,
        project_path: impl Into<PathBuf>,
        author: Option<String>,
    ) -> Self {
        let now = Utc::now();
        let name_str = name.into();
        let champion_str = champion.into();

        let authors = author.into_iter().collect::<Vec<_>>();

        Self {
            name: slugify(&name_str),
            display_name: name_str,
            version: "0.1.0".to_string(),
            description: format!("Mod for {} skin {}", champion_str, skin_id),
            layers: default_layers(),
            authors,
            extra: serde_json::Map::new(),
            pid: uuid::Uuid::new_v4().to_string(),
            kind: ProjectKind::Skin,
            champion: champion_str,
            skin_id,
            map_id: None,
            league_path: Some(league_path.into()),
            variant: None,
            game_version: None,
            source_branch: None,
            repath_prefix: None,
            extract_sfx: false,
            extract_vo: false,
            project_path: project_path.into(),
            created_at: now,
            modified_at: now,
        }
    }

    /// Clears the skin-specific fields.
    pub fn into_map(mut self, map_id: impl Into<String>) -> Self {
        self.kind = ProjectKind::Map;
        self.map_id = Some(map_id.into());
        self.champion.clear();
        self.skin_id = 0;
        self
    }

    /// Clears the champion/skin fields.
    pub fn into_loading_screen(mut self) -> Self {
        self.kind = ProjectKind::LoadingScreen;
        self.map_id = None;
        self.champion.clear();
        self.skin_id = 0;
        self
    }

    pub fn into_tft(mut self, wad_alias: impl Into<String>, skin_id: u32) -> Self {
        self.kind = ProjectKind::Tft;
        self.champion = wad_alias.into();
        self.skin_id = skin_id;
        self.map_id = None;
        self
    }

    pub fn to_mod_project(&self) -> ModProject {
        ModProject {
            name: self.name.clone(),
            display_name: self.display_name.clone(),
            version: self.version.clone(),
            description: self.description.clone(),
            authors: self.authors.iter().map(|a| ModProjectAuthor::Name(a.clone())).collect(),
            license: None,
            transformers: vec![],
            layers: self.layers.clone(),
            thumbnail: None,
        }
    }

    pub fn to_flint_metadata(&self) -> FlintMetadata {
        let is_skin = matches!(self.kind, ProjectKind::Skin | ProjectKind::Tft);
        let is_map = matches!(self.kind, ProjectKind::Map);
        FlintMetadata {
            schema: FLINT_SCHEMA,
            pid: self.pid.clone(),
            kind: self.kind,
            source: FlintSource {
                champion: if is_skin { self.champion.clone() } else { String::new() },
                skin_id: if is_skin { self.skin_id } else { 0 },
                map_id: if is_map { self.map_id.clone() } else { None },
                variant: if is_map { self.variant.clone() } else { None },
                game_version: self.game_version.clone(),
                branch: self.source_branch.clone(),
            },
            repath_prefix: self.repath_prefix.clone(),
            extract: FlintExtract { sfx: self.extract_sfx, vo: self.extract_vo },
            created_at: self.created_at,
            modified_at: Utc::now(),
            champion: String::new(),
            skin_id: 0,
            map_id: None,
            league_path: None,
        }
    }

    pub fn config_path(&self) -> PathBuf {
        self.project_path.join(PROJECT_FILE)
    }

    pub fn flint_path(&self) -> PathBuf {
        self.project_path.join(FLINT_FILE)
    }

    pub fn content_path(&self, layer: &str) -> PathBuf {
        self.project_path.join("content").join(layer)
    }

    /// The league-mod compatible default asset path: content/base.
    pub fn assets_path(&self) -> PathBuf {
        self.content_path("base")
    }

    pub fn output_path(&self) -> PathBuf {
        self.project_path.join("output")
    }
}

/// Creates a new project with the required directory structure. `champion` may
/// be empty for non-skin project types (loading-screen, map).
pub fn create_project(
    name: &str,
    champion: &str,
    skin_id: u32,
    league_path: &Path,
    output_dir: &Path,
    author: Option<String>,
) -> Result<Project> {
    tracing::info!("Creating project '{}' for {} skin {}", name, champion, skin_id);

    if name.is_empty() {
        return Err(Error::InvalidInput("Project name cannot be empty".to_string()));
    }
    if !league_path.exists() {
        return Err(Error::InvalidInput(format!(
            "League path does not exist: {}",
            league_path.display()
        )));
    }

    if !output_dir.exists() {
        fs::create_dir_all(output_dir)
            .map_err(|e| Error::io_with_path(e, output_dir))?;
        tracing::info!("Created output directory: {}", output_dir.display());
    }

    let project_dir_name = sanitize_filename(name);
    let project_path = output_dir.join(&project_dir_name);

    if project_path.exists() {
        return Err(Error::InvalidInput(format!(
            "Project already exists at: {}",
            project_path.display()
        )));
    }

    let project = Project::new(
        name,
        champion,
        skin_id,
        league_path,
        &project_path,
        author,
    );

    fs::create_dir_all(&project_path)
        .map_err(|e| Error::io_with_path(e, &project_path))?;

    fs::create_dir_all(project.assets_path())
        .map_err(|e| Error::io_with_path(e, project.assets_path()))?;

    fs::create_dir_all(project.output_path())
        .map_err(|e| Error::io_with_path(e, project.output_path()))?;

    save_project(&project)?;

    // Best-effort: the project is already persisted if this fails.
    if let Err(e) = register_in_index(output_dir, &project) {
        tracing::warn!("Failed to register {} in projects.json: {}", project.pid, e);
    }

    tracing::info!("Project created at: {}", project_path.display());
    Ok(project)
}

/// Upserts a project into `projects.json` at `projects_root`.
pub fn register_in_index(projects_root: &Path, project: &Project) -> Result<()> {
    use crate::project::index::{upsert, ProjectIndexEntry};
    let now = chrono::Utc::now();
    upsert(projects_root, ProjectIndexEntry {
        pid: project.pid.clone(),
        path: project.project_path.clone(),
        display_name: project.display_name.clone(),
        name: project.name.clone(),
        kind: project.kind,
        champion: if matches!(project.kind, ProjectKind::Skin) || matches!(project.kind, ProjectKind::Tft) { project.champion.clone() } else { String::new() },
        skin_id: if matches!(project.kind, ProjectKind::Skin) || matches!(project.kind, ProjectKind::Tft) { project.skin_id } else { 0 },
        map_id: if matches!(project.kind, ProjectKind::Map) { project.map_id.clone() } else { None },
        created_at: project.created_at,
        last_seen_at: now,
        exists: true,
    })
}

/// `path` may be the project directory or a mod.config.json / flint.json /
/// project.json file (the parent directory is used in that case).
pub fn open_project(path: &Path) -> Result<Project> {
    tracing::debug!("Attempting to open project from path: {}", path.display());

    let project_path = if path.is_file() {
        let file_name = path.file_name().and_then(|n| n.to_str());
        match file_name {
            Some("mod.config.json") | Some("flint.json") | Some("project.json") => {
                tracing::debug!("Path points to project file, using parent directory");
                path.parent().unwrap_or(path).to_path_buf()
            }
            _ => {
                tracing::debug!("Path is a file but not a known project file, treating as directory");
                path.to_path_buf()
            }
        }
    } else {
        path.to_path_buf()
    };

    let config_path = project_path.join(PROJECT_FILE);

    if !config_path.exists() {
        return Err(Error::InvalidInput(format!(
            "Project file not found: {}",
            config_path.display()
        )));
    }

    tracing::info!("Opening project from: {}", config_path.display());

    let file = File::open(&config_path)
        .map_err(|e| Error::io_with_path(e, &config_path))?;
    let reader = BufReader::new(file);

    let mut project: Project = serde_json::from_reader(reader)
        .map_err(|e| Error::InvalidInput(format!("Failed to parse project file: {}", e)))?;

    project.project_path = project_path.clone();

    let flint_path = project_path.join(FLINT_FILE);
    let mut needs_resave = false;
    if flint_path.exists() {
        if let Ok(file) = File::open(&flint_path) {
            let reader = BufReader::new(file);
            if let Ok(flint) = serde_json::from_reader::<_, FlintMetadata>(reader) {
                let flint = flint.normalized();
                project.pid = flint.pid;
                project.kind = flint.kind;
                project.champion = flint.source.champion;
                project.skin_id = flint.source.skin_id;
                project.map_id = flint.source.map_id;
                project.variant = flint.source.variant;
                project.game_version = flint.source.game_version;
                project.source_branch = flint.source.branch;
                project.repath_prefix = flint.repath_prefix;
                project.extract_sfx = flint.extract.sfx;
                project.extract_vo = flint.extract.vo;
                project.league_path = flint.league_path;
                project.created_at = flint.created_at;
                project.modified_at = flint.modified_at;
                needs_resave |= flint.schema < FLINT_SCHEMA;
            }
        }
    }

    // ── Legacy-format migration ────────────────────────────────────────────
    /* Older projects encoded the type by overloading `champion`
       ("map-<id>" / "loading-screen") with `kind` left at Skin. */
    if matches!(project.kind, ProjectKind::Skin) {
        if let Some(rest) = project.champion.strip_prefix("map-") {
            let map_id = rest.to_string();
            project.kind = ProjectKind::Map;
            project.map_id = Some(map_id);
            project.champion.clear();
            project.skin_id = 0;
            needs_resave = true;
        } else if project.champion.eq_ignore_ascii_case("loading-screen") {
            project.kind = ProjectKind::LoadingScreen;
            project.champion.clear();
            project.skin_id = 0;
            needs_resave = true;
        }
    }

    if project.pid.is_empty() {
        project.pid = uuid::Uuid::new_v4().to_string();
        needs_resave = true;
    }
    if needs_resave {
        if let Err(e) = save_project(&project) {
            tracing::warn!("Failed to backfill pid for {}: {}", project.project_path.display(), e);
        }
    }

    tracing::info!("Project '{}' loaded successfully", project.name);
    Ok(project)
}

/// Writes both mod.config.json (league-mod compatible) and flint.json.
pub fn save_project(project: &Project) -> Result<()> {
    let config_path = project.config_path();
    tracing::debug!("Saving project to: {}", config_path.display());

    let mod_project = project.to_mod_project();
    let mut config = serde_json::to_value(&mod_project)
        .map_err(|e| Error::InvalidInput(format!("Failed to serialize project: {}", e)))?;
    if let serde_json::Value::Object(map) = &mut config {
        for (key, value) in &project.extra {
            map.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    let file = File::create(&config_path)
        .map_err(|e| Error::io_with_path(e, &config_path))?;
    let writer = BufWriter::new(file);
    serde_json::to_writer_pretty(writer, &config)
        .map_err(|e| Error::InvalidInput(format!("Failed to write project file: {}", e)))?;

    let flint_path = project.flint_path();
    let flint_metadata = project.to_flint_metadata();
    let file = File::create(&flint_path)
        .map_err(|e| Error::io_with_path(e, &flint_path))?;
    let writer = BufWriter::new(file);
    serde_json::to_writer_pretty(writer, &flint_metadata)
        .map_err(|e| Error::InvalidInput(format!("Failed to write flint file: {}", e)))?;

    tracing::debug!("Project saved successfully");
    Ok(())
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn slugify(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_project_new() {
        let project = Project::new(
            "Test Project",
            "Ahri",
            0,
            "C:\\Riot Games\\League of Legends",
            "C:\\Projects\\test",
            None,
        );

        assert_eq!(project.name, "test-project");
        assert_eq!(project.display_name, "Test Project");
        assert_eq!(project.champion, "Ahri");
        assert_eq!(project.skin_id, 0);
        assert_eq!(project.layers.len(), 1);
        assert_eq!(project.layers[0].name, "base");
    }

    #[test]
    fn test_project_paths() {
        let project = Project::new(
            "Test",
            "Ahri",
            0,
            "C:\\League",
            "C:\\Projects\\test",
            None,
        );

        assert_eq!(project.config_path(), PathBuf::from("C:\\Projects\\test\\mod.config.json"));
        assert_eq!(project.flint_path(), PathBuf::from("C:\\Projects\\test\\flint.json"));
        assert_eq!(project.assets_path(), PathBuf::from("C:\\Projects\\test\\content\\base"));
        assert_eq!(project.output_path(), PathBuf::from("C:\\Projects\\test\\output"));
    }

    /// mod.config.json is a shared format — a `hashtables` array (or any field a
    /// newer league-mod writes) must survive Flint's open→save round trip.
    #[test]
    fn unknown_config_fields_survive_a_save_round_trip() {
        let dir = tempdir().unwrap();
        let config = serde_json::json!({
            "name": "test-mod",
            "display_name": "Test Mod",
            "version": "1.0.0",
            "description": "d",
            "authors": ["someone"],
            "layers": [{ "name": "base", "priority": 0 }],
            "hashtables": [
                { "path": "hashes/game.hashes.txt", "category": "game", "algorithm": "xxh64", "bits": 64 }
            ],
            "license": "MIT",
        });
        std::fs::write(
            dir.path().join(PROJECT_FILE),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();

        let project = open_project(dir.path()).unwrap();
        assert!(project.extra.contains_key("hashtables"));
        save_project(&project).unwrap();

        let rewritten: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join(PROJECT_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(rewritten["hashtables"][0]["category"], "game");
        assert_eq!(rewritten["license"], "MIT");
        assert_eq!(rewritten["name"], "test-mod");
    }

    #[test]
    fn test_to_mod_project() {
        let project = Project::new("Test", "Ahri", 0, "C:\\League", "C:\\test", None);
        let mod_project = project.to_mod_project();
        
        assert_eq!(mod_project.name, project.name);
        assert_eq!(mod_project.display_name, project.display_name);
        assert_eq!(mod_project.version, project.version);
    }

    #[test]
    fn schema_one_flint_files_still_load() {
        let raw = r#"{
            "pid": "3fe695f1-17b9-4a12-86c5-3e78db4f9132",
            "kind": "skin",
            "champion": "Irelia",
            "skin_id": 18,
            "league_path": "E:/Games/League of Legends",
            "created_at": "2026-09-02T20:24:20.394350400Z",
            "modified_at": "2026-09-02T20:24:20.394350400Z"
        }"#;

        let flint: FlintMetadata = serde_json::from_str(raw).unwrap();
        assert_eq!(flint.schema, 0);
        let flint = flint.normalized();
        assert_eq!(flint.source.champion, "Irelia");
        assert_eq!(flint.source.skin_id, 18);
    }

    #[test]
    fn saving_never_writes_the_league_path_back() {
        let mut project = Project::new("Test", "Ahri", 5, r"C:\League", r"C:\test", None);
        project.repath_prefix = Some("Creator/Test".to_string());
        project.game_version = Some("16.17.8104348".to_string());
        project.extract_vo = true;

        let json = serde_json::to_string(&project.to_flint_metadata()).unwrap();
        assert!(!json.contains("league_path"), "{json}");
        assert!(json.contains("\"schema\":2"), "{json}");
        assert!(json.contains("16.17.8104348"), "{json}");
        assert!(json.contains("\"vo\":true"), "{json}");
    }

    #[test]
    fn test_flint_metadata() {
        let project = Project::new("Test", "Ahri", 5, "C:\\League", "C:\\test", None);
        let flint = project.to_flint_metadata();
        
        assert_eq!(flint.schema, FLINT_SCHEMA);
        assert_eq!(flint.source.champion, "Ahri");
        assert_eq!(flint.source.skin_id, 5);
        assert!(flint.league_path.is_none());
    }

    #[test]
    fn test_project_content_path() {
        let project = Project::new("Test", "Ahri", 0, "C:\\League", "C:\\test", None);
        
        assert_eq!(project.content_path("base"), PathBuf::from("C:\\test\\content\\base"));
        assert_eq!(project.content_path("chroma1"), PathBuf::from("C:\\test\\content\\chroma1"));
    }

    #[test]
    fn test_sanitize_filename() {
        assert_eq!(sanitize_filename("Test Project"), "Test Project");
        assert_eq!(sanitize_filename("Test/Project"), "Test_Project");
        assert_eq!(sanitize_filename("Test:Project<>"), "Test_Project__");
        assert_eq!(sanitize_filename("Test-Project_123"), "Test-Project_123");
    }

    #[test]
    fn test_slugify() {
        assert_eq!(slugify("Test Project"), "test-project");
        assert_eq!(slugify("My Cool Mod"), "my-cool-mod");
    }

    #[test]
    fn test_layers() {
        let project = Project::new("Test", "Ahri", 0, "C:\\League", "C:\\test", None);

        assert_eq!(project.layers.len(), 1);
        assert_eq!(project.layers[0].name, "base");
    }

    #[test]
    fn test_create_and_open_project() {
        let temp_dir = tempdir().unwrap();
        let league_dir = temp_dir.path().join("League");
        fs::create_dir_all(&league_dir).unwrap();

        let project = create_project(
            "Test Project",
            "Ahri",
            0,
            &league_dir,
            temp_dir.path(),
            None,
        ).unwrap();

        assert_eq!(project.display_name, "Test Project");
        assert!(project.project_path.exists());
        assert!(project.assets_path().exists());
        assert!(project.output_path().exists());
        assert!(project.config_path().exists());
        assert!(project.flint_path().exists());

        assert!(!project.project_path.to_string_lossy().ends_with(".flint"));

        let loaded = open_project(&project.project_path).unwrap();
        assert_eq!(loaded.display_name, project.display_name);
        assert_eq!(loaded.champion, project.champion);
        assert_eq!(loaded.skin_id, project.skin_id);
    }

    #[test]
    fn test_create_project_empty_name() {
        let temp_dir = tempdir().unwrap();
        let result = create_project("", "Ahri", 0, temp_dir.path(), temp_dir.path(), None);
        assert!(result.is_err());
    }

    #[test]
    fn test_create_project_empty_champion_allowed() {
        let temp_dir = tempdir().unwrap();
        let league_dir = temp_dir.path().join("League");
        std::fs::create_dir_all(&league_dir).unwrap();
        let result = create_project("Test", "", 0, &league_dir, temp_dir.path(), None);
        assert!(result.is_ok(), "empty champion should be allowed: {:?}", result);
    }
}

/// Full game build from `Game/content-metadata.json`, e.g. `"16.17.8104348"`.
/// The file's value carries a `+branch.…` suffix that is dropped here.
pub fn read_game_version(league_path: &Path) -> Option<String> {
    let path = league_path.join("Game").join("content-metadata.json");
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let raw = value.get("version")?.as_str()?;
    Some(raw.split('+').next().unwrap_or(raw).to_string())
}
