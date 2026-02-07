use crate::error::{Error, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use sha2::{Sha256, Digest};
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AssetType {
    Texture,
    Model,
    Animation,
    Bin,
    Audio,
    Data,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,       // Relative to project root
    pub hash: String,      // SHA256 of content
    pub size: u64,
    pub asset_type: AssetType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub message: String,
    pub author: Option<String>,
    pub tags: Vec<String>,
    pub file_manifest: HashMap<String, FileEntry>, // path -> Entry
}

pub struct CheckpointManager {
    pub project_path: PathBuf,
    pub checkpoints_dir: PathBuf, // .flint/checkpoints/
    pub object_store: PathBuf,    // .flint/objects/
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

    pub fn init(&self) -> Result<()> {
        fs::create_dir_all(&self.checkpoints_dir)
            .map_err(|e| Error::io_with_path(e, &self.checkpoints_dir))?;
        fs::create_dir_all(&self.object_store)
            .map_err(|e| Error::io_with_path(e, &self.object_store))?;
        Ok(())
    }

    pub fn create_checkpoint(&self, message: String, tags: Vec<String>) -> Result<Checkpoint> {
        let mut manifest = HashMap::new();
        
        // Scan the entire project directory, but ignore .flint, .git, node_modules etc.
        // Actually, for Flint, the assets are in content/
        let scan_root = self.project_path.clone();
        
        for entry in WalkDir::new(&scan_root)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let _path = e.path();
                // Ignore internal folders
                if e.file_type().is_dir() {
                    let name = e.file_name().to_string_lossy();
                    return name != ".flint" && name != ".git" && name != "node_modules" && name != "output";
                }
                e.file_type().is_file()
            }) 
        {
            if entry.file_type().is_dir() { continue; }

            let full_path = entry.path();
            let relative_path = full_path.strip_prefix(&self.project_path)
                .map_err(|_| Error::InvalidInput("Failed to relativize path".into()))?
                .to_string_lossy()
                .to_string()
                .replace('\\', "/");

            let (hash, size) = self.hash_and_store_file(full_path)?;
            
            manifest.insert(relative_path.clone(), FileEntry {
                path: relative_path,
                hash,
                size,
                asset_type: self.detect_type(full_path),
            });
        }

        let checkpoint = Checkpoint {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now(),
            message,
            author: None,
            tags,
            file_manifest: manifest,
        };

        self.save_checkpoint(&checkpoint)?;
        
        Ok(checkpoint)
    }

    fn hash_and_store_file(&self, path: &Path) -> Result<(String, u64)> {
        let data = fs::read(path).map_err(|e| Error::io_with_path(e, path))?;
        let size = data.len() as u64;
        
        let mut hasher = Sha256::new();
        hasher.update(&data);
        let hash = format!("{:x}", hasher.finalize());
        
        let object_rel_path = PathBuf::from(&hash[..2]).join(&hash);
        let object_path = self.object_store.join(object_rel_path);
        
        if !object_path.exists() {
            if let Some(parent) = object_path.parent() {
                fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
            }
            fs::write(&object_path, data).map_err(|e| Error::io_with_path(e, &object_path))?;
        }
        
        Ok((hash, size))
    }

    fn detect_type(&self, path: &Path) -> AssetType {
        let ext = path.extension()
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
        serde_json::to_writer_pretty(file, checkpoint)
            .map_err(|e| Error::InvalidInput(format!("Failed to save checkpoint: {}", e)))?;
        Ok(())
    }

    pub fn load_checkpoint(&self, id: &str) -> Result<Checkpoint> {
        let path = self.checkpoints_dir.join(format!("{}.json", id));
        let file = fs::File::open(&path).map_err(|e| Error::io_with_path(e, &path))?;
        let checkpoint = serde_json::from_reader(file)
            .map_err(|e| Error::InvalidInput(format!("Failed to load checkpoint: {}", e)))?;
        Ok(checkpoint)
    }

    pub fn list_checkpoints(&self) -> Result<Vec<Checkpoint>> {
        let mut checkpoints = Vec::new();
        if !self.checkpoints_dir.exists() {
            return Ok(checkpoints);
        }

        for entry in fs::read_dir(&self.checkpoints_dir)
            .map_err(|e| Error::io_with_path(e, &self.checkpoints_dir))?
        {
            let entry = entry.map_err(|e| Error::InvalidInput(e.to_string()))?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(cp) = self.load_checkpoint(path.file_stem().unwrap().to_str().unwrap()) {
                    checkpoints.push(cp);
                }
            }
        }

        // Sort by timestamp descending
        checkpoints.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        Ok(checkpoints)
    }

    pub fn restore_checkpoint(&self, id: &str) -> Result<()> {
        let checkpoint = self.load_checkpoint(id)?;
        
        // 1. Reconstruct all files from manifest
        for (rel_path, entry) in &checkpoint.file_manifest {
            let target_path = self.project_path.join(rel_path.replace('/', "\\"));
            let object_path = self.object_store.join(&entry.hash[..2]).join(&entry.hash);
            
            if !object_path.exists() {
                return Err(Error::InvalidInput(format!("Object not found for hash: {}", entry.hash)));
            }

            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|e| Error::io_with_path(e, parent))?;
            }
            
            fs::copy(&object_path, &target_path).map_err(|e| Error::io_with_path(e, &target_path))?;
        }
        
        Ok(())
    }

    pub fn compare_checkpoints(&self, from_id: &str, to_id: &str) -> Result<CheckpointDiff> {
        let cp1 = self.load_checkpoint(from_id)?;
        let cp2 = self.load_checkpoint(to_id)?;
        
        let mut diff = CheckpointDiff::default();
        
        for (path, entry) in &cp2.file_manifest {
            match cp1.file_manifest.get(path) {
                None => diff.added.push(entry.clone()),
                Some(old) if old.hash != entry.hash => {
                    diff.modified.push((old.clone(), entry.clone()));
                }
                _ => {} // Unchanged
            }
        }
        
        for (path, entry) in &cp1.file_manifest {
            if !cp2.file_manifest.contains_key(path) {
                diff.deleted.push(entry.clone());
            }
        }
        
        Ok(diff)
    }

    pub fn delete_checkpoint(&self, id: &str) -> Result<()> {
        let path = self.checkpoints_dir.join(format!("{}.json", id));
        if path.exists() {
            fs::remove_file(&path).map_err(|e| Error::io_with_path(e, &path))?;
        }
        Ok(())
    }
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct CheckpointDiff {
    pub added: Vec<FileEntry>,
    pub modified: Vec<(FileEntry, FileEntry)>, // (old, new)
    pub deleted: Vec<FileEntry>,
}
