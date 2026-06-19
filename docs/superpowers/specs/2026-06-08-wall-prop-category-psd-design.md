# Wall/Prop Category PSDs — Design Spec

**Date:** 2026-06-08
**Status:** Draft for review
**Branch:** feat/map-preview
**Part of:** the map editing system, Layer 3b (extends the ground-tile stitcher).
**Reuses:** the PSD writer (`core::psd_write`), tile decode (`decode_full_rgba`),
re-encode (`write_tile_tex`), PSD read + crop (`psd` crate + `crop_tile`), and
the apply-by-name pattern — all already built and tested for the ground PSD.

## 1. Goal

Let the user recolor/edit the map's **wall, prop, camp, pit-surround, and river**
textures (everything that isn't the ground grid) via PSDs, the same way the
ground stitcher works. Texture-only — never touches the bin.

The non-ground textures (126 in the current SRX project) have **no grid
coordinates** in their names, so they can't be placed spatially. They are also
too many for one PSD (~2 GB uncompressed). So we split by **category** and lay
each texture out as its **own stacked layer**.

### Non-goals
- No spatial/UV placement (names carry no position; many props share a texture).
- No bin editing. No ground tiles (those have their own PSD).
- No automatic recolor (user edits in GIMP/Photoshop).

## 2. Key facts (verified against the current SRX project)

1. **126 non-ground `.tex`**, almost all 2048×2048 BC3 (median file size =
   2,796,228 bytes = a 2048² BC3). Decoded RGBA = 16 MB each → all-in-one PSD ≈
   2 GB (too heavy). A per-category PSD (~20–40 tiles) ≈ 300–500 MB, comparable
   to the ground PSD (~170 MB) the user already edits smoothly.
2. **No grid coordinates.** Names are like `chaos_top_a`, `chaos_baron_a`,
   `chaos_gromp_a`, `order_mid_b` — team side + role + letter, no `<col><row>`.
3. **~105 of 126 are `_1bitalpha` cutouts** — decode correctly now (BC1 alpha
   fix on this branch); re-encode preserves format via `write_tile_tex`.

## 3. Categories (token-based classification)

A non-ground `.tex` is assigned to the FIRST matching category (case-insensitive
substring on the filename):

| Category | Tokens |
|---|---|
| **Camps** | `gromp`, `krug`, `raptor`, `wolf`, `wolves`, `red`, `blue`, `crab`, `scuttle` |
| **Pits** | `baron`, `dragon` |
| **River** | `river`, `water` |
| **Walls** | `top`, `mid`, `bot`, `base`, `spawn`, `alcove`, `periph`, `wall` |
| **Misc** | (anything else — catch-all, nothing dropped) |

Order matters: Camps/Pits/River checked before Walls so e.g. `baronriver`
(token `river` AND `baron`) lands in **Pits** first? — no: `river` is checked
before walls but after pits, so `BaronRiver` → Pits (baron matches first). This
is fine; the exact bucket only affects which PSD a piece appears in, and Misc
guarantees nothing is lost. The ordering is: Camps → Pits → River → Walls → Misc.

Exclusions (same as ground stitcher): names with `decal`, `wind`, `_vfx`, `_fx`,
`mask`, `noise`, `overlay`, or a numeric `_NN` suffix are skipped. Ground tiles
(`ground_<cell>_…`) are skipped (handled by the ground PSD).

## 4. Architecture

```
[ top bar — map project ]   Category: [ Walls ▾ ]  [ Combine ] [ Apply ]
        │
        ▼
 combine_category_to_psd(project, category)
   • discover non-ground tiles, classify, keep those in `category`
   • decode each .tex → RGBA, make ONE PsdLayer per texture (name = file stem,
     x=0,y=0, full size, visible)
   • write textures-psd/<category>.psd (single group "<Category>")
   • emit file-changed (live tree refresh)
        │
 apply_category_psd(project, category)
   • read <category>.psd, for each layer (by name == stem): crop its rect from
     the canvas, re-encode to its original .tex format (write_tile_tex)
```

Canvas size = the **max width/height among the category's tiles** (they stack at
origin, so the canvas just needs to fit the largest). All layers at (0,0).

## 5. Components

### Rust — extend `src-tauri/src/commands/project/map_tiles.rs`
- `enum WallCategory { Walls, Camps, Pits, River, Misc }` + `fn classify_wall(name) -> Option<WallCategory>` (None for ground/excluded).
- `fn find_wall_tiles(project) -> Vec<(WallCategory, stem, PathBuf)>` — walk the
  texture dirs (reuse the same walk as `find_ground_tiles`), classify non-ground.
- `category_psd_path(project, cat) -> PathBuf` = `textures-psd/<cat>.psd`.
- `#[command] category_psd_exists(project, category: String) -> bool`
- `#[command] combine_category_to_psd(app, project, category: String) -> String`
  - filter to the category, decode, one `PsdLayer` per texture, one `PsdGroup`
    named the category, canvas = max tile dims, `write_psd`, write file, emit.
- `#[command] apply_category_psd(project, category: String) -> ApplyReport`
  - read PSD; for each non-divider layer, look up its `.tex` by stem (a map of
    stem→path for that category); crop the layer rect from `layer.rgba()` using
    the same inclusive-bounds `crop_tile` logic; `write_tile_tex`.
- `category` string parsed to the enum; invalid → error.

### Frontend
- `mapPreview.ts`: `combineCategoryToPsd(projectPath, category)`,
  `applyCategoryPsd(projectPath, category)`, `categoryPsdExists(projectPath, category)`,
  `categoryPsdPath(projectPath, category)`.
- `TitleBar.tsx`: a `<select>` of categories + Combine/Apply buttons (map
  projects only), beside the ground PSD buttons. Confirm-on-overwrite; success/
  error toasts; reuse `psdBtnStyle`.

## 6. Data shapes

```rust
enum WallCategory { Walls, Camps, Pits, River, Misc } // -> "walls"/"camps"/...
// reuses existing: ApplyReport { written, skipped, errors }, PsdDoc/Group/Layer
```
```ts
// reuses ApplyPsdReport. category: 'Walls'|'Camps'|'Pits'|'River'|'Misc'
```

## 7. Error handling
- A category with zero tiles → clear error ("no <category> textures found"); no
  file written.
- Apply with the PSD absent → error toast, no crash.
- A PSD layer matching no texture in that category → counted in `skipped`.
- Re-encode failure for one tile → recorded in `errors`, others still written.

## 8. Testing
- Unit: `classify_wall` — `chaos_top_a`→Walls, `chaos_gromp_a`→Camps,
  `chaos_baron_a`→Pits, `chaos_topriver_a`→Pits (baron? no — has `river`, no
  baron → River) [assert the actual precedence], `ground_a1_x`→None,
  `chaos_x_wind_decal`→None.
- The PSD writer + `crop_tile` round-trip is already proven by the ground
  stitcher's `psd_roundtrip_preserves_tile_pixels` test (same code path), so no
  new writer test is needed; add one `classify_wall` precedence test.
- Manual: Combine "Walls" → open PSD (one layer per wall texture, named) →
  recolor a few → Apply → those `.tex` update, live preview reflects it.

## 9. Open implementation-time decisions (not blockers)
- Exact canvas size policy (max-dims vs fixed 2048) — start with max-dims.
- Whether to also group within a category (e.g. order/chaos subgroups) — start
  flat (one group per PSD); add subgroups later if the layer list is unwieldy.

## 10. Known issue to revisit (not part of this feature)
Applying the **ground** PSD sometimes needs a second press to fully take (first
apply leaves part of the map un-updated). Likely a stale-read or preview-cache
race. Tracked separately; this spec doesn't address it but the same apply path
is shared, so a fix would benefit both.
