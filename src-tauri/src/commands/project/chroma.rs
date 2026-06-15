use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// FNV-1a 32-bit hash — Riot's BIN object-path hash function.
// Computed on the lowercase path string, same as ltk_meta.
// ---------------------------------------------------------------------------
fn fnv1a32(s: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for b in s.bytes() {
        hash ^= b.to_ascii_lowercase() as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

/// Replace every occurrence of `old` (4-byte LE u32) with `new` in `data`.
fn replace_u32_le(data: &mut [u8], old: u32, new: u32) {
    if old == new {
        return;
    }
    let old_bytes = old.to_le_bytes();
    let new_bytes = new.to_le_bytes();
    let mut i = 0;
    while i + 4 <= data.len() {
        if data[i..i + 4] == old_bytes {
            data[i..i + 4].copy_from_slice(&new_bytes);
            i += 4;
        } else {
            i += 1;
        }
    }
}

/// Rewrite a BIN's skin-path hashes from `skin{from_num}` to `skin{to_num}`.
/// Patches both the main entry key and the `/Resources` sub-key in one pass.
pub fn port_bin_bytes(data: &[u8], champion: &str, from_num: u32, to_num: u32) -> Vec<u8> {
    let champ_lower = champion.to_ascii_lowercase();
    let old_base = format!("characters/{}/skins/skin{}", champ_lower, from_num);
    let new_base = format!("characters/{}/skins/skin{}", champ_lower, to_num);

    let pairs = [
        (fnv1a32(&old_base), fnv1a32(&new_base)),
        (
            fnv1a32(&format!("{}/resources", old_base)),
            fnv1a32(&format!("{}/resources", new_base)),
        ),
    ];

    let mut out = data.to_vec();
    for (old_hash, new_hash) in pairs {
        replace_u32_le(&mut out, old_hash, new_hash);
    }
    out
}

// ---------------------------------------------------------------------------
// Chroma-link manifest — stored at {project_root}/chroma-links.json
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChromaBinEntry {
    /// Project-relative path to the chroma BIN (forward slashes).
    pub path: String,
    /// BIN skin number for this chroma (e.g. 1001 for skin1 chroma1).
    pub skin_num: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChromaLink {
    /// Project-relative path to the base BIN that chromas derive from.
    pub base_bin: String,
    /// Skin number of the base BIN (e.g. 1 for skin1).
    pub base_skin_num: u32,
    pub chroma_bins: Vec<ChromaBinEntry>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct ChromaLinks {
    pub links: Vec<ChromaLink>,
}

fn chroma_links_path(project_path: &Path) -> PathBuf {
    project_path.join("chroma-links.json")
}

fn read_chroma_links(project_path: &Path) -> ChromaLinks {
    let p = chroma_links_path(project_path);
    if !p.exists() {
        return ChromaLinks::default();
    }
    let raw = fs::read_to_string(&p).unwrap_or_default();
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_chroma_links(project_path: &Path, links: &ChromaLinks) -> Result<(), String> {
    let content = serde_json::to_string_pretty(links)
        .map_err(|e| format!("Failed to serialize chroma-links.json: {}", e))?;
    fs::write(chroma_links_path(project_path), content)
        .map_err(|e| format!("Failed to write chroma-links.json: {}", e))?;
    Ok(())
}

/// Walk `root` and collect every `.bin` file whose immediate parent directory
/// is exactly `skin{skin_num}` (case-insensitive).
fn find_skin_bins(root: &Path, skin_num: u32) -> Vec<PathBuf> {
    let target_dir = format!("skin{}", skin_num).to_ascii_lowercase();
    let mut result = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("bin") {
            continue;
        }
        let parent_name = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if parent_name == target_dir {
            result.push(path.to_path_buf());
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Port every BIN file under `skin{base_skin_num}/` to each requested chroma.
/// Creates the sibling `skin{chroma_skin_num}/` directories and writes patched BINs.
/// Records the links in `chroma-links.json` for future sync operations.
#[tauri::command]
pub async fn port_project_to_chromas(
    project_path: String,
    champion: String,
    base_skin_num: u32,
    chroma_skin_nums: Vec<u32>,
) -> Result<u32, String> {
    let project = Path::new(&project_path);
    let base_bins = find_skin_bins(project, base_skin_num);

    if base_bins.is_empty() {
        return Err(format!(
            "No BIN files found under skin{} in project",
            base_skin_num
        ));
    }

    let mut manifest = read_chroma_links(project);
    let mut total_written: u32 = 0;

    for chroma_num in &chroma_skin_nums {
        for base_bin in &base_bins {
            let base_data = fs::read(base_bin)
                .map_err(|e| format!("Failed to read {}: {}", base_bin.display(), e))?;

            let base_str = base_bin.to_string_lossy().replace('\\', "/");
            let old_seg = format!("skin{}", base_skin_num);
            let new_seg = format!("skin{}", chroma_num);
            let chroma_str = base_str.replacen(&old_seg, &new_seg, 1);
            let chroma_path = Path::new(&chroma_str);

            if let Some(parent) = chroma_path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    format!("Failed to create dir {}: {}", parent.display(), e)
                })?;
            }

            let chroma_data =
                port_bin_bytes(&base_data, &champion, base_skin_num, *chroma_num);

            crate::core::write_echo::mark(&chroma_str);
            fs::write(&chroma_str, &chroma_data)
                .map_err(|e| format!("Failed to write {}: {}", chroma_str, e))?;

            let project_str = project.to_string_lossy().replace('\\', "/");
            let rel_base = base_str
                .strip_prefix(&format!("{}/", project_str))
                .unwrap_or(&base_str)
                .to_string();
            let rel_chroma = chroma_str
                .strip_prefix(&format!("{}/", project_str))
                .unwrap_or(&chroma_str)
                .to_string();

            if let Some(link) = manifest.links.iter_mut().find(|l| l.base_bin == rel_base) {
                if !link.chroma_bins.iter().any(|e| e.skin_num == *chroma_num) {
                    link.chroma_bins.push(ChromaBinEntry {
                        path: rel_chroma,
                        skin_num: *chroma_num,
                    });
                }
            } else {
                manifest.links.push(ChromaLink {
                    base_bin: rel_base,
                    base_skin_num,
                    chroma_bins: vec![ChromaBinEntry {
                        path: rel_chroma,
                        skin_num: *chroma_num,
                    }],
                });
            }

            total_written += 1;
        }
    }

    write_chroma_links(project, &manifest)?;
    tracing::info!(
        "[chroma] Ported {} BIN(s) for {} chromas in {}",
        total_written,
        chroma_skin_nums.len(),
        project_path
    );
    Ok(total_written)
}

/// After saving a base BIN, re-derive all linked chroma BINs by re-applying
/// the hash substitution. Returns the project-relative paths that were synced.
#[tauri::command]
pub async fn sync_chroma_bins(
    project_path: String,
    base_bin_path: String,
    champion: String,
    base_skin_num: u32,
) -> Result<Vec<String>, String> {
    let project = Path::new(&project_path);
    let manifest = read_chroma_links(project);

    let rel_base = base_bin_path.replace('\\', "/");

    let Some(link) = manifest.links.iter().find(|l| l.base_bin == rel_base) else {
        return Ok(vec![]);
    };

    let base_bin_full = project.join(&rel_base);
    let base_data = fs::read(&base_bin_full)
        .map_err(|e| format!("Failed to read base BIN: {}", e))?;

    let mut synced: Vec<String> = Vec::new();

    for entry in &link.chroma_bins {
        let chroma_full = project.join(&entry.path);

        if !chroma_full.parent().map(|p| p.exists()).unwrap_or(false) {
            continue;
        }

        let chroma_data =
            port_bin_bytes(&base_data, &champion, base_skin_num, entry.skin_num);

        let chroma_str = chroma_full.to_string_lossy().replace('\\', "/");
        crate::core::write_echo::mark(&chroma_str);
        fs::write(&chroma_full, &chroma_data)
            .map_err(|e| format!("Failed to sync {}: {}", chroma_str, e))?;

        // Invalidate the .ritobin sidecar cache
        let ritobin = format!("{}.ritobin", chroma_str);
        if Path::new(&ritobin).exists() {
            crate::core::write_echo::mark(&ritobin);
            let _ = fs::remove_file(&ritobin);
        }

        tracing::info!("[chroma] Synced {}", chroma_str);
        synced.push(entry.path.clone());
    }

    Ok(synced)
}

/// Return the parsed chroma-links.json for the given project, or an empty manifest.
#[tauri::command]
pub async fn get_chroma_links(project_path: String) -> Result<ChromaLinks, String> {
    Ok(read_chroma_links(Path::new(&project_path)))
}
