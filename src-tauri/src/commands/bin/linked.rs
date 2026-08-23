use flint_core::bin::read_bin;
use flint_core::mesh::ritobin::{render_bin, resolve_linked_bin_path};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
pub struct LinkedBinText {
    pub path: String,
    pub text: String,
}

fn ritobin_text(bin_path: &Path) -> Option<String> {
    render_bin(bin_path).ok()
}

/// The ritobin text of every BIN in `bin_path`'s direct `linked` header.
///
/// Direct list only, no recursion — mirrors `find_linked_bin_ritobin_text`, but
/// keeps the files separate so a search can report which one a hit came from.
/// Unreadable links are skipped rather than failing the whole call.
#[tauri::command]
pub async fn list_linked_bin_texts(bin_path: String) -> Result<Vec<LinkedBinText>, String> {
    let path = PathBuf::from(&bin_path);
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read {bin_path}: {e}"))?;
    let tree = read_bin(&bytes).map_err(|e| format!("Failed to parse {bin_path}: {e}"))?;

    let project_root = flint_core::mesh::discovery::find_project_root(&path);
    let mut out = Vec::new();

    for linked in &tree.linked {
        let normalized = linked.replace('\\', "/");
        if !normalized.to_lowercase().ends_with(".bin") {
            continue;
        }
        let Some(resolved) = resolve_linked_bin_path(&path, project_root.as_deref(), &normalized)
        else {
            continue;
        };
        if resolved == path {
            continue;
        }
        let Some(text) = ritobin_text(&resolved) else { continue };
        out.push(LinkedBinText {
            path: resolved.to_string_lossy().replace('\\', "/"),
            text,
        });
    }

    Ok(out)
}
