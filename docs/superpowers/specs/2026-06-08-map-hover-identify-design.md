# Map Hover / Click-to-Identify — Design Spec

**Date:** 2026-06-08
**Status:** Draft for review
**Branch:** feat/map-preview
**Part of:** the map editing system, Layer 2 (navigation glue). Builds on the
map-preview feature; precedes the texture-sheet stitcher and preset systems.

## 1. Goal

When recoloring or editing a map, the hardest part is knowing *which texture
paints what you're looking at*. This feature makes the 3D map preview
**explorable**:

- **Hover** the mouse over geometry → a bottom status bar shows, live, the exact
  material name and its texture (and variant/stage) under the cursor.
- **Click** geometry → a pinned info card with a texture thumbnail, the
  project-relative path, a **Copy path** button, an **Open in editor** button,
  and the material/variant/layer details.

So the user sweeps the mouse to learn the map, then clicks the piece they want
and jumps straight to editing its texture in GIMP/Photoshop.

### Non-goals (this version)
- No editing in-app, no texture replacement (that's the stitcher/preset layers).
- No multi-select / measurement / annotation.

## 2. Key facts (verified against the current code & Babylon v9)

1. **Merged meshes lose per-submesh identity — but we can recover it.** The
   renderer merges submeshes by `(effectiveLayer, texturePath)` into ~180 meshes
   for performance (un-merging caused a 6 GB freeze; that fix stays). A merged
   mesh therefore has ONE `texturePath` but MULTIPLE original submeshes (e.g.
   `DragonPit_A_MAT` and `Order_Dragon_A_MAT` can share a texture). To name the
   exact material under the cursor we must track, per merged mesh, which triangle
   ranges came from which submesh.

2. **Babylon gives the triangle under the cursor.** `scene.pick(x, y)` returns
   `PickingInfo` with `faceId` (`PickingInfo.faceId` exists in
   `@babylonjs/core`). `faceId` is the triangle index into the mesh's index
   buffer; from it we find which submesh range it falls in → that submesh's
   material name.

3. **`scene.onPointerObservable`** (with `PointerEventTypes.POINTERMOVE` /
   `POINTERPICK`) is the standard hover/click hook in Babylon v9.

4. **Open-in-editor already exists:** `openWithDefaultApp(path)`
   (`src/lib/api/file.ts`) opens a file in the OS default app. We reuse it.

5. **Texture decode for the thumbnail exists:** the map preview already loads
   decoded textures via `loadMapTexture` (RGBA). The info card reuses that (or the
   already-loaded `RawTexture` if cached) for the thumbnail.

## 3. Architecture

```
[ MapPreview 3D scene ]
   pointer move ──▶ scene.pick(x,y) ──▶ { mesh, faceId }
                       │
                       ▼
       resolve faceId → submesh range → { materialName, texturePath, variant, stage }
                       │
        ┌──────────────┴───────────────┐
        ▼ (hover)                       ▼ (click)
   bottom status bar               pinned info card
   "MaterialName · tex · Base"     [thumb] path [Copy] [Open in editor]
                                   material / variant / layer details
```

The pick→identity resolution is pure data already on the frontend; no new Rust
command is needed for hover/identify. "Open in editor" reuses `openWithDefaultApp`.

## 4. Components

### 4.1 Builder: track submesh ranges (mapMeshBuilder.ts)

Extend `buildMapMeshes` so each `BuiltMapMesh` records the triangle ranges of the
submeshes merged into it:

```ts
interface SubmeshSpan {
  name: string;        // original submesh/material name
  texturePath: string | null;
  startFace: number;   // first triangle index in the merged mesh
  faceCount: number;   // number of triangles
}
// added to BuiltMapMesh:
spans: SubmeshSpan[];
```

During merge we already append each submesh's indices in order; track a running
face cursor (`indicesWritten / 3`) and push a `SubmeshSpan` per submesh. `faceId`
from a pick is then resolved by finding the span where
`startFace <= faceId < startFace + faceCount`. (Merged meshes are keyed by
texture, so most spans share the mesh's texture, but names differ — which is
exactly the identity we want.)

A small helper:
`resolveFace(built: BuiltMapMesh, faceId: number): SubmeshSpan | null`.

### 4.2 Renderer: pointer handling (MapPreview.tsx)

- On scene setup, add `scene.onPointerObservable`:
  - **POINTERMOVE** (throttled, e.g. skip if same mesh+span as last frame):
    `scene.pick` at pointer; if it hit one of our meshes, resolve the span →
    update a `hoverInfo` state → render the bottom status bar. Empty when nothing
    is hit.
  - **POINTERPICK** (click): resolve the span → set `pinnedInfo` state → show the
    info card; clicking empty space clears it.
- Map a merged Babylon mesh back to its `BuiltMapMesh` via a `Map<Mesh,
  BuiltMapMesh>` kept in a ref (built alongside `builtRef`).
- Identity shown is derived from the span: `materialName`, `texturePath`, the
  mesh's `variants`/`baronStage`, and `layer`.

### 4.3 UI (MapPreview.tsx, self-contained inline styles like the Layers panel)

- **Status bar:** a thin bar pinned bottom-center, shows on hover:
  `"<materialName>  ·  <texture filename>  ·  <variant/stage>"`. Hidden when not
  hovering geometry.
- **Info card** (on click): small panel near the click point with:
  - texture **thumbnail** (from the cached `RawTexture` / `loadMapTexture`),
  - project-relative **texture path** (full, selectable),
  - **Copy path** button (clipboard),
  - **Open in editor** button → `openWithDefaultApp(resolvedTexturePath)`,
  - **material name**, **variant(s)**, **baron stage** (if any), **layer** hex.
  - close (×) / click-empty-space to dismiss.

### 4.4 Resolving the texture's real file path

The span's `texturePath` is the bin path (`ASSETS/.../foo.tex`). "Open in editor"
and "Copy path" need the real on-disk file. Reuse the existing resolution: a new
thin command `resolve_map_texture_path(project_path, texture_path) -> String`
wrapping the same `resolve_asset_path` logic the preview already uses, OR call the
existing `resolve_asset_path` directly from the frontend (it's already exposed).
Prefer reusing `resolve_asset_path` — no new command.

## 5. Data shapes

```ts
interface HoverInfo {
  materialName: string;
  textureFile: string;     // basename for the status bar
  texturePath: string | null; // full bin path
  variants: MapVariant[];
  baronStage: BaronStage | null;
  layer: number;
}
// pinnedInfo: HoverInfo | null   (click)
// hoverInfo:  HoverInfo | null   (move)
```

## 6. Error handling

- Pick hits nothing / hits a non-map mesh → clear hover bar; click clears pin.
- `faceId` outside all spans (shouldn't happen) → fall back to the mesh's
  texture-level info (texturePath only), no crash.
- Texture path that can't be resolved to a file → Copy/Open disabled with a
  tooltip ("texture not found in project"); the rest of the card still shows.
- Thumbnail decode failure → card shows without the image.

## 7. Performance

- Hover picking runs on pointer-move; throttle by skipping the resolve when the
  picked `(mesh, span)` is unchanged, and cap to one pick per animation frame.
  `scene.pick` against ~180 meshes is cheap; this won't affect the render loop.

## 8. Testing

- **Unit (builder):** `resolveFace` — build a merged mesh from 2 submeshes with
  known index counts; assert faceId in range 1 → submesh A, faceId in range 2 →
  submesh B; out-of-range → null.
- **Unit (span tracking):** combining 2 submeshes (10 and 20 triangles) yields
  spans `{startFace:0,faceCount:10}` and `{startFace:10,faceCount:20}`.
- **Manual:** open the SRX project preview; hover the dragon pit → bottom bar
  shows `…DragonPit_A_MAT · ground_d4_dragonpit_a.tex · Base`; hover a wall →
  its material; click → card with thumbnail + correct path; Copy path pastes the
  project-relative path; Open in editor opens the texture.

## 9. Open implementation-time decisions (not blockers)
- New thin `resolve_map_texture_path` command vs. calling `resolve_asset_path`
  directly (prefer the latter).
- Whether "Open in editor" opens the raw `.tex` (default app) or first converts
  to a `.png` via the existing `convert_texture_to_png` for editability. Likely
  offer "Open .tex" now; PNG-convert can be a stitcher-era concern.

## 10. Fit in the larger system
- Layer 1 — Preview + variant/stage toggles ✅
- **Layer 2 — Hover/Click identify (this spec)**
- Layer 3 — Texture-sheet stitcher (ground grid PSD spec written; walls/props
  atlas + UV-world later)
- Layer 4 — Recolor presets (re-apply across Riot patches, smart prefix/suffix)
