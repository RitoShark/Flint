# UV Overlay in Info Card — Design Spec

**Date:** 2026-06-08
**Status:** Approved
**Branch:** feat/map-preview
**Part of:** map editing system, an enhancement to the hover/click-identify card.

## Goal
When inspecting a mesh in the map preview, see **where its geometry lands on the
texture** — the mesh's UV wireframe drawn over its decoded texture, in the click
info card. Answers "where is this on the UV map" for texture editing.

## Scope
- Clicked mesh only; draws the **whole merged mesh's** UVs (all triangles using
  that texture). Frontend-only (UVs/indices/submesh ranges already on the client).
- Non-goals: per-texture multi-mesh view, whole-map atlas, UV editing, zoom/pan.

## Data (all already available)
- `dataRef.current`: `uvs: Float32Array` (per-vertex, whole pool), `indices:
  Uint32Array`, `submeshes: SubmeshRange[]` (each with `start_index/index_count`).
- The clicked mesh → `BuiltMapMesh` via `meshByBabylonRef`; its `spans`
  (`startFace`/`faceCount` in the MERGED mesh) — but UVs live in the GLOBAL pool,
  so we use the original submesh ranges instead. Simpler source of truth: collect
  the global index ranges of the submeshes that compose this mesh.
- Mapping mesh → its submeshes: the merged mesh groups submeshes by (layer,
  texture); `IdentifyInfo` carries `meshName`. To get the triangles, gather every
  `data.submeshes[i]` whose (layer, texture) match this mesh. Concretely, store on
  `BuiltMapMesh` the list of source `SubmeshRange`s it merged (we already build
  `spans` with names; extend to keep each span's global `start_index`/`index_count`).

## Architecture
```
[ Info card ]  click a mesh
   [ Show UV ] toggle
        on ▼
   <UvOverlay meshName texturePath projectPath>
     • TextureThumb-style canvas: decode texture (loadMapTexture) -> draw image
     • overlay canvas (same px size): for each triangle of the mesh,
       read 3 vertices' UV from data.uvs, map u->x*W, v->y*H, stroke the triangle
```

## Component: `UvOverlay`
Props: `{ projectPath, texturePath, triUVs: Float32Array }` where `triUVs` is a
flat list of triangle UV coords (6 floats per triangle: u0,v0,u1,v1,u2,v2),
precomputed by the card from `data.uvs` + the mesh's index ranges.

- Renders two stacked canvases (texture below, UV lines above), fixed display
  size (e.g. 256–320px square), `position: relative`.
- Texture canvas: same decode path as `TextureThumb` (loadMapTexture → ImageData).
- UV canvas: clear, then for each triangle stroke a path
  `(u*W, (1-v)*H)` per vertex (V flipped to match image top-left origin),
  thin bright-green lines, slight alpha. Note: the renderer flips V for sampling
  (invertY); for the OVERLAY we draw against the raw image, so use `(1 - v)` so
  the wireframe aligns with how the texture looks in an editor.
- Tiled UVs (outside 0–1): clamp drawing to the canvas (lines may exit the image
  edge); acceptable — note it visually rather than wrapping.

## Card integration
- Add `const [showUv, setShowUv] = useState(false)` (reset when pinnedInfo changes).
- A "Show UV" / "Hide UV" button next to Copy path / Open in editor / Hide mesh.
- When on and `pinnedInfo.texturePath` exists, compute `triUVs` for the clicked
  mesh (from `meshByBabylonRef` → its submesh index ranges → `data.uvs`) and
  render `<UvOverlay>` in the card.

## Builder change (small)
Extend `BuiltMapMesh.spans` items to also carry the **global** index range of each
source submesh (`globalStartIndex`, `indexCount`) so the card can read the right
UVs. (Currently spans carry merged-mesh `startFace`; we add the global index
range, which combine already has from each `SubmeshRange`.)

## Error handling
- No texture → draw UVs on a checkerboard (no image).
- Empty/degenerate UVs → just the (blank) texture, no lines; no crash.
- Decode failure → texture blank, lines still drawn.

## Testing
- Manual: click the dragon pit → Show UV → wireframe traces its layout on the
  pit texture; click a wall → its UV islands appear over the wall texture;
  toggle off hides it. Confirm V orientation matches the texture as seen in GIMP.
- (No unit test infra for TS; logic is simple geometry drawing.)
