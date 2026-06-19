# Flatten-on-Apply (bake custom layers) — Design Spec

**Date:** 2026-06-08
**Status:** Approved
**Branch:** feat/map-preview
**Part of:** map editing system — changes how Apply reads the PSD.

## Goal
Let users add **custom layers** (e.g. a "river light" on a Dodge blend) in the
PSD and have them **baked into the textures** on Apply — instead of being
silently skipped. Apply should write what you SEE in the editor.

## Problem with current Apply
Apply matches PSD layers to `.tex` files **by name** and reads each named
layer's raw pixels in isolation. So:
- A custom unnamed layer ("Layer") matches nothing → skipped.
- Its blend (Dodge glow) is never composited onto the tiles beneath it.

## Approach: flatten the VISIBLE layers, slice per cell, write the visible tile
The `psd` crate (0.3.5) provides `flatten_layers_rgba(filter)` which composites
layers top-down **honoring blend mode + opacity** (see `blend.rs`: Normal,
Multiply, Screen, Dodge, …). We flatten only **visible** layers, then slice the
result per grid cell and write the tile that is visible at that cell.

User controls the target by toggling layer visibility before saving:
- Show Base + custom glow → base tiles get the glow baked in.
- Show an Infernal variant instead → that variant's tiles get written.

### Why "visible only"
Variant tiles (drake/baron) overlap the base cells. A single flattened image
can't separate them, so we write only the tile whose layer is visible at each
cell. This is deterministic and matches the on-screen result.

## Changes (Rust, `map_tiles.rs`)

### Shared helper
```
fn flatten_visible(psd: &Psd) -> Vec<u8>   // = psd.flatten_layers_rgba(|(_, l)| l.visible())
                                            //   falls back to psd.rgba() on Err
```

### Ground apply (`apply_psd_to_textures`)
Replace the per-layer loop with:
1. `canvas = flatten_visible(psd)` (size = psd.width × psd.height).
2. Build `visible_cells`: for each grid cell, the base/variant tile whose source
   layer is visible. Determine visibility by reading the PSD layers: a tile is
   "visible at cell (c,r)" if its named layer (or the merged BASE_LAYER for the
   base group) is visible. For the merged base layer, ALL base cells are visible.
   For variant layers (named `ground_<cell>_…`), that specific cell maps to the
   variant tile when its layer is visible (variant visibility overrides base at
   that cell, matching what's drawn on top).
3. For each chosen cell → tile path, `crop_tile(canvas, …, c*TILE, r*TILE, TILE,
   TILE)` → `write_tile_tex`.

Resolution of "which tile owns a cell": iterate visible variant layers first
(they sit above base); a cell claimed by a visible variant writes the variant
`.tex`; otherwise the base `.tex` at that cell.

### Category apply (`apply_category_psd`)
- **Combined** PSD (single BASE_LAYER atlas): `canvas = flatten_visible(psd)`,
  slice per atlas cell (existing `atlas_cols` layout) → write each tile. Custom
  layers bake into the atlas.
- **Split** PSD (one layer per texture): keep current name-based path BUT use the
  flattened canvas so custom layers above a named tile bake in. Simpler: for
  each named tile layer that is visible, crop its rect from the FLATTENED canvas
  (not the layer's own pixels) so anything painted above it is included.

## Edge cases
- No layers / flatten fails → fall back to `psd.rgba()` (stored composite).
- A cell with no visible tile → skipped (reported), not written.
- Tiled/oversized custom layers → clipped to canvas (already handled by crop).

## Out of scope
- Re-separating a flattened variant back into distinct variant files (you pick
  via visibility instead).
- Editing blend math ourselves (the crate does it).

## Testing
- Reuse the proven `crop_tile` round-trip test (unchanged path).
- Add a unit test: build a 2-layer PSD (a base tile + a fully-opaque red layer
  on top, both visible) via the writer, `flatten_visible` + crop the cell →
  assert the result is the red (top) layer, proving custom layers bake in.
- Manual: paint a Dodge glow layer over the river in the ground PSD, keep Base
  visible, Apply → the glow appears baked into the ground tiles in the live map.
