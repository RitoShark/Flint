use crate::error::{Error, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AssetType {
    Texture,
    Model,
    Animation,
    Bin,
    Audio,
    Data,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub asset_type: AssetType,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum FileChange {
    Added {
        entry: FileEntry,
    },
    Modified {
        old_hash: String,
        old_size: u64,
        new: FileEntry,
    },
    Deleted {
        old_hash: String,
        old_size: u64,
        asset_type: AssetType,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub message: String,
    pub author: Option<String>,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub changes: BTreeMap<String, FileChange>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub file_manifest: HashMap<String, FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CheckpointFileContent {
    #[serde(rename = "image")]
    Image { data: String, width: u32, height: u32 },
    #[serde(rename = "text")]
    Text { data: String },
    #[serde(rename = "binary")]
    Binary { size: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointProgress {
    pub phase: String,
    pub current: u64,
    pub total: u64,
}

fn should_skip_dir(name: &str) -> bool {
    matches!(name, ".flint" | ".git" | "node_modules" | "output")
}

fn collect_project_files(project_path: &Path) -> Vec<PathBuf> {
    WalkDir::new(project_path)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                !should_skip_dir(&name)
            } else {
                true
            }
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .collect()
}

pub struct CheckpointManager {
    pub project_path: PathBuf,
    pub checkpoints_dir: PathBuf,
    pub object_store: PathBuf,
}

impl CheckpointManager {
    pub fn new(project_path: PathBuf) -> Self {
        let flint_dir = project_path.join(".flint");
        Self {
            project_path,
            checkpoints_dir: flint_dir.join("checkpoints"),
            object_store: flint_dir.join("objects"),
        }
    }

    pub fn head_path(&self) -> PathBuf {
        self.project_path.join(".flint").join("HEAD")
    }

    pub fn read_head(&self) -> Option<String> {
        let head_file = self.head_path();
        if let Ok(raw) = fs::read_to_string(&head_file) {
            let id = raw.trim().to_string();
            if !id.is_empty() && self.checkpoints_dir.join(format!("{}.json", id)).exists() {
                return Some(id);
            }
        }
        self.read_all_raw_checkpoints()
            .ok()?
            .into_values()
            .max_by(|a, b| a.timestamp.cmp(&b.timestamp))
            .map(|cp| cp.id)
    }

    pub fn write_head(&self, id: &str) -> Result<()> {
        let head_file = self.head_path();
        if let Some(parent) = head_file.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
        }
        fs::write(&head_file, id).map_err(|e| Error::io_with_path(e, &head_file))
    }

    pub fn init(&self) -> Result<()> {
        crate::project_storage::ensure_metadata_dir(&self.project_path)
            .map_err(|e| Error::io_with_path(e, self.project_path.join(".flint")))?;
        fs::create_dir_all(&self.checkpoints_dir)
            .map_err(|e| Error::io_with_path(e, &self.checkpoints_dir))?;
        fs::create_dir_all(&self.object_store)
            .map_err(|e| Error::io_with_path(e, &self.object_store))?;
        Ok(())
    }

    pub fn compute_changes(
        parent_manifest: Option<&HashMap<String, FileEntry>>,
        current_manifest: &HashMap<String, FileEntry>,
    ) -> BTreeMap<String, FileChange> {
        let mut changes = BTreeMap::new();
        match parent_manifest {
            None => {
                for (path, entry) in current_manifest {
                    changes.insert(
                        path.clone(),
                        FileChange::Added {
                            entry: entry.clone(),
                        },
                    );
                }
            }
            Some(parent) => {
                for (path, entry) in current_manifest {
                    match parent.get(path) {
                        None => {
                            changes.insert(
                                path.clone(),
                                FileChange::Added {
                                    entry: entry.clone(),
                                },
                            );
                        }
                        Some(old) if old.hash != entry.hash => {
                            changes.insert(
                                path.clone(),
                                FileChange::Modified {
                                    old_hash: old.hash.clone(),
                                    old_size: old.size,
                                    new: entry.clone(),
                                },
                            );
                        }
                        _ => {}
                    }
                }
                for (path, old) in parent {
                    if !current_manifest.contains_key(path) {
                        changes.insert(
                            path.clone(),
                            FileChange::Deleted {
                                old_hash: old.hash.clone(),
                                old_size: old.size,
                                asset_type: old.asset_type.clone(),
                            },
                        );
                    }
                }
            }
        }
        changes
    }

    fn apply_changes(
        manifest: &mut HashMap<String, FileEntry>,
        changes: &BTreeMap<String, FileChange>,
    ) {
        for (path, change) in changes {
            match change {
                FileChange::Added { entry } => {
                    manifest.insert(path.clone(), entry.clone());
                }
                FileChange::Modified { new, .. } => {
                    manifest.insert(path.clone(), new.clone());
                }
                FileChange::Deleted { .. } => {
                    manifest.remove(path);
                }
            }
        }
    }

    pub fn create_checkpoint_with_progress<F>(
        &self,
        message: String,
        tags: Vec<String>,
        progress: Option<F>,
    ) -> Result<Checkpoint>
    where
        F: Fn(&str, u64, u64),
    {
        let automatic = tags
            .iter()
            .any(|tag| matches!(tag.as_str(), "auto" | "paint" | "fix" | "auto-backup"));
        let parent = self
            .read_head()
            .and_then(|head_id| self.load_checkpoint(&head_id).ok());

        if tags.iter().any(|tag| tag == "paint") {
            if let Some(ref checkpoint) = parent {
                let age = Utc::now()
                    .signed_duration_since(checkpoint.timestamp)
                    .num_seconds();
                if checkpoint.tags.iter().any(|tag| tag == "paint") && (0..900).contains(&age) {
                    return Ok(checkpoint.clone());
                }
            }
        }

        if let Some(ref cb) = progress {
            cb("Scanning files...", 0, 0);
        }
        let files = collect_project_files(&self.project_path);
        let total = files.len() as u64;

        let mut manifest = HashMap::new();
        for (i, full_path) in files.iter().enumerate() {
            if let Some(ref cb) = progress {
                cb("Saving checkpoint...", (i + 1) as u64, total);
            }

            let relative_path = full_path
                .strip_prefix(&self.project_path)
                .map_err(|_| Error::InvalidInput("Failed to relativize path".into()))?
                .to_string_lossy()
                .to_string()
                .replace('\\', "/");

            let (hash, size) = self.hash_and_store_file(full_path)?;

            manifest.insert(
                relative_path.clone(),
                FileEntry {
                    path: relative_path,
                    hash,
                    size,
                    asset_type: Self::detect_type(full_path),
                },
            );
        }

        let changes = Self::compute_changes(parent.as_ref().map(|p| &p.file_manifest), &manifest);

        if changes.is_empty() {
            if automatic {
                if let Some(checkpoint) = parent {
                    return Ok(checkpoint);
                }
            } else {
                return Err(Error::InvalidInput(
                    "No changes since last checkpoint".into(),
                ));
            }
        }

        let checkpoint = Checkpoint {
            id: Uuid::new_v4().to_string(),
            parent_id: parent.map(|p| p.id),
            timestamp: Utc::now(),
            message,
            author: None,
            tags,
            changes,
            file_manifest: manifest,
        };

        self.save_checkpoint(&checkpoint)?;
        self.write_head(&checkpoint.id)?;

        Ok(checkpoint)
    }

    pub fn create_checkpoint(&self, message: String, tags: Vec<String>) -> Result<Checkpoint> {
        self.create_checkpoint_with_progress(message, tags, None::<fn(&str, u64, u64)>)
    }

    fn hash_and_store_file(&self, path: &Path) -> Result<(String, u64)> {
        let data = fs::read(path).map_err(|e| Error::io_with_path(e, path))?;
        let size = data.len() as u64;

        let mut hasher = Sha256::new();
        hasher.update(&data);
        let hash = format!("{:x}", hasher.finalize());

        let object_rel_path = PathBuf::from(&hash[..2]).join(&hash);
        let object_path = self.object_store.join(object_rel_path);

        if !object_path.exists() && !object_path.with_extension("zst").exists() {
            if let Some(parent) = object_path.parent() {
                fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
            }
            let compressed = zstd::stream::encode_all(data.as_slice(), 3)
                .map_err(|e| Error::io_with_path(e, &object_path))?;
            let (stored_path, stored_data) = if compressed.len() < data.len() {
                (object_path.with_extension("zst"), compressed)
            } else {
                (object_path, data)
            };
            fs::write(&stored_path, stored_data)
                .map_err(|e| Error::io_with_path(e, &stored_path))?;
        }

        Ok((hash, size))
    }

    fn detect_type(path: &Path) -> AssetType {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_lowercase();

        match ext.as_str() {
            "dds" | "tex" | "png" | "jpg" | "jpeg" | "tga" => AssetType::Texture,
            "skn" | "skl" | "mapgeo" | "wgeo" | "sco" | "scb" => AssetType::Model,
            "anm" => AssetType::Animation,
            "bin" => AssetType::Bin,
            "bnk" | "wpk" | "wav" | "ogg" | "mp3" => AssetType::Audio,
            "json" | "txt" | "lua" | "xml" | "ritobin" | "py" => AssetType::Data,
            _ => AssetType::Unknown,
        }
    }

    fn save_checkpoint(&self, checkpoint: &Checkpoint) -> Result<()> {
        let path = self.checkpoints_dir.join(format!("{}.json", checkpoint.id));
        let file = fs::File::create(&path).map_err(|e| Error::io_with_path(e, &path))?;
        let on_disk = if !checkpoint.changes.is_empty() || checkpoint.parent_id.is_some() {
            Checkpoint {
                file_manifest: HashMap::new(),
                ..checkpoint.clone()
            }
        } else {
            checkpoint.clone()
        };
        serde_json::to_writer_pretty(file, &on_disk)
            .map_err(|e| Error::InvalidInput(format!("Failed to save checkpoint: {}", e)))?;
        Ok(())
    }

    fn read_raw_checkpoint(&self, id: &str) -> Result<Checkpoint> {
        let path = self.checkpoints_dir.join(format!("{}.json", id));
        let file = fs::File::open(&path).map_err(|e| Error::io_with_path(e, &path))?;
        serde_json::from_reader(file)
            .map_err(|e| Error::InvalidInput(format!("Failed to load checkpoint: {}", e)))
    }

    fn read_all_raw_checkpoints(&self) -> Result<HashMap<String, Checkpoint>> {
        let mut map = HashMap::new();
        if !self.checkpoints_dir.exists() {
            return Ok(map);
        }
        for entry in fs::read_dir(&self.checkpoints_dir)
            .map_err(|e| Error::io_with_path(e, &self.checkpoints_dir))?
        {
            let entry = entry.map_err(|e| Error::InvalidInput(e.to_string()))?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if let Ok(cp) = self.read_raw_checkpoint(stem) {
                        map.insert(cp.id.clone(), cp);
                    }
                }
            }
        }
        Ok(map)
    }

    pub fn load_checkpoint(&self, id: &str) -> Result<Checkpoint> {
        let mut chain: Vec<Checkpoint> = Vec::new();
        let mut visited = HashSet::new();
        let mut cur_id = Some(id.to_string());
        let mut base_manifest = HashMap::new();

        while let Some(cid) = cur_id.take() {
            if !visited.insert(cid.clone()) {
                break;
            }
            let cp = match self.read_raw_checkpoint(&cid) {
                Ok(c) => c,
                Err(e) if chain.is_empty() => return Err(e),
                Err(_) => break,
            };
            if !cp.file_manifest.is_empty() {
                base_manifest = cp.file_manifest.clone();
                if chain.is_empty() {
                    let mut target = cp;
                    if target.changes.is_empty() {
                        let parent_manifest = target
                            .parent_id
                            .as_deref()
                            .and_then(|pid| self.load_checkpoint(pid).ok())
                            .map(|p| p.file_manifest);
                        target.changes =
                            Self::compute_changes(parent_manifest.as_ref(), &target.file_manifest);
                    }
                    return Ok(target);
                }
                break;
            }
            cur_id = cp.parent_id.clone();
            chain.push(cp);
        }

        let mut manifest = base_manifest;
        let mut last = None;
        while let Some(mut node) = chain.pop() {
            Self::apply_changes(&mut manifest, &node.changes);
            node.file_manifest = manifest.clone();
            last = Some(node);
        }

        let mut target = last.ok_or_else(|| {
            Error::InvalidInput(format!("Failed to load checkpoint: {}", id))
        })?;

        if target.changes.is_empty() && !target.file_manifest.is_empty() {
            let parent_manifest = target
                .parent_id
                .as_deref()
                .and_then(|pid| self.load_checkpoint(pid).ok())
                .map(|p| p.file_manifest);
            target.changes = Self::compute_changes(parent_manifest.as_ref(), &target.file_manifest);
        }

        Ok(target)
    }

    pub fn list_checkpoints(&self) -> Result<Vec<Checkpoint>> {
        let metadata_dir = self.project_path.join(".flint");
        if metadata_dir.is_dir() {
            crate::project_storage::hide_directory(&metadata_dir)
                .map_err(|e| Error::io_with_path(e, &metadata_dir))?;
        }
        let raw_map = self.read_all_raw_checkpoints()?;
        if raw_map.is_empty() {
            return Ok(Vec::new());
        }

        let mut resolved_manifests: HashMap<String, HashMap<String, FileEntry>> = HashMap::new();
        for id in raw_map.keys() {
            self.resolve_manifest_from_map(id, &raw_map, &mut resolved_manifests);
        }

        let mut checkpoints: Vec<Checkpoint> = raw_map
            .into_iter()
            .map(|(id, mut cp)| {
                let manifest = resolved_manifests.remove(&id).unwrap_or_default();
                cp.file_manifest = manifest;
                cp
            })
            .collect();

        let manifest_lookup: HashMap<String, HashMap<String, FileEntry>> = checkpoints
            .iter()
            .map(|cp| (cp.id.clone(), cp.file_manifest.clone()))
            .collect();

        for cp in &mut checkpoints {
            if cp.changes.is_empty() && !cp.file_manifest.is_empty() {
                let parent_manifest = cp
                    .parent_id
                    .as_ref()
                    .and_then(|pid| manifest_lookup.get(pid));
                cp.changes = Self::compute_changes(parent_manifest, &cp.file_manifest);
            }
        }

        checkpoints.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        Ok(checkpoints)
    }

    fn resolve_manifest_from_map(
        &self,
        id: &str,
        raw_map: &HashMap<String, Checkpoint>,
        memo: &mut HashMap<String, HashMap<String, FileEntry>>,
    ) -> HashMap<String, FileEntry> {
        if let Some(existing) = memo.get(id) {
            return existing.clone();
        }
        let mut chain: Vec<&str> = Vec::new();
        let mut visited: HashSet<&str> = HashSet::new();
        let mut cur_id = id;

        while let Some(cp) = raw_map.get(cur_id) {
            if let Some(cached) = memo.get(cur_id) {
                let mut manifest = cached.clone();
                while let Some(node_id) = chain.pop() {
                    if let Some(node) = raw_map.get(node_id) {
                        Self::apply_changes(&mut manifest, &node.changes);
                        memo.insert(node_id.to_string(), manifest.clone());
                    }
                }
                return manifest;
            }
            if !cp.file_manifest.is_empty() {
                let mut manifest = cp.file_manifest.clone();
                memo.insert(cur_id.to_string(), manifest.clone());
                while let Some(node_id) = chain.pop() {
                    if let Some(node) = raw_map.get(node_id) {
                        Self::apply_changes(&mut manifest, &node.changes);
                        memo.insert(node_id.to_string(), manifest.clone());
                    }
                }
                return manifest;
            }
            visited.insert(cur_id);
            chain.push(cur_id);
            match cp.parent_id.as_deref() {
                Some(pid) if !visited.contains(pid) && raw_map.contains_key(pid) => {
                    cur_id = pid;
                }
                _ => break,
            }
        }

        let mut manifest = HashMap::new();
        while let Some(node_id) = chain.pop() {
            if let Some(node) = raw_map.get(node_id) {
                Self::apply_changes(&mut manifest, &node.changes);
                memo.insert(node_id.to_string(), manifest.clone());
            }
        }
        manifest
    }

    pub fn restore_checkpoint(&self, id: &str) -> Result<()> {
        let checkpoint = self.load_checkpoint(id)?;

        let backup_msg = format!("Auto-backup before restore to: {}", checkpoint.message);
        let _ = self.create_checkpoint(backup_msg, vec!["auto-backup".to_string()])?;

        let has_modern_config = self.project_path.join("mod.config.json").exists();

        let current_files = collect_project_files(&self.project_path);
        for file_path in &current_files {
            let relative = file_path
                .strip_prefix(&self.project_path)
                .map_err(|_| Error::InvalidInput("Failed to relativize path".into()))?
                .to_string_lossy()
                .to_string()
                .replace('\\', "/");

            if matches!(
                relative.as_str(),
                "project.json" | "mod.config.json" | "flint.json"
            ) {
                continue;
            }

            if !checkpoint.file_manifest.contains_key(&relative) {
                let _ = fs::remove_file(file_path);
            }
        }

        for (rel_path, entry) in &checkpoint.file_manifest {
            if rel_path == "project.json" && has_modern_config {
                continue;
            }
            let target_path = self.project_path.join(rel_path.replace('/', "\\"));
            let data = self.read_object_file(&entry.hash)?;

            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
            }

            fs::write(&target_path, data).map_err(|e| Error::io_with_path(e, &target_path))?;
        }

        self.cleanup_empty_dirs()?;
        self.write_head(id)?;

        Ok(())
    }

    pub fn restore_single_file(&self, id: &str, relative_path: &str) -> Result<()> {
        let norm = relative_path.replace('\\', "/");
        if norm.is_empty()
            || norm.starts_with('/')
            || norm.starts_with(".flint/")
            || norm.split('/').any(|part| part == "..")
        {
            return Err(Error::InvalidInput(format!(
                "Invalid project-relative path: {}",
                relative_path
            )));
        }

        let checkpoint = self.load_checkpoint(id)?;
        let hash = if let Some(entry) = checkpoint.file_manifest.get(&norm) {
            &entry.hash
        } else if let Some(FileChange::Deleted { old_hash, .. }) = checkpoint.changes.get(&norm) {
            old_hash
        } else {
            return Err(Error::InvalidInput(format!(
                "File '{}' not found in checkpoint {}",
                norm, id
            )));
        };

        let data = self.read_object_file(hash)?;
        let target_path = self.project_path.join(norm.replace('/', "\\"));
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
        }
        fs::write(&target_path, data).map_err(|e| Error::io_with_path(e, &target_path))
    }

    fn cleanup_empty_dirs(&self) -> Result<()> {
        let mut dirs: Vec<PathBuf> = WalkDir::new(&self.project_path)
            .into_iter()
            .filter_entry(|e| {
                if e.file_type().is_dir() {
                    let name = e.file_name().to_string_lossy();
                    !should_skip_dir(&name)
                } else {
                    true
                }
            })
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_dir() && e.path() != self.project_path)
            .map(|e| e.into_path())
            .collect();

        dirs.sort_by_key(|b| std::cmp::Reverse(b.components().count()));

        for dir in dirs {
            if let Ok(mut entries) = fs::read_dir(&dir) {
                if entries.next().is_none() {
                    let _ = fs::remove_dir(&dir);
                }
            }
        }

        Ok(())
    }

    pub fn diff_manifests(
        from_manifest: &HashMap<String, FileEntry>,
        to_manifest: &HashMap<String, FileEntry>,
    ) -> CheckpointDiff {
        let mut diff = CheckpointDiff::default();

        for (path, entry) in to_manifest {
            match from_manifest.get(path) {
                None => diff.added.push(entry.clone()),
                Some(old) if old.hash != entry.hash => {
                    diff.modified.push((old.clone(), entry.clone()));
                }
                _ => {}
            }
        }

        for (path, entry) in from_manifest {
            if !to_manifest.contains_key(path) {
                diff.deleted.push(entry.clone());
            }
        }

        diff.added.sort_by(|a, b| a.path.cmp(&b.path));
        diff.modified.sort_by(|a, b| a.1.path.cmp(&b.1.path));
        diff.deleted.sort_by(|a, b| a.path.cmp(&b.path));

        diff
    }

    pub fn compare_checkpoints(&self, from_id: &str, to_id: &str) -> Result<CheckpointDiff> {
        let cp1 = self.load_checkpoint(from_id)?;
        let cp2 = self.load_checkpoint(to_id)?;
        Ok(Self::diff_manifests(&cp1.file_manifest, &cp2.file_manifest))
    }

    pub fn delete_checkpoint(&self, id: &str) -> Result<()> {
        let path = self.checkpoints_dir.join(format!("{}.json", id));
        if !path.exists() {
            return Ok(());
        }

        if let Ok(all) = self.list_checkpoints() {
            if let Some(target) = all.iter().find(|cp| cp.id == id) {
                let parent_manifest = target
                    .parent_id
                    .as_ref()
                    .and_then(|pid| all.iter().find(|cp| &cp.id == pid))
                    .map(|p| &p.file_manifest);

                for child in all.iter().filter(|cp| cp.parent_id.as_deref() == Some(id)) {
                    let mut updated = child.clone();
                    updated.parent_id = target.parent_id.clone();
                    updated.changes =
                        Self::compute_changes(parent_manifest, &updated.file_manifest);
                    let _ = self.save_checkpoint(&updated);
                }

                let head_file = self.head_path();
                if let Ok(current_head) = fs::read_to_string(&head_file) {
                    if current_head.trim() == id {
                        if let Some(ref pid) = target.parent_id {
                            let _ = self.write_head(pid);
                        } else if let Some(next_latest) = all.iter().find(|cp| cp.id != id) {
                            let _ = self.write_head(&next_latest.id);
                        } else {
                            let _ = fs::remove_file(&head_file);
                        }
                    }
                }
            }
        }

        fs::remove_file(&path).map_err(|e| Error::io_with_path(e, &path))?;
        Ok(())
    }

    pub fn read_object_file(&self, hash: &str) -> Result<Vec<u8>> {
        let object_path = self.object_store.join(&hash[..2]).join(hash);
        if object_path.exists() {
            return fs::read(&object_path).map_err(|e| Error::io_with_path(e, &object_path));
        }
        let compressed_path = object_path.with_extension("zst");
        let file = fs::File::open(&compressed_path)
            .map_err(|e| Error::io_with_path(e, &compressed_path))?;
        zstd::stream::decode_all(file).map_err(|e| Error::io_with_path(e, &compressed_path))
    }

    pub fn read_checkpoint_file(
        &self,
        hash: &str,
        file_path: &str,
    ) -> Result<CheckpointFileContent> {
        let data = self.read_object_file(hash)?;
        let ext = Path::new(file_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_lowercase();

        match ext.as_str() {
            "dds" | "tex" => match Self::decode_texture_to_png(&data) {
                Ok((base64_data, width, height)) => Ok(CheckpointFileContent::Image {
                    data: base64_data,
                    width,
                    height,
                }),
                Err(_) => Ok(CheckpointFileContent::Binary {
                    size: data.len() as u64,
                }),
            },
            "png" | "jpg" | "jpeg" => {
                use base64::{engine::general_purpose::STANDARD, Engine};
                let base64_data = STANDARD.encode(&data);
                let prefix = match ext.as_str() {
                    "png" => "data:image/png;base64,",
                    _ => "data:image/jpeg;base64,",
                };
                Ok(CheckpointFileContent::Image {
                    data: format!("{}{}", prefix, base64_data),
                    width: 0,
                    height: 0,
                })
            }
            "json" | "txt" | "lua" | "xml" | "ritobin" | "py" | "cfg" | "ini" | "yaml" | "yml"
            | "toml" | "md" => match String::from_utf8(data.clone()) {
                Ok(text) => Ok(CheckpointFileContent::Text { data: text }),
                Err(_) => Ok(CheckpointFileContent::Binary {
                    size: data.len() as u64,
                }),
            },
            _ => Ok(CheckpointFileContent::Binary {
                size: data.len() as u64,
            }),
        }
    }

    fn decode_texture_to_png(data: &[u8]) -> std::result::Result<(String, u32, u32), String> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use ritoshark::prelude::*;
        use ritoshark::tex::Texture;

        if data.len() < 4 {
            return Err("File too small".to_string());
        }

        let texture = if &data[0..4] == b"DDS " {
            Texture::from_dds_bytes(data).map_err(|e| format!("Failed to parse texture: {:?}", e))?
        } else {
            Texture::from_bytes(data).map_err(|e| format!("Failed to parse texture: {:?}", e))?
        };

        let rgba_image = texture
            .decode_rgba()
            .map_err(|e| format!("Failed to decode texture: {:?}", e))?;

        let width = rgba_image.width();
        let height = rgba_image.height();

        let mut png_data = Vec::new();
        {
            use image::ImageEncoder;
            let encoder = image::codecs::png::PngEncoder::new(&mut png_data);
            encoder
                .write_image(
                    rgba_image.as_raw(),
                    width,
                    height,
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| format!("Failed to encode PNG: {}", e))?;
        }

        let base64_data = STANDARD.encode(&png_data);
        Ok((base64_data, width, height))
    }

    pub fn get_file_changes(&self) -> Result<HashMap<String, String>> {
        let latest = match self
            .read_head()
            .and_then(|id| self.load_checkpoint(&id).ok())
        {
            Some(cp) => cp,
            None => {
                return Ok(HashMap::new());
            }
        };

        let mut changes = HashMap::new();

        let current_files = collect_project_files(&self.project_path);

        for file_path in current_files {
            let relative = file_path
                .strip_prefix(&self.project_path)
                .map_err(|_| Error::InvalidInput("Failed to relativize path".into()))?
                .to_string_lossy()
                .to_string()
                .replace('\\', "/");

            if relative.starts_with(".flint/") {
                continue;
            }

            let data = fs::read(&file_path).map_err(|e| Error::io_with_path(e, &file_path))?;
            let mut hasher = Sha256::new();
            hasher.update(&data);
            let current_hash = format!("{:x}", hasher.finalize());

            if let Some(entry) = latest.file_manifest.get(&relative) {
                if entry.hash != current_hash {
                    changes.insert(relative, "M".to_string());
                }
            } else {
                changes.insert(relative, "N".to_string());
            }
        }

        for path in latest.file_manifest.keys() {
            if path.starts_with(".flint/") {
                continue;
            }
            let full_path = self.project_path.join(path.replace('/', "\\"));
            if !full_path.exists() {
                changes.insert(path.clone(), "D".to_string());
            }
        }

        Ok(changes)
    }
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct CheckpointDiff {
    pub added: Vec<FileEntry>,
    pub modified: Vec<(FileEntry, FileEntry)>,
    pub deleted: Vec<FileEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paint_groups_saves_but_manual_and_restore_backups_capture_changes() {
        let dir = tempfile::tempdir().unwrap();
        let manager = CheckpointManager::new(dir.path().to_path_buf());
        manager.init().unwrap();
        let file = dir.path().join("test.txt");
        fs::write(&file, "before").unwrap();
        let first = manager
            .create_checkpoint("Paint".into(), vec!["paint".into()])
            .unwrap();
        fs::write(&file, "after").unwrap();
        let grouped = manager
            .create_checkpoint("Paint again".into(), vec!["paint".into()])
            .unwrap();
        assert_eq!(first.id, grouped.id);
        let backup = manager
            .create_checkpoint("Before restore".into(), vec!["auto-backup".into()])
            .unwrap();
        assert_ne!(first.id, backup.id);
        let duplicate = manager
            .create_checkpoint("Before fix".into(), vec!["fix".into()])
            .unwrap();
        assert_eq!(backup.id, duplicate.id);
        let empty_manual = manager.create_checkpoint("Noop".into(), vec![]);
        assert!(empty_manual.is_err());
        assert!(empty_manual
            .unwrap_err()
            .to_string()
            .contains("No changes since last checkpoint"));
        fs::write(&file, "milestone").unwrap();
        let manual = manager
            .create_checkpoint("Milestone".into(), vec![])
            .unwrap();
        assert_ne!(manual.id, backup.id);
        assert_eq!(manager.list_checkpoints().unwrap().len(), 3);
    }

    #[test]
    fn paint_creates_a_new_point_after_the_window_expires() {
        let dir = tempfile::tempdir().unwrap();
        let manager = CheckpointManager::new(dir.path().to_path_buf());
        manager.init().unwrap();
        fs::write(dir.path().join("test.txt"), "before").unwrap();
        let mut first = manager
            .create_checkpoint("Paint".into(), vec!["paint".into()])
            .unwrap();
        first.timestamp = Utc::now() - chrono::Duration::minutes(16);
        manager.save_checkpoint(&first).unwrap();
        fs::write(dir.path().join("test.txt"), "after").unwrap();
        let next = manager
            .create_checkpoint("Paint".into(), vec!["paint".into()])
            .unwrap();
        assert_ne!(first.id, next.id);
    }

    #[test]
    fn compressed_and_legacy_objects_round_trip_and_restore() {
        let dir = tempfile::tempdir().unwrap();
        let manager = CheckpointManager::new(dir.path().to_path_buf());
        manager.init().unwrap();
        let data = vec![b'a'; 16_384];
        let file = dir.path().join("test.txt");
        fs::write(&file, &data).unwrap();
        let checkpoint = manager
            .create_checkpoint("Original".into(), vec![])
            .unwrap();
        let json = fs::read_to_string(
            manager
                .checkpoints_dir
                .join(format!("{}.json", checkpoint.id)),
        )
        .unwrap();
        assert!(json.contains("\n  \"id\": "));
        assert!(!json.contains("\"file_manifest\""));
        let parsed: Checkpoint = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, checkpoint.id);
        let hash = &checkpoint.file_manifest["test.txt"].hash;
        let object = manager.object_store.join(&hash[..2]).join(hash);
        assert!(fs::metadata(object.with_extension("zst")).unwrap().len() < data.len() as u64);
        assert_eq!(manager.read_object_file(hash).unwrap(), data);
        fs::write(&file, "changed").unwrap();
        manager.restore_checkpoint(&checkpoint.id).unwrap();
        assert_eq!(fs::read(&file).unwrap(), data);
        fs::write(&object, &data).unwrap();
        fs::remove_file(object.with_extension("zst")).unwrap();
        assert_eq!(manager.read_object_file(hash).unwrap(), data);
    }

    #[test]
    fn git_like_parent_chain_deltas_and_single_file_restore() {
        let dir = tempfile::tempdir().unwrap();
        let manager = CheckpointManager::new(dir.path().to_path_buf());
        manager.init().unwrap();

        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        fs::write(&a, "a-v1").unwrap();
        fs::write(&b, "b-v1").unwrap();

        let cp1 = manager.create_checkpoint("Initial".into(), vec![]).unwrap();
        assert_eq!(cp1.parent_id, None);
        assert_eq!(cp1.changes.len(), 2);
        assert_eq!(manager.read_head().as_deref(), Some(cp1.id.as_str()));

        fs::write(&a, "a-v2").unwrap();
        let cp2 = manager
            .create_checkpoint("Update a".into(), vec![])
            .unwrap();
        assert_eq!(cp2.parent_id.as_deref(), Some(cp1.id.as_str()));
        assert_eq!(cp2.changes.len(), 1);
        assert!(matches!(
            cp2.changes.get("a.txt"),
            Some(FileChange::Modified { .. })
        ));
        assert_eq!(manager.read_head().as_deref(), Some(cp2.id.as_str()));

        fs::remove_file(&b).unwrap();
        let cp3 = manager
            .create_checkpoint("Delete b".into(), vec![])
            .unwrap();
        assert_eq!(cp3.parent_id.as_deref(), Some(cp2.id.as_str()));
        assert_eq!(cp3.changes.len(), 1);
        assert!(matches!(
            cp3.changes.get("b.txt"),
            Some(FileChange::Deleted { .. })
        ));

        let loaded_cp3 = manager.load_checkpoint(&cp3.id).unwrap();
        assert!(loaded_cp3.file_manifest.contains_key("a.txt"));
        assert!(!loaded_cp3.file_manifest.contains_key("b.txt"));

        manager.restore_single_file(&cp1.id, "a.txt").unwrap();
        assert_eq!(fs::read_to_string(&a).unwrap(), "a-v1");
        assert!(!b.exists());

        manager.restore_single_file(&cp3.id, "b.txt").unwrap();
        assert_eq!(fs::read_to_string(&b).unwrap(), "b-v1");
    }
}
