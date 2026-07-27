//! Locating the companion BIN and skin folder that belong to a mesh file.
//!
//! Project trees vary, so each lookup tries several strategies in turn:
//! an explicit `characters/` segment, the enclosing WAD folder, then the
//! surrounding path structure.

use std::path::Path;


/// Extract character folder name from a file path
///
/// Tries multiple strategies: characters/ pattern, WAD folder name, path structure, filename.
pub fn extract_character_folder(file_path: &Path) -> Option<String> {
    let path_str = file_path.to_string_lossy().to_lowercase();
    let components: Vec<&str> = path_str.split(&['/', '\\'][..]).collect();

    // Strategy 1: "characters/{name}" pattern.
    for (i, part) in components.iter().enumerate() {
        if part == &"characters" && i + 1 < components.len() {
            return Some(components[i + 1].to_string());
        }
    }

    // Strategy 2: WAD folder name (e.g., "aurora.wad.client" → "aurora").
    for part in &components {
        if let Some(name) = part.strip_suffix(".wad.client")
            .or_else(|| part.strip_suffix(".wad"))
        {
            if !name.is_empty() {
                tracing::debug!("Extracted champion from WAD folder: {}", name);
                return Some(name.to_string());
            }
        }
    }

    // Strategy 3: "/{name}/base/{name}.skn" or "/{name}/skins/".
    for (i, part) in components.iter().enumerate() {
        if (part == &"base" || part == &"skins") && i > 0 {
            let potential_name = components[i - 1];
            if !potential_name.is_empty() &&
               potential_name != "assets" &&
               potential_name != "data" &&
               !potential_name.contains("wad") {
                tracing::debug!("Extracted champion name from path structure: {}", potential_name);
                return Some(potential_name.to_string());
            }
        }
    }

    // Strategy 4: filename, skipping generic/compound names (last resort).
    if let Some(file_name) = file_path.file_stem() {
        let name = file_name.to_string_lossy().to_lowercase();
        if !name.starts_with("skin") && name != "base" && !name.is_empty() && !name.contains('.') {
            tracing::debug!("Extracted champion name from filename: {}", name);
            return Some(name);
        }
    }

    None
}

/// Find BIN file associated with an SCB/SCO static mesh
///
/// Searches for .bin or .bin.ritobin files using smart root detection:
/// walks up from the mesh path to find a directory containing `data/`.
pub fn find_scb_bin(scb_path: &Path) -> Option<std::path::PathBuf> {
    tracing::debug!("Looking for BIN relative to SCB: {}", scb_path.display());

    let character_folder = extract_character_folder(scb_path)?;

    let skin_folder = extract_skin_folder(scb_path);
    tracing::debug!("SCB BIN lookup: champion={}, skin={:?}", character_folder, skin_folder);

    let project_root = find_project_root(scb_path)?;
    tracing::debug!("Project root: {}", project_root.display());

    let skins_dir = project_root
        .join("data")
        .join("characters")
        .join(&character_folder)
        .join("skins");

    search_skins_dir_for_bin(&skins_dir, skin_folder.as_deref())
}

/// Extract skin folder name from a path (e.g., "skin0", "skin20", "base" → "skin0")
pub fn extract_skin_folder(path: &Path) -> Option<String> {
    let path_str = path.to_string_lossy().to_lowercase();
    let components: Vec<&str> = path_str.split(&['/', '\\'][..]).collect();

    // Strategy 1: skins/{skinN} pattern.
    for (i, part) in components.iter().enumerate() {
        if *part == "skins" && i + 1 < components.len() {
            let next = components[i + 1];
            if next.starts_with("skin") {
                return Some(next.to_string());
            } else if next == "base" {
                return Some("skin0".to_string());
            }
        }
    }

    // Strategy 2: any "skinN" directory component (WAD-extracted paths).
    for part in components.iter().rev() {
        if part.starts_with("skin") && part.len() > 4 && part[4..].chars().all(|c| c.is_ascii_digit()) {
            return Some(part.to_string());
        }
    }

    None
}

/// Find the project root by walking up the directory tree until we find
/// a directory that contains a `data/` subdirectory.
///
/// Skips `.wad.client` / `.wad` folders — those are extracted WAD content,
/// not the actual project root.
pub fn find_project_root(file_path: &Path) -> Option<std::path::PathBuf> {
    let mut current = file_path.parent()?;
    let mut best: Option<std::path::PathBuf> = None;

    for _ in 0..15 {
        let data_dir = current.join("data");
        if data_dir.exists() && data_dir.is_dir() {
            let dir_name = current.file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            // Skip WAD folders — keep searching upward for the real project root
            if dir_name.ends_with(".wad.client") || dir_name.ends_with(".wad") {
                tracing::debug!("Skipping WAD folder as project root: {}", current.display());
                if best.is_none() {
                    best = Some(current.to_path_buf());
                }
            } else {
                tracing::debug!("Found project root (has data/): {}", current.display());
                return Some(current.to_path_buf());
            }
        }
        // Never walk above the Flint project root — a stray `data\` dir in
        // AppData / the user's home hijacks resolution (machine-dependent).
        if crate::mesh::texture::is_flint_project_root(current) {
            break;
        }
        current = match current.parent() {
            Some(p) => p,
            None => break,
        };
    }

    if let Some(ref fallback) = best {
        tracing::debug!("Using WAD folder as fallback project root: {}", fallback.display());
    }
    best
}

/// Search a skins directory for BIN files, trying multiple strategies.
/// Returns the best match: Concat.bin > skinN.bin > skin0.bin > any .bin
pub fn search_skins_dir_for_bin(skins_dir: &Path, skin_folder: Option<&str>) -> Option<std::path::PathBuf> {
    if !skins_dir.exists() {
        tracing::debug!("Skins directory does not exist: {}", skins_dir.display());
        return None;
    }

    // Strategy 1: *Concat.bin (highest priority — pre-merged).
    if let Ok(entries) = std::fs::read_dir(skins_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.contains("concat") && name.ends_with(".bin") {
                tracing::debug!("Found concat BIN: {}", entry.path().display());
                return Some(entry.path());
            }
        }
    }

    // Strategy 2: skinN/ subfolder if we know the skin.
    if let Some(skin) = skin_folder {
        let nested = skins_dir.join(skin).join(format!("{}.bin", skin));
        if nested.exists() {
            tracing::debug!("Found nested skin BIN: {}", nested.display());
            return Some(nested);
        }
        let flat = skins_dir.join(format!("{}.bin", skin));
        if flat.exists() {
            tracing::debug!("Found flat skin BIN: {}", flat.display());
            return Some(flat);
        }
    }

    // Strategy 3: skin0.bin.
    let skin0 = skins_dir.join("skin0.bin");
    if skin0.exists() {
        tracing::debug!("Found fallback skin0.bin: {}", skin0.display());
        return Some(skin0);
    }

    // Strategy 4: any .bin file in skins/.
    if let Ok(entries) = std::fs::read_dir(skins_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("bin") {
                tracing::debug!("Found fallback BIN: {}", path.display());
                return Some(path);
            }
        }
    }

    tracing::debug!("No BIN found in skins dir: {}", skins_dir.display());
    None
}
