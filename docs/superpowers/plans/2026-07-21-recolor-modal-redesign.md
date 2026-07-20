# Recolor Modal Redesign — Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox syntax.

**Goal:** Redesign `RecolorModal.tsx` to the Settings-modal look, replace the CSS-filter preview with an accurate per-pixel canvas render (so "preserve original color intensity" is visible), and add prev/next texture swapping in folder mode.

**Architecture:** Pure-TS pixel-op module (unit-tested) drives an offscreen canvas preview inside the modal. Folder mode enumerates all textures from the in-memory `fileTree` and decodes on demand. Controls become `SettingsRow` toggle rows; surfaces go glass.

**Tech Stack:** React 18 + TS, Vitest (frontend tests), design-lab CSS.

## Global Constraints

- No AI attribution in commits; short imperative / conventional-commit subjects (`feat:`/`fix:`).
- No backend/Rust changes. Preview is frontend-only; write path unchanged.
- Verify frontend with `npx tsc --noEmit`; run new unit tests with the repo's test runner.

---

### Task 1: Pixel-op module + tests

**Files:**
- Create: `src/lib/recolor/previewPixels.ts`
- Test: `src/lib/recolor/previewPixels.test.ts`

**Produces:**
- `applyHueShift(data: Uint8ClampedArray, hueDeg: number, sat: number, bright: number): void`
- `applyColorize(data: Uint8ClampedArray, targetHueDeg: number, preserveIntensity: boolean): void`
- `applyGrayscaleTint(data: Uint8ClampedArray, targetHueDeg: number): void`

All mutate an RGBA `Uint8ClampedArray` in place, preserving alpha, skipping fully-transparent pixels.

- [ ] Write failing tests: hueShift by 0° is identity; colorize sets all opaque pixels to the target hue while keeping distinct lightness; preserve=false lowers saturation vs preserve=true on a saturated pixel; alpha untouched.
- [ ] Run tests — expect fail (module missing).
- [ ] Implement `previewPixels.ts` with rgb↔hsv and rgb↔hsl helpers + the three ops.
- [ ] Run tests — expect pass.
- [ ] `npx tsc --noEmit`.
- [ ] Commit `feat(recolor): add per-pixel preview color ops`.

---

### Task 2: Canvas preview + texture swapping in the modal

**Files:**
- Modify: `src/components/modals/RecolorModal.tsx`

**Consumes:** Task 1 exports.

- [ ] Replace `folderImagePaths` (capped at 2) with a full texture-path list from the `fileTree` walk (drop the `>= 2` cap); add `previewIndex` state and a decode cache `Map<path,string>`.
- [ ] Add a `<canvas>` render: on `imageData`/mode/param/`showOriginal`/`previewIndex` change, draw the current PNG, apply the Task-1 op for the active mode (unless `showOriginal`), and paint the canvas. Remove `getPreviewStyle()` and the dual `<img>` block.
- [ ] Add the `‹ filename (i / total) ›` swap control (folder mode, >1 texture); arrows change `previewIndex` and lazily decode via `decodeDdsToPng` (cache-checked). Single-file mode shows no arrows.
- [ ] `npx tsc --noEmit`.
- [ ] Commit `feat(recolor): accurate canvas preview + swap previewed texture`.

---

### Task 3: Visual restyle

**Files:**
- Modify: `src/components/modals/RecolorModal.tsx` (controls → `SettingsRow` toggles)
- Modify: `src/styles/index.css` (`.recolor-modal__*` glass restyle + swap-control styles)

**Consumes:** `SettingsRow` from `./settings/SettingsRow`.

- [ ] Convert the three checkboxes to `SettingsRow` clickable toggle rows (icon + title + sub-line + a `dl-toggle`/`Checkbox`), matching Settings.
- [ ] Restyle `.recolor-modal__preview` frameless + dark translucent; restyle mode-hint and info/warning strips to translucent glass; add `.recolor-modal__swap*` styles.
- [ ] `npx tsc --noEmit`.
- [ ] Commit `feat(recolor): settings-modal glass restyle`.

---

## Self-review

- Spec §1 accurate preview → Task 1 + Task 2. §2 swap → Task 2. §3 restyle → Task 3. Covered.
- No placeholders; signatures consistent across tasks.
