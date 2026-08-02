//! Commands for the VFX paint panel — a resident session over one BIN's tree.
//!
//! The session is the source of truth while the panel is open; edits mutate it
//! in place and only [`paint_save`] touches the file. Saving checkpoints the
//! project first (when the BIN is inside one) so a recolor is always reversible
//! from the checkpoint timeline, then invalidates the `.ritobin` sidecar so the
//! Monaco view re-converts instead of showing pre-recolor text.

use crate::core::ipc_trace;
use flint_core::bin::paint::model::VfxModel;
use flint_core::bin::paint::recolor::{
    ColorTargetSel, PaletteStop, RecolorMode, RecolorOptions,
};
use flint_core::bin::paint::session;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaintOpenResult {
    pub session_id: u64,
    pub model: VfxModel,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaletteStopInput {
    pub vec4: [f32; 4],
    pub time: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecolorOptionsInput {
    pub mode: String,
    #[serde(default)]
    pub ignore_black_white: Option<bool>,
    #[serde(default)]
    pub preserve_alpha: Option<bool>,
    #[serde(default)]
    pub hsl_shift: Option<[f32; 3]>,
    #[serde(default)]
    pub hue_target: Option<f32>,
    #[serde(default)]
    pub seed: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecolorResult {
    pub changed: usize,
    /// Refreshed colors for the touched emitters only — patch these into the
    /// resident model instead of replacing it wholesale.
    pub colors: HashMap<String, flint_core::bin::paint::model::EmitterColors>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaintSaveResult {
    /// The file written, or `None` when the session had no unsaved edits.
    pub saved: Option<String>,
    /// True when a project checkpoint was created before writing.
    pub checkpointed: bool,
}

/// Presence probe: does this BIN hold VFX systems or static materials?
///
/// Cheap on purpose — one read + a scan of top-level entry class hashes, no
/// projection — so it is safe to run for every BIN opened in the editor.
#[tauri::command]
pub async fn bin_has_vfx_systems(bin_path: String) -> Result<bool, String> {
    let _t = ipc_trace::enter("bin_has_vfx_systems");

    let bytes =
        std::fs::read(&bin_path).map_err(|e| format!("Failed to read {}: {}", bin_path, e))?;
    // Ritobin text (or any non-BIN file): nothing to probe — and read_bin would
    // error-log the magic mismatch on every .ritobin opened in the editor.
    if bytes.len() < 4 || (&bytes[..4] != b"PROP" && &bytes[..4] != b"PTCH") {
        return Ok(false);
    }
    let bin = flint_core::bin::read_bin(&bytes).map_err(|e| format!("Failed to parse BIN: {}", e))?;
    Ok(flint_core::bin::has_vfx_content(&bin))
}

/// Open a BIN into a resident paint session.
#[tauri::command]
pub async fn paint_open(path: String) -> Result<PaintOpenResult, String> {
    let _t = ipc_trace::enter("paint_open");

    let opened = session::open(&path).map_err(|e| e.to_string())?;
    Ok(PaintOpenResult {
        session_id: opened.session_id,
        model: opened.model,
    })
}

/// Drop a session and free its tree.
#[tauri::command]
pub async fn paint_close(session_id: u64) -> Result<bool, String> {
    Ok(session::close(session_id))
}

/// Re-fetch the whole VFX model for a session.
#[tauri::command]
pub async fn paint_model(session_id: u64) -> Result<VfxModel, String> {
    session::model_of(session_id).map_err(|e| e.to_string())
}

/// Recolor the selected emitters' selected color slots.
#[tauri::command]
pub async fn paint_recolor(
    session_id: u64,
    emitter_keys: Vec<String>,
    color_targets: Vec<String>,
    palette: Vec<PaletteStopInput>,
    options: RecolorOptionsInput,
) -> Result<RecolorResult, String> {
    let _t = ipc_trace::enter("paint_recolor");

    let mode = RecolorMode::parse_id(&options.mode)
        .ok_or_else(|| format!("Unknown recolor mode: {}", options.mode))?;

    // An unknown target id is dropped rather than failing the call; an empty
    // result then means "nothing selected", which the caller already handles.
    let targets: Vec<ColorTargetSel> = color_targets
        .iter()
        .filter_map(|t| ColorTargetSel::parse_id(t))
        .collect();
    if targets.is_empty() {
        return Ok(RecolorResult {
            changed: 0,
            colors: HashMap::new(),
        });
    }

    let hsl = options.hsl_shift.unwrap_or([0.0, 0.0, 0.0]);
    let opts = RecolorOptions {
        mode,
        ignore_black_white: options.ignore_black_white.unwrap_or(true),
        preserve_alpha: options.preserve_alpha.unwrap_or(true),
        hsl_shift: (hsl[0], hsl[1], hsl[2]),
        hue_target: options.hue_target,
        seed: options.seed.unwrap_or(1),
    };

    let stops: Vec<PaletteStop> = palette
        .iter()
        .map(|s| PaletteStop {
            vec4: s.vec4,
            time: s.time,
        })
        .collect();

    let changed = session::recolor_emitters(session_id, &emitter_keys, &targets, &stops, &opts)
        .map_err(|e| e.to_string())?;

    let colors = if changed > 0 {
        session::emitter_colors_of(session_id, &emitter_keys).map_err(|e| e.to_string())?
    } else {
        HashMap::new()
    };

    Ok(RecolorResult { changed, colors })
}

/// Set one static-material color param (`mat::<materialKey>::<paramName>`).
#[tauri::command]
pub async fn paint_set_material_param(
    session_id: u64,
    selection_key: String,
    values: [f32; 4],
    preserve_alpha: Option<bool>,
) -> Result<bool, String> {
    session::set_material_param(
        session_id,
        &selection_key,
        values,
        preserve_alpha.unwrap_or(false),
    )
    .map_err(|e| e.to_string())
}

/// Set one emitter's blend mode.
#[tauri::command]
pub async fn paint_set_blend_mode(
    session_id: u64,
    emitter_key: String,
    mode: u8,
) -> Result<bool, String> {
    session::set_blend_mode(session_id, &emitter_key, mode).map_err(|e| e.to_string())
}

/// Undo the last edit; returns the refreshed model or `None`.
#[tauri::command]
pub async fn paint_undo(session_id: u64) -> Result<Option<VfxModel>, String> {
    session::undo(session_id).map_err(|e| e.to_string())
}

/// Redo the last undone edit; returns the refreshed model or `None`.
#[tauri::command]
pub async fn paint_redo(session_id: u64) -> Result<Option<VfxModel>, String> {
    session::redo(session_id).map_err(|e| e.to_string())
}

/// Does this session hold unsaved edits?
#[tauri::command]
pub async fn paint_is_dirty(session_id: u64) -> Result<bool, String> {
    session::is_dirty(session_id).map_err(|e| e.to_string())
}

/// The `<bin>.ritobin` sidecar next to a BIN. Paint writes the BIN directly, so
/// a stale sidecar would make the editor show pre-recolor text.
fn ritobin_sidecar(bin: &Path) -> PathBuf {
    let mut p = bin.to_path_buf().into_os_string();
    p.push(".ritobin");
    PathBuf::from(p)
}

/// Save the session: checkpoint the owning project (when there is one), write
/// the tree back to its file, then drop the `.ritobin` sidecar.
#[tauri::command]
pub async fn paint_save(app: tauri::AppHandle, session_id: u64) -> Result<PaintSaveResult, String> {
    let _t = ipc_trace::enter("paint_save");

    if !session::is_dirty(session_id).map_err(|e| e.to_string())? {
        return Ok(PaintSaveResult {
            saved: None,
            checkpointed: false,
        });
    }

    let bin_path = session::path_of(session_id).map_err(|e| e.to_string())?;

    // Checkpoint BEFORE writing, so the pre-recolor state is recoverable. A BIN
    // outside a project still saves — it just has no restore point.
    let checkpointed = match flint_core::mesh::discovery::find_project_root(&bin_path) {
        Some(project_root) => {
            let name = bin_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "bin".to_string());
            match crate::commands::checkpoint::create_checkpoint(
                app.clone(),
                project_root.to_string_lossy().into_owned(),
                format!("Paint: recolor {name}"),
                vec!["paint".to_string()],
            )
            .await
            {
                Ok(_) => true,
                Err(e) => {
                    // A failed checkpoint must not block the save the user asked
                    // for; surface it in the log and carry on.
                    tracing::warn!("Paint save: checkpoint failed for {}: {e}", bin_path.display());
                    false
                }
            }
        }
        None => false,
    };

    let saved = session::save(session_id).map_err(|e| e.to_string())?;

    if let Some(written) = &saved {
        let _ = std::fs::remove_file(ritobin_sidecar(written));
        tracing::info!("Paint saved {}", written.display());
    }

    Ok(PaintSaveResult {
        saved: saved.map(|p| p.to_string_lossy().into_owned()),
        checkpointed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_appends_rather_than_replacing_the_extension() {
        // `set_extension` would turn `x.bin` into `x.ritobin`, which is a
        // DIFFERENT file from the `x.bin.ritobin` cache the converter writes.
        let got = ritobin_sidecar(Path::new("/tmp/foo.bin"));
        assert_eq!(got, PathBuf::from("/tmp/foo.bin.ritobin"));
    }
}
