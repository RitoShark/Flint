//! In-memory 3D-editor session commands for a `.skn` (+ its sibling `.skl`).
//!
//! Lifecycle mirrors `commands/wad/wad_edit.rs`:
//!   1. `open_model_session(skn_path)` — parse, return a session id + summary.
//!   2. `stage_model_edit` / `undo_model_edit` / `redo_model_edit` — op log only.
//!   3. `derive_model_mesh` — current geometry, for the viewport.
//!   4. `save_model_session` — write, then RE-PARSE from disk into the session.
//!   5. `close_model_session`.

use crate::state::{ModelEditSession, ModelEditState};
use flint_core::mesh::edit::{
    apply_ops, load_paste_source, summarize, Derived, ModelEdit, ModelSummary, OpLog,
};
use ritoshark::anim::Skeleton;
use ritoshark::mesh::SkinnedMesh;
use ritoshark::prelude::{Parse, Serialize as RsSerialize};
use serde::Serialize;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSessionInfo {
    pub session_id: String,
    pub source_path: String,
    /// Absent when the `.skn` has no sibling `.skl` — the mesh still loads.
    pub skeleton_path: Option<String>,
    pub summary: ModelSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSaveResult {
    pub skn_path: String,
    /// Set when a paste appended influences and the `.skl` was rewritten too.
    pub skl_path: Option<String>,
    pub summary: ModelSummary,
}

/// Fold the session's active ops. Split out because every command needs it.
fn derive(session: &ModelEditSession) -> Result<Derived, String> {
    apply_ops(
        &session.pristine,
        session.skeleton.as_ref(),
        session.log.active(),
        &|p: &Path| load_paste_source(p),
    )
}

#[tauri::command]
pub async fn open_model_session(
    state: tauri::State<'_, ModelEditState>,
    skn_path: String,
) -> Result<ModelSessionInfo, String> {
    let path = PathBuf::from(&skn_path);
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {skn_path}: {e}"))?;
    let pristine = SkinnedMesh::from_bytes(&bytes)
        .map_err(|e| format!("Could not parse {skn_path}: {e:?}"))?;

    // The skeleton is the sibling with the same stem — the same rule ModelPreview
    // uses. A skin without one still opens; the skeleton tree is just disabled.
    let skl_candidate = path.with_extension("skl");
    let (skeleton, skeleton_path) = match std::fs::read(&skl_candidate) {
        Ok(b) => match Skeleton::from_bytes(&b) {
            Ok(s) => (Some(s), Some(skl_candidate)),
            Err(e) => {
                tracing::debug!("[model-edit] .skl present but unparseable: {e:?}");
                (None, None)
            }
        },
        Err(_) => (None, None),
    };

    let session = ModelEditSession {
        session_id: Uuid::new_v4().to_string(),
        source_path: path,
        skeleton_path: skeleton_path.clone(),
        pristine,
        skeleton,
        log: OpLog::default(),
    };
    let summary = {
        let derived = derive(&session)?;
        summarize(&derived, &session.log)
    };
    let source_path = session.source_path.to_string_lossy().to_string();
    let session_id = state.insert(session);
    tracing::info!("[model-edit] opened session for {source_path}");

    Ok(ModelSessionInfo {
        session_id,
        source_path,
        skeleton_path: skeleton_path.map(|p| p.to_string_lossy().to_string()),
        summary,
    })
}

/// Stage an op. A rejected op (bad index, name collision, format limit) leaves
/// the log untouched, so the frontend can surface the error and stay in sync.
#[tauri::command]
pub async fn stage_model_edit(
    state: tauri::State<'_, ModelEditState>,
    session_id: String,
    edit: ModelEdit,
) -> Result<ModelSummary, String> {
    let session = state
        .get(&session_id)
        .ok_or_else(|| format!("No model session {session_id}"))?;
    let mut guard = session.write();

    let mut trial = guard.log.clone();
    trial.push(edit);
    let derived = apply_ops(
        &guard.pristine,
        guard.skeleton.as_ref(),
        trial.active(),
        &|p: &Path| load_paste_source(p),
    )?;

    guard.log = trial;
    Ok(summarize(&derived, &guard.log))
}

#[tauri::command]
pub async fn undo_model_edit(
    state: tauri::State<'_, ModelEditState>,
    session_id: String,
) -> Result<ModelSummary, String> {
    let session = state
        .get(&session_id)
        .ok_or_else(|| format!("No model session {session_id}"))?;
    let mut guard = session.write();
    guard.log.undo();
    let derived = derive(&guard)?;
    Ok(summarize(&derived, &guard.log))
}

#[tauri::command]
pub async fn redo_model_edit(
    state: tauri::State<'_, ModelEditState>,
    session_id: String,
) -> Result<ModelSummary, String> {
    let session = state
        .get(&session_id)
        .ok_or_else(|| format!("No model session {session_id}"))?;
    let mut guard = session.write();
    guard.log.redo();
    let derived = derive(&guard)?;
    Ok(summarize(&derived, &guard.log))
}

/// Current geometry in the shared binary wire format (see `mesh/wire.rs`).
/// Textures are resolved by the existing `read_skn_mesh` path on first load;
/// this command is the geometry-only refresh after a structural op.
#[tauri::command]
pub async fn derive_model_mesh(
    state: tauri::State<'_, ModelEditState>,
    session_id: String,
) -> Result<tauri::ipc::Response, String> {
    let session = state
        .get(&session_id)
        .ok_or_else(|| format!("No model session {session_id}"))?;
    let derived = {
        let guard = session.read();
        derive(&guard)?
    };

    // Round-trip through the on-disk form so the wire payload goes through the
    // exact same mirrorX / bounds-recompute path the viewer already expects.
    let bytes = derived
        .mesh
        .to_bytes()
        .map_err(|e| format!("Could not serialize derived mesh: {e:?}"))?;
    let tmp = std::env::temp_dir().join(format!("flint-derive-{session_id}.skn"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Could not stage derived mesh: {e}"))?;
    let mesh_data = flint_core::mesh::skn::parse_skn_file(&tmp)
        .map_err(|e| format!("Could not re-read derived mesh: {e}"))?;
    let _ = std::fs::remove_file(&tmp);

    let buf = flint_core::mesh::wire::encode_skn_binary(&mesh_data)?;
    Ok(tauri::ipc::Response::new(buf))
}

#[tauri::command]
pub async fn save_model_session(
    state: tauri::State<'_, ModelEditState>,
    session_id: String,
    dest: Option<String>,
) -> Result<ModelSaveResult, String> {
    let session = state
        .get(&session_id)
        .ok_or_else(|| format!("No model session {session_id}"))?;
    let mut guard = session.write();

    let derived = derive(&guard)?;
    let skn_out = dest
        .map(PathBuf::from)
        .unwrap_or_else(|| guard.source_path.clone());

    let skn_bytes = derived
        .mesh
        .to_bytes()
        .map_err(|e| format!("Could not serialize .skn: {e:?}"))?;
    std::fs::write(&skn_out, &skn_bytes)
        .map_err(|e| format!("Could not write {}: {e}", skn_out.display()))?;

    // The .skl is written ONLY when a paste appended influences. Phase 1 never
    // touches joint names, ids, parents or transforms.
    let mut skl_written: Option<PathBuf> = None;
    if derived.skeleton_dirty {
        if let (Some(skel), Some(_)) = (derived.skeleton.as_ref(), guard.skeleton_path.as_ref()) {
            let skl_out = skn_out.with_extension("skl");
            let skl_bytes = skel
                .to_bytes()
                .map_err(|e| format!("Could not serialize .skl: {e:?}"))?;
            std::fs::write(&skl_out, &skl_bytes)
                .map_err(|e| format!("Could not write {}: {e}", skl_out.display()))?;
            skl_written = Some(skl_out);
        }
    }

    // RE-PARSE from disk. The WAD editor shipped a bug where an in-place save
    // rewrote the file while the session kept the old parse; every later read
    // then worked off stale offsets. Same trap here — close it by making the
    // session match what is now on disk.
    let fresh_bytes = std::fs::read(&skn_out)
        .map_err(|e| format!("Could not re-read {}: {e}", skn_out.display()))?;
    guard.pristine = SkinnedMesh::from_bytes(&fresh_bytes)
        .map_err(|e| format!("Wrote {} but could not re-parse it: {e:?}", skn_out.display()))?;
    if let Some(ref skl_out) = skl_written {
        let b = std::fs::read(skl_out)
            .map_err(|e| format!("Could not re-read {}: {e}", skl_out.display()))?;
        guard.skeleton = Skeleton::from_bytes(&b).ok();
        guard.skeleton_path = Some(skl_out.clone());
    }
    guard.source_path = skn_out.clone();
    guard.log.clear();

    let fresh = derive(&guard)?;
    tracing::info!("[model-edit] saved {}", skn_out.display());
    Ok(ModelSaveResult {
        skn_path: skn_out.to_string_lossy().to_string(),
        skl_path: skl_written.map(|p| p.to_string_lossy().to_string()),
        summary: summarize(&fresh, &guard.log),
    })
}

#[tauri::command]
pub async fn close_model_session(
    state: tauri::State<'_, ModelEditState>,
    session_id: String,
) -> Result<(), String> {
    state.remove(&session_id);
    Ok(())
}
