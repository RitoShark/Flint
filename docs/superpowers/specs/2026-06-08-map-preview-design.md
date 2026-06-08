# Map Preview — Design Spec

**Date:** 2026-06-08
**Status:** Draft for review
**Branch:** backend-refactor

## 1. Goal

Add a **3D map preview** to Flint for map projects. The user opens a map project
(e.g. `nightmap`, a `Map11` extract), clicks a button, and a **separate window**
opens showing the map's geometry rendered in 3D with its textures automatically
connected from the materials bin. When the user edits a texture (recolor) or the
materials bin in the project, the preview **reloads the affected assets live** so
they can iterate without re-opening anything.

This serves the recolor/automation workflow: see the map, recolor a texture, watch
it update — no manual asset wrangling.

### Non-goals (this version)

- No map *editing* (moving geometry, repathing). Read-only preview.
- No combining/puzzling map parts into a layered mega-file (a separate future idea).
- No bin-diff / "detect what Riot changed" system (separate future idea).
- No preset/variant library. Variant is auto-detected from the project (see §4).

## 2. Key domain facts (verified against the repos)

These facts were confirmed by reading `RitoShark-Crates` and the `nightmap`
project on disk; they are the foundation of the design.

1. **Submesh name = material name.** A mapgeo `Submesh` has a `name`
   (`rs_mapgeo` `mapgeo.rs:152`). In League authoring (Maya) each submesh is its
   own material, and the submesh name is the full material path. That name is the
   key into the materials bin.

2. **The materials bin keys `StaticMaterialDef` by that material path.** In
   `nightmap`'s `base_srx.materials.bin`, entries look like:
   `"Maps/KitPieces/SRS/Base/Materials/Default/Order_Dragon_Chemtech_A_MAT" = StaticMaterialDef { ... }`.
   So: `submesh.name` → `StaticMaterialDef` of the same name.

3. **`StaticMaterialDef` holds texture paths in `samplerValues`.** Each entry is a
   `StaticMaterialShaderSamplerDef` with `TextureName` (e.g. `"DiffuseTexture"`)
   and `texturePath` (e.g. `"ASSETS/Maps/KitPieces/SRS/Base/Textures/....tex"`).
   The diffuse texture is the one we render.

4. **The full chain is deterministic — no guessing:**
   ```
   mapgeo submesh.name
     → StaticMaterialDef "<same name>"   (materials bin)
       → samplerValues[ TextureName == "DiffuseTexture" ].texturePath
         → .tex/.dds file on disk
   ```

5. **The variant problem solves itself via the filesystem.** `flint.json` stores
   `map_id` (`"map11"`) but **not** which variant the user extracted. However, the
   asset extractor copies **only the selected variant's files** into the project.
   `nightmap` contains exactly one mapgeo+bin pair:
   `content/base/Map11.wad.client/data/maps/mapgeometry/map11/base_srx.mapgeo`
   and `base_srx.materials.bin`. So the preview discovers the variant by scanning
   that folder for `*.mapgeo` and pairing each with its same-stem `*.materials.bin`.
   No `flint.json` change is required.

6. **rs_mapgeo gives raw, packed vertex buffers.** `VertexBuffer.data` is raw
   bytes; layout comes from `VertexDescription.elements` (`ElementName` +
   `ElementFormat`). Positions/normals/UVs must be decoded per the declared
   format (including packed formats like `XyzPacked161616`). This decode belongs
   in Rust.

7. **WebGL cannot sample `.tex` (Riot's container) and is unreliable for `.dds`
   compressed formats.** Textures must be decoded to plain pixels somewhere.
   Flint already decodes `.tex`/`.dds` via `rs_tex` on the Rust side
   (`commands/assets/texture_convert.rs`). We reuse that path and send **raw RGBA
   pixels** to Babylon (a `RawTexture`) — minimal transformation, fastest reload.

8. **Existing infrastructure we reuse rather than reinvent:**
   - **Babylon engine lifecycle, render loop, unlit PBR material, camera framing**
     — proven in `ModelPreview.tsx` / `meshBuilder.ts`. Copy the patterns,
     especially: mount the engine once and mutate the scene (never recreate the
     WebGL context per reload); wrap the render loop in try/catch.
   - **Binary IPC wire format** — `mesh.ts` `decodeMeshPayload` uses
     `[u32 meta_len][meta json][pad to 4][typed binary buffers]`. We use the same
     shape so huge vertex arrays never go through JSON.
   - **File-version hot-reload** — `appMetadataStore` exposes `getFileVersion(path)`
     bumped by the app's file watcher; `ModelPreview` already hot-reloads off it.
   - **Standalone-window mounting** — `main.tsx` already branches on
     `window.location.hash === '#design-lab'` to mount a different root without
     booting app state. The preview window reuses this exact mechanism.
   - **Texture path resolution** — `resolve_asset_path(assetPath, binPath)` already
     exists (`api/mesh.ts:231`) for turning a bin texture path into a real file path.

## 3. Architecture overview

Hybrid split. **Rust owns format-specific + heavy work**; **frontend owns
Babylon.** A new **separate Tauri window** hosts the renderer.

```
[ Map project view (main window) ]
        │  user clicks "Preview Map"
        ▼
 open_map_preview_window(projectPath)   ── Rust command
        │  creates WebviewWindow → index.html#map-preview?project=<path>
        ▼
[ Map Preview window ]  (standalone React root, no app boot)
        │
        ├─ load_map_preview(projectPath)         ── Rust command
        │     • scan mapgeometry/<map_id>/ → pick the .mapgeo + .materials.bin pair
        │     • parse mapgeo (rs_mapgeo), DECODE packed vertex buffers → f32 arrays
        │     • parse materials bin (rs_bin), build submesh→texturePath table
        │     • return geometry payload (binary) + material table (json)
        │
        ├─ load_map_texture(projectPath, texturePath)   ── Rust command (lazy)
        │     • resolve texturePath → file in project
        │     • decode .tex/.dds → raw RGBA + w/h (rs_tex)
        │     • return RGBA payload (binary)
        │
        └─ Babylon scene: build meshes from geometry, lazily fetch textures,
           assign unlit PBR materials, orbit camera, live-reload on file changes.
```

### Why separate window

Requested by the user. Also a clean fit: it isolates the heavy WebGL context from
the main app (no contention with the existing SKN preview), and lets the map view
live alongside the editor so the user can recolor in one window and watch the
other update. Precedent exists (`#design-lab` standalone root).

## 4. Components

### 4.1 Rust: map preview module
`src-tauri/src/commands/project/map_preview.rs` (new), registered in `main.rs`.

**`discover_map_variant(project_path) -> MapPreviewSource`** (internal helper)
- Read `flint.json` → `map_id`.
- Scan `content/*/Map*.wad.client/data/maps/mapgeometry/<map_id>/` for `*.mapgeo`.
- For each, pair with same-stem `*.materials.bin`.
- Return the first complete pair (and the list, for a future picker). Error with a
  clear message if none found.

**`#[tauri::command] open_map_preview_window(app, project_path)`**
- If a window labeled `map-preview` already exists, focus it and emit a "load this
  project" event instead of spawning a duplicate.
- Else `WebviewWindowBuilder::new(app, "map-preview", WebviewUrl::App("index.html#map-preview?project=<urlencoded path>"))`,
  title "Map Preview — <project name>", reasonable size, resizable.
- Decorations: use native decorations (`true`) for v1 to avoid reimplementing the
  custom title bar in the standalone root. (Can be themed later.)

**`#[tauri::command] load_map_preview(project_path) -> Vec<u8>`** (binary payload)
- `discover_map_variant` → mapgeo path + bin path.
- Parse mapgeo via `rs_mapgeo`. For each `MapModel` and its submeshes:
  decode the model's vertex buffer(s) using its `VertexDescription` into flat
  `f32` positions / normals / uvs; rebase indices per submesh (mirror the
  `meshBuilder.ts` slicing contract so the frontend stays simple).
- Parse the materials bin via `rs_bin`. Build a map
  `submesh_name -> { diffuse_texture_path }` by reading `StaticMaterialDef`
  entries' `samplerValues` (TextureName == "DiffuseTexture"). Use `rs_hash`
  FNV1a-32 to match the bin's hashed field names.
- Assemble payload: `[u32 meta_len][meta json][pad][positions f32][normals f32]
  [uvs f32][indices u32]`. `meta` carries: per-submesh ranges + name, the
  `submesh_name -> texturePath` table, overall bounding box, counts.
- **Coordinate system:** apply the same axis handling the SKN path uses
  (`meshBuilder.ts` notes the Rust SKN backend negates X). The implementation must
  verify mapgeo orientation against a known-good reference and document the chosen
  transform inline. Treated as an implementation-time verification item, not an
  assumption baked into the spec.

**`#[tauri::command] load_map_texture(project_path, texture_path) -> Vec<u8>`**
- Resolve `texture_path` (an `ASSETS/...` path from the bin) to a real file inside
  the project (reuse/extend `resolve_asset_path` logic).
- Decode `.tex`/`.dds` to raw RGBA via `rs_tex` (reuse `texture_convert.rs` decode
  path; we want raw pixels, not PNG re-encode).
- Payload: `[u32 width][u32 height][rgba bytes]`. Missing/undecodable texture →
  a structured error the frontend renders as a magenta material (matches the
  SKN "no texture" convention).

### 4.2 Frontend: API bindings
`src/lib/api/mapPreview.ts` (new), exported from `api/index.ts`.
- `openMapPreviewWindow(projectPath)`
- `loadMapPreview(projectPath): Promise<MapPreviewData>` — decode the binary payload
  exactly like `decodeMeshPayload`, into typed arrays + the material table.
- `loadMapTexture(projectPath, texturePath): Promise<{ width, height, rgba: Uint8Array }>`

### 4.3 Frontend: standalone window root
- `main.tsx`: add a branch mirroring `#design-lab` — if hash starts with
  `#map-preview`, mount `<MapPreviewWindow .../>` (parse `project` from the hash
  query) and **skip** `AppProvider`/`App` boot. It still needs the logger + the
  Tauri file-watch listener for live reload (see §5).
- `src/components/preview/MapPreviewWindow.tsx` (new) — top-level window component:
  own minimal chrome/title, hosts `<MapPreview projectPath=... />`, handles the
  "load this project" event when the window is reused.

### 4.4 Frontend: the renderer
`src/components/preview/MapPreview.tsx` (new). Built by **adapting `ModelPreview.tsx`**:
- Engine/scene/camera created once on mount; render loop wrapped in try/catch;
  synchronous engine disposal on unmount. (Copy these hardened patterns verbatim.)
- On load: call `loadMapPreview`, build one Babylon mesh per submesh from the typed
  arrays (reuse/share `meshBuilder.ts` `buildSknMeshes` contract — same
  `SubmeshRange` shape; geometry-only, no bones).
- For each submesh, look up its `texturePath` in the material table and **lazily**
  call `loadMapTexture`; build a Babylon `RawTexture` from the RGBA pixels; assign
  an **unlit `PBRMaterial`** (per the hard-won SKN rule). Cache textures by path so
  shared textures load once. Magenta material when a texture is missing.
- Camera framing from the returned bounding box, reusing `ModelPreview`'s
  degenerate-box guards.
- Controls: orbit/pan/zoom (ArcRotateCamera as in ModelPreview); a materials/submesh
  list with show/hide toggles is a nice-to-have, not required for v1.

## 5. Live reload

- The main app already runs a Tauri file watcher that bumps `appMetadataStore`
  file-version counters. The preview window is a **separate webview**, so it must
  receive the same change signal. Two options, decided at implementation time:
  (a) the preview window attaches its own watcher for the project's
  `mapgeometry/<map_id>/` folder + referenced texture files; or
  (b) the existing watcher's Tauri events are emitted app-wide and the preview
  window listens. Prefer (a) for isolation: the preview owns a watcher scoped to
  the files it actually renders.
- On a **texture** change: re-call `loadMapTexture` for that path, rebuild just
  that `RawTexture`, swap it into the cached material. No full rebuild.
- On a **materials.bin** change: re-call `loadMapPreview` (cheap relative to the
  geometry) to refresh the submesh→texture table, then reconcile materials.
- On a **mapgeo** change: full reload (geometry changed). Rare during recolor work.
- Debounce rapid successive events (editors often write twice).

## 6. Data shapes

```ts
// material table entry (in meta json from load_map_preview)
interface MapMaterialInfo {
  submesh: string;          // submesh/material name (the key)
  diffuse_texture?: string; // bin texturePath, e.g. "ASSETS/Maps/.../foo.tex"
}

interface MapPreviewData {
  submeshes: SubmeshRange[];                 // same shape as meshBuilder.ts
  materials: Record<string, MapMaterialInfo>;// keyed by submesh name
  bounding_box: [[number,number,number],[number,number,number]];
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

// load_map_texture payload → decoded to:
interface MapTexture { width: number; height: number; rgba: Uint8Array; }
```

## 7. Error handling

- No mapgeo/bin pair found → preview window shows a clear "no map geometry found in
  this project" message (not a crash).
- Mapgeo parse failure → surfaced as an error overlay (reuse ModelPreview's
  overlay pattern); log the version so unsupported mapgeo versions are diagnosable
  (`rs_mapgeo` rejects v8/10/16).
- A submesh whose material/texture can't be resolved → magenta material, preview
  still renders everything else (per-submesh isolation).
- Texture decode failure → magenta for that material; logged.
- Window already open → focus + reload, never duplicate.

## 8. Testing

- **Rust unit tests** (in the new module):
  - `discover_map_variant` finds `base_srx` pair in a fixture dir; errors cleanly
    when absent; pairs by stem.
  - materials-bin walk extracts the expected `submesh → DiffuseTexture path` for a
    small synthetic bin (or a trimmed real one), incl. the FNV field-name matching.
  - vertex decode: a synthetic mapgeo (or the smallest real one) decodes to the
    expected vertex count and finite positions.
- **Manual verification** (the real proof, per project norms): open `nightmap`,
  click Preview Map, confirm: separate window opens, geometry renders, textures
  are connected (not all magenta), camera frames the map; then recolor a texture in
  the main window and confirm the preview updates live.
- The geometry/winding/orientation correctness is verified visually against the
  real map, mirroring how the SKN preview was validated.

## 9. Open implementation-time decisions (not blockers)

- Native vs. custom window decorations (start native).
- Watcher ownership for live reload (§5 a vs b; prefer a).
- Whether to share `meshBuilder.ts` directly or fork a map-specific builder (decide
  once the exact submesh slicing for mapgeo is in hand).
- Mapgeo coordinate transform (verify visually; document inline).

## 10. Future work (explicitly out of scope now)

- Variant picker UI + persisting chosen variant in `flint.json` (only needed if a
  project ever holds multiple variants).
- Layered "combine map parts into one big file" exporter.
- Bin-diff / Riot-update change detection and smart-fill.
- Normal/other sampler channels beyond diffuse; lighting/baked-paint channels.
