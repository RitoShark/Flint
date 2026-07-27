//! Discover Flint projects on disk and reconcile with `projects.json`.

use crate::error::Result;
use crate::project::index::{read_index, upsert, ProjectIndexEntry};
use crate::project::project::{open_project, FlintMetadata, Project, ProjectKind};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};

const PROJECT_FILE: &str = "mod.config.json";
const FLINT_FILE: &str = "flint.json";
const INDEX_FILE: &str = "projects.json";

/// One row returned to the frontend, always reflecting current on-disk state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectListing {
    pub pid: String,
    pub path: PathBuf,
    pub name: String,
    pub display_name: String,
    /// Drives which type-specific fields below are meaningful. Older entries default to Skin.
    #[serde(default)]
    pub kind: ProjectKind,
    pub champion: String,
    pub skin_id: u32,
    /// Map id (e.g. "map11"). Only present for Map projects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_id: Option<String>,
    pub created_at: String,
    pub modified_at: String,
    pub last_seen_at: String,
    /// True if `path` currently contains a readable `mod.config.json`.
    pub exists: bool,
    /// True if this row came from the disk walk (vs. solely the index).
    pub on_disk: bool,
    /// True if rediscovered (in index AND on disk under a new path).
    pub relocated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

/// Scans `projects_root` one level deep, merges with the `projects.json` index,
/// and returns the union. The index is rewritten with newly-discovered or
/// relocated projects.
pub fn discover_projects(projects_root: &Path) -> Result<Vec<ProjectListing>> {
    if !projects_root.exists() {
        return Ok(vec![]);
    }

    let mut results: Vec<ProjectListing> = Vec::new();
    let mut indexed = read_index(projects_root);

    // ── Pass 1: walk disk, upsert each found project ────────────────────────
    let entries = match fs::read_dir(projects_root) {
        Ok(it) => it,
        Err(e) => {
            tracing::warn!("Failed to read projects root {}: {}", projects_root.display(), e);
            return Ok(vec![]);
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.eq_ignore_ascii_case(INDEX_FILE) { continue; }
        let config = path.join(PROJECT_FILE);
        if !config.is_file() { continue; }

        let listing = match read_listing_lightweight(&path) {
            Some(l) => l,
            None => match open_project(&path) {
                Ok(p) => listing_from_project(&p),
                Err(e) => {
                    tracing::warn!("Skipping unreadable project at {}: {}", path.display(), e);
                    continue;
                }
            }
        };

        let prior = indexed.entries.iter().find(|e| e.pid == listing.pid).cloned();
        let relocated = prior
            .as_ref()
            .map(|p| p.path != listing.path)
            .unwrap_or(false);

        let now = Utc::now();
        let upsert_entry = ProjectIndexEntry {
            pid: listing.pid.clone(),
            path: listing.path.clone(),
            display_name: listing.display_name.clone(),
            name: listing.name.clone(),
            kind: listing.kind,
            champion: listing.champion.clone(),
            skin_id: listing.skin_id,
            map_id: listing.map_id.clone(),
            created_at: prior.as_ref().map(|p| p.created_at).unwrap_or(now),
            last_seen_at: now,
            exists: true,
        };
        if let Err(e) = upsert(projects_root, upsert_entry.clone()) {
            tracing::warn!("Failed to update projects.json for {}: {}", listing.pid, e);
        }

        if let Some(slot) = indexed.entries.iter_mut().find(|e| e.pid == upsert_entry.pid) {
            *slot = upsert_entry.clone();
        } else {
            indexed.entries.push(upsert_entry.clone());
        }

        let thumbnail = read_thumbnail_base64(&path);
        results.push(ProjectListing {
            pid: listing.pid,
            path: listing.path,
            name: listing.name,
            display_name: listing.display_name,
            kind: listing.kind,
            champion: listing.champion,
            skin_id: listing.skin_id,
            map_id: listing.map_id,
            created_at: listing.created_at,
            modified_at: listing.modified_at,
            last_seen_at: now.to_rfc3339(),
            exists: true,
            on_disk: true,
            relocated,
            thumbnail,
        });
    }

    // ── Pass 2: indexed projects not found on disk this scan ────────────────
    for e in &indexed.entries {
        if results.iter().any(|r| r.pid == e.pid) { continue; }
        let exists_now = e.path.is_dir() && e.path.join(PROJECT_FILE).is_file();
        let thumbnail = if exists_now { read_thumbnail_base64(&e.path) } else { None };
        results.push(ProjectListing {
            pid: e.pid.clone(),
            path: e.path.clone(),
            name: e.name.clone(),
            display_name: e.display_name.clone(),
            kind: e.kind,
            champion: e.champion.clone(),
            skin_id: e.skin_id,
            map_id: e.map_id.clone(),
            created_at: e.created_at.to_rfc3339(),
            modified_at: e.last_seen_at.to_rfc3339(),
            last_seen_at: e.last_seen_at.to_rfc3339(),
            exists: exists_now,
            on_disk: false,
            relocated: false,
            thumbnail,
        });
    }

    results.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(results)
}

/// Builds a listing from the project's JSON files without the full
/// `open_project` pipeline. Returns `None` if either file is unreadable.
fn read_listing_lightweight(project_path: &Path) -> Option<ProjectListing> {
    let config_path = project_path.join(PROJECT_FILE);
    let config_file = File::open(&config_path).ok()?;
    let config: serde_json::Value =
        serde_json::from_reader(BufReader::new(config_file)).ok()?;

    let name = config.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let display_name = config.get("display_name").and_then(|v| v.as_str()).unwrap_or(&name).to_string();

    // Flint metadata is optional — projects imported from another tool may lack it.
    let flint_path = project_path.join(FLINT_FILE);
    let (pid, kind, champion, skin_id, map_id, created_at, modified_at) = if flint_path.exists() {
        match File::open(&flint_path).and_then(|f| {
            serde_json::from_reader::<_, FlintMetadata>(BufReader::new(f))
                .map_err(std::io::Error::other)
        }) {
            Ok(meta) => {
                /* Normalise legacy `champion: "map-<id>"` / `"loading-screen"`
                   tags into the kind+map_id shape. */
                let (kind, champion, skin_id, map_id) = if matches!(meta.kind, ProjectKind::Skin) {
                    if let Some(rest) = meta.champion.strip_prefix("map-") {
                        (ProjectKind::Map, String::new(), 0, Some(rest.to_string()))
                    } else if meta.champion.eq_ignore_ascii_case("loading-screen") {
                        (ProjectKind::LoadingScreen, String::new(), 0, None)
                    } else {
                        (meta.kind, meta.champion, meta.skin_id, meta.map_id)
                    }
                } else {
                    (meta.kind, meta.champion, meta.skin_id, meta.map_id)
                };
                (
                    if meta.pid.is_empty() { uuid::Uuid::new_v4().to_string() } else { meta.pid },
                    kind,
                    champion,
                    skin_id,
                    map_id,
                    meta.created_at.to_rfc3339(),
                    meta.modified_at.to_rfc3339(),
                )
            }
            Err(_) => (uuid::Uuid::new_v4().to_string(), ProjectKind::Skin, String::new(), 0, None, String::new(), String::new()),
        }
    } else {
        (uuid::Uuid::new_v4().to_string(), ProjectKind::Skin, String::new(), 0, None, String::new(), String::new())
    };

    Some(ProjectListing {
        pid,
        path: project_path.to_path_buf(),
        name,
        display_name,
        kind,
        champion,
        skin_id,
        map_id,
        created_at,
        modified_at: modified_at.clone(),
        last_seen_at: modified_at,
        exists: true,
        on_disk: true,
        relocated: false,
        thumbnail: None,
    })
}

fn listing_from_project(p: &Project) -> ProjectListing {
    ProjectListing {
        pid: p.pid.clone(),
        path: p.project_path.clone(),
        name: p.name.clone(),
        display_name: p.display_name.clone(),
        kind: p.kind,
        champion: p.champion.clone(),
        skin_id: p.skin_id,
        map_id: p.map_id.clone(),
        created_at: p.created_at.to_rfc3339(),
        modified_at: p.modified_at.to_rfc3339(),
        last_seen_at: Utc::now().to_rfc3339(),
        exists: true,
        on_disk: true,
        relocated: false,
        thumbnail: None,
    }
}

fn read_thumbnail_base64(project_path: &Path) -> Option<String> {
    let thumb_path = project_path.join("thumbnail.webp");
    if thumb_path.is_file() {
        if let Ok(data) = fs::read(&thumb_path) {
            use base64::{engine::general_purpose::STANDARD, Engine};
            let b64 = STANDARD.encode(&data);
            return Some(format!("data:image/webp;base64,{}", b64));
        }
    }
    None
}
