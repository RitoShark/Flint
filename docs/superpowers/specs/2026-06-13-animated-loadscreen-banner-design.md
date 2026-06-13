# Animated Loadscreen Banner — Design

**Date:** 2026-06-13
**Status:** Shipped — see **As-built deviations** below; this doc is the original
design and several decisions changed during implementation.

## As-built deviations (2026-06-14)

The authoritative current behavior lives in `CLAUDE.md` (Animated Loadscreen
Banner + the two Mask sections). Key differences from this original design:

- **Mask convention is "paint to protect", not "paint = VFX".** In the shader,
  blue HIGH = VFX shows. The artist authors by painting the CHAMPION to keep it
  clean, so the editor's brush **masks out** (drives blue DOWN to 0) and the
  eraser **restores** (drives blue UP to 255). A fresh mask starts **blue = 255
  everywhere** (whole banner glows), not black. Tool buttons are **"Mask out" /
  "Restore"**; the overlay highlights the protected (low-blue) region in red. The
  loadscreen backdrop is shown at **full** opacity, the paint overlay at 40%.
- **Mask is the bundled base's NATIVE size (616×1120) with R/G copied VERBATIM**
  from the bundle (the secondary-VFX scroll pattern), NOT resized to the
  loadscreen. Only the blue channel varies. It's a tiling/pattern texture, not
  pixel-aligned to the loadscreen. A real reference mask is bundled at
  `src-tauri/resources/banner-mask-base.tex`.
- **Mask format is BC7**, not uncompressed `Bgra8` (the reference masks ship as
  BC7; `encode_mask_tex` preserves the existing file's format).
- **BIN injection builds the `StaticMaterialDef` directly as a `BinEntry` tree**
  (`prop(name, value)` + `fnv1a_32`), NOT a ritobin-text template + `text_to_tree`
  merge. Same approach as `inject_animation_block`.
- **The link is inserted after the LAST loadscreen variant field** (`loadScreen`/
  `loadScreenVintage`/`loadScreenShade`/`loadScreenExalted`) so it lands before
  `skinAudioProperties`.
- **The "Re-apply Banner Preset" menu item was removed** — it only existed to
  upgrade black masks made by pre-fix builds, which won't exist in prod. Clicking
  "Add Animated Loadscreen Banner" when already applied just opens the editor.
- `apply_loadscreen_banner` takes a `rebuild_mask: bool` flag (default true);
  the editor's params-only save passes `false` so it never clobbers the mask
  being painted.
- Brush size / hardness / opacity persist in localStorage; quick-adjust uses a
  pinned red ring (no Pointer Lock, to avoid the WebView "press Esc" banner).

## Summary

A project-level preset that turns a skin's static loadscreen image into an
**animated VFX banner**. Flint injects a known `StaticMaterialDef` shader block
into the project's main skin BIN, links it to the loadscreen, creates a mask
`.tex`, and opens a **mask-painting modal** where the user paints (over a dimmed
copy of the loadscreen) the region where the animated effect should show.

The effect is the "UI BaseShader" animated-banner material League uses for
animated splash/loadscreen art. The painted mask drives the secondary-VFX
blue-channel mask (`UI_SECONDARY_B_MASK` family of params): **where painted =
VFX shows**.

## User-facing behavior

Two entry points:

1. **Project root → right-click → "Add Animated Loadscreen Banner"**
   - If the project has no loadscreen image → blocked with a toast.
   - If the banner is already applied → opens the mask editor directly
     (re-editing is the common, non-destructive path). A **separate**
     "Re-apply Banner Preset" menu item (confirm-gated) resets the shader
     params to defaults while keeping the painted mask. *(Implementation note:
     the shared `ConfirmDialog` only supports one `onConfirm` action — cancel
     just closes — so the spec's single three-button dialog became
     "open-editor by default" + a separate confirm-gated re-apply item.)*
   - Otherwise: injects the material into the main BIN, creates an empty
     (all-black) mask `.tex` the same size as the loadscreen, then opens the
     mask editor modal.

2. **Right-click a `*-mask.tex` → "Edit Loadscreen Banner Mask"**
   - Opens the mask editor directly on that mask. No BIN injection.

### Mask editor modal

- Backdrop: the skin's `loadscreen.image`, decoded to PNG, drawn dimmed
  (~35% opacity) under the paint canvas as a tracing reference.
- Canvas: same resolution as the loadscreen. Starts black (nothing showing);
  the user paints in the VFX region.
- Brush tools (v1): **brush + eraser**, with **size / hardness / opacity**
  sliders, a brush-ring cursor, and undo/redo.
- A small side panel of **preset sliders** (a handful of the most useful shader
  params, e.g. shine strength, scroll speed, tint color) — changing these
  re-writes only the material's `paramValues` in the BIN, never the mask.
- Save writes the painted **blue channel** into the mask `.tex`.

## Channel semantics (confirmed)

- The user's brush intensity is written into the **BLUE channel only** of the
  mask `.tex`. R and G are fixed at 0, A fixed at 255 on save.
- The shader reads the blue channel as the secondary-VFX mask
  (`UI_Secondary_B_*` / `UI_SECONDARY_B_MASK_*`). Where blue > 0 → VFX shows.

## Mask file (confirmed)

- Created at the **same width×height as the loadscreen** `.tex`.
- **Starts empty (all black, blue = 0).**
- Encoded as **uncompressed RGBA8 (`Bgra8`) `.tex`** — lossless blue gradients,
  no BC block artifacts.
- Path: alongside the loadscreen in the project assets, suffixed `-mask.tex`,
  e.g. `…/evelynni-port/evelynnLoadScreen-mask.tex`. Real disk location:
  `content/base/<champ>.wad.client/assets/<creator>/<project>/…-mask.tex`.
  BIN reference path: `ASSETS/<creator>/<project>/…-mask.tex`.

## BIN injection (Approach A — ritobin-text template + `text_to_tree` merge)

The preset is stored as a **ritobin text template** (the `StaticMaterialDef`
block) with placeholders, substituted at apply time, parsed via the existing
`flint_ltk::bin::ltk_bridge::text_to_tree`, then **structurally merged** into the
real `Bin`.

### Placeholders

- `{{MATERIAL_NAME}}` — `"<Champion>/<Project>/Materials/<Project>_Animated_Banner"`
  (the `StaticMaterialDef.name` string).
- `{{MASK_PATH}}` — `ASSETS/<creator>/<project>/…-mask.tex` (the
  `samplerValues[0].texturePath`).
- The exposed slider values (shine strength, scroll speed, tint, …) — injected
  into their `StaticMaterialShaderParamDef.value` lines.

### Material link hash

The skin entry references the material by hash:
`0xeda7817e: link = <hash>`, where `<hash> = fnv1a_lower({{MATERIAL_NAME}})`
(FNV-1a 32-bit of the **lowercased** material name — the same hashing
`bin/split.rs::fnv1a_lower` already uses for class/object-path hashes). The
material entry's own root key (`entries` map key) is that same hash.

`0xeda7817e` is the (currently un-named-in-dictionary) `SkinCharacterDataProperties`
field that points the loadscreen at a material override. We write it as a literal
hash field — no resolved name required.

### Merge algorithm (`apply_banner_to_bin`)

Inputs: `&mut Bin` (the main skin BIN, already read), substituted preset text,
material hash.

1. Parse the substituted preset → a `Bin` holding the single `StaticMaterialDef`
   entry (keyed by `material_hash`).
2. In the target BIN, find the **root entry whose `class_hash` ==
   `SkinCharacterDataProperties`** (FNV of `SkinCharacterDataProperties`).
   - If absent → error (do not inject a dangling material).
3. Add/replace the field `0xeda7817e` on that entry → `BinValue::Link(material_hash)`.
4. Append (or replace by key) the `StaticMaterialDef` entry into `bin.entries`.
   Idempotent: a second apply must not duplicate the entry or the field.
5. Caller serializes via `write_bin` and writes to disk **atomically**
   (temp file + rename) so a failure can't corrupt the skin BIN.

`banner_status(bin) -> { applied: bool, material_hash, mask_path }`:
detects whether the `0xeda7817e` link + matching `StaticMaterialDef` entry exist,
and reads the mask path back out of `samplerValues[0].texturePath`.

## Architecture & components

### Backend (Rust)

- **`flint-ltk` engine module `loadscreen_banner`** (pure, unit-tested):
  - `PRESET_TEMPLATE` (the ritobin text const, from the user's reference block).
  - `substitute(params) -> String`.
  - `fnv1a_lower(s) -> u32` (shared with split.rs — lift to a common spot or
    re-expose; do **not** silently duplicate divergent copies).
  - `apply_banner_to_bin(bin, params) -> Result<()>` and
    `banner_status(bin) -> BannerStatus`.
- **`commands/editor/loadscreen_banner.rs`** — thin Tauri commands:
  - `get_loadscreen_banner_info(project_path) ->
    { loadscreen_image_path, loadscreen_exists, mask_path, material_name, applied }`.
    Resolves the loadscreen `.tex` to a real disk path (project meta gives
    champion/skin_id/creator; `find_main_skin_bin` locates the BIN; the
    `loadscreen.image` field gives the asset path → disk path).
  - `apply_loadscreen_banner(project_path, params, update_params_only: bool) ->
    { mask_path, width, height }`. Creates the black mask `.tex` (sized to the
    loadscreen) if missing, runs the merge (or params-only rewrite), writes BIN.
  - `save_banner_mask(project_path, mask_path, rgba, width, height)` — blue-only
    RGBA8 → `.tex` via `ritoshark::tex::Texture::from_rgba_bgra8`, write to disk.
    Raw-bytes IPC (mirrors `save_painted_texture`).

### Frontend (TypeScript / React)

- **`components/modals/LoadscreenBannerModal.tsx`** — the mask editor. Uses the
  **design-lab `.dl-*`** system (the current Flint look): portal to
  `document.body`, `.dl-modal-backdrop` > `.dl-modal--large`, `.dl-btn*`,
  `.dl-row`, etc. (per CLAUDE.md styling rule).
- **`lib/maskPaint.ts`** — flat-2D, single-channel (blue) adaptation of the
  existing `lib/babylon/paintEngine.ts` math (`stampMask` + `falloff` reused;
  composite targets the B channel only; eraser drives B→0). Unit-tested.
- **`lib/api/loadscreenBanner.ts`** — the three command bindings + types.
- **`lib/editor/fileContextMenuOptions.ts`** — two new menu entries:
  - project-root (depth 0): "Add Animated Loadscreen Banner".
  - `.tex` files matching `*-mask.tex`: "Edit Loadscreen Banner Mask".
- **`lib/types.ts`** `ModalType` += `'loadscreenBanner'`; **`App.tsx`** dispatcher
  case → `<LoadscreenBannerModal />`; modal options carry
  `{ projectPath, maskPath? }`.
- Re-apply confirm dialog uses the existing `openConfirmDialog` (design-lab).

## Data flow

**Apply:** context menu → `get_loadscreen_banner_info` → (guard: loadscreen
exists; guard: applied → confirm dialog) → `apply_loadscreen_banner` →
open modal → decode loadscreen (dim backdrop) + decode mask (current blue) →
paint → `save_banner_mask` → hot-reload watcher refreshes the preview.

**Slider change:** `apply_loadscreen_banner(update_params_only: true)` — rewrites
only `paramValues`, mask untouched.

**Re-edit:** context menu on `*-mask.tex` → derive project →
`get_loadscreen_banner_info` → open modal directly.

## Error handling

- No / unresolvable loadscreen image → blocked, clear toast.
- `find_main_skin_bin` → None → error toast, no writes.
- `SkinCharacterDataProperties` entry missing → error toast, no injection.
- BIN written atomically (temp + rename).
- Re-apply preserves existing mask pixels (params-only rewrite).

## Testing

- **flint-ltk unit tests:** substitution → valid ritobin; `text_to_tree` parses
  it; `fnv1a_lower(material_name)` matches expected; `apply_banner_to_bin` adds
  exactly one entry + one field and is idempotent; `banner_status` round-trips
  applied/not-applied and reads back the mask path.
- **`maskPaint.ts` vitest:** blue-only composite; eraser drives B→0; R/G
  untouched; coverage MAX (no buildup), mirroring `paintEngine.test.ts`.

## Scope (v1) / YAGNI

- In: the two entry points, mask paint (brush+eraser, size/hardness/opacity,
  undo/redo), a small set of preset sliders, RGBA8 mask `.tex`, idempotent BIN
  merge.
- Out (later): 3D/UV projection painting, full param editor, BC3 mask option,
  multiple banner presets, animated preview of the running shader in-app.

## Key references (existing code reused)

- Paint math: `src/lib/babylon/paintEngine.ts` (+ `paintEngine.test.ts`).
- Tex decode: `decode_bytes_to_png` / `decode_texture_file_sync`
  (`commands/assets/file.rs`).
- Tex encode (RGBA8→tex): `Texture::from_rgba_bgra8`
  (`commands/assets/texture_convert.rs`).
- BIN read/write/parse: `flint_ltk::bin::ltk_bridge::{read_bin, write_bin,
  text_to_tree}`; types `Bin`/`BinEntry`/`BinValue`.
- FNV-1a 32: `flint_ltk::bin::split::fnv1a_lower`.
- Main BIN lookup: `flint_ltk::repath::organizer::find_main_skin_bin`.
- Save-painted-texture precedent: `save_painted_texture` (map preview).
- Context menu: `src/lib/editor/fileContextMenuOptions.ts` (project-root gate
  `depth === 0 && projectPath`; `.tex` ext branch).
- Styling: `src/styles/design-lab.css` (`.dl-*`).
