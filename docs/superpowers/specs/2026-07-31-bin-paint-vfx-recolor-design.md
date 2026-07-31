# BIN Paint — VFX recolor panel

Date: 2026-07-31

A VFX recolor surface inside Flint's BIN editor, ported from Quartz's Paint page.
It swaps in over Monaco the same way the animation mask editor does, so a VFX BIN
can be recolored without leaving the editor.

## Placement

`BinEditor.tsx` gains a toolbar toggle beside the existing masks button (`◑`).
Toggling overlays the panel at `inset: 0; z-index: 40` inside the editor's
content wrapper — the slot the `MaskEditor` already occupies.

The toggle only renders when the BIN actually has something to paint. A cheap
probe `bin_has_vfx_systems` (one `read_bin`, scan entry class hashes for
`VfxSystemDefinitionData` / `StaticMaterialDef`, no projection) decides this,
mirroring `bin_has_animation_masks`. The probe effect is keyed on `filePath` and
resets both `hasVfx` and `paintOpen` on file change, so switching files can never
leave the panel open over a BIN with no systems.

Rationale for a swap panel over a new page: the owner's existing mental model for
"a structured editor on top of a BIN" is the mask editor, and the file is already
open, watched, and session-cached. A separate page would duplicate that plumbing.

## Backend

Three modules ported from `quartz-lib/src/paint/` into `crates/flint-bin/src/paint/`:

| Module | Responsibility |
|---|---|
| `model.rs` | Walk a `Bin` into systems/emitters/colors/materials; build the `EditIndex` of `NodePath`s back into the live tree |
| `recolor.rs` | Color math — HSL conversion, palette sampling, the six recolor modes |
| `session.rs` | Resident session registry, entry-granular COW undo/redo, save |

`flint-bin` already re-exports `ritoshark::bin::{Bin, BinEntry, BinType, BinValue}`
and owns `read_bin`/`write_bin`, so the tree-walking code ports with no type
adaptation.

### Single-bin simplification

Quartz's session resolves linked BINs, so its `NodePath` carries a `bin: usize`
and every key is bin-prefixed (`"0:1a2b3c4d"`). Flint's editor operates on one
file, so:

- `NodePath` drops the `bin` field; `resolve_mut` takes `&mut Bin`.
- `project_all(&[LoadedBin])` collapses to `project(&Bin)`.
- Entry keys are the bare path hash (`"1a2b3c4d"`), no bin prefix.
- The `linked_bins` dependency is gone entirely.

This removes the single largest porting obstacle. If linked-BIN recoloring is
wanted later, the `bin` field comes back — the `NodePath` indirection is
deliberately preserved so that change stays local to `model.rs`.

### Editable node shapes

A VFX color takes five shapes on disk, all of which the projection and the
writer must handle:

1. bare `vec4` (`color: vec4 = {...}`)
2. `ValueColor { constantValue: vec4 }`
3. `ValueColor { values: list[vec4] }`
4. `ValueColor { dynamics: { values, times } }` (pointer-nested)
5. `ValueColor { constantValue, dynamics: { values, times } }` — both at once

Keyframe order is always **constant first, then the `values` list in order**.
Every consumer (projection, recolor, the UI's swatch row) uses that one order.

Color slots are matched by field name in priority order, so a BIN using an alias
still resolves: `color`; `birthColor`; `fresnelColor` | `outlineColor`;
`lingerColor` | `SeparateLingerColor`.

### Undo

Entry-granular copy-on-write (`UndoFrame::capture`), capped at 50 frames. A
recolor clones only the top-level entries it touches, not the whole tree — that
is what keeps a click responsive on a large VFX BIN. A fresh edit clears the redo
stack. A no-op edit must report "nothing changed" rather than dirtying the
session and pushing an empty frame.

### Save

`paint_save` runs, in order:

1. Resolve the project root from the BIN path. If found, `create_checkpoint`
   with message `Paint: recolor <filename>`.
2. `write_bin` the resident tree to the file.
3. Delete the `<bin>.ritobin` sidecar.

Step 1 is skipped when the file is outside a project — Paint still saves, just
with no restore point. Step 3 is required: Paint writes the BIN directly, so a
stale sidecar would make Monaco show pre-recolor text on the next open. This is
the same invalidation `apply_loadscreen_banner` performs.

Checkpoints are project-wide, not per-file. That is heavier than a per-file
backup, but it reuses the restore UI (`CheckpointTimeline`) that already exists
and is the same tradeoff the Skin Fixer accepts.

### Commands

| Command | Purpose |
|---|---|
| `bin_has_vfx_systems` | Cheap presence probe for the toolbar toggle |
| `paint_open` | Open a BIN into a resident session; returns `{sessionId, model}` |
| `paint_close` | Drop the session, free the tree |
| `paint_recolor` | Recolor selected emitters' selected slots; returns changed count + refreshed colors for touched emitters only |
| `paint_set_material_param` | Set one static-material color param |
| `paint_set_blend_mode` | Set one emitter's `blendMode: u8` |
| `paint_undo` / `paint_redo` | Replay one frame; returns the refreshed model |
| `paint_save` | Checkpoint, write, invalidate sidecar |

`paint_recolor` returns only the touched emitters' colors rather than a whole
reprojection — O(selected), not O(file).

## Frontend

```
src/components/preview/paint/
  PaintPanel.tsx     panel shell, session lifecycle, toolbar, save
  SystemList.tsx     systems → emitters tree, selection, lock, expand
  PaletteBar.tsx     palette stops + mode select
  ColorSwatch.tsx    one keyframe swatch
src/lib/api/paint.ts        typed invoke wrappers
src/lib/paint/colorMath.ts  hex ↔ vec4, HSL (port of ColorHandler.ts)
```

Styled with the `.dl-*` design-lab classes, not Quartz's MUI/Emotion — pulling in
a second styling system for one panel is not worth it. Icons and glyphs are
centered by their container's flex layout, never by pixel nudges.

The session is opened when the panel first mounts and closed on unmount. Closing
the panel with unsaved edits keeps the session alive until the editor unmounts,
so toggling the panel off and on does not lose work.

## Scope

**In:** system/emitter tree with multi-select, search filter, lock,
expand/collapse; six recolor modes (random, random-keyframe, linear, shift,
shift-hue, materials); palette manager with stops; LC/OC/BC/Color target toggles;
blend-mode select and "Select BM *n*"; material color params; ignore-black/white
and preserve-alpha; undo/redo; save.

**Out (deliberately):** emitter texture path rewriting; the per-keyframe alpha
editor; color filter and tolerance; saved-palette persistence; the Minecraft
skin.

## Testing

Quartz's `edit_tests` module ports across — it is the load-bearing part of the
port. Those tests build synthetic BINs on disk covering all five color shapes and
assert that an edit reaches the **bytes**, survives a save/reopen round-trip, and
replays byte-exact through undo and redo. That is what catches a writer which
silently no-ops on one shape while appearing to work on the others.

Specific cases carried over:

- every color shape is written (guards a shape-blind writer)
- edits survive save + reopen (guards "it didn't save")
- RGB preserved on alpha-only edits; alpha preserved under `preserve_alpha`
- a no-op edit pushes no undo frame and mutates no bytes
- undo/redo byte-exact, including two different edit kinds interleaved
- saving a clean session writes nothing
- undo back to pristine then save restores the original file bytes

Verification: `cargo test -p flint-bin`,
`cargo clippy --lib --bins -- -D warnings -A clippy::needless_return`,
`npx tsc --noEmit`. Never a standalone `cargo build` (it wipes the incremental
cache the Tauri dev server depends on).
