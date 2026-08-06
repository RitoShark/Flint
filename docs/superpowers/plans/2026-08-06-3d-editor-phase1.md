# 3D Editor — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated 3D Editor window, opened by right-clicking a `.skn`, that renders the model full-size with an outliner and inspector and can rename, duplicate, delete, reorder and cross-file copy-paste submeshes, then write the result back to disk.

**Architecture:** A Rust `ModelEditSession` holds the pristine `SkinnedMesh` + `Skeleton` parse and a staged op log; undo/redo is a cursor into that log replayed over the pristine parse, so every derived state is a fresh fold with no drift. The frontend is a second WebView2 window (the `thumbnail`/`map-preview` pattern) whose viewport is a headless `SknScene` controller extracted out of `ModelPreview.tsx` and shared by both.

**Tech Stack:** Rust (Tauri 2, `ritoshark` = `rs_mesh`/`rs_anim`/`rs_math`, `parking_lot`, `uuid`, `serde`), TypeScript + React 18, Babylon.js, Zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-3d-editor-phase1-design.md`

## Global Constraints

- **No AI attribution anywhere.** No `Co-Authored-By`, no "Generated with…", no AI/Claude/assistant mention in commits, code, comments, or docs. Never sign commits.
- **Commit after every task.** Conventional Commits (`feat:`/`fix:`/`refactor:`/`doc:`; optional scope e.g. `feat(editor3d): …`). Short imperative subject.
- **Never run `cargo build` or `cargo check` standalone** — it wipes the incremental cache and makes the next `npm run tauri dev` take 15+ minutes. `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return` is safe. `cargo test -p flint-core --lib` is safe (library crate only). `npx tsc --noEmit` is safe.
- **Rust lint gate:** `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return` must pass before each Rust commit.
- **TS test runner:** `npm test` (`vitest run`). Test env is **node**, include glob is `src/**/*.test.ts` — so only pure `.ts` modules are unit-testable. No DOM, no `.tsx` tests. Put logic that needs testing in `src/lib/`, not in components.
- **Raw-bytes IPC** for binary payloads: `Result<tauri::ipc::Response, String>` + `Ok(tauri::ipc::Response::new(bytes))`; frontend `invokeCommand<ArrayBuffer>`. Never ship `Vec<u8>` as JSON.
- **Logging levels:** per-item/per-submesh chatter is `tracing::debug!` (Rust) and `console.debug` (TS). `info!`/`console.log` is for one-line lifecycle events only — anything else floods the user-visible log.
- **In-app dragging uses `src/lib/pointerDrag.ts`**, never HTML5 `draggable`/`onDragStart`. WebView2's native OS drag-drop blocks HTML5 DnD inside the webview.
- **Format limits (hard, reject don't truncate):** SKN indices are `u16` → max 65,535 vertices. `blend_indices` are `u8` → max 256 entries in `Skeleton.influences`.
- **`.skl` writes in Phase 1 are limited to appending `Skeleton.influences` entries** during a cross-file paste. Never touch joint names, ids, parents or transforms.

---

## File Structure

**New — Rust**
| File | Responsibility |
|---|---|
| `src-tauri/crates/flint-core/src/mesh/edit.rs` | Op enum, op implementations, `apply_ops` fold, bounds recompute, all unit tests. No Tauri. |
| `src-tauri/src/commands/editor/model_edit.rs` | Session commands over `ModelEditState`. Thin. |
| `src-tauri/src/commands/project/model_editor.rs` | `open_model_editor_window`. |

**New — TypeScript**
| File | Responsibility |
|---|---|
| `src/lib/babylon/sknScene.ts` | Headless Babylon scene controller (engine, camera, lights, skybox, grid, materials, mesh build, skeleton overlay, picking). |
| `src/lib/api/modelEdit.ts` | Command wrappers + shared types. |
| `src/lib/stores/modelEditorStore.ts` | Zustand: session id, summary, selection, clipboard, dirty, undo/redo availability. |
| `src/lib/editor3d/boneTree.ts` | Pure `bones[] → tree` fold. Unit-tested. |
| `src/lib/editor3d/renameValidation.ts` | Pure submesh-name validation. Unit-tested. |
| `src/components/editor3d/ModelEditorWindow.tsx` | Window root: hash params, session lifecycle, layout, top bar, dirty guards. |
| `src/components/editor3d/EditorViewport.tsx` | Canvas + `SknScene` lifecycle + picking. |
| `src/components/editor3d/Outliner.tsx` | Mesh tree + skeleton tree. |
| `src/components/editor3d/Inspector.tsx` | Selection properties. |
| `src/styles/modelEditor.css` | Window styles. Own file, not `index.css`. |

**Modified**
| File | Change |
|---|---|
| `src-tauri/crates/flint-core/src/mesh/mod.rs` | `pub mod edit;` |
| `src-tauri/src/state.rs` | `ModelEditState` + `ModelEditSession` |
| `src-tauri/src/commands/editor/mod.rs` | `pub mod model_edit;` |
| `src-tauri/src/commands/project/mod.rs` | `pub mod model_editor;` |
| `src-tauri/src/main.rs` | `.manage(ModelEditState::new())` + command registration |
| `src-tauri/capabilities/default.json` | `"model-editor"` in `windows` |
| `src/lib/editor/fileContextMenuOptions.ts` | "Open in 3D Editor" in the existing `ext === 'skn'` block (line ~592) — reaches FileTree **and** FolderGridView, both call `buildFileContextMenuOptions` |
| `src/lib/api/index.ts` | `export * from './modelEdit';` |
| `src/main.tsx` | `#model-editor` bootstrap |
| `src/components/preview/ModelPreview.tsx` | Re-based on `sknScene.ts` |
| `CLAUDE.md` | Record the new window, the session, and verified facts |

---

## Task 1: Edit session core — rename + byte-identical no-op save

**Files:**
- Create: `src-tauri/crates/flint-core/src/mesh/edit.rs`
- Modify: `src-tauri/crates/flint-core/src/mesh/mod.rs`

**Interfaces:**
- Consumes: `ritoshark::mesh::{SkinnedMesh, SkinnedMeshRange}`, `ritoshark::anim::Skeleton`, `ritoshark::prelude::{Parse, Serialize}`, `ritoshark::math::{Aabb, Sphere, Vec3}`
- Produces:
  - `pub enum ModelEdit` — serde-tagged, `kind` discriminant, camelCase fields
  - `pub struct Derived { pub mesh: SkinnedMesh, pub skeleton: Option<Skeleton>, pub skeleton_dirty: bool }`
  - `pub fn apply_ops(pristine: &SkinnedMesh, skeleton: Option<&Skeleton>, ops: &[ModelEdit]) -> Result<Derived, String>`
  - `pub const MAX_VERTICES: usize = 65_536`, `pub const MAX_INFLUENCES: usize = 256`

- [ ] **Step 1: Register the module**

In `src-tauri/crates/flint-core/src/mesh/mod.rs`, add after `pub mod discovery;`:

```rust
pub mod edit;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/crates/flint-core/src/mesh/edit.rs` with **only** the test module and a stub, so the test compiles and fails:

```rust
//! In-memory edit ops for a `.skn` (and its sibling `.skl`).
//!
//! The session model mirrors `commands/wad/wad_edit.rs`: the parsed source is kept
//! pristine and never mutated, edits are staged as an op log, and every derived
//! state is a fresh fold of the whole log over the pristine parse. Undo/redo is a
//! cursor into the log, not an inverse-op stack — so there is no inverse to get
//! wrong and no drift after a long editing session.

use ritoshark::anim::Skeleton;
use ritoshark::math::{Aabb, Sphere, Vec3};
use ritoshark::mesh::{SkinnedMesh, SkinnedMeshRange, SkinnedMeshVertex, SkinnedMeshVertexType};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// SKN indices are `u16`, so the merged vertex buffer can never exceed this.
pub const MAX_VERTICES: usize = u16::MAX as usize + 1;
/// `SkinnedMeshVertex::blend_indices` are `u8`, so the influence table caps here.
pub const MAX_INFLUENCES: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ModelEdit {
    #[serde(rename_all = "camelCase")]
    RenameSubmesh { index: usize, name: String },
    #[serde(rename_all = "camelCase")]
    DuplicateSubmesh { index: usize, name: String },
    #[serde(rename_all = "camelCase")]
    DeleteSubmesh { index: usize },
    #[serde(rename_all = "camelCase")]
    ReorderSubmesh { from: usize, to: usize },
    #[serde(rename_all = "camelCase")]
    PasteSubmesh {
        source_skn: PathBuf,
        source_index: usize,
        name: String,
    },
}

/// The result of folding an op log over the pristine parse.
pub struct Derived {
    pub mesh: SkinnedMesh,
    pub skeleton: Option<Skeleton>,
    /// True when an op appended to `skeleton.influences`, meaning the `.skl`
    /// must be written alongside the `.skn`.
    pub skeleton_dirty: bool,
}

pub fn apply_ops(
    _pristine: &SkinnedMesh,
    _skeleton: Option<&Skeleton>,
    _ops: &[ModelEdit],
) -> Result<Derived, String> {
    Err("not implemented".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ritoshark::prelude::{Parse, Serialize as RsSerialize};

    /// A 2-range mesh: range "Body" owns vertices 0..3 / indices 0..3, range
    /// "Cape" owns vertices 3..6 / indices 3..6. Indices are GLOBAL vertex
    /// indices, matching what the game and `meshBuilder.ts` expect.
    pub(super) fn fixture() -> SkinnedMesh {
        let vert = |x: f32, bone: u8| SkinnedMeshVertex {
            position: Vec3::new(x, 0.0, 0.0),
            blend_indices: [bone, 0, 0, 0],
            blend_weights: [1.0, 0.0, 0.0, 0.0],
            normal: Vec3::new(0.0, 1.0, 0.0),
            uv: ritoshark::math::Vec2::new(0.0, 0.0),
            color: None,
            tangent: None,
        };
        SkinnedMesh {
            major: 4,
            minor: 1,
            flags: 0,
            vertex_type: SkinnedMeshVertexType::Basic,
            bounding_box: Aabb::new(Vec3::new(0.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 0.0)),
            bounding_sphere: Sphere::new(Vec3::new(2.5, 0.0, 0.0), 2.5),
            ranges: vec![
                SkinnedMeshRange::new("Body", 0, 3, 0, 3),
                SkinnedMeshRange::new("Cape", 3, 3, 3, 3),
            ],
            indices: vec![0, 1, 2, 3, 4, 5],
            vertices: (0..6).map(|i| vert(i as f32, (i % 2) as u8)).collect(),
            trailing: vec![0u8; 12],
        }
    }

    #[test]
    fn empty_op_log_round_trips_byte_identically() {
        let mesh = fixture();
        let original = mesh.to_bytes().expect("fixture serializes");

        let derived = apply_ops(&mesh, None, &[]).expect("empty fold succeeds");
        let written = derived.mesh.to_bytes().expect("derived serializes");

        assert_eq!(original, written, "a zero-op fold must be byte-identical");
        // And it must still parse.
        SkinnedMesh::from_bytes(&written).expect("derived output re-parses");
    }

    #[test]
    fn rename_changes_only_the_named_range() {
        let mesh = fixture();
        let derived = apply_ops(
            &mesh,
            None,
            &[ModelEdit::RenameSubmesh { index: 1, name: "Wings".into() }],
        )
        .expect("rename succeeds");

        assert_eq!(derived.mesh.ranges[0].name, "Body");
        assert_eq!(derived.mesh.ranges[1].name, "Wings");
        assert_eq!(derived.mesh.vertices, mesh.vertices, "geometry untouched");
        assert_eq!(derived.mesh.indices, mesh.indices, "indices untouched");
        assert!(!derived.skeleton_dirty);
    }

    #[test]
    fn rename_out_of_range_is_an_error() {
        let mesh = fixture();
        let err = apply_ops(
            &mesh,
            None,
            &[ModelEdit::RenameSubmesh { index: 9, name: "Nope".into() }],
        )
        .expect_err("index 9 does not exist");
        assert!(err.contains("index 9"), "error names the bad index: {err}");
    }

    #[test]
    fn rename_to_a_duplicate_name_is_an_error() {
        let mesh = fixture();
        let err = apply_ops(
            &mesh,
            None,
            &[ModelEdit::RenameSubmesh { index: 1, name: "Body".into() }],
        )
        .expect_err("duplicate names are rejected");
        assert!(err.contains("Body"), "error names the collision: {err}");
    }

    #[test]
    fn rename_to_an_empty_name_is_an_error() {
        let mesh = fixture();
        let err = apply_ops(
            &mesh,
            None,
            &[ModelEdit::RenameSubmesh { index: 0, name: "  ".into() }],
        )
        .expect_err("blank names are rejected");
        assert!(err.to_lowercase().contains("empty"), "error explains why: {err}");
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p flint-core --lib mesh::edit`
Expected: 5 tests FAIL with `not implemented`.

- [ ] **Step 4: Implement `apply_ops` and rename**

Replace the stub `apply_ops` with:

```rust
/// Fold `ops` over a clone of `pristine`. Every derived state is a fresh fold —
/// callers never mutate the pristine parse.
pub fn apply_ops(
    pristine: &SkinnedMesh,
    skeleton: Option<&Skeleton>,
    ops: &[ModelEdit],
) -> Result<Derived, String> {
    let mut mesh = pristine.clone();
    let mut skel = skeleton.cloned();
    let mut skeleton_dirty = false;

    for op in ops {
        match op {
            ModelEdit::RenameSubmesh { index, name } => rename_submesh(&mut mesh, *index, name)?,
            ModelEdit::DuplicateSubmesh { .. }
            | ModelEdit::DeleteSubmesh { .. }
            | ModelEdit::ReorderSubmesh { .. }
            | ModelEdit::PasteSubmesh { .. } => {
                return Err("op not implemented yet".to_string())
            }
        }
    }

    let _ = (&mut skel, &mut skeleton_dirty);
    Ok(Derived { mesh, skeleton: skel, skeleton_dirty })
}

fn check_index(mesh: &SkinnedMesh, index: usize) -> Result<(), String> {
    if index >= mesh.ranges.len() {
        return Err(format!(
            "submesh index {index} out of range (mesh has {} submeshes)",
            mesh.ranges.len()
        ));
    }
    Ok(())
}

/// Reject a name that is blank or already taken by a *different* range.
/// Submesh names are the key the skin BIN references geometry by, so a
/// collision silently makes one of the two unreachable.
fn check_name(mesh: &SkinnedMesh, name: &str, allow_index: Option<usize>) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("submesh name cannot be empty".to_string());
    }
    for (i, range) in mesh.ranges.iter().enumerate() {
        if Some(i) == allow_index {
            continue;
        }
        if range.name.eq_ignore_ascii_case(name) {
            return Err(format!("a submesh named \"{name}\" already exists"));
        }
    }
    Ok(())
}

fn rename_submesh(mesh: &mut SkinnedMesh, index: usize, name: &str) -> Result<(), String> {
    check_index(mesh, index)?;
    check_name(mesh, name, Some(index))?;
    mesh.ranges[index].name = name.to_string();
    Ok(())
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p flint-core --lib mesh::edit`
Expected: 5 tests PASS.

- [ ] **Step 6: Lint**

Run: `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return`
Expected: no warnings.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/crates/flint-core/src/mesh/edit.rs src-tauri/crates/flint-core/src/mesh/mod.rs
git commit -m "feat(editor3d): model edit session core with submesh rename"
```

---

## Task 2: Delete and duplicate submesh

**Files:**
- Modify: `src-tauri/crates/flint-core/src/mesh/edit.rs`

**Interfaces:**
- Consumes: `apply_ops`, `check_index`, `check_name`, `tests::fixture` from Task 1
- Produces: `fn delete_submesh(&mut SkinnedMesh, usize) -> Result<(), String>`, `fn duplicate_submesh(&mut SkinnedMesh, usize, &str) -> Result<(), String>`, `fn recompute_bounds(&mut SkinnedMesh)`

**Context the implementer needs:** ranges carve up two shared buffers, and the values in `mesh.indices` are **global** vertex indices (not range-local — `meshBuilder.ts` rebases them by subtracting `vertex_start`). So deleting a range must (a) drain both buffers, (b) shift every later range's starts down, and (c) shift every surviving *index value* above the removed span down by the removed vertex count.

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests`:

```rust
    #[test]
    fn delete_compacts_buffers_and_reindexes_survivors() {
        let mesh = fixture();
        let derived = apply_ops(&mesh, None, &[ModelEdit::DeleteSubmesh { index: 0 }])
            .expect("delete succeeds");
        let out = derived.mesh;

        assert_eq!(out.ranges.len(), 1);
        assert_eq!(out.ranges[0].name, "Cape");
        // "Cape" moves to the front of both buffers.
        assert_eq!(out.ranges[0].vertex_start, 0);
        assert_eq!(out.ranges[0].index_start, 0);
        assert_eq!(out.vertices.len(), 3);
        // Global index values shift down by the 3 removed vertices.
        assert_eq!(out.indices, vec![0, 1, 2]);
        // And the result is a valid file.
        let bytes = {
            use ritoshark::prelude::Serialize as RsSerialize;
            out.to_bytes().expect("serializes")
        };
        SkinnedMesh::from_bytes(&bytes).expect("re-parses");
    }

    #[test]
    fn delete_recomputes_bounds_from_surviving_vertices() {
        let mesh = fixture();
        let derived = apply_ops(&mesh, None, &[ModelEdit::DeleteSubmesh { index: 0 }])
            .expect("delete succeeds");
        // Surviving vertices are x = 3, 4, 5.
        assert_eq!(derived.mesh.bounding_box.min.x, 3.0);
        assert_eq!(derived.mesh.bounding_box.max.x, 5.0);
    }

    #[test]
    fn delete_last_submesh_is_an_error() {
        let mut mesh = fixture();
        mesh.ranges.truncate(1);
        mesh.vertices.truncate(3);
        mesh.indices.truncate(3);
        let err = apply_ops(&mesh, None, &[ModelEdit::DeleteSubmesh { index: 0 }])
            .expect_err("cannot delete the only submesh");
        assert!(err.to_lowercase().contains("last"), "error explains why: {err}");
    }

    #[test]
    fn duplicate_appends_a_rebased_copy() {
        let mesh = fixture();
        let derived = apply_ops(
            &mesh,
            None,
            &[ModelEdit::DuplicateSubmesh { index: 0, name: "Body_copy".into() }],
        )
        .expect("duplicate succeeds");
        let out = derived.mesh;

        assert_eq!(out.ranges.len(), 3);
        let copy = &out.ranges[2];
        assert_eq!(copy.name, "Body_copy");
        assert_eq!(copy.vertex_start, 6);
        assert_eq!(copy.vertex_count, 3);
        assert_eq!(copy.index_start, 6);
        assert_eq!(copy.index_count, 3);
        assert_eq!(out.vertices.len(), 9);
        // The copy's indices point at the copy's own vertices, not the original's.
        assert_eq!(&out.indices[6..9], &[6, 7, 8]);
        // Original ranges are untouched.
        assert_eq!(out.ranges[0].vertex_start, 0);
        assert_eq!(out.ranges[1].vertex_start, 3);
    }

    #[test]
    fn duplicate_past_the_u16_index_limit_is_rejected() {
        let mut mesh = fixture();
        // Grow "Body" so a duplicate would cross 65_536 vertices.
        let filler = mesh.vertices[0];
        mesh.vertices = vec![filler; 40_000];
        mesh.indices = (0..40_000u32).map(|i| i as u16).collect();
        mesh.ranges = vec![SkinnedMeshRange::new("Body", 0, 40_000, 0, 40_000)];

        let err = apply_ops(
            &mesh,
            None,
            &[ModelEdit::DuplicateSubmesh { index: 0, name: "Body_copy".into() }],
        )
        .expect_err("80k vertices exceeds the u16 index space");
        assert!(err.contains("65535") || err.contains("65,535"), "error cites the limit: {err}");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p flint-core --lib mesh::edit`
Expected: the 5 new tests FAIL with `op not implemented yet`.

- [ ] **Step 3: Implement delete, duplicate and bounds recompute**

Add to `edit.rs`:

```rust
/// Recompute the AABB and bounding sphere over the current vertex buffer.
/// Any op that adds or removes vertices must call this — a stale box breaks
/// camera framing and the game's culling alike.
fn recompute_bounds(mesh: &mut SkinnedMesh) {
    if mesh.vertices.is_empty() {
        mesh.bounding_box = Aabb::new(Vec3::ZERO, Vec3::ZERO);
        mesh.bounding_sphere = Sphere::new(Vec3::ZERO, 0.0);
        return;
    }
    let mut min = Vec3::splat(f32::MAX);
    let mut max = Vec3::splat(f32::MIN);
    for v in &mesh.vertices {
        min = min.min(v.position);
        max = max.max(v.position);
    }
    mesh.bounding_box = Aabb::new(min, max);
    let center = (min + max) * 0.5;
    let radius = mesh
        .vertices
        .iter()
        .map(|v| (v.position - center).length())
        .fold(0.0f32, f32::max);
    mesh.bounding_sphere = Sphere::new(center, radius);
}

fn delete_submesh(mesh: &mut SkinnedMesh, index: usize) -> Result<(), String> {
    check_index(mesh, index)?;
    if mesh.ranges.len() == 1 {
        return Err("cannot delete the last submesh — a .skn needs at least one".to_string());
    }

    let range = mesh.ranges[index].clone();
    let v_start = range.vertex_start as usize;
    let v_count = range.vertex_count as usize;
    let i_start = range.index_start as usize;
    let i_count = range.index_count as usize;

    mesh.vertices.drain(v_start..v_start + v_count);
    mesh.indices.drain(i_start..i_start + i_count);
    mesh.ranges.remove(index);

    // Index VALUES are global vertex indices; every survivor above the removed
    // span slides down. Survivors never point into the removed span, because a
    // range's triangles only reference its own vertices.
    let shift = range.vertex_count as u16;
    for idx in &mut mesh.indices {
        if *idx >= range.vertex_start as u16 {
            *idx -= shift;
        }
    }

    for r in &mut mesh.ranges {
        if r.vertex_start > range.vertex_start {
            r.vertex_start -= range.vertex_count;
        }
        if r.index_start > range.index_start {
            r.index_start -= range.index_count;
        }
    }

    recompute_bounds(mesh);
    Ok(())
}

fn duplicate_submesh(mesh: &mut SkinnedMesh, index: usize, name: &str) -> Result<(), String> {
    check_index(mesh, index)?;
    check_name(mesh, name, None)?;

    let range = mesh.ranges[index].clone();
    let v_start = range.vertex_start as usize;
    let v_count = range.vertex_count as usize;
    let i_start = range.index_start as usize;
    let i_count = range.index_count as usize;

    let new_v_start = mesh.vertices.len();
    if new_v_start + v_count > MAX_VERTICES {
        return Err(format!(
            "duplicating \"{}\" would need {} vertices; a .skn stores u16 indices so it cannot exceed 65535",
            range.name,
            new_v_start + v_count
        ));
    }

    let copied: Vec<SkinnedMeshVertex> = mesh.vertices[v_start..v_start + v_count].to_vec();
    mesh.vertices.extend(copied);

    let new_i_start = mesh.indices.len();
    let rebased: Vec<u16> = mesh.indices[i_start..i_start + i_count]
        .iter()
        .map(|idx| idx - range.vertex_start as u16 + new_v_start as u16)
        .collect();
    mesh.indices.extend(rebased);

    mesh.ranges.push(SkinnedMeshRange::new(
        name,
        new_v_start as u32,
        v_count as u32,
        new_i_start as u32,
        i_count as u32,
    ));

    recompute_bounds(mesh);
    Ok(())
}
```

Then wire both into the `apply_ops` match, replacing the two arms:

```rust
            ModelEdit::DeleteSubmesh { index } => delete_submesh(&mut mesh, *index)?,
            ModelEdit::DuplicateSubmesh { index, name } => {
                duplicate_submesh(&mut mesh, *index, name)?
            }
            ModelEdit::ReorderSubmesh { .. } | ModelEdit::PasteSubmesh { .. } => {
                return Err("op not implemented yet".to_string())
            }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p flint-core --lib mesh::edit`
Expected: 10 tests PASS.

- [ ] **Step 5: Lint and commit**

```bash
cargo clippy --lib --bins -- -D warnings -A clippy::needless_return
git add src-tauri/crates/flint-core/src/mesh/edit.rs
git commit -m "feat(editor3d): delete and duplicate submesh ops"
```

---

## Task 3: Reorder submesh

**Files:**
- Modify: `src-tauri/crates/flint-core/src/mesh/edit.rs`

**Interfaces:**
- Consumes: `apply_ops`, `check_index`
- Produces: `fn reorder_submesh(&mut SkinnedMesh, usize, usize) -> Result<(), String>`

**Context:** each `SkinnedMeshRange` carries its own buffer offsets, so reordering is purely a permutation of `mesh.ranges` — no buffer movement, no reindexing. This changes list/draw order only.

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests`:

```rust
    #[test]
    fn reorder_permutes_ranges_without_touching_buffers() {
        let mesh = fixture();
        let derived = apply_ops(&mesh, None, &[ModelEdit::ReorderSubmesh { from: 0, to: 1 }])
            .expect("reorder succeeds");
        let out = derived.mesh;

        assert_eq!(out.ranges[0].name, "Cape");
        assert_eq!(out.ranges[1].name, "Body");
        // Offsets travel with their range; buffers are identical.
        assert_eq!(out.ranges[0].vertex_start, 3);
        assert_eq!(out.ranges[1].vertex_start, 0);
        assert_eq!(out.vertices, mesh.vertices);
        assert_eq!(out.indices, mesh.indices);
    }

    #[test]
    fn reorder_out_of_range_is_an_error() {
        let mesh = fixture();
        assert!(apply_ops(&mesh, None, &[ModelEdit::ReorderSubmesh { from: 0, to: 7 }]).is_err());
        assert!(apply_ops(&mesh, None, &[ModelEdit::ReorderSubmesh { from: 7, to: 0 }]).is_err());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p flint-core --lib mesh::edit`
Expected: 2 new tests FAIL.

- [ ] **Step 3: Implement reorder**

```rust
fn reorder_submesh(mesh: &mut SkinnedMesh, from: usize, to: usize) -> Result<(), String> {
    check_index(mesh, from)?;
    check_index(mesh, to)?;
    if from == to {
        return Ok(());
    }
    let range = mesh.ranges.remove(from);
    mesh.ranges.insert(to, range);
    Ok(())
}
```

Wire into `apply_ops`:

```rust
            ModelEdit::ReorderSubmesh { from, to } => reorder_submesh(&mut mesh, *from, *to)?,
            ModelEdit::PasteSubmesh { .. } => return Err("op not implemented yet".to_string()),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p flint-core --lib mesh::edit`
Expected: 12 tests PASS.

- [ ] **Step 5: Lint and commit**

```bash
cargo clippy --lib --bins -- -D warnings -A clippy::needless_return
git add src-tauri/crates/flint-core/src/mesh/edit.rs
git commit -m "feat(editor3d): reorder submesh op"
```

---

## Task 4: Cross-file paste with influence remap

**Files:**
- Modify: `src-tauri/crates/flint-core/src/mesh/edit.rs`

**Interfaces:**
- Consumes: everything from Tasks 1–3
- Produces: `pub struct PasteSource { pub mesh: SkinnedMesh, pub skeleton: Option<Skeleton> }`, `pub fn load_paste_source(path: &std::path::Path) -> Result<PasteSource, String>`, and `apply_ops` gaining a `resolve: &dyn Fn(&Path) -> Result<PasteSource, String>` parameter.

**Context — the remap chain.** A vertex's `blend_indices[i]` is **not** a joint id: it indexes the *skeleton's* `influences` table, and `influences[k]` is the joint id. So moving geometry between two skins means: source influence index → source joint id → source joint **name** → destination joint with that name → its position in the destination `influences` table (appending if absent). Name is the only stable key across two different skeletons.

**Signature change.** `apply_ops` needs to read *other* `.skn` files. It takes a resolver closure rather than doing I/O itself, so the tests stay pure. Update every existing call site (all in `mod tests`) to pass `&no_paste` (defined below).

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests`:

```rust
    use std::path::Path;

    /// Resolver for tests that never paste.
    pub(super) fn no_paste(_p: &Path) -> Result<PasteSource, String> {
        Err("no paste source in this test".to_string())
    }

    fn joint(name: &str, id: i16) -> ritoshark::anim::Joint {
        ritoshark::anim::Joint {
            name: name.to_string(),
            flags: 0,
            id,
            parent_id: -1,
            radius: 2.1,
            hash: ritoshark::hash::elf_lower(name),
            local_translation: Vec3::ZERO,
            local_scale: Vec3::ONE,
            local_rotation: ritoshark::math::Quat::IDENTITY,
            inverse_bind_translation: Vec3::ZERO,
            inverse_bind_scale: Vec3::ONE,
            inverse_bind_rotation: ritoshark::math::Quat::IDENTITY,
        }
    }

    fn skeleton_with(names: &[&str], influences: &[u16]) -> Skeleton {
        Skeleton {
            flags: 0,
            name: "test".into(),
            asset: "test".into(),
            joints: names.iter().enumerate().map(|(i, n)| joint(n, i as i16)).collect(),
            influences: influences.to_vec(),
        }
    }

    #[test]
    fn paste_remaps_influence_indices_by_joint_name() {
        // Destination influences: [Root(0), Spine(1)]  -> index 0 = Root, 1 = Spine
        let dest_skel = skeleton_with(&["Root", "Spine", "Arm"], &[0, 1]);
        // Source influences: [Spine(0)] under a DIFFERENT joint order, so the raw
        // blend index 0 means Spine here but Root in the destination.
        let src_skel = skeleton_with(&["Spine", "Root"], &[0]);

        let mut src_mesh = fixture();
        src_mesh.ranges = vec![SkinnedMeshRange::new("Horns", 0, 3, 0, 3)];
        src_mesh.vertices.truncate(3);
        src_mesh.indices = vec![0, 1, 2];
        for v in &mut src_mesh.vertices {
            v.blend_indices = [0, 0, 0, 0];
        }

        let resolve = move |_p: &Path| {
            Ok(PasteSource { mesh: src_mesh.clone(), skeleton: Some(src_skel.clone()) })
        };

        let derived = apply_ops(
            &fixture(),
            Some(&dest_skel),
            &[ModelEdit::PasteSubmesh {
                source_skn: PathBuf::from("other.skn"),
                source_index: 0,
                name: "Horns".into(),
            }],
            &resolve,
        )
        .expect("paste succeeds");

        let pasted = derived.mesh.ranges.last().expect("range appended");
        assert_eq!(pasted.name, "Horns");
        assert_eq!(pasted.vertex_start, 6);
        // Source blend index 0 = source influences[0] = joint 0 = "Spine".
        // Destination "Spine" is joint id 1, which sits at destination influences[1].
        let first = derived.mesh.vertices[6];
        assert_eq!(first.blend_indices[0], 1, "remapped through joint NAME, not raw index");
        assert!(!derived.skeleton_dirty, "no new influence was needed");
    }

    #[test]
    fn paste_appends_a_missing_influence_and_marks_the_skeleton_dirty() {
        // "Arm" exists as a joint in the destination but is not in its influence table.
        let dest_skel = skeleton_with(&["Root", "Spine", "Arm"], &[0, 1]);
        let src_skel = skeleton_with(&["Arm"], &[0]);

        let mut src_mesh = fixture();
        src_mesh.ranges = vec![SkinnedMeshRange::new("Claw", 0, 3, 0, 3)];
        src_mesh.vertices.truncate(3);
        src_mesh.indices = vec![0, 1, 2];
        for v in &mut src_mesh.vertices {
            v.blend_indices = [0, 0, 0, 0];
        }

        let resolve = move |_p: &Path| {
            Ok(PasteSource { mesh: src_mesh.clone(), skeleton: Some(src_skel.clone()) })
        };

        let derived = apply_ops(
            &fixture(),
            Some(&dest_skel),
            &[ModelEdit::PasteSubmesh {
                source_skn: PathBuf::from("other.skn"),
                source_index: 0,
                name: "Claw".into(),
            }],
            &resolve,
        )
        .expect("paste succeeds");

        let skel = derived.skeleton.expect("skeleton present");
        assert_eq!(skel.influences, vec![0, 1, 2], "Arm (joint id 2) appended");
        assert_eq!(derived.mesh.vertices[6].blend_indices[0], 2, "points at the new slot");
        assert!(derived.skeleton_dirty, "the .skl must be written");
        // Joint hierarchy is untouched — Phase 1 only ever appends influences.
        assert_eq!(skel.joints.len(), 3);
        assert_eq!(skel.joints[2].name, "Arm");
    }

    #[test]
    fn paste_fails_when_a_source_joint_is_absent_from_the_destination() {
        let dest_skel = skeleton_with(&["Root", "Spine"], &[0, 1]);
        let src_skel = skeleton_with(&["Tentacle"], &[0]);

        let mut src_mesh = fixture();
        src_mesh.ranges = vec![SkinnedMeshRange::new("Tent", 0, 3, 0, 3)];
        src_mesh.vertices.truncate(3);
        src_mesh.indices = vec![0, 1, 2];
        for v in &mut src_mesh.vertices {
            v.blend_indices = [0, 0, 0, 0];
        }

        let resolve = move |_p: &Path| {
            Ok(PasteSource { mesh: src_mesh.clone(), skeleton: Some(src_skel.clone()) })
        };

        let err = apply_ops(
            &fixture(),
            Some(&dest_skel),
            &[ModelEdit::PasteSubmesh {
                source_skn: PathBuf::from("other.skn"),
                source_index: 0,
                name: "Tent".into(),
            }],
            &resolve,
        )
        .expect_err("Tentacle has no home in the destination rig");
        assert!(err.contains("Tentacle"), "error names the missing joint: {err}");
    }

    #[test]
    fn paste_without_a_destination_skeleton_is_an_error() {
        let src_skel = skeleton_with(&["Root"], &[0]);
        let mut src_mesh = fixture();
        src_mesh.ranges = vec![SkinnedMeshRange::new("X", 0, 3, 0, 3)];
        src_mesh.vertices.truncate(3);
        src_mesh.indices = vec![0, 1, 2];

        let resolve = move |_p: &Path| {
            Ok(PasteSource { mesh: src_mesh.clone(), skeleton: Some(src_skel.clone()) })
        };

        let err = apply_ops(
            &fixture(),
            None,
            &[ModelEdit::PasteSubmesh {
                source_skn: PathBuf::from("other.skn"),
                source_index: 0,
                name: "X".into(),
            }],
            &resolve,
        )
        .expect_err("cannot remap without a destination rig");
        assert!(err.to_lowercase().contains("skeleton"), "error explains why: {err}");
    }
```

Then update the four existing `apply_ops(...)` call sites in `mod tests` from Tasks 1–3 to pass `&no_paste` as the new fourth argument.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p flint-core --lib mesh::edit`
Expected: compile error (`apply_ops` takes 3 args) — this is the failing state. After adding the parameter in Step 3 the 4 new tests must go red before green; if they pass immediately, the test is not exercising the remap.

- [ ] **Step 3: Implement paste**

Add to `edit.rs`:

```rust
use std::path::Path;

/// A `.skn` + its sibling `.skl`, loaded as the source of a cross-file paste.
pub struct PasteSource {
    pub mesh: SkinnedMesh,
    pub skeleton: Option<Skeleton>,
}

/// Load a paste source from disk. The `.skl` is the sibling with the same stem —
/// the same rule `ModelPreview` uses. A missing `.skl` is not fatal here; the
/// paste itself will reject the op if a remap turns out to be needed.
pub fn load_paste_source(path: &Path) -> Result<PasteSource, String> {
    use ritoshark::prelude::Parse;
    let bytes = std::fs::read(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let mesh = SkinnedMesh::from_bytes(&bytes)
        .map_err(|e| format!("parsing {}: {e:?}", path.display()))?;
    let skl_path = path.with_extension("skl");
    let skeleton = std::fs::read(&skl_path)
        .ok()
        .and_then(|b| Skeleton::from_bytes(&b).ok());
    Ok(PasteSource { mesh, skeleton })
}

/// Map one source influence index to a destination influence index, appending to
/// the destination table when the joint is present in the rig but not yet bound.
/// Returns the destination index.
fn remap_influence(
    src_skel: &Skeleton,
    dest_skel: &mut Skeleton,
    src_influence_idx: u8,
) -> Result<u8, String> {
    let src_joint_id = *src_skel
        .influences
        .get(src_influence_idx as usize)
        .ok_or_else(|| {
            format!("source influence index {src_influence_idx} is outside its skeleton's table")
        })?;
    let src_name = src_skel
        .joints
        .iter()
        .find(|j| j.id == src_joint_id as i16)
        .map(|j| j.name.as_str())
        .ok_or_else(|| format!("source skeleton has no joint with id {src_joint_id}"))?;

    let dest_joint_id = dest_skel
        .joints
        .iter()
        .find(|j| j.name.eq_ignore_ascii_case(src_name))
        .map(|j| j.id)
        .ok_or_else(|| {
            format!("this skin's skeleton has no joint named \"{src_name}\" — the pasted geometry is rigged to bones this rig does not have")
        })?;

    if let Some(pos) = dest_skel.influences.iter().position(|&i| i as i16 == dest_joint_id) {
        return Ok(pos as u8);
    }

    if dest_skel.influences.len() >= MAX_INFLUENCES {
        return Err(format!(
            "this skin already binds {MAX_INFLUENCES} bones; blend indices are u8 so \"{src_name}\" cannot be added"
        ));
    }
    dest_skel.influences.push(dest_joint_id as u16);
    Ok((dest_skel.influences.len() - 1) as u8)
}

fn paste_submesh(
    mesh: &mut SkinnedMesh,
    skeleton: &mut Option<Skeleton>,
    skeleton_dirty: &mut bool,
    source: &PasteSource,
    source_index: usize,
    name: &str,
) -> Result<(), String> {
    check_name(mesh, name, None)?;

    let range = source
        .mesh
        .ranges
        .get(source_index)
        .ok_or_else(|| format!("source submesh index {source_index} does not exist"))?
        .clone();

    let v_start = range.vertex_start as usize;
    let v_count = range.vertex_count as usize;
    let i_start = range.index_start as usize;
    let i_count = range.index_count as usize;

    let new_v_start = mesh.vertices.len();
    if new_v_start + v_count > MAX_VERTICES {
        return Err(format!(
            "pasting \"{}\" would need {} vertices; a .skn stores u16 indices so it cannot exceed 65535",
            range.name,
            new_v_start + v_count
        ));
    }

    let mut copied: Vec<SkinnedMeshVertex> =
        source.mesh.vertices[v_start..v_start + v_count].to_vec();

    // Remap skinning only when the geometry is actually skinned. An unskinned
    // paste (all weights zero) needs no rig on either side.
    let needs_remap = copied
        .iter()
        .any(|v| v.blend_weights.iter().any(|w| *w > 0.0));

    if needs_remap {
        let src_skel = source.skeleton.as_ref().ok_or_else(|| {
            "the source .skn has no sibling .skl, so its bone bindings cannot be translated"
                .to_string()
        })?;
        let dest_skel = skeleton.as_mut().ok_or_else(|| {
            "this .skn has no sibling .skl, so pasted geometry cannot be re-bound to its skeleton"
                .to_string()
        })?;
        let before = dest_skel.influences.len();
        for v in &mut copied {
            for slot in 0..4 {
                if v.blend_weights[slot] <= 0.0 {
                    v.blend_indices[slot] = 0;
                    continue;
                }
                v.blend_indices[slot] = remap_influence(src_skel, dest_skel, v.blend_indices[slot])?;
            }
        }
        if dest_skel.influences.len() != before {
            *skeleton_dirty = true;
        }
    }

    mesh.vertices.extend(copied);

    let new_i_start = mesh.indices.len();
    let rebased: Vec<u16> = source.mesh.indices[i_start..i_start + i_count]
        .iter()
        .map(|idx| idx - range.vertex_start as u16 + new_v_start as u16)
        .collect();
    mesh.indices.extend(rebased);

    mesh.ranges.push(SkinnedMeshRange::new(
        name,
        new_v_start as u32,
        v_count as u32,
        new_i_start as u32,
        i_count as u32,
    ));

    recompute_bounds(mesh);
    Ok(())
}
```

Change the `apply_ops` signature and its paste arm:

```rust
pub fn apply_ops(
    pristine: &SkinnedMesh,
    skeleton: Option<&Skeleton>,
    ops: &[ModelEdit],
    resolve: &dyn Fn(&Path) -> Result<PasteSource, String>,
) -> Result<Derived, String> {
    let mut mesh = pristine.clone();
    let mut skel = skeleton.cloned();
    let mut skeleton_dirty = false;

    for op in ops {
        match op {
            ModelEdit::RenameSubmesh { index, name } => rename_submesh(&mut mesh, *index, name)?,
            ModelEdit::DeleteSubmesh { index } => delete_submesh(&mut mesh, *index)?,
            ModelEdit::DuplicateSubmesh { index, name } => {
                duplicate_submesh(&mut mesh, *index, name)?
            }
            ModelEdit::ReorderSubmesh { from, to } => reorder_submesh(&mut mesh, *from, *to)?,
            ModelEdit::PasteSubmesh { source_skn, source_index, name } => {
                let source = resolve(source_skn)?;
                paste_submesh(
                    &mut mesh,
                    &mut skel,
                    &mut skeleton_dirty,
                    &source,
                    *source_index,
                    name,
                )?
            }
        }
    }

    Ok(Derived { mesh, skeleton: skel, skeleton_dirty })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p flint-core --lib mesh::edit`
Expected: 16 tests PASS.

- [ ] **Step 5: Lint and commit**

```bash
cargo clippy --lib --bins -- -D warnings -A clippy::needless_return
git add src-tauri/crates/flint-core/src/mesh/edit.rs
git commit -m "feat(editor3d): cross-file submesh paste with influence remap"
```

---

## Task 5: Undo/redo cursor and derived summary

**Files:**
- Modify: `src-tauri/crates/flint-core/src/mesh/edit.rs`

**Interfaces:**
- Produces:
  - `pub struct OpLog { ops: Vec<ModelEdit>, cursor: usize }` with `push`, `undo`, `redo`, `active`, `can_undo`, `can_redo`, `clear`, `is_dirty`
  - `pub struct SubmeshInfo { pub name: String, pub vertex_count: u32, pub index_count: u32, pub vertex_start: u32, pub index_start: u32 }` (serde camelCase)
  - `pub struct ModelSummary { pub submeshes: Vec<SubmeshInfo>, pub vertex_count: u32, pub index_count: u32, pub influence_count: u32, pub dirty: bool, pub can_undo: bool, pub can_redo: bool }` (serde camelCase)
  - `pub fn summarize(derived: &Derived, log: &OpLog) -> ModelSummary`

**Context:** staging a new op after an undo must **truncate the redo tail** — otherwise redo would replay an op onto a state it was never authored against.

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests`:

```rust
    #[test]
    fn staging_after_undo_truncates_the_redo_tail() {
        let mut log = OpLog::default();
        log.push(ModelEdit::RenameSubmesh { index: 0, name: "A".into() });
        log.push(ModelEdit::RenameSubmesh { index: 0, name: "B".into() });
        assert!(log.undo());
        assert!(log.can_redo());

        log.push(ModelEdit::RenameSubmesh { index: 0, name: "C".into() });
        assert!(!log.can_redo(), "the stale redo tail is gone");
        assert_eq!(log.active().len(), 2);

        let derived = apply_ops(&fixture(), None, log.active(), &no_paste).expect("folds");
        assert_eq!(derived.mesh.ranges[0].name, "C");
    }

    #[test]
    fn undo_then_redo_restores_the_same_state() {
        let mut log = OpLog::default();
        log.push(ModelEdit::RenameSubmesh { index: 0, name: "A".into() });
        log.push(ModelEdit::DuplicateSubmesh { index: 0, name: "A_copy".into() });
        log.push(ModelEdit::RenameSubmesh { index: 1, name: "Z".into() });

        assert!(log.undo());
        assert!(log.undo());
        assert!(log.redo());
        assert_eq!(log.active().len(), 2);

        let derived = apply_ops(&fixture(), None, log.active(), &no_paste).expect("folds");
        assert_eq!(derived.mesh.ranges[0].name, "A");
        assert_eq!(derived.mesh.ranges.len(), 3);
    }

    #[test]
    fn undo_at_the_start_and_redo_at_the_end_are_no_ops() {
        let mut log = OpLog::default();
        assert!(!log.undo());
        assert!(!log.redo());
        log.push(ModelEdit::RenameSubmesh { index: 0, name: "A".into() });
        assert!(!log.redo());
        assert!(log.undo());
        assert!(!log.undo());
    }

    #[test]
    fn summary_reports_ranges_counts_and_flags() {
        let mut log = OpLog::default();
        log.push(ModelEdit::RenameSubmesh { index: 1, name: "Wings".into() });
        let derived = apply_ops(&fixture(), None, log.active(), &no_paste).expect("folds");
        let summary = summarize(&derived, &log);

        assert_eq!(summary.submeshes.len(), 2);
        assert_eq!(summary.submeshes[1].name, "Wings");
        assert_eq!(summary.submeshes[1].vertex_count, 3);
        assert_eq!(summary.vertex_count, 6);
        assert_eq!(summary.index_count, 6);
        assert!(summary.dirty);
        assert!(summary.can_undo);
        assert!(!summary.can_redo);
    }

    #[test]
    fn a_cleared_log_is_not_dirty() {
        let mut log = OpLog::default();
        log.push(ModelEdit::RenameSubmesh { index: 0, name: "A".into() });
        log.clear();
        assert!(!log.is_dirty());
        assert!(!log.can_undo());
        assert!(log.active().is_empty());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p flint-core --lib mesh::edit`
Expected: compile error — `OpLog`, `summarize`, `ModelSummary` do not exist.

- [ ] **Step 3: Implement `OpLog` and `summarize`**

```rust
/// The staged op log plus an undo cursor. `ops[..cursor]` is the active prefix;
/// everything from `cursor` on is the redo tail.
#[derive(Debug, Default, Clone)]
pub struct OpLog {
    ops: Vec<ModelEdit>,
    cursor: usize,
}

impl OpLog {
    /// Stage an op. Any redo tail is discarded — those ops were authored against
    /// a state that no longer exists.
    pub fn push(&mut self, op: ModelEdit) {
        self.ops.truncate(self.cursor);
        self.ops.push(op);
        self.cursor = self.ops.len();
    }

    /// Move the cursor back one op. Returns false when already at the start.
    pub fn undo(&mut self) -> bool {
        if self.cursor == 0 {
            return false;
        }
        self.cursor -= 1;
        true
    }

    /// Move the cursor forward one op. Returns false when already at the end.
    pub fn redo(&mut self) -> bool {
        if self.cursor >= self.ops.len() {
            return false;
        }
        self.cursor += 1;
        true
    }

    /// The ops to fold for the current state.
    pub fn active(&self) -> &[ModelEdit] {
        &self.ops[..self.cursor]
    }

    pub fn can_undo(&self) -> bool {
        self.cursor > 0
    }

    pub fn can_redo(&self) -> bool {
        self.cursor < self.ops.len()
    }

    /// True when the current state differs from what is on disk.
    pub fn is_dirty(&self) -> bool {
        self.cursor > 0
    }

    /// Drop every op — used after a successful save, when disk and state agree.
    pub fn clear(&mut self) {
        self.ops.clear();
        self.cursor = 0;
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmeshInfo {
    pub name: String,
    pub vertex_count: u32,
    pub index_count: u32,
    pub vertex_start: u32,
    pub index_start: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub submeshes: Vec<SubmeshInfo>,
    pub vertex_count: u32,
    pub index_count: u32,
    pub influence_count: u32,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// The small JSON the frontend needs after every op. Deliberately carries no
/// geometry — buffers travel only through `derive_model_mesh`'s binary payload.
pub fn summarize(derived: &Derived, log: &OpLog) -> ModelSummary {
    ModelSummary {
        submeshes: derived
            .mesh
            .ranges
            .iter()
            .map(|r| SubmeshInfo {
                name: r.name.clone(),
                vertex_count: r.vertex_count,
                index_count: r.index_count,
                vertex_start: r.vertex_start,
                index_start: r.index_start,
            })
            .collect(),
        vertex_count: derived.mesh.vertices.len() as u32,
        index_count: derived.mesh.indices.len() as u32,
        influence_count: derived
            .skeleton
            .as_ref()
            .map(|s| s.influences.len() as u32)
            .unwrap_or(0),
        dirty: log.is_dirty(),
        can_undo: log.can_undo(),
        can_redo: log.can_redo(),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p flint-core --lib mesh::edit`
Expected: 21 tests PASS.

- [ ] **Step 5: Lint and commit**

```bash
cargo clippy --lib --bins -- -D warnings -A clippy::needless_return
git add src-tauri/crates/flint-core/src/mesh/edit.rs
git commit -m "feat(editor3d): op log undo cursor and derived summary"
```

---

## Task 6: Tauri session state and commands

**Files:**
- Create: `src-tauri/src/commands/editor/model_edit.rs`
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/commands/editor/mod.rs`, `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `flint_core::mesh::edit::{ModelEdit, OpLog, apply_ops, load_paste_source, summarize, ModelSummary, Derived}`, `flint_core::mesh::wire::encode_skn_binary`, `flint_core::mesh::skn::parse_skn_file`, `flint_core::mesh::skl::parse_skl_file`
- Produces commands: `open_model_session`, `stage_model_edit`, `undo_model_edit`, `redo_model_edit`, `derive_model_mesh`, `save_model_session`, `close_model_session`; and `ModelSessionInfo { session_id, source_path, skeleton_path, summary }`

**Context:** `state.rs` already has the exact shape to copy — `WadEditState` at line ~166 is `Arc<RwLock<HashMap<String, Arc<RwLock<WadEditSession>>>>>` with `insert`/`get`/`remove`. Mirror it.

- [ ] **Step 1: Add the session state**

Append to `src-tauri/src/state.rs`, after the `WadEditState` block:

```rust
// =============================================================================
// 3D model edit sessions
// =============================================================================

/// One open `.skn` in the 3D editor. `pristine` is the parse of what is on disk
/// and is never mutated; every derived state is a fresh fold of `log.active()`
/// over it. Mirrors `WadEditSession`.
pub struct ModelEditSession {
    pub session_id: String,
    pub source_path: PathBuf,
    pub skeleton_path: Option<PathBuf>,
    pub pristine: ritoshark::mesh::SkinnedMesh,
    pub skeleton: Option<ritoshark::anim::Skeleton>,
    pub log: flint_core::mesh::edit::OpLog,
}

#[derive(Clone, Default)]
pub struct ModelEditState(Arc<RwLock<HashMap<String, Arc<RwLock<ModelEditSession>>>>>);

impl ModelEditState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, session: ModelEditSession) -> String {
        let id = session.session_id.clone();
        self.0.write().insert(id.clone(), Arc::new(RwLock::new(session)));
        id
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<RwLock<ModelEditSession>>> {
        self.0.read().get(session_id).cloned()
    }

    pub fn remove(&self, session_id: &str) -> bool {
        self.0.write().remove(session_id).is_some()
    }
}
```

- [ ] **Step 2: Write the commands**

Create `src-tauri/src/commands/editor/model_edit.rs`:

```rust
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
```

- [ ] **Step 3: Register the module, state and commands**

`src-tauri/src/commands/editor/mod.rs` — add:

```rust
pub mod model_edit;
```

`src-tauri/src/main.rs` — add to the `.manage(...)` chain after `.manage(WadEditState::new())`:

```rust
        .manage(ModelEditState::new())
```

…importing `ModelEditState` alongside the other state types, and add to `invoke_handler`, near the other editor commands:

```rust
            commands::editor::model_edit::open_model_session,
            commands::editor::model_edit::stage_model_edit,
            commands::editor::model_edit::undo_model_edit,
            commands::editor::model_edit::redo_model_edit,
            commands::editor::model_edit::derive_model_mesh,
            commands::editor::model_edit::save_model_session,
            commands::editor::model_edit::close_model_session,
```

- [ ] **Step 4: Lint**

Run: `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return`
Expected: no warnings. (This compiles the binary — it is the intended gate, and clippy does not wipe the incremental cache.)

- [ ] **Step 5: Run the Rust tests**

Run: `cargo test -p flint-core --lib mesh::edit`
Expected: 21 tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/commands/editor/model_edit.rs src-tauri/src/commands/editor/mod.rs src-tauri/src/main.rs
git commit -m "feat(editor3d): model edit session tauri commands"
```

---

## Task 7: The editor window — open, route, mount

**Files:**
- Create: `src-tauri/src/commands/project/model_editor.rs`, `src/components/editor3d/ModelEditorWindow.tsx`, `src/styles/modelEditor.css`
- Modify: `src-tauri/src/commands/project/mod.rs`, `src-tauri/src/main.rs`, `src-tauri/capabilities/default.json`, `src/main.tsx`, `src/lib/editor/fileContextMenuOptions.ts`, `src/lib/api/modelEdit.ts` (create), `src/lib/api/index.ts`

**Interfaces:**
- Produces: command `open_model_editor_window(project_path, skn_path)`; TS `openModelEditorWindow(project: string, skn: string): Promise<void>`; component `ModelEditorWindow`
- Deliverable: right-clicking a `.skn` opens a real window showing the file name and submesh list. No viewport yet.

- [ ] **Step 1: Write the Rust window command**

Create `src-tauri/src/commands/project/model_editor.rs` — this is `thumbnail_window.rs` with a new label, plus a load event so a second `.skn` retargets the open window instead of spawning another WebView2:

```rust
//! Opens the separate 3D Editor window. Mirrors the thumbnail/map-preview
//! pattern: reuse-by-label, unique WebView2 data dir + matching browser args on
//! Windows (the 0x8007139F guard). See CLAUDE.md "Multi-window pattern".

/// Percent-encode a path for a URL hash query (dependency-free).
fn encode_query_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[tauri::command]
pub async fn open_model_editor_window(
    app: tauri::AppHandle,
    project_path: String,
    skn_path: String,
) -> Result<(), String> {
    use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
    const LABEL: &str = "model-editor";

    // One reusable window: each extra WebView2 costs a browser process and its
    // own data directory. An already-open editor retargets instead.
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_focus();
        let _ = win.emit("model-editor-load", (project_path, skn_path));
        return Ok(());
    }

    let url = format!(
        "index.html#model-editor?project={}&skn={}",
        encode_query_component(&project_path),
        encode_query_component(&skn_path),
    );

    // MUST match `additionalBrowserArgs` in tauri.conf.json.
    const MAIN_BROWSER_ARGS: &str =
        "--disable-features=msSmartScreenProtection --disable-background-networking --disable-translate";
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("webview-model-editor");
    let _ = std::fs::create_dir_all(&data_dir);

    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App(url.into()))
        .title("Flint — 3D Editor")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .additional_browser_args(MAIN_BROWSER_ARGS)
        .data_directory(data_dir)
        .build()
        .map_err(|e| format!("Failed to open 3D editor window: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_reserved_chars() {
        assert_eq!(encode_query_component("a/b c"), "a%2Fb%20c");
        assert_eq!(encode_query_component("Aatrox.skn"), "Aatrox.skn");
    }
}
```

- [ ] **Step 2: Register it**

`src-tauri/src/commands/project/mod.rs` — add after `pub mod map_preview;`:

```rust
pub mod model_editor;
```

`src-tauri/src/main.rs` `invoke_handler` — add next to `open_thumbnail_window`:

```rust
            commands::model_editor::open_model_editor_window,
```

`src-tauri/capabilities/default.json` — add to `windows`:

```json
    "windows": [
        "main",
        "map-preview",
        "thumbnail",
        "model-editor"
    ],
```

- [ ] **Step 3: Write the API wrapper**

Create `src/lib/api/modelEdit.ts`:

```ts
import { invokeCommand } from './core';

/** One submesh (material range) of the session's current derived mesh. */
export interface SubmeshInfo {
    name: string;
    vertexCount: number;
    indexCount: number;
    vertexStart: number;
    indexStart: number;
}

/** The small JSON returned after every op — no geometry travels here. */
export interface ModelSummary {
    submeshes: SubmeshInfo[];
    vertexCount: number;
    indexCount: number;
    influenceCount: number;
    dirty: boolean;
    canUndo: boolean;
    canRedo: boolean;
}

export interface ModelSessionInfo {
    sessionId: string;
    sourcePath: string;
    /** Absent when the `.skn` has no sibling `.skl`. */
    skeletonPath: string | null;
    summary: ModelSummary;
}

export interface ModelSaveResult {
    sknPath: string;
    sklPath: string | null;
    summary: ModelSummary;
}

/** Mirrors the Rust `ModelEdit` enum (serde tag = "kind", camelCase fields). */
export type ModelEdit =
    | { kind: 'renameSubmesh'; index: number; name: string }
    | { kind: 'duplicateSubmesh'; index: number; name: string }
    | { kind: 'deleteSubmesh'; index: number }
    | { kind: 'reorderSubmesh'; from: number; to: number }
    | { kind: 'pasteSubmesh'; sourceSkn: string; sourceIndex: number; name: string };

/**
 * Opens the standalone 3D Editor window for a `.skn`. Mirrors the map-preview
 * multi-window pattern (CLAUDE.md "Multi-window pattern"). An already-open
 * editor is focused and retargeted at the new file.
 */
export async function openModelEditorWindow(project: string, skn: string): Promise<void> {
    return invokeCommand('open_model_editor_window', { projectPath: project, sknPath: skn });
}

export async function openModelSession(sknPath: string): Promise<ModelSessionInfo> {
    return invokeCommand('open_model_session', { sknPath });
}

export async function stageModelEdit(sessionId: string, edit: ModelEdit): Promise<ModelSummary> {
    return invokeCommand('stage_model_edit', { sessionId, edit });
}

export async function undoModelEdit(sessionId: string): Promise<ModelSummary> {
    return invokeCommand('undo_model_edit', { sessionId });
}

export async function redoModelEdit(sessionId: string): Promise<ModelSummary> {
    return invokeCommand('redo_model_edit', { sessionId });
}

/** Current geometry in the shared binary wire format — decode with `decodeMeshPayload`. */
export async function deriveModelMesh(sessionId: string): Promise<ArrayBuffer> {
    return invokeCommand<ArrayBuffer>('derive_model_mesh', { sessionId });
}

export async function saveModelSession(sessionId: string, dest?: string): Promise<ModelSaveResult> {
    return invokeCommand('save_model_session', { sessionId, dest: dest ?? null });
}

export async function closeModelSession(sessionId: string): Promise<void> {
    return invokeCommand('close_model_session', { sessionId });
}
```

Add to `src/lib/api/index.ts`, after `export * from './mesh';`:

```ts
export * from './modelEdit';
```

- [ ] **Step 4: Add the context-menu item**

In `src/lib/editor/fileContextMenuOptions.ts`, the `ext === 'skn'` block already exists near line 592. Add the import at the top, next to the thumbnail one:

```ts
import { openModelEditorWindow } from '../api/modelEdit';
```

and put the new item **first** in that block, so it reads:

```ts
    if (ext === 'skn') {
        options.push({
            label: 'Open in 3D Editor',
            icon: getIcon('model'),
            separator: true,
            onClick: () => openModelEditorWindow(projectPath, fullPath.replace(/\//g, '\\')),
        });
        options.push({
            label: 'Create Thumbnail…',
            icon: getIcon('picture'),
            onClick: () => openThumbnailWindow(projectPath, fullPath.replace(/\//g, '\\')),
        });
    }
```

`model` is an existing key in `src/lib/ui-helpers/fileIcons.tsx`; `getIcon` is typed `keyof typeof icons`, so a wrong name is a compile error rather than a silent blank.

This one edit reaches both consumers — `FileTree.tsx:629` and `FolderGridView.tsx:57` both call `buildFileContextMenuOptions`.

- [ ] **Step 5: Write the window root**

Create `src/components/editor3d/ModelEditorWindow.tsx`:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as api from '../../lib/api';
import type { ModelSessionInfo } from '../../lib/api/modelEdit';
import '../../styles/modelEditor.css';

interface Target {
    project: string;
    skn: string;
}

/** Parse `?project=…&skn=…` out of `#model-editor?…`. */
function targetFromHash(): Target | null {
    const hash = window.location.hash;
    const q = hash.indexOf('?');
    if (q < 0) return null;
    const params = new URLSearchParams(hash.slice(q + 1));
    const skn = params.get('skn');
    if (!skn) return null;
    return { project: params.get('project') || '', skn };
}

export const ModelEditorWindow: React.FC = () => {
    const [target, setTarget] = useState<Target | null>(() => targetFromHash());
    const [session, setSession] = useState<ModelSessionInfo | null>(null);
    const [error, setError] = useState<string | null>(null);

    // The backend retargets an already-open window rather than spawning a second
    // WebView2, so the file can change under us.
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        listen<[string, string]>('model-editor-load', (ev) => {
            const [project, skn] = ev.payload;
            setTarget({ project, skn });
        }).then((u) => { unlisten = u; });
        return () => unlisten?.();
    }, []);

    useEffect(() => {
        if (!target) return;
        let cancelled = false;
        let openedId: string | null = null;
        setSession(null);
        setError(null);

        void (async () => {
            try {
                const info = await api.openModelSession(target.skn);
                openedId = info.sessionId;
                if (cancelled) {
                    void api.closeModelSession(info.sessionId);
                    return;
                }
                setSession(info);
            } catch (err) {
                if (!cancelled) setError(String(err));
            }
        })();

        return () => {
            cancelled = true;
            if (openedId) void api.closeModelSession(openedId);
        };
    }, [target]);

    const fileName = useCallback(
        () => (target ? target.skn.replace(/\\/g, '/').split('/').pop() ?? target.skn : ''),
        [target],
    )();

    if (!target) {
        return <div className="m3d__empty">No model specified.</div>;
    }
    if (error) {
        return (
            <div className="m3d__empty m3d__empty--error">
                <strong>Could not open this model</strong>
                <p>{error}</p>
                <code>{target.skn}</code>
            </div>
        );
    }

    return (
        <div className="m3d">
            <header className="m3d__topbar">
                <span className="m3d__filename">{fileName}</span>
                {session?.summary.dirty && <span className="m3d__dirty" aria-label="Unsaved changes">●</span>}
            </header>
            <div className="m3d__body">
                <aside className="m3d__dock m3d__dock--left">
                    {!session && <div className="m3d__loading">Loading…</div>}
                    {session && (
                        <ul className="m3d__list">
                            {session.summary.submeshes.map((s) => (
                                <li key={s.name} className="m3d__list-row">{s.name}</li>
                            ))}
                        </ul>
                    )}
                </aside>
                <main className="m3d__viewport" />
                <aside className="m3d__dock m3d__dock--right" />
            </div>
            <footer className="m3d__status">
                {session
                    ? `${session.summary.submeshes.length} submeshes · ${session.summary.vertexCount.toLocaleString()} verts`
                    : ''}
            </footer>
        </div>
    );
};
```

- [ ] **Step 6: Write the stylesheet**

Create `src/styles/modelEditor.css`. Keep it to layout only — colours come from the theme variables already defined in `src/themes/default.css`:

```css
.m3d {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg-primary);
    color: var(--text-primary);
    font: 13px/1.4 system-ui, sans-serif;
}

.m3d__topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 38px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-subtle);
    flex: 0 0 auto;
}

.m3d__filename { font-weight: 600; }
.m3d__dirty { color: var(--accent-primary); line-height: 1; }

.m3d__body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
}

.m3d__dock {
    flex: 0 0 260px;
    min-width: 200px;
    overflow: auto;
    border-right: 1px solid var(--border-subtle);
}
.m3d__dock--right {
    border-right: none;
    border-left: 1px solid var(--border-subtle);
}

.m3d__viewport {
    flex: 1 1 auto;
    min-width: 0;
    position: relative;
}

.m3d__status {
    flex: 0 0 auto;
    height: 26px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    border-top: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-size: 12px;
}

.m3d__list { list-style: none; margin: 0; padding: 4px 0; }
.m3d__list-row { padding: 4px 12px; cursor: default; }
.m3d__list-row:hover { background: var(--bg-hover); }

.m3d__empty,
.m3d__loading {
    padding: 24px;
    color: var(--text-secondary);
}
.m3d__empty--error code {
    display: block;
    margin-top: 8px;
    font-size: 12px;
    word-break: break-all;
}
```

Confirm the variable names against `src/themes/default.css` before committing; substitute the project's actual names if any differ.

- [ ] **Step 7: Bootstrap the route**

In `src/main.tsx`, add the import next to the other window roots:

```tsx
import { ModelEditorWindow } from './components/editor3d/ModelEditorWindow';
```

the detector next to `isThumbnail`:

```tsx
const isModelEditor =
    typeof window !== 'undefined' && window.location.hash.startsWith('#model-editor');
```

and a branch in `root.render(...)` **before** `isThumbnail`, mounted without StrictMode like its siblings:

```tsx
    isModelEditor
        ? React.createElement(ModelEditorWindow)
        : isThumbnail
            ? React.createElement(ThumbnailWindow)
            : /* …existing chain unchanged… */
```

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Verify by running the app**

Run: `npm run tauri dev`
Then: open a project, right-click any `.skn`, choose "Open in 3D Editor".
Expected: a new 1440×900 window titled "Flint — 3D Editor" showing the file name and the submesh names in the left dock; the status bar shows submesh and vertex counts. Right-click a *different* `.skn` — the same window focuses and reloads with the new file rather than opening a second window.

- [ ] **Step 10: Lint and commit**

```bash
cargo clippy --lib --bins -- -D warnings -A clippy::needless_return
git add src-tauri/src/commands/project/model_editor.rs src-tauri/src/commands/project/mod.rs src-tauri/src/main.rs src-tauri/capabilities/default.json src/lib/api/modelEdit.ts src/lib/api/index.ts src/lib/editor/fileContextMenuOptions.ts src/components/editor3d/ModelEditorWindow.tsx src/styles/modelEditor.css src/main.tsx
git commit -m "feat(editor3d): 3D editor window opened from the .skn context menu"
```

---

## Task 8: Extract `SknScene` and re-base `ModelPreview`

**Files:**
- Create: `src/lib/babylon/sknScene.ts`
- Modify: `src/components/preview/ModelPreview.tsx`

**Interfaces:**
- Consumes: `createEngine` (`src/lib/babylon/engine.ts`), `buildSknMeshes` + `MeshDTO` (`meshBuilder.ts`), `buildBabylonSkeleton` + `buildSkeletonLines` / `buildSkeletonOctahedrons` / `buildSkeletonJoints` + `BoneData` / `SklData` (`skeletonBuilder.ts`), `computeFraming` / `applyFraming` / `BoundingBox` (`cameraFraming.ts`), `api.SknMeshData`
- Produces: `createSknScene(canvas, opts): SknSceneHandle` with the members listed below.

**This is a behaviour-preserving refactor.** It ships before any editor viewport work so a regression is attributable. Three documented contracts must survive; all three live in `SkinnedPreview`/`PreviewPanel` *above* `ModelPreview`, so they should not be disturbed — but they are what to check:

1. **`.skn`/`.anm` must not remount the viewer** — a `.anm` click swaps the clip, it does not rebuild the scene. `ModelPreview`'s mesh-load effect must **not** depend on `initialAnimation`/`autoPlay` (they are read through `initialAnimationRef`/`autoPlayRef`); a dependency there re-fetches the mesh, and the framing effect then calls `applyFraming` and resets the camera.
2. **The one-frame WebGL context gap** on viewer swaps (`swapping` in `SkinnedPreview`) — without it engines pile up. Watch the `[engine] CREATED` debug log.
3. **Framing is one-time at load** (`framedAtValidSize`), and `safeDisposeSkeletonViewer` swallows Babylon-internal teardown failures.

Also preserved verbatim: the skybox `files` array order is `[px, py, pz, nx, ny, nz]`. Babylon consumes that array **by index** and Flint passes blob URLs, which carry no filename — the position alone picks the GPU face.

- [ ] **Step 1: Create the controller module**

Create `src/lib/babylon/sknScene.ts`. **Move** — do not re-write from scratch — the following out of `ModelPreview.tsx`'s effects, preserving every comment that explains a past bug:

- engine + scene creation, lights, `ArcRotateCamera`, the render loop and the resize observer;
- the skybox effect (keeping the `[px, py, pz, nx, ny, nz]` order and its comment);
- the ground/grid builders;
- `buildSknMeshes` + material/texture construction (`PBRMaterial`/`StandardMaterial`, alpha handling driven by `material_data[..].has_alpha`);
- the skeleton overlay (`buildBabylonSkeleton`, the lines/octahedron/joint-marker builders, `SkeletonViewer` + `safeDisposeSkeletonViewer`);
- camera framing (`computeFraming`/`applyFraming` + the `framedAtValidSize` one-time rule).

Expose exactly this surface:

```ts
export type SkeletonOverlayMode = 'off' | 'lines' | 'octahedrons' | 'joints';

export interface SknSceneOptions {
    /** Draw the ground grid. Default true. */
    grid?: boolean;
    /** Load the bundled skybox. Default true. */
    skybox?: boolean;
}

export interface SknSceneHandle {
    /** Replace the loaded geometry. Framing runs once per mesh identity. */
    loadMesh(mesh: SknMeshData, skeleton: SklData | null): Promise<void>;
    setSubmeshVisible(name: string, visible: boolean): void;
    /** Show only this submesh; `null` shows everything not individually hidden. */
    setIsolated(name: string | null): void;
    setWireframe(on: boolean): void;
    setSkeletonOverlay(mode: SkeletonOverlayMode): void;
    /** Emissive-tint the named submesh; `null` clears. Not a HighlightLayer —
     *  that is a full-screen post-process and costs more than this needs. */
    setSelection(name: string | null): void;
    frameCamera(): void;
    /** Canvas-space pick → submesh name, or null on a miss. */
    pickAt(x: number, y: number): string | null;
    /** Rename in place, so a rename does not force a geometry reload. */
    renameSubmesh(oldName: string, newName: string): void;
    /** The underlying scene, for callers that still need Babylon directly
     *  (the animation player). */
    readonly scene: Scene;
    dispose(): void;
}

export function createSknScene(
    canvas: HTMLCanvasElement,
    opts?: SknSceneOptions,
): SknSceneHandle;
```

`buildSknMeshes` already creates **one Babylon `Mesh` per material range, named by submesh** — so `setSubmeshVisible`, `setIsolated`, `setSelection`, `renameSubmesh` and `pickAt` are all lookups in a `Map<string, Mesh>` the controller keeps. `pickAt` is `scene.pick(x, y)` and reading `pickInfo.pickedMesh?.name`.

- [ ] **Step 2: Re-base `ModelPreview` onto the controller**

Replace the moved effects in `ModelPreview.tsx` with a single controller instance held in a ref. `ModelPreview` keeps: its settings popups and toolbar, the animation clip list and `AnimationPlayer` (driven through `handle.scene`), `SubmeshVisibilityTimeline`, the submesh/form pickers, and `modelPreviewSessionStore` persistence.

Do **not** change `SkinnedPreview` or `PreviewPanel`.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the existing unit tests**

Run: `npm test`
Expected: all existing suites PASS — in particular `cameraFraming.test.ts` and `submeshVisibility.test.ts`, which cover logic this refactor moves around.

- [ ] **Step 5: Verify the preview pane by hand (this is the real gate)**

Run: `npm run tauri dev`, then walk each check:

1. Click a `.skn` in the file tree → model renders with textures, grid and skybox; camera frames it.
2. Rotate/zoom, then click a **`.anm`** sibling → the clip changes and **the camera does not reset**. This is contract 1.
3. Click back to the `.skn` → still no camera reset.
4. Toggle wireframe, the skeleton overlay (each mode), and individual submeshes → all behave as before.
5. Open DevTools, filter the console for `[engine] CREATED` → exactly one line per genuine viewer swap, not one per selection. This is contract 2.
6. Check the skybox: bright sky **overhead**, not on a side wall. This is the face-order rule.
7. Minimise and restore the window → the scene recovers, no stretched bands.

- [ ] **Step 6: Commit**

```bash
git add src/lib/babylon/sknScene.ts src/components/preview/ModelPreview.tsx
git commit -m "refactor(editor3d): extract SknScene controller from ModelPreview"
```

---

## Task 9: Editor store and pure helpers

**Files:**
- Create: `src/lib/stores/modelEditorStore.ts`, `src/lib/editor3d/boneTree.ts`, `src/lib/editor3d/renameValidation.ts`, `src/lib/editor3d/boneTree.test.ts`, `src/lib/editor3d/renameValidation.test.ts`

**Interfaces:**
- Consumes: `ModelSummary`, `SubmeshInfo`, `ModelEdit` from `src/lib/api/modelEdit.ts`; `BoneData`/`SklData` from `src/lib/babylon/skeletonBuilder.ts`
- Produces:
  - `buildBoneTree(bones: BoneData[]): BoneNode[]` where `BoneNode = { bone: BoneData; children: BoneNode[] }`
  - `validateSubmeshName(name: string, existing: string[], selfIndex: number | null): string | null` — returns an error message, or `null` when valid
  - `useModelEditorStore` (zustand) with `{ sessionId, summary, skeleton, selection, clipboard, saving, setSession, applySummary, select, setClipboard, reset }`
  - `type Selection = { kind: 'submesh'; name: string } | { kind: 'joint'; id: number } | null`

**Context:** Vitest runs in the **node** environment over `src/**/*.test.ts` — so these two helpers live in `src/lib/`, not inside components, precisely so they are testable.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/editor3d/boneTree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildBoneTree } from './boneTree';
import type { BoneData } from '../babylon/skeletonBuilder';

const bone = (name: string, id: number, parentId: number): BoneData => ({
    name,
    id,
    parent_id: parentId,
    local_translation: [0, 0, 0],
    local_rotation: [0, 0, 0, 1],
    local_scale: [1, 1, 1],
    world_position: [0, 0, 0],
    inverse_bind_matrix: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
    ],
});

describe('buildBoneTree', () => {
    it('nests children under their parent', () => {
        const tree = buildBoneTree([bone('Root', 0, -1), bone('Spine', 1, 0), bone('Head', 2, 1)]);
        expect(tree).toHaveLength(1);
        expect(tree[0].bone.name).toBe('Root');
        expect(tree[0].children[0].bone.name).toBe('Spine');
        expect(tree[0].children[0].children[0].bone.name).toBe('Head');
    });

    it('supports multiple roots', () => {
        const tree = buildBoneTree([bone('A', 0, -1), bone('B', 1, -1), bone('A1', 2, 0)]);
        expect(tree.map((n) => n.bone.name)).toEqual(['A', 'B']);
        expect(tree[0].children).toHaveLength(1);
    });

    it('handles a child listed before its parent', () => {
        const tree = buildBoneTree([bone('Head', 2, 1), bone('Spine', 1, 0), bone('Root', 0, -1)]);
        expect(tree).toHaveLength(1);
        expect(tree[0].bone.name).toBe('Root');
        expect(tree[0].children[0].children[0].bone.name).toBe('Head');
    });

    it('treats a bone whose parent does not exist as a root rather than dropping it', () => {
        const tree = buildBoneTree([bone('Orphan', 5, 99), bone('Root', 0, -1)]);
        expect(tree.map((n) => n.bone.name).sort()).toEqual(['Orphan', 'Root']);
    });

    it('does not loop forever on a self-parented bone', () => {
        const tree = buildBoneTree([bone('Loop', 0, 0)]);
        expect(tree).toHaveLength(1);
        expect(tree[0].children).toHaveLength(0);
    });

    it('returns an empty array for no bones', () => {
        expect(buildBoneTree([])).toEqual([]);
    });
});
```

Create `src/lib/editor3d/renameValidation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateSubmeshName } from './renameValidation';

describe('validateSubmeshName', () => {
    const existing = ['Body', 'Cape'];

    it('accepts a fresh name', () => {
        expect(validateSubmeshName('Wings', existing, 1)).toBeNull();
    });

    it('accepts a submesh keeping its own name', () => {
        expect(validateSubmeshName('Cape', existing, 1)).toBeNull();
    });

    it('rejects a name taken by another submesh', () => {
        expect(validateSubmeshName('Body', existing, 1)).toMatch(/already exists/i);
    });

    it('rejects a collision that differs only in case', () => {
        expect(validateSubmeshName('BODY', existing, 1)).toMatch(/already exists/i);
    });

    it('rejects an empty or whitespace name', () => {
        expect(validateSubmeshName('', existing, 1)).toMatch(/empty/i);
        expect(validateSubmeshName('   ', existing, 1)).toMatch(/empty/i);
    });

    it('checks against every name when there is no self index (duplicate/paste)', () => {
        expect(validateSubmeshName('Cape', existing, null)).toMatch(/already exists/i);
        expect(validateSubmeshName('Cape_copy', existing, null)).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: both new suites FAIL — the modules do not exist.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/editor3d/boneTree.ts`:

```ts
import type { BoneData } from '../babylon/skeletonBuilder';

export interface BoneNode {
    bone: BoneData;
    children: BoneNode[];
}

/**
 * Fold a flat SKL joint list into a hierarchy. `parent_id === -1` marks a root.
 *
 * Two defensive cases matter on real files: a joint whose `parent_id` names a
 * joint that is not in the list (repathed/hand-built skeletons) is promoted to
 * a root rather than dropped, and a self-parented joint is treated as a root so
 * the walk cannot loop.
 */
export function buildBoneTree(bones: BoneData[]): BoneNode[] {
    const nodes = new Map<number, BoneNode>();
    for (const bone of bones) {
        nodes.set(bone.id, { bone, children: [] });
    }

    const roots: BoneNode[] = [];
    for (const bone of bones) {
        const node = nodes.get(bone.id)!;
        const parent = bone.parent_id === bone.id ? undefined : nodes.get(bone.parent_id);
        if (parent) {
            parent.children.push(node);
        } else {
            roots.push(node);
        }
    }
    return roots;
}
```

Create `src/lib/editor3d/renameValidation.ts`:

```ts
/**
 * Validate a submesh name against the rest of the mesh. Returns an error string,
 * or `null` when the name is usable.
 *
 * Names are the key the skin BIN references geometry by (and FNV1a-32 of the
 * lowercased name is what submesh-visibility events match on), so a collision
 * silently makes one of the two unreachable. Comparison is case-insensitive for
 * the same reason.
 *
 * `selfIndex` is the index being renamed — pass `null` for duplicate/paste,
 * where the name must be free against every existing submesh.
 */
export function validateSubmeshName(
    name: string,
    existing: string[],
    selfIndex: number | null,
): string | null {
    if (name.trim() === '') return 'Name cannot be empty.';
    const lower = name.toLowerCase();
    for (let i = 0; i < existing.length; i++) {
        if (i === selfIndex) continue;
        if (existing[i].toLowerCase() === lower) {
            return `A submesh named "${existing[i]}" already exists.`;
        }
    }
    return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: both suites PASS (12 new tests).

- [ ] **Step 5: Write the store**

Create `src/lib/stores/modelEditorStore.ts`:

```ts
import { create } from 'zustand';
import type { ModelSummary, ModelSessionInfo } from '../api/modelEdit';
import type { SklData } from '../babylon/skeletonBuilder';

export type Selection =
    | { kind: 'submesh'; name: string }
    | { kind: 'joint'; id: number }
    | null;

/** A submesh copied for pasting. In-window only — no OS clipboard in Phase 1. */
export interface SubmeshClipboard {
    sourceSkn: string;
    sourceIndex: number;
    name: string;
}

interface ModelEditorState {
    sessionId: string | null;
    sourcePath: string | null;
    skeletonPath: string | null;
    summary: ModelSummary | null;
    skeleton: SklData | null;
    selection: Selection;
    clipboard: SubmeshClipboard | null;
    saving: boolean;

    setSession(info: ModelSessionInfo, skeleton: SklData | null): void;
    applySummary(summary: ModelSummary): void;
    select(selection: Selection): void;
    setClipboard(clipboard: SubmeshClipboard | null): void;
    setSaving(saving: boolean): void;
    reset(): void;
}

export const useModelEditorStore = create<ModelEditorState>((set) => ({
    sessionId: null,
    sourcePath: null,
    skeletonPath: null,
    summary: null,
    skeleton: null,
    selection: null,
    clipboard: null,
    saving: false,

    setSession: (info, skeleton) =>
        set({
            sessionId: info.sessionId,
            sourcePath: info.sourcePath,
            skeletonPath: info.skeletonPath,
            summary: info.summary,
            skeleton,
            selection: null,
        }),

    // The backend summary is authoritative — it comes from the same fold that
    // produced the geometry, so the UI can never drift from what would be saved.
    applySummary: (summary) => set({ summary }),

    select: (selection) => set({ selection }),
    setClipboard: (clipboard) => set({ clipboard }),
    setSaving: (saving) => set({ saving }),

    reset: () =>
        set({
            sessionId: null,
            sourcePath: null,
            skeletonPath: null,
            summary: null,
            skeleton: null,
            selection: null,
            saving: false,
        }),
}));
```

Note `reset()` deliberately keeps `clipboard` — copying a submesh in one file and pasting it after switching to another is the whole point of cross-file paste.

- [ ] **Step 6: Type-check and commit**

```bash
npx tsc --noEmit
npm test
git add src/lib/editor3d src/lib/stores/modelEditorStore.ts
git commit -m "feat(editor3d): editor store, bone tree fold and rename validation"
```

---

## Task 10: Outliner

**Files:**
- Create: `src/components/editor3d/Outliner.tsx`
- Modify: `src/components/editor3d/ModelEditorWindow.tsx`, `src/styles/modelEditor.css`

**Interfaces:**
- Consumes: `useModelEditorStore`, `Selection`, `buildBoneTree`, `BoneNode`, `validateSubmeshName`, `beginPointerDrag` (`src/lib/pointerDrag.ts`), `useModalStore().openContextMenu`, `ContextMenuOption` (`src/lib/types.ts`)
- Produces: `<Outliner onEdit={(edit: ModelEdit) => Promise<void>} onToggleVisible={(name: string, visible: boolean) => void} onIsolate={(name: string | null) => void} />`

- [ ] **Step 1: Write the component**

Create `src/components/editor3d/Outliner.tsx` with two sections.

**Meshes section** — one row per `summary.submeshes` entry:
- an eye button toggling local visibility state (kept in the component, since visibility is a view concern and never staged as an op);
- the name, inline-editable on double-click or `F2`, validated with `validateSubmeshName(next, names, index)` — show the error inline and keep focus rather than staging a doomed op;
- click selects (`select({ kind: 'submesh', name })`);
- right-click opens the shared context menu via `useModalStore().openContextMenu(e.clientX, e.clientY, options)` with: Rename, Duplicate, Delete (`danger: true`), Copy, Paste, Isolate;
- **drag to reorder uses `beginPointerDrag` from `src/lib/pointerDrag.ts`** — never HTML5 `draggable`. WebView2's native OS drag-drop blocks HTML5 DnD inside the webview and you get a permanent no-drop cursor. Hit-test the drop row with `document.elementFromPoint` (the drag ghost is `pointer-events: none`), read a `data-submesh-index` attribute off it, and emit `{ kind: 'reorderSubmesh', from, to }`.

Menu actions map to ops:
- Rename → inline edit, then `{ kind: 'renameSubmesh', index, name }`
- Duplicate → `{ kind: 'duplicateSubmesh', index, name: uniqueName(`${name}_copy`) }`, where `uniqueName` appends `_2`, `_3`… until `validateSubmeshName(candidate, names, null)` returns `null`
- Delete → `openConfirmDialog` then `{ kind: 'deleteSubmesh', index }`
- Copy → `setClipboard({ sourceSkn: sourcePath!, sourceIndex: index, name })`
- Paste → disabled when `clipboard === null`; otherwise `{ kind: 'pasteSubmesh', sourceSkn: clipboard.sourceSkn, sourceIndex: clipboard.sourceIndex, name: uniqueName(clipboard.name) }`
- Isolate → `onIsolate(name)`, toggling back to `null` when already isolated

**Skeleton section** — `buildBoneTree(skeleton.bones)` rendered as a collapsible tree with a name filter input. Clicking a joint calls `select({ kind: 'joint', id })`. Read-only: no rename, no context menu. When `skeleton === null`, render the header with the note *"This .skn has no sibling .skl — skeleton unavailable."* rather than hiding the section, so the absence is legible.

Filtering keeps a joint whose name matches **or** which has a matching descendant, so the path to a match stays visible.

- [ ] **Step 2: Wire it into the window**

In `ModelEditorWindow.tsx`, replace the placeholder `<ul className="m3d__list">` with `<Outliner … />`, and add the op dispatcher:

```tsx
const applyEdit = useCallback(async (edit: ModelEdit) => {
    const id = useModelEditorStore.getState().sessionId;
    if (!id) return;
    try {
        const summary = await api.stageModelEdit(id, edit);
        useModelEditorStore.getState().applySummary(summary);
        // Geometry-changing ops need a viewport reload; rename and reorder do not.
        if (edit.kind !== 'renameSubmesh' && edit.kind !== 'reorderSubmesh') {
            await reloadGeometry();
        }
    } catch (err) {
        setOpError(String(err));
    }
}, [reloadGeometry]);
```

`reloadGeometry` is a no-op stub until Task 12; declare it as `useCallback(async () => {}, [])` for now so the signature is already right.

Also load the skeleton once the session opens, so the tree has data:

```tsx
const skeleton = info.skeletonPath ? await api.readSklSkeleton(info.skeletonPath) : null;
useModelEditorStore.getState().setSession(info, skeleton);
```

- [ ] **Step 3: Add the styles**

Extend `src/styles/modelEditor.css` with `.m3d__section`, `.m3d__section-title`, `.m3d__row`, `.m3d__row--selected`, `.m3d__eye`, `.m3d__name-input`, `.m3d__filter`, `.m3d__tree-toggle`, `.m3d__hint`.

**Every icon button must be centred by its container's layout** — `display: flex; align-items: center; justify-content: center` on the button, `display: block` on the inline SVG. An inline SVG sits on the text baseline and reads as off-centre; never patch that with a `margin-top` nudge.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify by hand**

Run: `npm run tauri dev`, open a `.skn` in the 3D Editor:
1. Both sections render; the mesh rows list every submesh; the skeleton tree nests correctly and the filter narrows it while keeping ancestors visible.
2. Double-click a name, type a duplicate of another submesh → inline error, nothing staged.
3. Rename to something free → the row updates, the dirty dot appears.
4. Duplicate → a new `<name>_copy` row appears.
5. Delete → confirm dialog, row disappears. Delete down to one submesh → the last delete is refused with the backend's message.
6. Drag a row over another → the order changes, and the ghost follows the cursor (proving pointer-drag, not HTML5).
7. Copy from one `.skn`, retarget the window to another `.skn`, Paste → either it lands, or it fails naming the missing joints.

- [ ] **Step 6: Commit**

```bash
git add src/components/editor3d/Outliner.tsx src/components/editor3d/ModelEditorWindow.tsx src/styles/modelEditor.css
git commit -m "feat(editor3d): outliner with mesh and skeleton trees"
```

---

## Task 11: Inspector

**Files:**
- Create: `src/components/editor3d/Inspector.tsx`
- Modify: `src/components/editor3d/ModelEditorWindow.tsx`, `src/styles/modelEditor.css`

**Interfaces:**
- Consumes: `useModelEditorStore` (`selection`, `summary`, `skeleton`)
- Produces: `<Inspector />` — reads everything from the store, takes no props.

- [ ] **Step 1: Write the component**

Create `src/components/editor3d/Inspector.tsx` rendering a label/value list keyed off `selection`:

- `null` → *"Select a submesh or joint."*
- `{ kind: 'submesh', name }` → look up the `SubmeshInfo`; show **Name**, **Material** (same string — a `.skn` stores only the material name; the material itself lives in the skin BIN), **Vertices** (`vertexCount`), **Triangles** (`indexCount / 3`), **Vertex range** (`vertexStart`–`vertexStart + vertexCount - 1`), **Index range** likewise.
- `{ kind: 'joint', id }` → look up the `BoneData`; show **Name**, **ID**, **Parent** (the parent joint's name, or *"— (root)"* when `parent_id === -1`), **Local translation** / **Local scale** as `x, y, z` to 3 decimals, **Local rotation** converted from the stored quaternion to Euler degrees, **Bind world position**, and **Influence index** — its position in `skeleton.influences`, or *"not bound"* when absent.

Quaternion → Euler conversion, inline (Babylon is not imported here; this panel stays a pure renderer):

```ts
/** Quaternion [x,y,z,w] → Euler degrees, YXZ order to match Babylon's display. */
function quatToEulerDegrees(q: [number, number, number, number]): [number, number, number] {
    const [x, y, z, w] = q;
    const sinp = 2 * (w * x - y * z);
    const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
    const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y));
    const roll = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
    const deg = (r: number) => Number((r * (180 / Math.PI)).toFixed(2));
    return [deg(pitch), deg(yaw), deg(roll)];
}
```

- [ ] **Step 2: Wire it in**

In `ModelEditorWindow.tsx`, render `<Inspector />` inside `.m3d__dock--right`.

- [ ] **Step 3: Add the styles**

Extend `modelEditor.css` with `.m3d__inspector`, `.m3d__field`, `.m3d__field-label`, `.m3d__field-value`. Use a two-column grid so values align; do not eyeball offsets.

- [ ] **Step 4: Type-check and verify**

Run: `npx tsc --noEmit`, then `npm run tauri dev`.
Expected: clicking a submesh row shows its counts and ranges; clicking a joint shows its transform, its parent's name, and either its influence index or "not bound". Selecting nothing shows the hint.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor3d/Inspector.tsx src/components/editor3d/ModelEditorWindow.tsx src/styles/modelEditor.css
git commit -m "feat(editor3d): inspector panel for submesh and joint selection"
```

---

## Task 12: Viewport, picking and selection sync

**Files:**
- Create: `src/components/editor3d/EditorViewport.tsx`
- Modify: `src/components/editor3d/ModelEditorWindow.tsx`, `src/styles/modelEditor.css`

**Interfaces:**
- Consumes: `createSknScene` / `SknSceneHandle` (Task 8), `api.readSknMesh`, `api.deriveModelMesh`, `decodeMeshPayload`, `useModelEditorStore`
- Produces: `<EditorViewport sknPath={string} reloadToken={number} onPick={(name: string | null) => void} handleRef={React.MutableRefObject<SknSceneHandle | null>} />`

**Context — two mesh sources.** The *first* load goes through `api.readSknMesh(sknPath)` so textures and material data resolve through the existing BIN lookup. Geometry refreshes after a structural op go through `api.deriveModelMesh(sessionId)`, which returns geometry only. Keep the first payload's `textures` / `material_data` and splice them onto each derived payload, or the model turns untextured after the first duplicate.

- [ ] **Step 1: Export the payload decoder**

`decodeMeshPayload` in `src/lib/api/mesh.ts` is currently module-private. Change `function decodeMeshPayload` to `export function decodeMeshPayload` — the editor needs it for the derived-geometry path, and duplicating it would let the two decoders drift apart.

- [ ] **Step 2: Write the viewport**

Create `src/components/editor3d/EditorViewport.tsx`:

- a `<canvas>` filling `.m3d__viewport`;
- on mount, `createSknScene(canvas)` into `handleRef.current`; on unmount, `dispose()`;
- an effect on `sknPath` that calls `api.readSknMesh`, stashes `textures`/`material_data` in a ref, and calls `handle.loadMesh(mesh, skeleton)`;
- an effect on `reloadToken` (bumped by `reloadGeometry`) that calls `api.deriveModelMesh(sessionId)`, decodes it, splices the stashed textures back on, and calls `handle.loadMesh(...)` **without** re-framing the camera — a duplicate must not yank the view;
- a `click` handler calling `handle.pickAt(offsetX, offsetY)` and reporting the result through `onPick`;
- **one canvas, one engine.** Never create a second `SknScene` for the same canvas — check the `[engine] CREATED` debug line if the app starts feeling heavy.

- [ ] **Step 3: Wire selection both ways**

In `ModelEditorWindow.tsx`:
- pass `onPick={(name) => select(name ? { kind: 'submesh', name } : null)}`;
- subscribe to `selection` and call `handleRef.current?.setSelection(selection?.kind === 'submesh' ? selection.name : null)`;
- pass the Outliner's `onToggleVisible` to `handle.setSubmeshVisible` and `onIsolate` to `handle.setIsolated`;
- implement the real `reloadGeometry`: `setReloadToken((n) => n + 1)`.

- [ ] **Step 4: Type-check and verify**

Run: `npx tsc --noEmit`, then `npm run tauri dev`.
Expected:
1. The model renders in the editor window, framed, with textures.
2. Clicking a submesh in the viewport highlights it **and** selects its row in the outliner; the Inspector updates.
3. Selecting a row highlights that submesh in the viewport.
4. Toggling the eye hides/shows in the viewport; Isolate shows only that submesh.
5. Duplicate a submesh → the copy appears in the viewport **and stays textured**, and the camera does not jump.
6. Delete a submesh → it disappears and the rest still renders correctly (this is the reindexing from Task 2 proving out end-to-end).

- [ ] **Step 5: Commit**

```bash
git add src/components/editor3d/EditorViewport.tsx src/components/editor3d/ModelEditorWindow.tsx src/lib/api/mesh.ts src/styles/modelEditor.css
git commit -m "feat(editor3d): editor viewport with picking and selection sync"
```

---

## Task 13: Save, undo/redo, dirty guards and docs

**Files:**
- Modify: `src/components/editor3d/ModelEditorWindow.tsx`, `src/styles/modelEditor.css`, `CLAUDE.md`

**Interfaces:**
- Consumes: `api.saveModelSession`, `api.undoModelEdit`, `api.redoModelEdit`, `getCurrentWindow` (`@tauri-apps/api/window`), `save` (`@tauri-apps/plugin-dialog`)

- [ ] **Step 1: Build the top bar**

Add to `ModelEditorWindow.tsx`'s header:
- **Save** — `api.saveModelSession(sessionId)`, disabled unless `summary.dirty`; on success `applySummary(result.summary)` and toast `Saved <filename>`, plus `+ .skl` when `result.sklPath` is set. On failure show the error and leave the state dirty — the session is unchanged, so a retry is safe.
- **Save As…** — the dialog plugin's `save({ defaultPath, filters: [{ name: 'Simple Skin', extensions: ['skn'] }] })`, then `saveModelSession(sessionId, chosenPath)`.
- **Undo** / **Redo** — `api.undoModelEdit` / `api.redoModelEdit`, each `applySummary` then `reloadGeometry()`; disabled from `summary.canUndo` / `summary.canRedo`.
- **Mode tabs** — `Mesh` (active), `Weights` and `Anim` rendered `disabled` with `title="Coming in a later phase"`. They show the shell's shape without faking behaviour.

Bind `Ctrl/Cmd+S` to Save, `Ctrl/Cmd+Z` to Undo and `Ctrl/Cmd+Shift+Z` to Redo with a `window` `keydown` listener reading the current values through a ref — the same `saveRef` pattern `BinEditor.tsx` and `WadPreviewPanel.tsx` already use.

- [ ] **Step 2: Add the dirty guards**

Two exits need guarding, both routed through one `confirmDiscard(): Promise<boolean>` helper that resolves `true` when it is safe to proceed:

- **Window close** — `getCurrentWindow().onCloseRequested(async (event) => { if (!(await confirmDiscard())) event.preventDefault(); })`.
- **Retarget** — the `model-editor-load` listener must run `confirmDiscard()` before calling `setTarget`; on cancel, keep the current file (the backend has already focused the window, which is the right outcome either way).

`confirmDiscard` returns `true` immediately when `!summary?.dirty`. Otherwise it renders a modal with **Save**, **Discard** and **Cancel**. Per the ecosystem UI rule, that modal has a footer Cancel and therefore must **not** also carry a header `×`.

- [ ] **Step 3: Type-check and verify**

Run: `npx tsc --noEmit`, then `npm run tauri dev`. Walk every path:
1. Rename a submesh → Save → reopen the file → the new name persisted.
2. Duplicate → Save → reopen → the copy is there and renders.
3. Delete → Save → reopen → gone, remaining submeshes still correct.
4. Open, change nothing, Save As to a new path → the new file is byte-identical to the source (`fc /b old.skn new.skn` on Windows reports no differences). This is the zero-op guarantee from Task 1 proving out end-to-end.
5. Paste a submesh that needs a new influence → Save → the toast mentions `+ .skl`, and the pasted geometry is still correctly skinned on reopen.
6. Make an edit, try to close the window → the guard appears; Cancel keeps it open; Discard closes it.
7. Make an edit, right-click a different `.skn` in the main window → the guard appears before retargeting.
8. Ctrl+Z / Ctrl+Shift+Z step through the op log and the viewport follows.

- [ ] **Step 4: Update CLAUDE.md**

Add a section recording what a future session would otherwise have to rediscover:

```markdown
## 3D Editor window + model edit session (2026-08-06)
- **Third secondary window**, label `model-editor` (`commands/project/model_editor.rs`) — same
  pattern as map-preview/thumbnail: reuse-by-label, `MAIN_BROWSER_ARGS` + unique
  `data_directory` (0x8007139F guard), label in `capabilities/default.json`, `#model-editor`
  branch in `main.tsx` mounted WITHOUT StrictMode. It **retargets** on a second `.skn` (event
  `model-editor-load`) rather than opening another WebView2.
- **`ModelEditSession`** (`state.rs` + `commands/editor/model_edit.rs`, ops in
  `flint-core/src/mesh/edit.rs`): pristine parse + op log; undo/redo is a CURSOR into the log
  replayed over the pristine parse, not an inverse-op stack. Staging after an undo truncates the
  redo tail. `save_model_session` RE-PARSES from disk afterwards (same stale-cache trap the WAD
  editor hit).
- **SKN index values are GLOBAL vertex indices**, not range-local (`meshBuilder.ts` rebases by
  subtracting `vertex_start`). Deleting a range must drain both buffers, shift later ranges'
  starts, AND shift every surviving index value above the removed span down by the removed
  vertex count.
- **Two hard format limits**: indices are `u16` → 65,535 vertices max; `blend_indices` are `u8`
  → `Skeleton.influences` caps at 256. Both are rejected with a message, never truncated.
- **Cross-file paste remaps by joint NAME**: source influence index → source joint id → joint
  name → destination joint → destination influence index (appending when absent). Raw blend
  indices are meaningless across two skeletons. Phase 1 writes the `.skl` ONLY to append
  influences — never joint names, ids, parents or transforms.
- **`SknScene` (`src/lib/babylon/sknScene.ts`)** is the shared headless scene controller;
  `ModelPreview` and the editor viewport both mount it. Scene-level fixes (skybox face order,
  framing, safe SkeletonViewer disposal) belong there, not in either consumer.
```

- [ ] **Step 5: Final full check**

```bash
cargo clippy --lib --bins -- -D warnings -A clippy::needless_return
cargo test -p flint-core --lib mesh::edit
npx tsc --noEmit
npm test
```
Expected: clippy clean, 21 Rust tests pass, no TS errors, all vitest suites pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/editor3d/ModelEditorWindow.tsx src/styles/modelEditor.css CLAUDE.md
git commit -m "feat(editor3d): save, undo/redo and unsaved-change guards"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| "Open in 3D Editor" on `.skn` in FileTree + FolderGridView | 7 (one edit to the shared builder covers both) |
| `open_model_editor_window`, reuse-by-label, unique data dir, capability, `#model-editor` bootstrap, no StrictMode | 7 |
| One reusable window, retarget on a second `.skn` | 7 (open), 13 (dirty guard on retarget) |
| `SknScene` extraction; `ModelPreview` re-based; three contracts preserved | 8 |
| Outliner mesh tree: rename, visibility, solo, duplicate, delete, copy-paste, reorder | 10 |
| Outliner skeleton tree: hierarchy, filter, select, read-only | 9 (fold + tests), 10 (UI) |
| Inspector: submesh and joint properties | 11 |
| Top bar: filename, dirty dot, Save/Save As, undo/redo, disabled mode tabs | 7 (filename/dot), 13 (rest) |
| Status bar counts | 7 |
| `ModelEditSession`, op log, cursor undo/redo, post-save re-parse | 1–6 |
| Cross-file paste with name-keyed influence remap; material-name-only note | 4 (backend), 11 (Inspector shows material = name) |
| `u16` / `u8` limits rejected not truncated | 2, 4 |
| `.skl` written only to append influences | 4, 6 |
| Selection: viewport pick ↔ outliner, emissive tint not HighlightLayer | 8 (surface), 12 (wiring) |
| Rename validation: empty, duplicate | 9 (pure + tests), 10 (UI) |
| Errors: unparseable `.skn`, missing `.skl`, paste with unmatched joints, save failure, dirty swap, dirty close | 7, 6, 4, 13, 13, 13 |
| Rust tests (all 9 listed cases) | 1–5 |
| TS tests (op log tail, bone tree fold, rename validation) | 9 |

Two spec items landed differently than written, deliberately:
- **"Op-log store: staging after an undo truncates the redo tail"** is tested in **Rust** (Task 5) rather than TS. The op log is authoritative on the backend and the TS store only mirrors the summary it returns, so testing it in TS would test a mock. The behaviour is covered.
- **Rename's "warns when the old name appears in the skin BIN"** is *not* implemented. Scanning the project's BINs for the name is the same tree-walk as Phase 3's reference rewrite, and building half of it here would be dead code the moment Phase 3 lands. Phase 1 validates within the `.skn` only. Flagged rather than silently dropped.

**Placeholder scan:** no TBD/TODO, no "add error handling", no "similar to Task N". Task 8's step 1 says "move these effects" rather than reproducing 900 lines of `ModelPreview` inline — the moved code already exists in the repo and is named precisely; that is a move instruction, not a placeholder. `reloadGeometry` is explicitly a typed stub in Task 10 and implemented in Task 12.

**Type consistency:** `ModelEdit` variants are `renameSubmesh` / `duplicateSubmesh` / `deleteSubmesh` / `reorderSubmesh` / `pasteSubmesh` in both the Rust `#[serde(tag = "kind", rename_all = "camelCase")]` enum and the TS union. `ModelSummary` / `SubmeshInfo` fields are camelCase on both sides (`vertexCount`, `canUndo`). `apply_ops` takes 4 arguments from Task 4 onward and Task 4 step 1 explicitly updates the earlier call sites. `SknSceneHandle` members used in Task 12 (`loadMesh`, `setSubmeshVisible`, `setIsolated`, `setSelection`, `pickAt`, `dispose`) are all declared in Task 8.
