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
    /// `.anm` files whose tracks were re-keyed to a renamed joint's new hash.
    #[serde(default)]
    pub anm_files_updated: Vec<String>,
    /// BIN files whose bone-reference fields were rewritten to a renamed joint's new name.
    #[serde(default)]
    pub bin_files_updated: Vec<String>,
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

/// Preview which `.anm` files and BIN bone-reference fields would need to
/// change if the joint at `index` were renamed — scanned against the joint's
/// CURRENT name/hash (i.e. after any rename ops already staged in this
/// session), so chained renames preview against the right identity. Read-only:
/// never touches disk beyond scanning.
#[tauri::command]
pub async fn preview_joint_rename(
    state: tauri::State<'_, ModelEditState>,
    session_id: String,
    index: usize,
) -> Result<flint_core::mesh::joint_rename::JointRenameImpact, String> {
    let session = state
        .get(&session_id)
        .ok_or_else(|| format!("No model session {session_id}"))?;
    let guard = session.read();
    let derived = derive(&guard)?;
    let skel = derived
        .skeleton
        .as_ref()
        .ok_or_else(|| "this .skn has no skeleton".to_string())?;
    let joint = skel
        .joints
        .get(index)
        .ok_or_else(|| format!("joint index {index} out of range (skeleton has {} joints)", skel.joints.len()))?;
    Ok(flint_core::mesh::joint_rename::scan_impact(&guard.source_path, &joint.name, joint.hash))
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
    // Keyed on a per-call id, not the session id: concurrent calls for the same
    // session (a rapid preview refresh, a stray double-dispatch) would otherwise
    // share one temp filename and interleave writes/reads/deletes, producing
    // spurious parse errors or garbled geometry in the viewport.
    let tmp = std::env::temp_dir().join(format!("flint-derive-{}.skn", Uuid::new_v4()));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Could not stage derived mesh: {e}"))?;
    let mesh_data = flint_core::mesh::skn::parse_skn_file(&tmp)
        .map_err(|e| format!("Could not re-read derived mesh: {e}"));
    let _ = std::fs::remove_file(&tmp);
    let mesh_data = mesh_data?;

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
    // Captured BEFORE the skl/skeleton on-disk re-read below overwrites
    // `guard.skeleton` — this is the OLD identity every existing `.anm`/BIN
    // reference on disk was written against.
    let old_skeleton = guard.skeleton.clone();
    let renamed_indices: std::collections::HashSet<usize> = guard
        .log
        .active()
        .iter()
        .filter_map(|op| match op {
            ModelEdit::RenameJoint { index, .. } => Some(*index),
            _ => None,
        })
        .collect();
    let skn_out = dest
        .map(PathBuf::from)
        .unwrap_or_else(|| guard.source_path.clone());

    // Write the .skl FIRST, before the .skn. The .skl is written ONLY when a
    // paste appended influences — Phase 1 never touches joint names, ids,
    // parents or transforms. If the .skl write fails here, the .skn on disk is
    // still the old one, so the pair on disk is untouched and consistent. The
    // reverse order is the one that can corrupt: a new .skn whose influence
    // data references bind additions, paired with the OLD .skl that lacks
    // them, is a broken asset. This order's failure mode is harmless instead —
    // an old .skn paired with a .skl carrying extra influence entries is inert,
    // because unused influence slots are never referenced by the mesh.
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

    let skn_bytes = derived
        .mesh
        .to_bytes()
        .map_err(|e| format!("Could not serialize .skn: {e:?}"))?;
    std::fs::write(&skn_out, &skn_bytes)
        .map_err(|e| format!("Could not write {}: {e}", skn_out.display()))?;

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

    // Propagate any joint rename to every `.anm` track and BIN bone-reference
    // field the project owns, keyed off the OLD identity (`old_skeleton`) to
    // the NEW one (`derived.skeleton`, the same skeleton just written to the
    // `.skl`). This runs AFTER the `.skl`/`.skn` are already on disk and the
    // session already resynced — a propagation failure below is reported to
    // the caller but never unwinds the save itself.
    let mut rename_pairs: Vec<(String, u32, String, u32)> = Vec::new();
    if let (Some(old_skel), Some(new_skel)) = (old_skeleton.as_ref(), derived.skeleton.as_ref()) {
        for idx in &renamed_indices {
            if let (Some(old_joint), Some(new_joint)) = (old_skel.joints.get(*idx), new_skel.joints.get(*idx)) {
                if old_joint.hash != new_joint.hash || old_joint.name != new_joint.name {
                    rename_pairs.push((old_joint.name.clone(), old_joint.hash, new_joint.name.clone(), new_joint.hash));
                }
            }
        }
    }

    let mut anm_files_updated = Vec::new();
    let mut bin_files_updated = Vec::new();
    if !rename_pairs.is_empty() {
        let propagation = flint_core::mesh::joint_rename::propagate_renames(&skn_out, &rename_pairs);
        anm_files_updated = propagation.anm_files_updated;
        bin_files_updated = propagation.bin_files_updated;
        if !propagation.errors.is_empty() {
            tracing::warn!(
                "[model-edit] saved {} but joint-rename propagation had failures: {}",
                skn_out.display(),
                propagation.errors.join("; ")
            );
            return Err(format!(
                "saved {} but could not propagate the joint rename to every file: {}",
                skn_out.display(),
                propagation.errors.join("; ")
            ));
        }
    }

    let fresh = derive(&guard)?;
    tracing::info!("[model-edit] saved {}", skn_out.display());
    Ok(ModelSaveResult {
        skn_path: skn_out.to_string_lossy().to_string(),
        skl_path: skl_written.map(|p| p.to_string_lossy().to_string()),
        summary: summarize(&fresh, &guard.log),
        anm_files_updated,
        bin_files_updated,
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

/// Add or remove a submesh from a gear form's hide/show lists, by directly
/// editing the skin BIN — this is separate from the `.skn` edit session
/// entirely (gear forms are `GearSkinUpgrade` entries in the skin BIN, not
/// geometry in the mesh). `mode` is `"show"`, `"hide"`, or `"clear"` (removes
/// from both lists).
#[tauri::command]
pub async fn assign_submesh_to_form(
    skn_path: String,
    form_index: usize,
    submesh: String,
    mode: String,
) -> Result<(), String> {
    let skn = Path::new(&skn_path);
    let skin_bin_path = flint_core::mesh::texture::find_skin_bin(skn)
        .ok_or_else(|| format!("No skin BIN found for {skn_path}"))?;

    let data = std::fs::read(&skin_bin_path)
        .map_err(|e| format!("Could not read {}: {e}", skin_bin_path.display()))?;
    let mut tree = flint_core::bin::codec::read_bin(&data)
        .map_err(|e| format!("Could not parse {}: {e}", skin_bin_path.display()))?;

    // Two steps, not one `set_form_submesh_visibility` call: `load_linked`
    // borrows `tree` immutably (to read its `linked` header), which can't
    // coexist with the `&mut tree` the edit itself needs. Resolving the
    // gear's path_hash first lets that immutable borrow end before the
    // mutable one begins.
    let gear_path_hash = flint_core::mesh::submesh_visibility::local_gear_path_hash_for_form_index(
        &tree,
        || flint_core::mesh::ritobin::read_linked_bin_trees(skn, &skin_bin_path, &tree),
        form_index,
    )?;
    flint_core::mesh::submesh_visibility::apply_submesh_visibility_to_gear(
        &mut tree,
        gear_path_hash,
        &submesh,
        &mode,
    )?;

    let bytes = flint_core::bin::codec::write_bin(&tree)
        .map_err(|e| format!("Could not serialize {}: {e}", skin_bin_path.display()))?;
    std::fs::write(&skin_bin_path, &bytes)
        .map_err(|e| format!("Could not write {}: {e}", skin_bin_path.display()))?;

    // Invalidate the .ritobin text cache so the BIN editor re-converts instead
    // of showing stale text (mirrors apply_loadscreen_banner).
    let ritobin_cache = {
        let mut p = skin_bin_path.clone().into_os_string();
        p.push(".ritobin");
        PathBuf::from(p)
    };
    let _ = std::fs::remove_file(&ritobin_cache);

    tracing::info!(
        "[model-edit] form {form_index} {mode} '{submesh}' in {}",
        skin_bin_path.display()
    );
    Ok(())
}
