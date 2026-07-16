//! Project index — `projects.json` at the user's projects root.
//!
//! A recovery layer keyed by stable `pid` (UUID v4); the source of truth is
//! each project's own `flint.json`.

use crate::error::{Error, Result};
use crate::project::project::ProjectKind;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};

/// Written at the projects root, not inside any individual project directory.
const INDEX_FILE: &str = "projects.json";

/// Paths whose corrupt-index warning has already been logged this process, so
/// repeated `read_index` calls at startup don't flood the log with the same line.
static WARNED_CORRUPT: std::sync::Mutex<Option<std::collections::HashSet<PathBuf>>> =
    std::sync::Mutex::new(None);

/// Log a corrupt-index warning at most once per unique path per process.
fn warn_corrupt_once(path: &Path, detail: &str) {
    if let Ok(mut guard) = WARNED_CORRUPT.lock() {
        let set = guard.get_or_insert_with(std::collections::HashSet::new);
        if !set.insert(path.to_path_buf()) {
            return; // already warned for this path
        }
    }
    tracing::warn!("Corrupt projects.json at {} ({}); ignoring", path.display(), detail);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectIndexEntry {
    /// Stable project ID (UUID v4), shared with the project's `flint.json`.
    pub pid: String,
    /// Last known absolute path to the project directory.
    pub path: PathBuf,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub name: String,
    /// Drives which type-specific fields below are meaningful.
    #[serde(default)]
    pub kind: ProjectKind,
    /// Champion internal name (e.g. "Ahri") — empty for non-skin projects.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub champion: String,
    /// Skin id (0 = base). Only meaningful for Skin projects.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub skin_id: u32,
    /// Map id (e.g. "map11"). Only meaningful for Map projects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    /// Whether the recorded `path` still exists on disk; refreshed on every scan.
    #[serde(default)]
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectIndex {
    /// Bump when the schema changes incompatibly.
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub entries: Vec<ProjectIndexEntry>,
}

fn default_schema_version() -> u32 { 1 }
fn is_zero(v: &u32) -> bool { *v == 0 }

// ── Path helpers ────────────────────────────────────────────────────────────

pub fn index_path(projects_root: &Path) -> PathBuf {
    projects_root.join(INDEX_FILE)
}

// ── Read / write ────────────────────────────────────────────────────────────

/// Missing file → empty index. A corrupt file is logged and treated as empty.
pub fn read_index(projects_root: &Path) -> ProjectIndex {
    let path = index_path(projects_root);
    if !path.exists() { return ProjectIndex { schema_version: 1, entries: vec![] }; }

    match File::open(&path) {
        Ok(file) => match serde_json::from_reader::<_, ProjectIndex>(BufReader::new(file)) {
            Ok(idx) => idx,
            Err(e) => {
                warn_corrupt_once(&path, &e.to_string());
                ProjectIndex::default()
            }
        },
        Err(e) => {
            tracing::warn!("Failed to read projects.json at {} ({}); treating as empty", path.display(), e);
            ProjectIndex::default()
        }
    }
}

/// Creates the projects root directory if missing.
pub fn write_index(projects_root: &Path, index: &ProjectIndex) -> Result<()> {
    fs::create_dir_all(projects_root)
        .map_err(|e| Error::io_with_path(e, projects_root))?;
    let path = index_path(projects_root);
    let file = File::create(&path).map_err(|e| Error::io_with_path(e, &path))?;
    serde_json::to_writer_pretty(BufWriter::new(file), index)
        .map_err(|e| Error::InvalidInput(format!("Failed to write {}: {}", path.display(), e)))?;
    Ok(())
}

// ── Mutation helpers ────────────────────────────────────────────────────────

/// Upserts by `pid`, rewriting the location if `path` differs and bumping `last_seen_at`.
pub fn upsert(projects_root: &Path, entry: ProjectIndexEntry) -> Result<()> {
    let mut index = read_index(projects_root);
    if let Some(existing) = index.entries.iter_mut().find(|e| e.pid == entry.pid) {
        existing.path = entry.path;
        existing.display_name = entry.display_name;
        existing.name = entry.name;
        existing.kind = entry.kind;
        existing.champion = entry.champion;
        existing.skin_id = entry.skin_id;
        existing.map_id = entry.map_id;
        existing.last_seen_at = entry.last_seen_at;
        existing.exists = entry.exists;
    } else {
        index.entries.push(entry);
    }
    write_index(projects_root, &index)
}

/// Returns true if a row was actually removed.
pub fn remove(projects_root: &Path, pid: &str) -> Result<bool> {
    let mut index = read_index(projects_root);
    let before = index.entries.len();
    index.entries.retain(|e| e.pid != pid);
    let removed = index.entries.len() != before;
    if removed { write_index(projects_root, &index)?; }
    Ok(removed)
}
