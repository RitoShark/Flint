use flint_core::bin::{read_bin, write_bin, BinValue};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::{Path, PathBuf},
};

fn root(path: &Path) -> Result<PathBuf, String> {
    path.ancestors()
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().to_lowercase().ends_with(".wad.client"))
        })
        .map(Path::to_path_buf)
        .ok_or_else(|| "Choose a BIN inside an extracted project WAD".into())
}
fn safe(path: &str) -> bool {
    !path.contains([':', '\\'])
        && path
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}
fn refs(
    value: &BinValue,
    links: &mut BTreeSet<u32>,
    files: &mut BTreeSet<u64>,
    paths: &mut BTreeSet<String>,
) {
    match value {
        BinValue::Link(h) | BinValue::Hash(h) => {
            links.insert(*h);
        }
        BinValue::File(h) if *h != 0 => {
            files.insert(*h);
        }
        BinValue::String(p) if p.to_lowercase().starts_with("assets/") => {
            paths.insert(p.replace('\\', "/"));
        }
        BinValue::Embed { fields, .. } | BinValue::Pointer { fields, .. } => {
            for v in fields.values() {
                refs(v, links, files, paths);
            }
        }
        BinValue::List { items, .. } => {
            for v in items {
                refs(v, links, files, paths);
            }
        }
        BinValue::Map { entries, .. } => {
            for (k, v) in entries {
                refs(k, links, files, paths);
                refs(v, links, files, paths);
            }
        }
        BinValue::Option { value: Some(v), .. } => refs(v, links, files, paths),
        _ => {}
    }
}
#[derive(Debug, Serialize)]
pub struct PortReport {
    entries: usize,
    files: usize,
}
fn port(source: &Path, target: &Path, systems: Vec<String>) -> Result<PortReport, String> {
    let source_root = std::fs::canonicalize(root(source)?).map_err(|e| e.to_string())?;
    let target_root = std::fs::canonicalize(root(target)?).map_err(|e| e.to_string())?;
    let mut donor_entries = BTreeMap::new();
    let mut names = flint_core::bin::Trailer::new();
    let mut pending = vec![source.to_path_buf()];
    let mut visited = BTreeSet::new();
    while let Some(path) = pending.pop() {
        let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        if !path.starts_with(&source_root) {
            return Err("Linked BIN leaves donor WAD".into());
        }
        if !visited.insert(path.clone()) {
            continue;
        }
        if visited.len() > 256 {
            return Err("Too many linked donor BINs".into());
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let bin = read_bin(&bytes).map_err(|e| e.to_string())?;
        let table = flint_core::bin::names::name_table(&bin, &path);
        names.names.extend(table.names);
        names.files.extend(table.files);
        for link in bin.linked {
            if safe(&link) {
                pending.push(source_root.join(link));
            } else {
                return Err("Unsafe linked BIN path".into());
            }
        }
        for entry in bin.entries {
            donor_entries.entry(entry.path_hash).or_insert(entry);
        }
    }
    let target_bytes = std::fs::read(target).map_err(|e| e.to_string())?;
    let mut destination = read_bin(&target_bytes).map_err(|e| e.to_string())?;
    let mut wanted = BTreeSet::new();
    for key in systems {
        let hash =
            u32::from_str_radix(key.trim_start_matches("0x"), 16).map_err(|e| e.to_string())?;
        let entry = donor_entries.get(&hash).ok_or("Donor system is missing")?;
        if entry.class_hash != 0x45cd899f {
            return Err("Selection is not a VFX system".into());
        }
        wanted.insert(hash);
    }
    if wanted.is_empty() {
        return Err("Select at least one VFX system".into());
    }
    let mut queue: Vec<_> = wanted.iter().copied().collect();
    let mut file_hashes = BTreeSet::new();
    let mut paths = BTreeSet::new();
    while let Some(hash) = queue.pop() {
        let entry = &donor_entries[&hash];
        let mut links = BTreeSet::new();
        for value in entry.fields.values() {
            refs(value, &mut links, &mut file_hashes, &mut paths);
        }
        for link in links {
            if donor_entries.contains_key(&link) && wanted.insert(link) {
                queue.push(link);
            }
        }
    }
    let mut indexed = BTreeMap::new();
    for entry in walkdir::WalkDir::new(&source_root).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(&source_root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        indexed.insert(flint_core::hash::wad_chunk_hash(&relative), relative);
    }
    for hash in file_hashes {
        let path = indexed.get(&hash).ok_or_else(|| {
            format!("Donor asset {hash:016x} is missing. Extract its dependencies first.")
        })?;
        paths.insert(path.clone());
    }
    let mut copies = Vec::new();
    for path in &paths {
        names
            .files
            .insert(flint_core::hash::wad_chunk_hash(path), path.clone());
    }
    for path in paths {
        if !safe(&path) {
            return Err("Unsafe donor asset path".into());
        }
        let input = std::fs::canonicalize(source_root.join(&path))
            .map_err(|_| format!("Donor asset is missing: {path}"))?;
        if !input.starts_with(&source_root) {
            return Err("Donor asset leaves its WAD".into());
        }
        let bytes = std::fs::read(input).map_err(|e| e.to_string())?;
        let output = target_root.join(&path);
        if output.exists() {
            if std::fs::read(&output).map_err(|e| e.to_string())? != bytes {
                return Err(format!(
                    "Asset conflict: {path}. Existing files are preserved."
                ));
            }
        } else {
            copies.push((output, bytes));
        }
    }
    let mut added = 0;
    for hash in wanted {
        let entry = donor_entries.remove(&hash).unwrap();
        if let Some(existing) = destination.entries.iter().find(|e| e.path_hash == hash) {
            if existing != &entry {
                return Err(format!(
                    "Entry conflict: {hash:08x}. Existing definitions are preserved."
                ));
            }
        } else {
            destination.entries.push(entry);
            added += 1;
        }
    }
    let bytes = write_bin(&destination).map_err(|e| e.to_string())?;
    for (output, _) in &copies {
        let mut parent = output.parent();
        while let Some(path) = parent {
            if path.exists() {
                if !std::fs::canonicalize(path)
                    .map_err(|e| e.to_string())?
                    .starts_with(&target_root)
                {
                    return Err("Asset destination leaves target WAD".into());
                }
                break;
            }
            parent = path.parent();
        }
    }
    let mut created = Vec::new();
    let write_result = (|| -> Result<(), String> {
        for (output, bytes) in &copies {
            std::fs::create_dir_all(output.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(output)
                .map_err(|e| e.to_string())?;
            created.push(output.clone());
            file.write_all(bytes).map_err(|e| e.to_string())?;
        }
        super::persist::replace_if_unchanged(target, &target_bytes, &bytes)?;
        Ok(())
    })();
    if let Err(error) = write_result {
        for path in created {
            let _ = std::fs::remove_file(path);
        }
        return Err(error);
    }
    let _ = std::fs::remove_file(format!("{}.ritobin", target.display()));
    super::bin::merge_into_files_txt(target, &names);
    Ok(PortReport {
        entries: added,
        files: copies.len(),
    })
}
#[tauri::command]
pub async fn port_vfx_systems(
    app: tauri::AppHandle,
    source: String,
    target: String,
    systems: Vec<String>,
) -> Result<PortReport, String> {
    let project = flint_core::mesh::discovery::find_project_root(Path::new(&target))
        .ok_or("Target must belong to a Flint project")?;
    crate::commands::checkpoint::create_checkpoint(
        app,
        project.to_string_lossy().into_owned(),
        "Import donor VFX systems".into(),
        vec!["vfx".into()],
    )
    .await?;
    tokio::task::spawn_blocking(move || port(Path::new(&source), Path::new(&target), systems))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use flint_core::bin::{Bin, BinEntry};
    #[test]
    fn imports_linked_definitions_and_assets_without_overwriting_conflicts() {
        let temp = tempfile::tempdir().unwrap();
        let donor = temp.path().join("donor.wad.client");
        let target = temp.path().join("target.wad.client");
        std::fs::create_dir_all(donor.join("assets")).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(donor.join("assets/fx.tex"), b"texture").unwrap();
        let mut bin = Bin::new();
        bin.entries.push(BinEntry {
            path_hash: 1,
            class_hash: 0x45cd899f,
            fields: [(1, BinValue::Link(2))].into_iter().collect(),
        });
        bin.entries.push(BinEntry {
            path_hash: 2,
            class_hash: 3,
            fields: [(
                1,
                BinValue::File(flint_core::hash::wad_chunk_hash("assets/fx.tex")),
            )]
            .into_iter()
            .collect(),
        });
        std::fs::write(donor.join("skin.bin"), write_bin(&bin).unwrap()).unwrap();
        let empty = write_bin(&Bin::new()).unwrap();
        std::fs::write(target.join("skin.bin"), &empty).unwrap();
        let report = port(
            &donor.join("skin.bin"),
            &target.join("skin.bin"),
            vec!["00000001".into()],
        )
        .unwrap();
        assert_eq!((report.entries, report.files), (2, 1));
        assert_eq!(
            std::fs::read(target.join("assets/fx.tex")).unwrap(),
            b"texture"
        );
        std::fs::write(target.join("skin.bin"), &empty).unwrap();
        std::fs::write(target.join("assets/fx.tex"), b"custom texture").unwrap();
        assert!(port(
            &donor.join("skin.bin"),
            &target.join("skin.bin"),
            vec!["00000001".into()]
        )
        .unwrap_err()
        .contains("Asset conflict"));
        assert_eq!(std::fs::read(target.join("skin.bin")).unwrap(), empty);
        assert_eq!(
            std::fs::read(target.join("assets/fx.tex")).unwrap(),
            b"custom texture"
        );
    }
}
