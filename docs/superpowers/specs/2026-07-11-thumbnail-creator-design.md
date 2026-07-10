# Thumbnail Creator — Design

**Status:** approved-pending-review · **Date:** 2026-07-11

Skin poster / thumbnail generator for the Divine website. Turns a champion skin
into a splash-style thumbnail (à la the "PROJECT Yone" / "Teemo Dart Monkey"
reference posters) via a template-driven, movable-layer editor with live 3D
model rendering and still-image export.

Prototyped as a standalone `npm run dev` UX playground (design-lab styled); this
spec is the port into Flint proper.

---

## 1. Goals

- Right-click a `.skn` (or project) → open a dedicated **Thumbnail Creator**.
- Compose a poster from **movable layers**: 3D model instance(s), text blocks,
  a fixed decorative "disc" unit, and (later) corner textures + logo.
- Two shipped **style presets**, JSON-driven and extensible:
  - **Riot style** (ex-"Project", Beaufort for LOL font) — restrained, the disc
    carries the color; text is only subtly tinted by the mod hue.
  - **Divine style** (ex-"Teemo", Albiero font) — colorful/glowy; text takes the
    mod hue **significantly**.
- **Live SKN rendering** (real Babylon models + animation), not placeholders.
- Single global **mod hue** drives text tint + glow + accents (no per-text color
  picker).
- Export a **still** at a user-chosen animation frame: **WebP default, PNG
  optional**.

### Non-goals (V1)
- Animated/video export (architect for it; don't build the encoder).
- Corner-texture / logo image slots (structure the layer type; wire assets
  later — user is still producing them).
- WAD-sourced models (disk `.skn` only, like Jade's studio V1).

---

## 2. Entry point & windowing

A **separate OS window**, mirroring the existing **map-preview** pattern
(`commands/project/map_preview.rs::open_map_preview_window`,
`main.tsx` hash bootstrap, `capabilities/default.json` `windows` list). Rationale
recorded in CLAUDE.md "Multi-window pattern": secondary windows **re-derive state
from URL params + disk**, never share zustand.

- New Rust command `open_thumbnail_window(project_path, skn_path)` — reuse-by-
  label (`thumbnail`), builds `index.html#thumbnail?…params`, sets
  `MAIN_BROWSER_ARGS` + a **unique** `data_directory(app_data/webview-thumbnail)`
  on Windows (the 0x8007139F guard).
- `capabilities/default.json` → add `"thumbnail"` to the `windows` array.
- `main.tsx` → detect `#thumbnail`, mount a standalone `<ThumbnailWindow/>` root
  **without** StrictMode (matches map-preview).
- Launch wiring: a context-menu item in `fileContextMenuOptions.ts`
  ("Create Thumbnail…") on `.skn` files and the project root, calling the
  command with the skn/project path.

---

## 3. Composition model

The poster is a **640×360 (16:9) artboard** (authoring size; exports upscale to
the chosen resolution). It renders in three stacked planes:

1. **3D scene (Babylon)** — the environment background + model instance(s) +
   glow, rendered to a canvas. This is the "photo studio" layer.
2. **Decoration overlay (DOM/2D)** — the disc unit (ring PNG + interior disc PNG
   + black fill), corner textures (later), positioned absolutely over the 3D
   canvas.
3. **Text overlay (DOM)** — draggable/editable text blocks, top-most.

Editing happens on the DOM overlays (crisp text, easy drag); the 3D scene sits
behind. **Export** composites: Babylon `screenshot` → 2D canvas → draw
decoration images → draw text → encode WebP/PNG. (Reference: Jade
`studioScene.ts` uses `Tools.CreateScreenshotUsingRenderTarget`; we mirror it.)

### Layer types
- `model` — a `StudioModel` (SKN instance). Props: `sknPath`, `anim`, `frame`,
  transform (x/y/w/h on the artboard = screen-space placement of its render),
  `orbit` (camera angle around the model), `scale`. **Free add/remove list**
  (Kayn's 3 forms → add a 3rd). Each independently animatable.
- `text` — props: `text` (multi-line), `size` (auto-shrunk to fit, see §5),
  `font`, `italic`, `spacing`, `align`, x/y/w/h. **No color** (driven by hue).
- `disc` — the **fixed composite** decoration (Riot style only): ring +
  interior glow disc + ~20% black fill, at the authored positions from the saved
  preset. **Locked, non-movable, delete-only** (§6).
- `deco` — generic image slot (corner textures, logo) — structure now, assets
  later.
- `env` — environment background image (per-preset; user supplies).

Layers carry `locked` (placement lock, toggled via a 🔒 icon on the layer row).

---

## 4. Preset engine (JSON)

Presets are **data, not code** — authored in the editor and saved as JSON (the
"Save preset" flow the prototype already emits). Shape (from the prototype's
`presetJSON()`, extended):

```jsonc
{
  "preset": "riot" | "divine",
  "font": "Beaufort for LOL" | "Albiero",
  "hue": 210,                       // global mod hue, 0–360
  "canvas": { "w": 640, "h": 360, "ratio": "16:9" },
  "layers": [ { "type": "...", "name": "...", "locked": true, /* props */ } ]
}
```

- Ship two presets under `src/lib/thumbnail/presets/{riot,divine}.json`.
- The **Riot preset default** is the user's saved state (title "MOD NAME",
  subtitle "Character", ring + black-fill + interior-disc placements). The three
  disc pieces collapse into ONE `disc` layer (§6).
- Loading a preset seeds layers; users mutate then can re-Save (author more
  presets later, zero code).
- **Disc/env/corner assets** referenced by stable keys (`RING`, `GLOW`, corner
  keys); the actual files ship in `src-tauri/resources/thumbnail/` (converted to
  WebP) and load via a Tauri asset command.

---

## 5. Text: auto-shrink + multi-line

- **Auto-shrink to fit:** after laying out a text block, if the rendered text
  overflows its box width (or height for multi-line), reduce `size` (binary
  search / step down) until it fits, down to a floor. The stored `size` is the
  *max*; the *rendered* size is the fit result. Applies live while editing and
  at export so long mod names never clip.
- **Multi-line:** double-click enters inline edit; **Enter inserts a newline**
  (a second row). Text is **bottom-anchored** — new rows push the block *upward*
  (first row rises), matching how splash titles stack. Shift+Enter / Escape /
  blur commits. Stored as `\n`-joined string.

---

## 6. The disc unit (Riot style) — fixed composite, delete-only

The ring + interior glow disc + ~20% black fill are baked into a **single
`disc` layer** at the saved positions. Behavior:
- **Cannot be moved or resized** — no handles, ignores drag (reuse the
  prototype's locked path).
- **Only deletable** (whole unit) and hideable. Re-addable from an "Add disc"
  action if deleted.
- The black-fill **opacity** remains an exposed property (default 20%); position
  is fixed.
- Renders as: interior disc PNG (behind model) → 20% black circle → [model in
  the 3D layer] → ring PNG (in front). Z-order fixed by the composite.

---

## 7. Global mod hue

One **hue control** (0–360 slider in a "Theme" panel) replaces all per-text
color pickers. It drives, per style:

| Target | Riot style | Divine style |
|---|---|---|
| Text | **subtle** tint (mostly keeps cream/gold, hue nudges it) | **significant** — text visibly takes the accent |
| Glow | tinted to hue | tinted to hue (stronger) |
| Accent / ring / decoration tint | tinted to hue | tinted to hue |

- Implemented as a per-style "hue response" curve: Riot mixes ~10–15% hue into
  the base text color; Divine mixes ~70–90%. Glow/accent take the hue more
  directly in both.
- Stored as `hue` on the preset; user-authorable, end-user changeable.
- Architected so saturation/lightness or per-element overrides can be added
  later (user chose "hue now, expand later").

---

## 8. SKN rendering (the critical port)

Flint **already has every piece** Jade's studio uses — reuse them, don't
reinvent:

- `read_skn_mesh` → `buildSknMeshes` (meshBuilder.ts) — geometry + submeshes.
- `read_skl_skeleton` → `buildBabylonSkeleton` (skeletonBuilder.ts) — skeleton.
- `read_animation_list` / `read_animation` → `AnimationPlayer` (animationPlayer.ts)
  — clip listing + baked playback. (All in `commands/assets/mesh.rs`, already
  used by `ModelPreview.tsx`.)
- Textures via the existing `read_skn_textures*` / `decode_texture_disk` path
  (same as `ModelPreview` / Jade `studioLoad.ts`).

New module `src/lib/thumbnail/studioScene.ts` — a **trimmed** version of Jade's
`studioScene.ts` adapted to Flint's builders: ArcRotateCamera, hemispheric
light, optional glow layer, background image layer (cover/contain/stretch +
pan/zoom — port Jade's `applyBgLayerTransform`), N model instances, per-model
animation via `AnimationPlayer`, **frame scrubbing** (drive `player` to a fixed
time and pause), and `screenshot(w,h)` via `Tools.CreateScreenshotUsingRender
Target`. Each `model` layer maps to one object in the scene; its artboard x/y/w/h
positions the *rendered* model (we render the model to its own RT / viewport
region, or position via camera + a per-model root — decided at build time,
favoring per-model RT for clean screen-space placement).

**"Ports SKN correctly" acceptance:** a real champion `.skn` loads with textures
and a selectable animation, scrubs to a frame, and appears in the artboard +
final export — verified against a known skin (e.g. the reference Yone/Teemo).

---

## 9. Export

- Compose at the **chosen output resolution** (default 1920×1080 for 16:9; ratio
  picker offers 16:9/16:10/4:3/1:1 → concrete pixel sizes).
- Steps: Babylon `screenshot(outW,outH)` (transparent bg if env is image-less) →
  draw onto an offscreen 2D canvas → draw env (if image) → draw disc/deco PNGs →
  draw text (hue-resolved, auto-shrunk) → `canvas.convertToBlob({type})`.
- **WebP default**, PNG + JPG optional (format picker). Save via existing
  `save_file_bytes` raw-bytes IPC.

---

## 10. Styling & UI

- **100% design-lab (`.dl-*`)** — the port reuses the prototype's structure but
  every control is a real design-lab primitive (buttons, inputs, sliders,
  segmented toggles, dropdowns). Palette comes from Flint's theme (`index.css`
  `:root` + `themes/default.css` → **red** accent; the editor chrome/selection/
  handles read `--accent-primary` so they track the active theme).
- Layout (from the final prototype): **artboard on the LEFT** (takes the space),
  a single **right sidebar** = Layers (top) + draggable divider + Properties
  (below). Topbar: preset picker, undo/redo, Save-preset, ratio, format, Export.
- **Editor interactions** (all validated in the prototype, port verbatim):
  drag-to-move; corner-handle resize via a **separate overlay layer** (handles
  always beat layer-select, grabbable outside the artboard); **Shift** = axis-
  lock (move) / aspect-lock (resize); **Alt+scroll** zoom-to-cursor; **Ctrl+0/1/9**
  fit/100%/fit-selection; **Space/middle-drag** pan; **Ctrl+Z / Ctrl+Shift+Z**
  undo/redo (snapshot-based); per-row 🔒 lock; Delete removes selection.

---

## 11. File / module layout

```
src/
  main.tsx                                  # + '#thumbnail' bootstrap
  components/thumbnail/
    ThumbnailWindow.tsx                     # standalone root
    ThumbnailEditor.tsx                     # shell: topbar + artboard + sidebar
    ThumbnailArtboard.tsx                   # 3D canvas + overlays + interactions
    LayersPanel.tsx  PropertiesPanel.tsx  ThemePanel.tsx
  lib/thumbnail/
    studioScene.ts                          # trimmed Jade studio (Flint builders)
    preset.ts   presets/{riot,divine}.json  # engine + shipped presets
    layers.ts                               # layer model + ops (undo/serialize)
    textFit.ts                              # auto-shrink + multi-line layout
    hue.ts                                  # global-hue → per-style color resolve
    export.ts                               # composite → WebP/PNG
src-tauri/
  commands/project/thumbnail_window.rs      # open_thumbnail_window
  resources/thumbnail/{ring,glow}.webp      # converted disc assets
  capabilities/default.json                 # + "thumbnail" window
```

Reuse (do not fork): `src/lib/babylon/*` (meshBuilder, skeletonBuilder,
animationPlayer, engine), `commands/assets/mesh.rs`, `save_file_bytes`,
`decode_texture_disk`, the map-preview window plumbing.

---

## 12. Build order (phased; each phase independently testable)

1. **Window shell** — Rust command + capability + `main.tsx` bootstrap +
   `ThumbnailWindow` mounting an empty design-lab editor. Right-click launches it.
2. **Editor UX port** — layers/artboard/properties, drag/resize/overlay-handles,
   zoom/pan, undo, locks, draggable divider. (Direct port of the prototype;
   placeholders for models.)
3. **SKN scene** — `studioScene.ts` with real Babylon SKN load + animation +
   frame scrub + per-model placement + env background. Replace placeholders.
4. **Presets + disc** — JSON engine, ship Riot/Divine presets (Riot = saved
   state), disc composite (locked/delete-only), convert PNGs → WebP resources.
5. **Text** — auto-shrink + multi-line (Enter, bottom-anchored).
6. **Hue theme** — global hue panel + per-style response driving text/glow/accent.
7. **Export** — composite → WebP/PNG at chosen resolution via `save_file_bytes`.

---

## 13. Open items (deferred, not blocking V1)
- Corner-texture / logo image slots — wire when the user supplies the PNGs.
- Animated (WebM/APNG) export.
- WAD-sourced models.
- Saturation/lightness or per-element hue overrides.
