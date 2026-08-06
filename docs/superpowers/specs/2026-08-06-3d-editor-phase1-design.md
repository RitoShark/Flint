# 3D Editor — Phase 1: Editor Shell + Mesh Editing — Design

**Date:** 2026-08-06
**Status:** Approved

## Problem

Flint can *view* a `.skn` but cannot edit one. The model preview
(`src/components/preview/ModelPreview.tsx`) renders the mesh, resolves textures, draws the
skeleton and plays `.anm` clips — all read-only, all inside a preview pane sized for a
sidebar. There is no way to rename a submesh, duplicate one, move geometry between skins,
inspect a joint's transform, or work on a model at full screen.

The broader goal is a real 3D editor: weight painting, bone renaming, animation-layer
keyframe editing, and sequencer-driven clip playback. That is five independent subsystems,
and shipping them as one change is not implementable. This document specifies **Phase 1**
only — the window, the scene architecture everything else hangs on, and complete submesh
editing — and records the phase roadmap so later specs have a fixed frame.

## Goal

A dedicated 3D Editor window, opened by right-clicking a `.skn`, that presents the model at
full size with an outliner, an inspector, and viewport selection, and that can rename,
duplicate, delete, reorder and copy-paste submeshes and write the result back to the `.skn`.

Explicitly **not** in Phase 1: weight painting, bone renaming, animation editing, sequencer
playback, mesh creation, sculpting, vertex-level editing, UV editing.

## Phase roadmap

Each phase is independently shippable and gets its own spec and plan.

| Phase | Delivers |
|---|---|
| **1 (this doc)** | Editor window, `SknScene` extraction, outliner, inspector, viewport picking, `ModelEditSession` with submesh rename / duplicate / delete / reorder / copy-paste, Save |
| **2** | Sequencer & playback — clip-graph parse (`SequencerClipData` → ordered `mClipNameList`), timeline UI, chained playback, event markers |
| **3** | Name propagation — bone rename (`.skl` write, `.anm` track re-hash, BIN reference rewrite) and submesh-name references in the skin BIN, with an impact report |
| **4** | Weight painting — brush on `bone_weights`/`bone_indices`, normalization, per-bone heatmap, write to `.skn` |
| **5** | Animation layers — pose + keyframe editing, override/additive layers with per-bone masks, flatten to `.anm` |

**Why bone rename is not in Phase 1.** `.anm` tracks are keyed by the ELF hash of the joint
name (`rs_hash::elf_lower`), and BINs reference bones by FNV1a-32 of the name —
`ParticleEventDataPair.mBoneName`/`mTargetBoneName`, `JointSnapEventData.mJointNameToOverride`/
`mJointNameToSnapTo`, `SpringPhysicsEventData.SpringToAffect`. Renaming a joint in the `.skl`
alone silently breaks every one of those. Doing it safely *is* the propagation engine, so it
is its own phase. Phase 1's skeleton tree is select / inspect / filter only, with no writes.

## What already exists

Phase 1 is mostly assembly. The pieces in place:

- **Renderer** — Babylon. `src/lib/babylon/`: `meshBuilder.ts` (builds **one Babylon `Mesh`
  per material range**, named by submesh — so picking, per-submesh visibility and isolate are
  nearly free), `skeletonBuilder.ts` (lines / octahedrons / joint markers / `buildBabylonSkeleton`),
  `animationPlayer.ts`, `submeshVisibility.ts`, `cameraFraming.ts`, `engine.ts`.
- **Backend** — `src-tauri/crates/flint-core/src/mesh/`: `skn.rs`, `skl.rs`, `animation.rs`,
  `texture.rs`, `wire.rs` (the `[u32 meta_len][meta JSON][buffers]` binary IPC format),
  `submesh_visibility.rs`. Commands in `src-tauri/src/commands/assets/mesh.rs`.
- **Library** — `rs_mesh` (`SkinnedMesh`, `SkinnedMeshRange`, `SkinnedMeshVertex`, byte-exact
  `read.rs`/`write.rs`) and `rs_anim` (`Skeleton`, `Animation`, `Pose`, `skeleton_write.rs`,
  `animation_write.rs`). **No library work is needed for Phase 1** — SKN read+write is complete
  and round-trips byte-for-byte for versions 1, 2 and 4.
- **Multi-window** — `src-tauri/src/commands/project/map_preview.rs::open_map_preview_window`
  is the working template.
- **Session/undo precedent** — `src-tauri/src/commands/wad/wad_edit.rs` (staged deltas over a
  pristine parse, plus the post-save re-parse rule).

## Architecture

### Decision: extract a headless scene controller

`ModelPreview.tsx` is 1905 lines and roughly 18 `useEffect`s, all coupled to its own settings
popups and preview-pane assumptions. Three options were considered:

- **Mount `<ModelPreview>` inside the editor window as-is.** Fastest to a running window, but
  its toolbar and settings fight the editor chrome and it offers no seam for selection
  highlighting or the weight-paint overlay Phase 4 needs. It would be forked anyway.
- **Fork a standalone editor viewport.** Total freedom, two drifting copies of the texture,
  skybox, framing and skeleton code. The CLAUDE.md notes on that file exist because those bugs
  were expensive to find; a fork guarantees rediscovering them.
- **Extract a shared controller (chosen).**

New module `src/lib/babylon/sknScene.ts` — a headless controller owning engine, camera,
lights, skybox, grid/floor, materials + textures, mesh build, skeleton overlay and the
`AnimationPlayer` wiring, lifted from `ModelPreview`'s effects without behaviour change:

```ts
createSknScene(canvas: HTMLCanvasElement, opts): SknSceneHandle

interface SknSceneHandle {
    loadMesh(mesh: SknMeshData, skeleton: SklData | null): Promise<void>;
    setSubmeshVisible(name: string, visible: boolean): void;
    setIsolated(name: string | null): void;
    setWireframe(on: boolean): void;
    setSkeletonOverlay(mode: 'off' | 'lines' | 'octahedrons' | 'joints'): void;
    setSelection(sel: Selection | null): void;
    frameCamera(): void;
    pickAt(x: number, y: number): string | null;   // → submesh name
    renameSubmesh(oldName: string, newName: string): void;
    dispose(): void;
}
```

`ModelPreview` then becomes React chrome over the controller, and the editor window mounts the
same controller with different chrome. The skybox face order (`[px, py, pz, nx, ny, nz]` — the
array position alone decides the GPU face when the files are blob URLs), the framing-once rule,
`safeDisposeSkeletonViewer` and the texture-resolution path all live in exactly one place.

**Behaviour-preservation constraint.** The extraction ships as its own commit, verified against
the preview pane before any editor code is written. Three documented contracts must survive it:
the `.skn`/`.anm` no-remount rule (`SkinnedPreview` keeps the mounted spelling via `isSamePath`;
`ModelPreview`'s mesh-load effect must not depend on `initialAnimation`/`autoPlay`), the
one-frame WebGL context gap on viewer swaps, and framing-once-at-load. All three live in
`SkinnedPreview`/`PreviewPanel` *above* `ModelPreview`, so the extraction should not disturb
them — but they are the regression to watch for.

### Window

Command `open_model_editor_window(sknPath, projectPath)` in a new
`src-tauri/src/commands/project/model_editor.rs`, modeled directly on `open_map_preview_window`:

- Reuse by label — if the window exists, focus it and emit a load event rather than creating a
  second one.
- URL `index.html#model-editor?<urlencoded params>`.
- On Windows, set **both** `.additional_browser_args(MAIN_BROWSER_ARGS)` (must stay identical to
  `tauri.conf.json`'s `additionalBrowserArgs`) **and** a unique
  `.data_directory(app_data_dir/webview-model-editor)`. Without the unique data dir a second
  WebView2 fails with `0x8007139F`.
- Label `model-editor` added to the `windows` array in `src-tauri/capabilities/default.json`.
- Frontend bootstrap: `src/main.tsx` detects `window.location.hash.startsWith('#model-editor')`
  and mounts a standalone root **without StrictMode**, matching the map-preview and thumbnail
  branches.

**One reusable window, not one per file.** Each extra WebView2 costs a full browser process and
its own data directory. Opening a different `.skn` while the editor is open swaps the loaded
file; if the session is dirty, it prompts (Save / Discard / Cancel) first.

**State is re-derived from URL params and disk. No zustand is shared across windows** — the
ecosystem rule for secondary windows. The editor window owns its own store instance.

### Entry point

A "Open in 3D Editor" context-menu item for `.skn` files in:

- `src/components/browser/FileTree.tsx` (project tree)
- `src/components/preview/FolderGridView.tsx` (folder grid)

Not in the WAD Explorer: WAD chunks are not files on disk and the edit session needs a real
path. Opening a `.skn` from a WAD means extracting it into a project first, which is the
existing workflow.

### `ModelEditSession` (Rust)

New `src-tauri/src/commands/editor/model_edit.rs` plus the session logic in
`flint-core/src/mesh/edit.rs` (so it is unit-testable without Tauri).

State mirrors `wad_edit.rs`: a `Mutex<HashMap<ModelSessionId, ModelSession>>` in Tauri managed
state. A session holds the **pristine** parse plus a staged op log:

```rust
pub struct ModelSession {
    source_path: PathBuf,
    pristine: SkinnedMesh,          // rs_mesh, never mutated
    skeleton: Option<Skeleton>,     // rs_anim, read-only in Phase 1
    ops: Vec<ModelEdit>,
    cursor: usize,                  // undo/redo position within `ops`
}

pub enum ModelEdit {
    RenameSubmesh { index: usize, name: String },
    DuplicateSubmesh { index: usize, name: String },
    DeleteSubmesh { index: usize },
    ReorderSubmesh { from: usize, to: usize },
    PasteSubmesh { source_skn: PathBuf, source_index: usize, name: String },
}
```

**Undo/redo is a cursor into `ops`**, replayed over `pristine` — not an inverse-op stack. Every
derive is a fresh fold from the original parse, so there is no drift and no inverse-op to get
wrong. Replay is cheap: these ops touch ranges and buffers, not per-vertex work, and a `.skn`
is a few MB.

Commands:

| Command | Behaviour |
|---|---|
| `open_model_session(skn_path)` | Parse SKN + resolve/parse SKL, return `{ session_id, mesh_payload, skeleton }` |
| `stage_model_edit(session_id, edit)` | Push op at cursor (truncating any redo tail), return the new derived summary |
| `undo_model_edit` / `redo_model_edit` | Move the cursor, return the derived summary |
| `derive_model_mesh(session_id)` | Current derived mesh in the `wire.rs` binary format, for viewport reload |
| `save_model_session(session_id, dest?)` | Apply ops, write `.skn`, **re-parse the written file into the session**, clear `ops` |
| `close_model_session(session_id)` | Drop it |

**The post-save re-parse is not optional.** The WAD editor shipped a bug where an in-place save
rewrote the file while the session kept the old TOC, and every later read of an untouched chunk
seeked to a stale offset. The same shape applies here: after writing, re-parse from disk into
`pristine`, clear `ops`, and re-point `source_path` at the output.

Only `derive_model_mesh` returns bulk geometry, and it uses the existing binary wire format
(`[u32 meta_len][meta JSON][pad][positions][normals][uvs][indices][bone_weights][bone_indices]`)
via `tauri::ipc::Response`. Op staging returns a small JSON summary (submesh names, counts,
bounds, dirty flag) — not the buffers. The viewport only reloads geometry for ops that change
it (duplicate, delete, paste); a rename or reorder updates names in place via
`SknSceneHandle.renameSubmesh`.

### Cross-file copy-paste

Copy-paste of a submesh between two different `.skn` files is the one op that must be Rust,
because merging vertex and index buffers means remapping bone indices:

1. Append the source range's vertices to the destination vertex buffer.
2. For each vertex, resolve `bone_indices[i]` through the **source** skeleton's `influences`
   table to a real joint id, look that joint up **by name** in the destination skeleton, and
   re-encode as a destination influence index — appending to the destination `influences` list
   when the joint is present in the destination skeleton but not yet in its influence table.
3. If a source joint has no name match in the destination skeleton, the paste fails with a
   report naming the missing joints. It does not silently zero the weight — that produces
   geometry welded to the origin, which looks like a renderer bug.
4. Rebase the copied indices onto the new vertex start and append a new `SkinnedMeshRange`.
5. Recompute `bounding_box` and `bounding_sphere` over the merged vertex set.

**Pasted geometry carries its material name only.** A `.skn` stores a material *name* per
range; the material itself lives in the skin BIN. So the paste reports "material `<name>` is not
defined in this skin's BIN — wire it up in the BIN editor" rather than pretending to move a
material it cannot see. The submesh renders untextured until that is done.

Clipboard state (source path + range index + name) lives in the editor window's store. It is
in-window only in Phase 1 — no cross-window or OS clipboard integration.

### Layout

```
┌─ Top bar ──────────────────────────────────────────────────────────┐
│ Aatrox.skn ●   [Save] [Save As]  [↶] [↷]   ⟨Mesh⟩ ⟨Weights⟩ ⟨Anim⟩ │
├──────────────┬──────────────────────────────────┬──────────────────┤
│  OUTLINER    │                                  │   INSPECTOR      │
│              │                                  │                  │
│ ▾ Meshes     │            Viewport              │  Submesh: Body   │
│   👁 Body     │          (SknScene)              │  Material: Body  │
│   👁 Weapon   │                                  │  Verts:   3,412  │
│   👁 Cape     │                                  │  Tris:    5,120  │
│              │                                  │  Bounds:  …      │
│ ▾ Skeleton   │                                  │                  │
│   Root       │                                  │                  │
│    └ Spine   │                                  │                  │
├──────────────┴──────────────────────────────────┴──────────────────┤
│ 3 submeshes · 12,204 verts · 61 joints                             │
└────────────────────────────────────────────────────────────────────┘
```

The `Weights` and `Anim` mode tabs are rendered **disabled** in Phase 1, so the shell's shape is
visible without faking behaviour.

**Outliner — Meshes tree.** Per row: visibility toggle, name (F2 or double-click to rename
inline), context menu (Rename, Duplicate, Delete, Copy, Paste, Isolate). Drag to reorder uses
`src/lib/pointerDrag.ts` — **not** HTML5 drag-and-drop, which WebView2's native OS drag-drop
blocks inside the webview.

**Outliner — Skeleton tree.** Joint hierarchy from `SklData.bones` (`parent_id` = -1 is a root),
with a name filter, expand/collapse, and selection synced with the viewport's bone overlay.
Read-only in Phase 1.

**Inspector.** Submesh selected: name, material name, vertex count, triangle count, index range,
per-submesh bounds, and whether a texture resolved. Joint selected: name, id, parent, local
translation / rotation (quaternion, shown as Euler) / scale, bind-pose world position, and its
index in the `influences` table if present.

**Selection.** `pickAt` on viewport click maps the hit Babylon mesh back to its submesh name;
selecting in the outliner highlights in the viewport. Highlight is an emissive tint on the
selected mesh's material — not a Babylon `HighlightLayer`, which is a full-screen post-process
and costs more than this needs.

### Rename validation

Submesh names are the key the skin BIN uses to reference geometry (and FNV1a-32 of the lowercased
name is what submesh-visibility events match on). A rename therefore:

- rejects empty names and duplicates within the same `.skn`;
- warns — does not block — when the old name appears in the project's skin BIN, listing where.
  Rewriting those BIN references is the same propagation problem as bone rename, and lands with
  it in Phase 3.

## Data flow

```
FileTree right-click .skn
  → open_model_editor_window(sknPath, projectPath)          [Rust]
  → new WebView2, index.html#model-editor?path=…&project=…
  → main.tsx mounts <ModelEditorWindow>                     [no StrictMode]
  → open_model_session(sknPath)                             [Rust]
      ├→ mesh payload (binary wire format) ─→ createSknScene().loadMesh()
      └→ SklData (JSON)                    ─→ skeleton tree + bone overlay

edit (rename / duplicate / delete / reorder / paste)
  → stage_model_edit(session_id, edit)                      [Rust]
  → summary ─→ outliner + inspector update
  → (geometry-changing ops only) derive_model_mesh ─→ loadMesh()

Save
  → save_model_session(session_id)                          [Rust]
  → write .skn → re-parse from disk into session → clear ops
  → toast + clear dirty flag
```

## Error handling

| Case | Behaviour |
|---|---|
| `.skn` fails to parse | Window opens showing the parse error and the path, not a blank canvas |
| No `.skl` resolves (skeleton-less mesh) | Mesh loads; skeleton tree and bone overlay are disabled with an explanatory note. Not an error |
| Textures fail to resolve | Existing `texture_warning` path — mesh renders untextured with the warning surfaced |
| Paste from a `.skn` with unmatched joints | Paste rejected, missing joint names listed |
| Save fails (permissions, disk) | Session stays dirty and unchanged; error toast with the OS message |
| Second `.skn` opened while dirty | Prompt Save / Discard / Cancel before swapping |
| Window closed while dirty | Same prompt, close cancellable |

## Testing

**Rust (`flint-core`, unit):**
- A session with zero staged ops saves **byte-identical** output to the source file.
- Rename round-trips: stage, save, re-read, name matches.
- Duplicate produces a valid range — non-overlapping vertex/index spans, correct counts, mesh
  re-parses.
- Delete removes the range and compacts the buffers without corrupting the remaining ranges'
  starts.
- Reorder changes range order without touching vertex data.
- Cross-file paste remaps bone indices correctly through both `influences` tables (fixture with
  a known joint layout), and fails with named joints when a source joint is absent in the
  destination skeleton.
- Undo/redo cursor: stage three ops, undo twice, redo once, derived state equals staging just
  the first two.

**TypeScript (vitest):**
- Op-log store: staging after an undo truncates the redo tail; dirty flag tracks the cursor.
- Outliner tree model: `bones[]` with `parent_id` folds into the correct hierarchy, including
  multiple roots and out-of-order parents.
- Rename validation: empty and duplicate names rejected.

**Not unit-tested:** the Babylon scene itself, consistent with the repo — `cameraFraming` and
`submeshVisibility` have tests, the scene does not. The `SknScene` extraction is verified by
exercising the existing preview pane before the editor is built on it.

## Files

**New**
- `src/lib/babylon/sknScene.ts` — headless scene controller
- `src/components/editor3d/ModelEditorWindow.tsx` — window root
- `src/components/editor3d/Outliner.tsx` — mesh + skeleton trees
- `src/components/editor3d/Inspector.tsx` — selection properties
- `src/components/editor3d/EditorViewport.tsx` — canvas + `SknScene` lifecycle
- `src/lib/stores/modelEditorStore.ts` — op log, selection, clipboard, dirty state
- `src/lib/api/modelEdit.ts` — command wrappers
- `src/styles/modelEditor.css` — window styles (own file, not `index.css`)
- `src-tauri/src/commands/project/model_editor.rs` — `open_model_editor_window`
- `src-tauri/src/commands/editor/model_edit.rs` — session commands
- `src-tauri/crates/flint-core/src/mesh/edit.rs` — session logic + ops + tests

**Modified**
- `src/components/preview/ModelPreview.tsx` — re-based on `sknScene.ts`
- `src/components/browser/FileTree.tsx`, `src/components/preview/FolderGridView.tsx` — context item
- `src/main.tsx` — `#model-editor` bootstrap
- `src-tauri/capabilities/default.json` — `model-editor` label
- `src-tauri/src/main.rs` — command registration
- `CLAUDE.md` — record the window pattern's second user and any new verified facts

## Open questions deferred to later phases

- Phase 2 will need the animation-BIN clip graph (`SequencerClipData`, `AtomicClipData`,
  `mClipNameList`, `mEventDataMap`). `flint-core/src/mesh/submesh_visibility.rs` already parses
  the event-data map for visibility events, and the reference artifact from
  `2026-08-05-animation-bin-schema-aggregator-design.md` documents the class shapes. Neither
  parses the clip *graph* yet.
- Phase 2 renders no particles. `ParticleEventData` and `SoundEventData` will appear as timeline
  markers; `.troy` effects will not render, since Flint's viewer has no VFX system.
- Phase 3's BIN reference rewrite can likely reuse the tree-walk in
  `flint-core/src/repath/refather.rs`, which already rewrites string values across a whole BIN.
