# Recolor Modal Redesign — Design

## Goal

Bring the Recolor Texture / Batch Recolor Folder modal (`RecolorModal.tsx`, one
component for both modes) up to the same design-lab / Settings-modal visual
language, fix the misleading preview, and let users swap which texture the
modal previews in folder mode.

## Problems being solved

1. **Dated visuals.** The modal predates the Settings-modal redesign: bare
   `Checkbox`es, solid grey `bg-tertiary` hint/tab boxes, a hard-bordered
   preview. It should read as the same system as Settings (frameless
   translucent surfaces, `SettingsRow`-style toggle rows).
2. **"Preserve original color intensity" does nothing visible on the preview.**
   The preview uses a rough CSS `filter` chain
   (`grayscale→sepia→saturate→hue-rotate`) that only nudges saturation `1`↔`0.8`
   between preserve on/off — it does not resemble the real per-pixel recolor,
   so the checkbox appears to have no effect.
3. **No way to swap the previewed texture.** Folder mode auto-picks the first
   two textures and shows them fixed side-by-side; users can't check the effect
   on a specific texture in the batch.

## Approach

### 1. Accurate preview — canvas pixel replicate (decided)

Replace the CSS-`filter` fake with a real per-pixel render on an offscreen
`<canvas>`:

- Draw the loaded PNG, `getImageData`, apply the recolor math in JS per pixel,
  `putImageData`, and show the canvas.
- **hueShift**: per pixel → HSV, `H = (H + hue) mod 360`, `S *= saturation`,
  `V *= brightness` (clamped).
- **colorize**: per pixel → HSL, set `H = targetHue`, keep `L` (shading/detail
  preserved). `S = original S` when **preserve original color intensity is ON**;
  `S = min(originalS, 0.6)`-style reduced constant when OFF. This makes the
  checkbox visibly change the preview.
- **grayscale + tint**: `L` from luminance (Rec. 601), apply `targetHue` as a
  low-saturation tint.
- `showOriginal` draws the untouched image (no pixel op).
- Runs live on every slider / checkbox change (cheap, no backend round-trip).

Preview-only. The actual write still goes through the unchanged backend
commands (`recolorImage`/`colorizeImage`/`recolorFolder`/`colorizeFolder`).

### 2. Swap previews — prev/next arrows (decided)

- **Single-file mode**: one image, no arrows (unchanged source, new render).
- **Folder mode**: enumerate **all** `.dds`/`.tex` paths under the folder up
  front (names only, via the existing `fileTree` walk — no new API). Show a
  `‹ filename (i / total) ›` control over the preview.
- **Decode on demand**: only the currently-viewed texture is decoded via
  `decodeDdsToPng`; the arrows change the index and lazily decode the new one.
  A tiny per-path decode cache avoids re-decoding when cycling back.
- The dual side-by-side preview is **removed** — the single swappable preview
  replaces it.

### 3. Visual restyle (both modes)

- **Toggle rows** ("Preserve original color intensity", "Create checkpoint",
  "Skip distortion") → `SettingsRow` clickable toggle rows (icon + title + sub),
  matching Settings.
- **Mode hint** and **overwrite warning** → translucent glass strips consistent
  with Settings (no solid `bg-tertiary`/warning box).
- **Preview panel** → frameless, dark translucent surface; the swap control and
  Original/Preview badge sit on top.
- Mode tabs keep their tab role but restyle to the current pill look.

## Non-goals

- No backend / recolor-engine changes. Preview math is a frontend approximation
  for guidance; the write path is authoritative and untouched.
- No new Tauri command — folder enumeration reuses the in-memory `fileTree`.
- No multi-texture simultaneous preview (prev/next covers "see several").

## Files

- `src/components/modals/RecolorModal.tsx` — rewrite preview + controls.
- `src/lib/recolor/previewPixels.ts` (new) — pure pixel-op functions
  (`applyHueShift`, `applyColorize`, `applyGrayscaleTint`) + HSV/HSL helpers,
  unit-tested.
- `src/styles/index.css` (or `settings-polish.css`) — restyle `.recolor-modal__*`
  to the glass/design-lab look; add swap-control styles.
