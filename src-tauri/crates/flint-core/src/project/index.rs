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

/// Normalised form for comparing two recorded paths: separators unified and
/// case folded, since the index may hold `C:\...\Foo` where the caller passes
/// `C:/.../foo`. Case folding is safe here because this index is only ever
/// consulted for Windows/macOS projects roots.
fn path_key(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Drops every row whose recorded `path` matches `path`, returning how many
/// went away.
///
/// Deleting by `pid` is preferred, but a project whose folder is already gone
/// can no longer be read for its `flint.json` — this is the only way to evict
/// those rows, which would otherwise be resurrected by `discover_projects`'
/// index-only pass on every scan.
pub fn remove_by_path(projects_root: &Path, path: &Path) -> Result<usize> {
    let mut index = read_index(projects_root);
    let target = path_key(path);
    let before = index.entries.len();
    index.entries.retain(|e| path_key(&e.path) != target);
    let removed = before - index.entries.len();
    if removed > 0 { write_index(projects_root, &index)?; }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: &str, path: &str) -> ProjectIndexEntry {
        let now = Utc::now();
        ProjectIndexEntry {
            pid: pid.to_string(),
            path: PathBuf::from(path),
            display_name: String::new(),
            name: String::new(),
            kind: ProjectKind::default(),
            champion: String::new(),
            skin_id: 0,
            map_id: None,
            created_at: now,
            last_seen_at: now,
            exists: true,
        }
    }

    #[test]
    fn remove_by_path_evicts_matching_row_ignoring_separator_and_case() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_index(root, &ProjectIndex {
            schema_version: 1,
            entries: vec![
                entry("a", &format!("{}\\Smolder_Skin0", root.display())),
                entry("b", &format!("{}\\Ahri_Skin1", root.display())),
            ],
        }).unwrap();

        // Same project, spelled with forward slashes and different casing.
        let target = PathBuf::from(format!("{}/smolder_skin0", root.display()).replace('\\', "/"));
        assert_eq!(remove_by_path(root, &target).unwrap(), 1);

        let after = read_index(root);
        assert_eq!(after.entries.len(), 1);
        assert_eq!(after.entries[0].pid, "b");
    }

    #[test]
    fn remove_by_path_is_a_noop_when_nothing_matches() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_index(root, &ProjectIndex {
            schema_version: 1,
            entries: vec![entry("a", &format!("{}\\Keep", root.display()))],
        }).unwrap();

        assert_eq!(remove_by_path(root, Path::new("D:/elsewhere/Gone")).unwrap(), 0);
        assert_eq!(read_index(root).entries.len(), 1);
    }
}
