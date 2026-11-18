use flint_core::bin::{read_bin, BinValue};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Serialize)]
pub struct GhostInventory {
    pub present: Vec<String>,
    pub references: Vec<String>,
    pub wads: Vec<String>,
}

fn collect(value: &BinValue, out: &mut BTreeSet<String>) {
    match value {
        BinValue::File(h) => {
            out.insert(format!("{h:016x}"));
        }
        BinValue::String(path) if path.contains('/') || path.contains('\\') => {
            let path = path.replace('\\', "/").to_lowercase();
            out.insert(format!(
                "{:016x}",
                xxhash_rust::xxh64::xxh64(path.as_bytes(), 0)
            ));
        }
        BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => {
            for v in fields.values() {
                collect(v, out);
            }
        }
        BinValue::List { items, .. } => {
            for v in items {
                collect(v, out);
            }
        }
        BinValue::Option { value: Some(v), .. } => collect(v, out),
        BinValue::Map { entries, .. } => {
            for (k, v) in entries {
                collect(k, out);
                collect(v, out);
            }
        }
        _ => {}
    }
}

#[tauri::command]
pub async fn project_ghost_inventory(project_path: String) -> Result<GhostInventory, String> {
    tokio::task::spawn_blocking(move || {
        let mut present = BTreeSet::new();
        let mut references = BTreeSet::new();
        let mut wads = BTreeSet::new();
        let content = Path::new(&project_path).join("content");
        let mut wad_folders = Vec::new();
        for layer in std::fs::read_dir(content).map_err(|e| e.to_string())? {
            let layer = layer.map_err(|e| e.to_string())?;
            if !layer.file_type().map_err(|e| e.to_string())?.is_dir() {
                continue;
            }
            for entry in std::fs::read_dir(layer.path()).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_type().map_err(|e| e.to_string())?.is_dir()
                    && entry
                        .file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        .ends_with(".wad.client")
                {
                    wad_folders.push(entry.path());
                }
            }
        }
        for wad in wad_folders {
            let name = wad
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            wads.insert(name.clone());
            for entry in walkdir::WalkDir::new(&wad).follow_links(false) {
                let entry = entry.map_err(|e| e.to_string())?;
                if !entry.file_type().is_file() {
                    continue;
                }
                let relative = entry
                    .path()
                    .strip_prefix(&wad)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_lowercase();
                present.insert(format!(
                    "{name}/{:016x}",
                    xxhash_rust::xxh64::xxh64(relative.as_bytes(), 0)
                ));
                if let Some(stem) = entry.path().file_stem().and_then(|s| s.to_str()) {
                    if stem.len() == 16 && u64::from_str_radix(stem, 16).is_ok() {
                        present.insert(format!("{name}/{}", stem.to_lowercase()));
                    }
                }
                if relative.ends_with(".bin") {
                    let bytes = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
                    let bin =
                        read_bin(&bytes).map_err(|e| format!("{}: {e}", entry.path().display()))?;
                    for linked in &bin.linked {
                        collect(&BinValue::String(linked.clone()), &mut references);
                    }
                    for entry in bin.entries {
                        for v in entry.fields.values() {
                            collect(v, &mut references);
                        }
                    }
                }
            }
        }
        Ok(GhostInventory {
            present: present.into_iter().collect(),
            references: references.into_iter().collect(),
            wads: wads.into_iter().collect(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains([':', '\\'])
        && path
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}

#[tauri::command]
pub async fn bring_ghost_to_layer(
    project_path: String,
    layer: String,
    wad_path: String,
    hash: String,
    asset_path: Option<String>,
) -> Result<String, String> {
    let layers = super::layers::list_project_layers(project_path.clone()).await?;
    if !layers.iter().any(|l| l.name == layer) || !safe_relative(&layer) || layer.contains('/') {
        return Err("Unknown project layer".into());
    }
    tokio::task::spawn_blocking(move || {
        let hash =
            u64::from_str_radix(hash.trim_start_matches("0x"), 16).map_err(|e| e.to_string())?;
        let wad = PathBuf::from(&wad_path);
        let name = wad
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Invalid WAD name")?;
        if !name.to_lowercase().ends_with(".wad.client") {
            return Err("Expected a game WAD".into());
        }
        let mut reader =
            flint_core::wad::adapter::WadHandle::open(&wad).map_err(|e| e.to_string())?;
        let chunk = reader.get_chunk(hash).cloned().ok_or("Chunk is missing")?;
        let bytes = reader
            .wad_mut()
            .load_chunk_decompressed(&chunk)
            .map_err(|e| e.to_string())?;
        let relative = asset_path.unwrap_or_else(|| {
            format!(
                "{hash:016x}.{}",
                flint_core::wad::sniff::sniff(&bytes)
                    .map(|f| f.ext)
                    .unwrap_or("ltk")
            )
        });
        if !safe_relative(&relative) {
            return Err("Invalid asset path".into());
        }
        let root = std::fs::canonicalize(project_path).map_err(|e| e.to_string())?;
        let mut parent = root.clone();
        let destination = format!("content/{layer}/{name}/{relative}");
        let pieces: Vec<_> = destination.split('/').collect();
        for piece in &pieces[..pieces.len() - 1] {
            parent.push(piece);
            if parent.exists() {
                if !std::fs::canonicalize(&parent)
                    .map_err(|e| e.to_string())?
                    .starts_with(&root)
                {
                    return Err("Destination leaves the project".into());
                }
            } else {
                std::fs::create_dir(&parent).map_err(|e| e.to_string())?;
            }
        }
        let output = root.join(destination);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|e| format!("Cannot add file (existing files are preserved): {e}"))?;
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&output);
            return Err(error.to_string());
        }
        Ok(output.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reference_walk_handles_hashes_and_normalizes_paths() {
        let mut refs = BTreeSet::new();
        collect(&BinValue::File(42), &mut refs);
        collect(&BinValue::String("ASSETS\\test.tex".into()), &mut refs);
        assert!(refs.contains("000000000000002a"));
        assert!(refs.contains(&format!(
            "{:016x}",
            xxhash_rust::xxh64::xxh64(b"assets/test.tex", 0)
        )));
        for path in ["../x", "C:/x", "/x", "assets/../x", "a\\b"] {
            assert!(!safe_relative(path));
        }
        assert!(safe_relative("assets/test.tex"));
    }
    #[tokio::test]
    async fn inventory_includes_other_layers_and_preserves_raw_hash_identity() {
        let root = tempfile::tempdir().unwrap();
        let wad = root.path().join("content/chroma/ahri.wad.client");
        std::fs::create_dir_all(&wad).unwrap();
        std::fs::write(wad.join("000000000000002a.tex"), b"fixture").unwrap();
        let inv = project_ghost_inventory(root.path().to_string_lossy().into_owned())
            .await
            .unwrap();
        assert!(inv
            .present
            .contains(&"ahri.wad.client/000000000000002a".into()));
    }
}

#[derive(Clone, Serialize)]
pub struct LayerGhost {
    pub path: String,
    pub source: String,
    pub layer: String,
    pub size: u64,
}

#[tauri::command]
pub async fn list_layer_ghosts(project_path: String) -> Result<Vec<LayerGhost>, String> {
    let inventory = project_ghost_inventory(project_path.clone()).await?;
    let layers = super::layers::list_project_layers(project_path.clone()).await?;
    tokio::task::spawn_blocking(move || {
        let root = Path::new(&project_path);
        let base = root.join("content/base");
        if !base.is_dir() {
            return Ok(Vec::new());
        }
        let referenced: BTreeSet<_> = inventory.references.into_iter().collect();
        let mut result = Vec::new();
        for entry in walkdir::WalkDir::new(&base).follow_links(false) {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&base)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            let Some((wad, asset)) = relative.split_once('/') else {
                continue;
            };
            if !wad.to_lowercase().ends_with(".wad.client") {
                continue;
            }
            let hash = format!("{:016x}", flint_core::hash::wad_chunk_hash(asset));
            let raw = entry
                .path()
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if !referenced.contains(&hash) && !(raw.len() == 16 && referenced.contains(&raw)) {
                continue;
            }
            for layer in &layers {
                if layer.name == "base" || !safe_relative(&layer.name) || layer.name.contains('/') {
                    continue;
                }
                let destination = format!("content/{}/{relative}", layer.name);
                if root.join(&destination).exists() {
                    continue;
                }
                result.push(LayerGhost {
                    path: destination,
                    source: format!("content/base/{relative}"),
                    layer: layer.name.clone(),
                    size: entry.metadata().map_err(|e| e.to_string())?.len(),
                });
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn bring_inherited_to_layer(
    project_path: String,
    source: String,
    layer: String,
) -> Result<(), String> {
    if !safe_relative(&source) {
        return Err("Invalid source path".into());
    }
    let candidate = list_layer_ghosts(project_path.clone())
        .await?
        .into_iter()
        .find(|g| g.source == source && g.layer == layer)
        .ok_or("File is no longer an inherited reference; refresh the project")?;
    tokio::task::spawn_blocking(move || {
        let root = std::fs::canonicalize(project_path).map_err(|e| e.to_string())?;
        let input =
            std::fs::canonicalize(root.join(&candidate.source)).map_err(|e| e.to_string())?;
        if !input.starts_with(&root) {
            return Err("Source leaves the project".into());
        }
        let output = root.join(&candidate.path);
        let mut parent = root.clone();
        let pieces: Vec<_> = candidate.path.split('/').collect();
        for piece in &pieces[..pieces.len() - 1] {
            parent.push(piece);
            if parent.exists() {
                if !std::fs::canonicalize(&parent)
                    .map_err(|e| e.to_string())?
                    .starts_with(&root)
                {
                    return Err("Destination leaves the project".into());
                }
            } else {
                std::fs::create_dir(&parent).map_err(|e| e.to_string())?;
            }
        }
        let mut source = std::fs::File::open(input).map_err(|e| e.to_string())?;
        let mut destination = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|e| e.to_string())?;
        if let Err(error) =
            std::io::copy(&mut source, &mut destination).and_then(|_| destination.sync_all())
        {
            drop(destination);
            let _ = std::fs::remove_file(output);
            return Err(error.to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod layer_fixture_tests {
    #[tokio::test]
    async fn inherited_copy_only_includes_references_and_preserves_overrides() {
        use flint_core::bin::{write_bin, Bin, BinEntry, BinValue};
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("content/base/kayn.wad.client");
        std::fs::create_dir_all(base.join("assets")).unwrap();
        std::fs::write(base.join("assets/a.tex"), b"texture").unwrap();
        std::fs::write(base.join("assets/unused.tex"), b"unused").unwrap();
        std::fs::write(
            temp.path().join("mod.config.json"),
            r#"{"layers":[{"name":"base"},{"name":"red"},{"name":"blue"}]}"#,
        )
        .unwrap();
        let mut bin = Bin::new();
        bin.entries.push(BinEntry {
            path_hash: 1,
            class_hash: 2,
            fields: [(
                3,
                BinValue::File(flint_core::hash::wad_chunk_hash("assets/a.tex")),
            )]
            .into_iter()
            .collect(),
        });
        std::fs::write(base.join("skin.bin"), write_bin(&bin).unwrap()).unwrap();
        let blue = temp.path().join("content/blue/kayn.wad.client/assets");
        std::fs::create_dir_all(&blue).unwrap();
        std::fs::write(blue.join("a.tex"), b"override").unwrap();
        let project = temp.path().to_string_lossy().into_owned();
        let ghosts = super::list_layer_ghosts(project.clone()).await.unwrap();
        assert_eq!(ghosts.len(), 1);
        assert_eq!(ghosts[0].layer, "red");
        let source = ghosts[0].source.clone();
        super::bring_inherited_to_layer(project.clone(), source.clone(), "red".into())
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(temp.path().join(&ghosts[0].path)).unwrap(),
            b"texture"
        );
        assert!(super::list_layer_ghosts(project.clone())
            .await
            .unwrap()
            .is_empty());
        assert!(
            super::bring_inherited_to_layer(project, source, "red".into())
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(blue.join("a.tex")).unwrap(), b"override");
    }
    #[tokio::test]
    #[ignore]
    async fn inspect_real_layer_references() {
        let path = std::env::var("FLINT_GHOST_PROJECT").expect("fixture project path");
        let ghosts = super::list_layer_ghosts(path).await.unwrap();
        let mut counts = std::collections::BTreeMap::new();
        for ghost in ghosts {
            *counts.entry(ghost.layer).or_insert(0) += 1;
        }
        println!("Inherited references: {counts:?}");
        assert!(counts.values().all(|count| *count > 0));
        assert!(!counts.is_empty());
    }
}
