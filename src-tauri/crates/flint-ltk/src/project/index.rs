//! Project index — `projects.json` at the user's projects root.
//!
//! Tracks every Flint project the user has ever created/opened by a stable
//! `pid` (project id, UUID v4). Each entry remembers the absolute path, last
//! known location, and a snapshot of name/champion/skin so the picker can
//! show an entry even when the project folder is missing or moved.
//!
//! The index is a recovery layer — the source of truth is still each
//! project's own `flint.json` (which now also carries `pid`). Any time a
//! project is created or opened we upsert here; at startup the picker
//! reconciles against on-disk state.

use crate::error::{Error, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};

/// Filename of the index — written at the projects root, NOT inside any
/// individual project directory.
const INDEX_FILE: &str = "projects.json";

/// One entry in the projects index. Kept lean — anything heavier (file tree,
/// thumbnails) lives inside the project itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectIndexEntry {
    /// Stable project ID (UUID v4). Generated once on project creation,
    /// stored both here and in the project's `flint.json`.
    pub pid: String,
    /// Last known absolute path to the project directory.
    pub path: PathBuf,
    /// Project's `display_name` (from mod.config.json) at last open.
    #[serde(default)]
    pub display_name: String,
    /// Project's `name` slug.
    #[serde(default)]
    pub name: String,
    /// Champion internal name (e.g. "Ahri") — empty string for map projects
    /// since they don't have a real champion.
    #[serde(default)]
    pub champion: String,
    /// Skin id (0 = base).
    #[serde(default)]
    pub skin_id: u32,
    /// First time the project was registered (or detected on disk).
    pub created_at: DateTime<Utc>,
    /// Last time the project was opened or scanned successfully.
    pub last_seen_at: DateTime<Utc>,
    /// Whether the recorded `path` still exists on disk. Refreshed on every
    /// scan; useful for "missing — locate again?" UI affordances.
    #[serde(default)]
    pub exists: bool,
}

/// Wrapper struct so the on-disk format can grow new top-level fields
/// (schema version, etc.) without breaking older indexes.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectIndex {
    /// File-format version. Bump when the schema changes incompatibly.
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    /// All known projects. Order is irrelevant — frontend sorts.
    #[serde(default)]
    pub entries: Vec<ProjectIndexEntry>,
}

fn default_schema_version() -> u32 { 1 }

// ── Path helpers ────────────────────────────────────────────────────────────

pub fn index_path(projects_root: &Path) -> PathBuf {
    projects_root.join(INDEX_FILE)
}

// ── Read / write ────────────────────────────────────────────────────────────

/// Load the index from `projects.json`. Missing file → empty index. A
/// corrupt file is logged and treated as empty so a single bad write can't
/// brick the project picker.
pub fn read_index(projects_root: &Path) -> ProjectIndex {
    let path = index_path(projects_root);
    if !path.exists() { return ProjectIndex { schema_version: 1, entries: vec![] }; }

    match File::open(&path) {
        Ok(file) => match serde_json::from_reader::<_, ProjectIndex>(BufReader::new(file)) {
            Ok(idx) => idx,
            Err(e) => {
                tracing::warn!("Corrupt projects.json at {} ({}); ignoring", path.display(), e);
                ProjectIndex::default()
            }
        },
        Err(e) => {
            tracing::warn!("Failed to read projects.json at {} ({}); treating as empty", path.display(), e);
            ProjectIndex::default()
        }
    }
}

/// Write the index back. Creates the projects root directory if missing.
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

/// Upsert an entry by `pid`. If `path` differs from the existing record we
/// rewrite the location (project moved). Bumps `last_seen_at`.
pub fn upsert(projects_root: &Path, entry: ProjectIndexEntry) -> Result<()> {
    let mut index = read_index(projects_root);
    if let Some(existing) = index.entries.iter_mut().find(|e| e.pid == entry.pid) {
        existing.path = entry.path;
        existing.display_name = entry.display_name;
        existing.name = entry.name;
        existing.champion = entry.champion;
        existing.skin_id = entry.skin_id;
        existing.last_seen_at = entry.last_seen_at;
        existing.exists = entry.exists;
    } else {
        index.entries.push(entry);
    }
    write_index(projects_root, &index)
}

/// Remove an entry by pid. Returns true if a row was actually removed.
pub fn remove(projects_root: &Path, pid: &str) -> Result<bool> {
    let mut index = read_index(projects_root);
    let before = index.entries.len();
    index.entries.retain(|e| e.pid != pid);
    let removed = index.entries.len() != before;
    if removed { write_index(projects_root, &index)?; }
    Ok(removed)
}
