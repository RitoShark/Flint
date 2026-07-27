//! Project layer creation and listing.

use crate::core::ipc_trace;
use serde::Serialize;
use std::path::{Path, PathBuf};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LayerCategory {
    Animation,
    Model,
    Particle,
    Audio,
}

impl LayerCategory {
    fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "animation" | "animations" | "anim" => Some(Self::Animation),
            "model" | "models" | "mesh" => Some(Self::Model),
            "particle" | "particles" | "vfx" => Some(Self::Particle),
            "audio" | "sound" | "sounds" | "sfx" => Some(Self::Audio),
            _ => None,
        }
    }
}

const MODEL_EXTS: &[&str] = &["skn", "scb", "sco", "skl"];
const TEXTURE_EXTS: &[&str] = &["tex", "dds"];

/// Returns true if `rel_path` (forward-slashed, layer-relative) belongs to any
/// of the selected categories. `model_dirs` is the set of layer-relative
/// directories containing at least one model file; when Model is selected,
/// textures under those dirs are pulled in too.
fn matches_categories(
    rel_path: &str,
    cats: &[LayerCategory],
    model_dirs: &std::collections::HashSet<String>,
) -> bool {
    let lower = rel_path.to_ascii_lowercase();
    let ext = Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    for cat in cats {
        let hit = match cat {
            LayerCategory::Animation => {
                ext == "anm" || lower.contains("/animations/")
            }
            LayerCategory::Model => {
                if MODEL_EXTS.contains(&ext) {
                    true
                } else if TEXTURE_EXTS.contains(&ext) {
                    // Texture only counts when it sits in (or under) a mesh folder.
                    is_under_any(&lower, model_dirs)
                } else {
                    false
                }
            }
            LayerCategory::Particle => {
                lower.contains("/particles/")
                    || lower.contains("/vfx/")
                    || (ext == "bin" && (lower.contains("vfx") || lower.contains("particle")))
            }
            LayerCategory::Audio => {
                matches!(ext, "bnk" | "wpk" | "wem")
                    || lower.contains("/sounds/")
                    || lower.contains("/sfx/")
                    || lower.contains("/vo/")
            }
        };
        if hit {
            return true;
        }
    }
    false
}

/// True if `path_lower` lives inside any of the directories in `dirs`
/// (which are themselves stored lower-cased and forward-slashed).
fn is_under_any(path_lower: &str, dirs: &std::collections::HashSet<String>) -> bool {
    for d in dirs {
        if d.is_empty() {
            return true;
        }
        if path_lower.starts_with(d) {
            // Require a directory boundary so "skin1" doesn't match "skin10".
            let rest = &path_lower[d.len()..];
            if rest.starts_with('/') {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Serialize)]
pub struct CreateLayerResult {
    pub layer_name: String,
    pub layer_path: String,
    pub files_copied: usize,
    pub bytes_copied: u64,
}

/// Create a new mod-project layer under `content/<layer_name>/` by copying
/// categorized files out of `source_layer` and registering the layer in
/// `mod.config.json`.
///
/// # Arguments
/// * `project_path` — absolute path to the project root.
/// * `layer_name` — new layer slug (lower-case letters, digits, `_`/`-`).
/// * `source_layer` — name of an existing layer to seed from (e.g. `"base"`).
/// * `categories` — file categories to copy. Empty vec creates an empty layer.
/// * `description` — optional description recorded in `mod.config.json`.
/// * `priority` — optional explicit priority. When `None`, picks
///   `max(existing) + 1` so the new layer overrides everything.
#[tauri::command]
pub async fn create_project_layer(
    project_path: String,
    layer_name: String,
    source_layer: String,
    categories: Vec<String>,
    description: Option<String>,
    priority: Option<i32>,
) -> Result<CreateLayerResult, String> {
    let _t = ipc_trace::enter("create_project_layer");

    // Validate the slug up front — modpkg readers reject anything else.
    let slug = layer_name.trim().to_string();
    if slug.is_empty() {
        return Err("Layer name cannot be empty".to_string());
    }
    if !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(
            "Layer name may only contain letters, digits, underscores, and hyphens"
                .to_string(),
        );
    }

    let project_root = PathBuf::from(&project_path);
    if !project_root.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    let source_root = project_root.join("content").join(&source_layer);
    if !source_root.is_dir() {
        return Err(format!(
            "Source layer not found: content/{}",
            source_layer
        ));
    }

    let dest_root = project_root.join("content").join(&slug);
    if dest_root.exists() {
        return Err(format!("Layer already exists: content/{}", slug));
    }

    let parsed_cats: Vec<LayerCategory> = categories
        .iter()
        .filter_map(|c| LayerCategory::parse(c))
        .collect();

    let dest_root_for_task = dest_root.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<CreateLayerResult, String> {
        std::fs::create_dir_all(&dest_root_for_task)
            .map_err(|e| format!("Failed to create layer directory: {}", e))?;

        // Pass 1 — collect directories that hold model files (only when Model
        // is selected, since the set is otherwise unused).
        let mut model_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
        if parsed_cats.contains(&LayerCategory::Model) {
            for entry in walkdir::WalkDir::new(&source_root).min_depth(1) {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                if !entry.file_type().is_file() {
                    continue;
                }
                let abs = entry.path();
                let ext = abs
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_ascii_lowercase())
                    .unwrap_or_default();
                if !MODEL_EXTS.contains(&ext.as_str()) {
                    continue;
                }
                let rel = match abs.strip_prefix(&source_root) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                if let Some(parent) = rel.parent() {
                    let dir = parent.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
                    model_dirs.insert(dir);
                }
            }
        }

        let mut files_copied = 0usize;
        let mut bytes_copied = 0u64;

        // Pass 2 — categorize and copy.
        for entry in walkdir::WalkDir::new(&source_root).min_depth(1) {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let abs = entry.path();
            let rel = match abs.strip_prefix(&source_root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            // .ritobin is a generated cache file — never duplicate it.
            if abs.extension().and_then(|e| e.to_str()) == Some("ritobin") {
                continue;
            }
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if !parsed_cats.is_empty()
                && !matches_categories(&rel_str, &parsed_cats, &model_dirs)
            {
                continue;
            }
            let target = dest_root_for_task.join(rel);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            }
            let copied = std::fs::copy(abs, &target)
                .map_err(|e| format!("Failed to copy {}: {}", rel_str, e))?;
            files_copied += 1;
            bytes_copied += copied;
        }

        Ok(CreateLayerResult {
            layer_name: String::new(), // filled in below
            layer_path: String::new(),
            files_copied,
            bytes_copied,
        })
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))??;

    // Update mod.config.json directly (avoids the `Project` round-trip, which
    // would also rewrite flint.json).
    let config_path = project_root.join("mod.config.json");
    if config_path.is_file() {
        let raw = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read mod.config.json: {}", e))?;
        let mut config: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("mod.config.json is not valid JSON: {}", e))?;

        let layers = config
            .as_object_mut()
            .ok_or_else(|| "mod.config.json root must be an object".to_string())?
            .entry("layers")
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
        let layers_arr = layers
            .as_array_mut()
            .ok_or_else(|| "mod.config.json `layers` is not an array".to_string())?;

        // The JSON could carry a stale entry the on-disk check missed.
        if layers_arr.iter().any(|l| {
            l.get("name").and_then(|n| n.as_str()) == Some(slug.as_str())
        }) {
            return Err(format!(
                "Layer '{}' already exists in mod.config.json",
                slug
            ));
        }

        let resolved_priority = priority.unwrap_or_else(|| {
            let max = layers_arr
                .iter()
                .filter_map(|l| l.get("priority").and_then(|p| p.as_i64()))
                .max()
                .unwrap_or(0);
            (max as i32) + 1
        });

        let mut entry = serde_json::Map::new();
        entry.insert("name".into(), serde_json::Value::String(slug.clone()));
        entry.insert(
            "priority".into(),
            serde_json::Value::Number(resolved_priority.into()),
        );
        if let Some(desc) = description.as_ref().filter(|d| !d.trim().is_empty()) {
            entry.insert("description".into(), serde_json::Value::String(desc.clone()));
        }
        layers_arr.push(serde_json::Value::Object(entry));

        let pretty = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize mod.config.json: {}", e))?;
        std::fs::write(&config_path, pretty)
            .map_err(|e| format!("Failed to write mod.config.json: {}", e))?;
    }

    Ok(CreateLayerResult {
        layer_name: slug,
        layer_path: format!("content/{}", layer_name),
        files_copied: result.files_copied,
        bytes_copied: result.bytes_copied,
    })
}

/// List the layer names currently registered in `mod.config.json`.
#[tauri::command]
pub async fn list_project_layers(project_path: String) -> Result<Vec<String>, String> {
    let _t = ipc_trace::enter("list_project_layers");
    let config_path = PathBuf::from(&project_path).join("mod.config.json");
    if !config_path.is_file() {
        return Ok(vec!["base".to_string()]);
    }
    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read mod.config.json: {}", e))?;
    let config: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("mod.config.json is not valid JSON: {}", e))?;
    let mut names: Vec<String> = config
        .get("layers")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|l| l.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if names.is_empty() {
        names.push("base".to_string());
    }
    Ok(names)
}


// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

