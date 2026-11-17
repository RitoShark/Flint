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
