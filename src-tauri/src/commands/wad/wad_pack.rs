//! Pack an extracted WAD folder back into a `.wad.client`, for the Explorer
//! "Pack folder to WAD" verb.

use crate::core::ipc_trace;
use std::path::{Path, PathBuf};

/// Where a packed folder's WAD is written: alongside the folder.
///
/// A folder already named `*.wad.client` writes to exactly that name — the
/// extracted form and the packed form share it, which is the convention the
/// rest of Flint uses for project content directories.
fn wad_output_path(folder: &Path) -> PathBuf {
    let name = folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "packed".to_string());

    let parent = folder.parent().unwrap_or_else(|| Path::new("."));
    if name.to_lowercase().ends_with(".wad.client") {
        parent.join(name)
    } else {
        parent.join(format!("{}.wad.client", name))
    }
}

/// Pack `folder_path` into a `.wad.client` beside it, returning the written path.
#[tauri::command]
pub async fn pack_folder_to_wad(folder_path: String) -> Result<String, String> {
    let _t = ipc_trace::enter("pack_folder_to_wad");

    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("Not a folder: {}", folder_path));
    }

    let out_path = wad_output_path(&folder);

    // Packing walks and compresses every file; keep it off the async runtime.
    let bytes = tokio::task::spawn_blocking({
        let folder = folder.clone();
        move || flint_core::export::build_wad_from_directory(&folder)
    })
    .await
    .map_err(|e| format!("pack panicked: {}", e))??;

    std::fs::write(&out_path, bytes)
        .map_err(|e| format!("Failed to write {}: {}", out_path.display(), e))?;

    tracing::info!("Packed {} -> {}", folder.display(), out_path.display());
    Ok(out_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn a_wad_client_folder_keeps_its_name() {
        // `aatrox.wad.client/` packs to `aatrox.wad.client`, not
        // `aatrox.wad.client.wad.client`.
        let out = wad_output_path(&PathBuf::from("C:/mods/aatrox.wad.client"));
        assert_eq!(out, PathBuf::from("C:/mods/aatrox.wad.client"));
    }

    #[test]
    fn a_plain_folder_gains_the_wad_client_suffix() {
        let out = wad_output_path(&PathBuf::from("C:/mods/aatrox"));
        assert_eq!(out, PathBuf::from("C:/mods/aatrox.wad.client"));
    }

    #[test]
    fn the_suffix_match_is_case_insensitive() {
        let out = wad_output_path(&PathBuf::from("C:/mods/Aatrox.WAD.CLIENT"));
        assert_eq!(out, PathBuf::from("C:/mods/Aatrox.WAD.CLIENT"));
    }
}
