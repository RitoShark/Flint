# Ground-Tile PSD Stitcher — Design Spec

**Date:** 2026-06-08
**Status:** Draft for review
**Branch:** feat/map-preview
**Depends on:** the map-preview feature (texture decode/encode pipeline, variant/stage classification)

## 1. Goal

Recoloring a League map's ground is painful because the ground is authored as a
grid of separate texture tiles (`Ground_A1…E5`), plus overlapping variant tiles
for the elemental dragon pits and the Baron-pit stages. Editing each tile in
isolation makes it impossible to keep a consistent look (a "night map"
desaturation, a recolor) across seams.

This feature gives a **one-button round trip**:

1. **Combine** the open map project's ground tiles into a single layered **PSD**
   (5×5 grid canvas), with overlapping variant/stage tiles as separate,
   hidden-by-default layer groups.
2. User edits the PSD in GIMP or Photoshop and saves.
3. **Apply** the edited PSD back: each layer (named after its source texture) is
   encoded and written back to that `.tex`.

**Texture-only.** The tool never reads or writes the map bin. This is deliberate
crash-safety: the user has established that manipulating the map bin crashes the
game, so the entire workflow operates on texture files only — nothing the bin
references can fall out of sync.

### Non-goals (this version)

- No recolor *preset* system (re-apply saved recolors after a Riot patch with
  prefix/suffix smart-matching) — that is the **next** feature, separate spec.
- No bin editing, no crash-proofing of the bin.
- No non-ground textures (walls, props, VFX) — ground tiles only.
- No automatic recolor (the user does the actual editing in GIMP/Photoshop).

## 2. Key domain facts (verified against the current SRX project)

1. **Ground is a complete 5×5 grid.** Tiles are named `Ground_<Col><Row>_…`
   where Col ∈ A–E and Row ∈ 1–5. The current `Map11` SRX extract has all 25
   cells present (`ground_a1_*` … `ground_e5_*`). Each tile is 2048×2048, so the
   full canvas is 10240×10240. (Matches the user's existing `split_tiles.py`,
   which assumed a 5×5 grid of 2048² tiles.)

2. **Two cells have overlapping variant tiles at the SAME grid position:**
   - **D4 (Dragon pit):** `ground_d4_dragonpit_a` (default) plus elemental
     versions `_chemtech_a`, `_cloud_a`, `_earth_a` (Mountain), `_fire_a`
     (Infernal), `_ocean_a`.
   - **B2 (Baron pit):** `ground_b2_baronpit_a` (default) plus `_tunnel_a`,
     `_upgraded_a`, `_walled_a` (stages).
   These must be SEPARATE layers (not flattened), because they occupy the same
   pixels. They are hidden by default so the user edits the base map cleanly.

3. **`.tex` is Riot's BC1/BC3 block format.** Flint already decodes it
   (`decode_full_rgba` — includes the BC1 punch-through alpha fix from this
   branch) and encodes it (`convert_dds_to_tex` path). This feature reuses both;
   it does NOT add a new texture codec.

4. **The tool operates on the currently-open map project.** It takes the active
   project's `projectPath` (same as the map preview) and discovers ground tiles
   under `content/<layer>/<wad>/assets/maps/kitpieces/<…>/textures/`. No manual
   path selection.

5. **Variant/stage classification already exists** in the map-preview code
   (`classifyBaronStage`, element-token detection / `effectiveLayer`). The
   stitcher reuses the same rules so layer grouping matches the preview's model.

## 3. Architecture

```
[ Map Preview window — two buttons ]

 ① "Combine ground → PSD"
    Rust: combine_ground_to_psd(project_path)
      • discover ground .tex tiles in the open project
      • decode each .tex → RGBA8 (decode_full_rgba)
      • classify each: grid cell (A1..E5) + variant/stage group
      • place each into the 10240² canvas at its grid cell
      • assemble PSD: Base group (default tiles, visible) +
        one hidden group per variant/stage
      • write <project>/ground_map.psd
    → user edits ground_map.psd in GIMP/Photoshop, saves

 ② "Apply PSD → textures"
    Rust: apply_psd_to_textures(project_path, psd_path)
      • read the PSD layers (name + bounds + RGBA pixels)
      • for each layer: name == source texture stem → encode RGBA → write that .tex
      • layers matching no source texture: skip + warn
```

The bin is never touched. The PSD lives in the project root (or a chosen path).

## 4. Components

### 4.1 Rust: `src-tauri/src/commands/project/map_tiles.rs` (new)

**Discovery**
- `find_ground_tiles(project_path) -> Vec<GroundTile>` — walk the project's
  texture dir(s); for each `*.tex` whose filename starts `ground_`, parse:
  - `cell`: `(col 0..4, row 0..4)` from the `<A-E><1-5>` after `ground_`.
  - `group`: `Base` (default), an elemental variant, or a Baron stage —
    via the shared classification rules.
  - `stem`: filename without extension (the round-trip key).

**Combine**
- `#[tauri::command] combine_ground_to_psd(project_path) -> String` (returns the
  written PSD path).
  - Decode each tile to `image::RgbaImage`.
  - Canvas = 5 × tileSize wide/tall (tileSize from the first tile, default 2048).
  - Build a layer per tile: pixels = the tile image, position = `(col*tile,
    row*tile)`, name = the tile's `stem`, group = its classification, visible =
    (group == Base).
  - Serialize to PSD via the `psd_write` module.

**Apply**
- `#[tauri::command] apply_psd_to_textures(project_path, psd_path) -> ApplyReport`
  - Read PSD (layers: name, bounds, RGBA) via the `psd_read` module.
  - For each layer, resolve `<stem>.tex` among the project's ground tiles. If
    found: crop/take the layer's pixels, encode to the tile's original `.tex`
    format (BC1/BC3 matched from the source, like `convert_dds_to_tex`), write it.
  - Report: written count, skipped layers (no matching texture), errors.

### 4.2 Rust: `psd_write` module (the main new work)

A minimal Photoshop-document writer. Scope is deliberately tiny:
- 8-bit RGBA, one merged image header + a layer-and-mask section.
- Layers with: name, top/left/bottom/right bounds, opacity, visibility flag, and
  RGBA channel data (channels -1=A, 0=R, 1=G, 2=B), RAW compression (no RLE) for
  simplicity (file is large but correct; both GIMP and Photoshop read RAW).
- **Layer groups** via the divider section markers: a `</Layer group>` bounding
  layer pair (`lsct` "section divider setting" = open/close folder), which is how
  PSD encodes groups. GIMP and Photoshop both honor these.
- A flattened composite for the base image data section (required by the format;
  can be the visible-layers composite).

Reference: the Adobe "Photoshop File Format" layer-and-mask + `lsct` spec. We
implement only what we emit; we do not aim for full PSD coverage.

### 4.3 Rust: `psd_read` module

- Prefer an existing read-only PSD crate (e.g. `psd`). It must expose per-layer
  name, bounds, and RGBA pixels. If a suitable crate isn't available, implement a
  minimal reader matching exactly what `psd_write` produces (RAW channels + `lsct`).
- Decided at implementation time after a quick crate check; the interface
  (`read_layers(path) -> Vec<PsdLayer { name, x, y, rgba, width, height }>`) is
  fixed either way.

### 4.4 Frontend

- Two buttons in the Map Preview window (`MapPreview.tsx`): **"Combine ground →
  PSD"** and **"Apply PSD → textures"** (the latter opens a file picker defaulting
  to the project's `ground_map.psd`).
- API bindings in `mapPreview.ts`: `combineGroundToPsd(projectPath)`,
  `applyPsdToTextures(projectPath, psdPath)`.
- Result feedback via the existing toast/store; on apply, also trigger the
  existing `file-changed` flow so the live preview updates.

## 5. Layer structure (the PSD)

```
ground_map.psd   (10240×10240, transparent where no tile)
├─ Base                       (group, visible)
│   ├─ ground_a1_alcovetop_a       (A1)
│   ├─ ground_b2_baronpit_a        (B2, default baron)
│   ├─ ground_d4_dragonpit_a       (D4, default dragon pit)
│   └─ … all 25 default cells
├─ DragonPit · Infernal       (group, hidden)  ground_d4_dragonpit_fire_a
├─ DragonPit · Mountain       (group, hidden)  ground_d4_dragonpit_earth_a
├─ DragonPit · Ocean          (group, hidden)  ground_d4_dragonpit_ocean_a
├─ DragonPit · Cloud          (group, hidden)  ground_d4_dragonpit_cloud_a
├─ DragonPit · Hextech        (group, hidden)  ground_d4_dragonpit_hextech_a (if present)
├─ DragonPit · Chemtech       (group, hidden)  ground_d4_dragonpit_chemtech_a
├─ BaronPit · Walled          (group, hidden)  ground_b2_baronpit_walled_a
├─ BaronPit · Upgraded        (group, hidden)  ground_b2_baronpit_upgraded_a
└─ BaronPit · Tunnel          (group, hidden)  ground_b2_baronpit_tunnel_a
```

Layer name == source texture stem (the round-trip key). Group names are
human-readable; only the layer name matters for save-back.

## 6. Data shapes

```rust
struct GroundTile {
    stem: String,        // "ground_d4_dragonpit_fire_a" (round-trip key)
    abs_path: PathBuf,   // the .tex on disk
    col: u8, row: u8,    // 0..4 grid cell
    group: TileGroup,    // Base | Variant(name) | BaronStage(name)
}

struct ApplyReport {
    written: u32,
    skipped: Vec<String>,   // layer names with no matching texture
    errors: Vec<String>,
}
```

```ts
interface ApplyReport { written: number; skipped: string[]; errors: string[]; }
```

## 7. Error handling

- No ground tiles found → clear error, no file written.
- A tile that isn't 2048² → placed at its native size at the cell origin; logged
  (canvas still sized from the dominant tile size). Never crash.
- Apply: a PSD layer whose name matches no source texture → skipped + listed in
  the report (so adding/renaming a layer in GIMP doesn't break the run).
- Apply: encode failure for one tile → recorded in `errors`, other tiles still
  written.
- PSD write/read failure → surfaced as a command error with context.

## 8. Testing

- **PSD round-trip (the critical test):** write a PSD with 2 layers + 1 group
  (small RGBA images with known pixels) → read it back → assert layer names,
  bounds, group membership, and pixel values match. This validates the writer and
  reader together.
- **Grid-cell parsing:** `ground_d4_dragonpit_fire_a` → cell (D,4), group
  DragonPit·Infernal; `ground_a1_alcovetop_a` → (A,1), Base; non-`ground_` names
  rejected.
- **Placement offsets:** tile at cell (C,3) lands at pixel (2*2048, 2*2048).
- **Apply mapping:** a PSD layer named `ground_b2_baronpit_a` resolves to and
  writes `ground_b2_baronpit_a.tex`; an unmatched layer is skipped.
- **Manual verification:** on the open SRX project, Combine → open the PSD in
  GIMP (confirm groups + hidden variants), recolor the Base group, Apply →
  confirm the `.tex` files updated and the live map preview reflects the recolor.

## 9. Open implementation-time decisions (not blockers)

- `psd_read`: existing crate vs. minimal in-house reader (quick crate check first).
- PSD layer pixel compression: RAW (chosen for simplicity) vs. RLE (smaller
  file). Start RAW; revisit only if file size is a problem.
- Whether to also write an `.xcf` — no (PSD opens in GIMP and Photoshop; one
  format).

## 10. Future work (separate specs)

- **Recolor preset re-apply:** save the edited textures as a preset; after a Riot
  patch, re-apply onto the fresh extract with smart prefix/suffix matching
  (handles the observed `.srs_env_update` rename). This is the user's #2 priority.
- Non-ground texture stitching (walls/props) if useful.
