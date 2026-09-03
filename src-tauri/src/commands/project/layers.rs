//! Project layer creation and listing.

use crate::core::ipc_trace;
use serde::Serialize;
use std::path::{Path, PathBuf};
/// One bucket a layer file can land in. Every file gets exactly one, decided
/// by `categorize`, so the chips in the Add Layer modal and the `categories`
/// argument below can never disagree about what a category contains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LayerCategory {
    Animation,
    Model,
    Particle,
    Audio,
    Data,
    Other,
}

impl LayerCategory {
    fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "animation" | "animations" | "anim" => Some(Self::Animation),
            "model" | "models" | "mesh" => Some(Self::Model),
            "particle" | "particles" | "vfx" => Some(Self::Particle),
            "audio" | "sound" | "sounds" | "sfx" => Some(Self::Audio),
            "data" | "bin" | "bins" => Some(Self::Data),
            "other" | "misc" => Some(Self::Other),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Animation => "animation",
            Self::Model => "model",
            Self::Particle => "particle",
            Self::Audio => "audio",
            Self::Data => "data",
            Self::Other => "other",
        }
    }
}

const MODEL_EXTS: &[&str] = &["skn", "scb", "sco", "skl"];
const TEXTURE_EXTS: &[&str] = &["tex", "dds", "png", "tga"];

/// Assign `rel_path` (forward-slashed, layer-relative) to its single category.
/// `model_dirs` holds the lower-cased layer-relative directories that contain
/// at least one mesh, so textures sitting beside a mesh count as Model.
///
/// Order matters: a VFX bin under `data/` is a Particle, not Data.
fn categorize(rel_path: &str, model_dirs: &std::collections::HashSet<String>) -> LayerCategory {
    let lower = rel_path.to_ascii_lowercase();
    let ext = Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    if ext == "anm" || has_segment(&lower, "animations") {
        return LayerCategory::Animation;
    }
    if has_segment(&lower, "particles")
        || has_segment(&lower, "vfx")
        || (ext == "bin" && (lower.contains("vfx") || lower.contains("particle")))
    {
        return LayerCategory::Particle;
    }
    if matches!(ext, "bnk" | "wpk" | "wem")
        || has_segment(&lower, "sounds")
        || has_segment(&lower, "sfx")
        || has_segment(&lower, "vo")
    {
        return LayerCategory::Audio;
    }
    if MODEL_EXTS.contains(&ext) {
        return LayerCategory::Model;
    }
    if TEXTURE_EXTS.contains(&ext) && is_under_any(&lower, model_dirs) {
        return LayerCategory::Model;
    }
    if has_segment(&lower, "data") {
        return LayerCategory::Data;
    }
    LayerCategory::Other
}

/// True when `name` is a whole path segment of `path_lower`, so `vfx` does not
/// match `vfx_textures` and `data` does not match `metadata`.
fn has_segment(path_lower: &str, name: &str) -> bool {
    path_lower.split('/').any(|seg| seg == name)
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

/// Layer-relative directories holding at least one mesh file.
fn collect_model_dirs(source_root: &Path) -> std::collections::HashSet<String> {
    let mut dirs = std::collections::HashSet::new();
    for entry in walkdir::WalkDir::new(source_root).min_depth(1) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !MODEL_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let rel = match entry.path().strip_prefix(source_root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if let Some(parent) = rel.parent() {
            dirs.insert(parent.to_string_lossy().replace('\\', "/").to_ascii_lowercase());
        }
    }
    dirs
}

/// One selectable file in the Add Layer explorer.
#[derive(Debug, Serialize)]
pub struct LayerFile {
    pub path: String,
    pub size: u64,
    pub category: &'static str,
}

/// Flat listing of everything a layer holds, each file tagged with the
/// category it belongs to. Paths are layer-relative and forward-slashed.
#[tauri::command]
pub async fn list_layer_files(
    project_path: String,
    layer_name: String,
) -> Result<Vec<LayerFile>, String> {
    let _t = ipc_trace::enter("list_layer_files");
    let source_root = PathBuf::from(&project_path).join("content").join(&layer_name);
    if !source_root.is_dir() {
        return Err(format!("Layer not found: content/{}", layer_name));
    }

    tokio::task::spawn_blocking(move || {
        let model_dirs = collect_model_dirs(&source_root);
        let mut files: Vec<LayerFile> = Vec::new();
        for entry in walkdir::WalkDir::new(&source_root).min_depth(1) {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let abs = entry.path();
            // .ritobin is a generated cache file — never offer it.
            if abs.extension().and_then(|e| e.to_str()) == Some("ritobin") {
                continue;
            }
            let rel = match abs.strip_prefix(&source_root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let path = rel.to_string_lossy().replace('\\', "/");
            let category = categorize(&path, &model_dirs).as_str();
            files.push(LayerFile {
                size: entry.metadata().map(|m| m.len()).unwrap_or(0),
                path,
                category,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        files
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))
}

/// Reject anything that could escape the source layer: absolute paths, drive
/// prefixes, and `..` segments.
fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains(':')
        && !path.split('/').any(|seg| seg == ".." || seg.is_empty())
}

#[derive(Debug, Serialize)]
pub struct CreateLayerResult {
    pub layer_name: String,
    pub layer_path: String,
    pub files_copied: usize,
    pub bytes_copied: u64,
}

/// Create a new mod-project layer under `content/<layer_name>/` by copying
/// files out of `source_layer` and registering the layer in `mod.config.json`.
///
/// # Arguments
/// * `project_path` — absolute path to the project root.
/// * `layer_name` — new layer slug (lower-case letters, digits, `_`/`-`).
/// * `source_layer` — name of an existing layer to seed from (e.g. `"base"`).
/// * `categories` — file categories to copy. Empty vec creates an empty layer.
///   Ignored entirely when `files` is given.
/// * `files` — explicit layer-relative paths to copy, from the file picker.
///   Wins over `categories`.
/// * `description` — optional description recorded in `mod.config.json`.
/// * `priority` — optional explicit priority. When `None`, picks
///   `max(existing) + 1` so the new layer overrides everything.
#[tauri::command]
pub async fn create_project_layer(
    project_path: String,
    layer_name: String,
    source_layer: String,
    categories: Vec<String>,
    files: Option<Vec<String>>,
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

    if let Some(list) = files.as_ref() {
        if let Some(bad) = list.iter().find(|p| !safe_relative(p)) {
            return Err(format!("Refusing to copy path outside the layer: {}", bad));
        }
    }

    let parsed_cats: Vec<LayerCategory> = categories
        .iter()
        .filter_map(|c| LayerCategory::parse(c))
        .collect();

    let dest_root_for_task = dest_root.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<CreateLayerResult, String> {
        std::fs::create_dir_all(&dest_root_for_task)
            .map_err(|e| format!("Failed to create layer directory: {}", e))?;

        let mut files_copied = 0usize;
        let mut bytes_copied = 0u64;

        let mut copy_one = |rel: &str| -> Result<(), String> {
            let source = source_root.join(rel);
            if !source.is_file() {
                return Ok(());
            }
            let target = dest_root_for_task.join(rel);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            }
            let copied = std::fs::copy(&source, &target)
                .map_err(|e| format!("Failed to copy {}: {}", rel, e))?;
            files_copied += 1;
            bytes_copied += copied;
            Ok(())
        };

        match files {
            Some(list) => {
                for rel in &list {
                    copy_one(rel)?;
                }
            }
            None => {
                let model_dirs = if parsed_cats.contains(&LayerCategory::Model) {
                    collect_model_dirs(&source_root)
                } else {
                    std::collections::HashSet::new()
                };
                let mut rels: Vec<String> = Vec::new();
                for entry in walkdir::WalkDir::new(&source_root).min_depth(1) {
                    let entry = match entry {
                        Ok(e) => e,
                        Err(_) => continue,
                    };
                    if !entry.file_type().is_file() {
                        continue;
                    }
                    let abs = entry.path();
                    // .ritobin is a generated cache file — never duplicate it.
                    if abs.extension().and_then(|e| e.to_str()) == Some("ritobin") {
                        continue;
                    }
                    let rel = match abs.strip_prefix(&source_root) {
                        Ok(r) => r,
                        Err(_) => continue,
                    };
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    if !parsed_cats.is_empty()
                        && !parsed_cats.contains(&categorize(&rel_str, &model_dirs))
                    {
                        continue;
                    }
                    rels.push(rel_str);
                }
                for rel in &rels {
                    copy_one(rel)?;
                }
            }
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

/// One layer already registered in `mod.config.json`, in priority order.
#[derive(Debug, Serialize)]
pub struct ProjectLayer {
    pub name: String,
    pub priority: i32,
    pub description: Option<String>,
}

/// List the layers registered in `mod.config.json`, lowest priority first.
#[tauri::command]
pub async fn list_project_layers(project_path: String) -> Result<Vec<ProjectLayer>, String> {
    let _t = ipc_trace::enter("list_project_layers");
    let config_path = PathBuf::from(&project_path).join("mod.config.json");
    let fallback = || {
        vec![ProjectLayer {
            name: "base".to_string(),
            priority: 0,
            description: None,
        }]
    };
    if !config_path.is_file() {
        return Ok(fallback());
    }
    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read mod.config.json: {}", e))?;
    let config: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("mod.config.json is not valid JSON: {}", e))?;
    let mut layers: Vec<ProjectLayer> = config
        .get("layers")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|l| {
                    let name = l.get("name").and_then(|n| n.as_str())?.to_string();
                    Some(ProjectLayer {
                        name,
                        priority: l
                            .get("priority")
                            .and_then(|p| p.as_i64())
                            .unwrap_or(0) as i32,
                        description: l
                            .get("description")
                            .and_then(|d| d.as_str())
                            .map(String::from),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if layers.is_empty() {
        return Ok(fallback());
    }
    layers.sort_by_key(|l| l.priority);
    Ok(layers)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn dirs(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_vfx_bin_under_data_is_a_particle_not_data() {
        let none = HashSet::new();
        assert_eq!(
            categorize("base.wad.client/data/characters/ahri/skins/skin01_vfx.bin", &none),
            LayerCategory::Particle,
        );
    }

    #[test]
    fn a_skin_bin_is_data() {
        let none = HashSet::new();
        assert_eq!(
            categorize("base.wad.client/data/characters/ahri/skins/skin01.bin", &none),
            LayerCategory::Data,
        );
    }

    #[test]
    fn a_texture_beside_a_mesh_is_a_model_and_a_loose_one_is_not() {
        let model_dirs = dirs(&["base.wad.client/assets/characters/ahri/skins/skin01"]);
        assert_eq!(
            categorize(
                "base.wad.client/assets/characters/ahri/skins/skin01/ahri_base_tx_cm.tex",
                &model_dirs,
            ),
            LayerCategory::Model,
        );
        assert_eq!(
            categorize("base.wad.client/assets/ux/lobby/banner.tex", &model_dirs),
            LayerCategory::Other,
        );
    }

    #[test]
    fn segment_matching_does_not_fire_on_a_prefix() {
        let none = HashSet::new();
        // `metadata` must not read as `data`, `vfx_textures` must not read as `vfx`.
        assert_eq!(
            categorize("base.wad.client/metadata/notes.txt", &none),
            LayerCategory::Other,
        );
        assert_eq!(
            categorize("base.wad.client/assets/vfx_textures/glow.tex", &none),
            LayerCategory::Other,
        );
    }

    #[test]
    fn an_anm_is_an_animation_wherever_it_sits() {
        let none = HashSet::new();
        assert_eq!(
            categorize("base.wad.client/assets/characters/ahri/idle.anm", &none),
            LayerCategory::Animation,
        );
    }

    #[test]
    fn safe_relative_rejects_escapes() {
        assert!(safe_relative("assets/characters/ahri/idle.anm"));
        assert!(!safe_relative("../outside.txt"));
        assert!(!safe_relative("/absolute.txt"));
        assert!(!safe_relative("C:/windows/system32/evil.dll"));
        assert!(!safe_relative("assets//double.tex"));
        assert!(!safe_relative(""));
    }

    #[test]
    fn every_category_string_round_trips() {
        for cat in [
            LayerCategory::Animation,
            LayerCategory::Model,
            LayerCategory::Particle,
            LayerCategory::Audio,
            LayerCategory::Data,
            LayerCategory::Other,
        ] {
            assert_eq!(LayerCategory::parse(cat.as_str()), Some(cat));
        }
    }
}
