# In-App Mesh Projection Painting — Design Spec

**Date:** 2026-06-09
**Status:** Draft for review
**Branch:** backend-refactor
**Part of:** the map editing system — paint directly on the 3D map and save to `.tex`.

## 1. Goal

Paint light/recolor **directly onto the 3D map** in Flint's preview, the way
Riot's artists use Substance Painter: a brush dab is projected through the camera
onto the mesh, the hit point's **UV** is computed, and paint is composited into
the underlying **texture**, updating live on the model and saved back to `.tex`.

This replaces the GIMP round-trip for light maps. The user already does this in
GIMP with a **fading (soft) brush** and **Dodge** blend mode; we bring those
into the app.

### Why this is feasible
Babylon's `scene.pick().getTextureCoordinates()` returns the exact **UV under the
cursor** — the hard 80% of projection painting, already solved by the engine and
documented community pattern (no full library to adopt). The brush engine (soft
falloff, blend modes, flow) is standard per-texel compositing we implement. We
already have `.tex` decode/encode in Rust and live `RawTexture` updates.

### Key constraint surfaced in design
**Wall and ground are separate textures.** A stroke that flows from the ground
onto a rock wall must write into BOTH textures — each hit resolves to *its own*
texture + UV. Multi-texture painting is a first-class requirement, not an edge
case.

## 2. Scope (phased)

Built in verifiable phases — each works before the next:

- **Phase 1 — Core brush, single texture.** Soft/fading brush, blend modes
  (Normal/Dodge/Multiply), size/opacity/flow, eyedropper. Paint one texture,
  live update, save to `.tex`. Edge-dilation so island edges don't leave a hard
  line.
- **Phase 2 — Multi-texture strokes.** A single stroke spanning ground + wall
  writes to every texture it touches. Dirty-tracking per texture; save all.
- **Phase 3 — True seam bleed.** Neighbor-aware bleed across UV-island seams
  (build a seam adjacency map from the mesh) for continuous cross-seam paint.
- **Phase 4 — Undo/redo.** Per-stroke tile snapshots.

### Non-goals
- No layers/masks/channels (not Substance). No normal/height painting (color/
  alpha only). No bin edits. Each phase ships usable; later phases optional.

## 3. Architecture

```
[ Map preview ]  "Paint" mode ON
   pointer down/move (drag) ──► for each step along the stroke:
      scene.pick(x, y)
        ├─ hitMesh, faceId, getTextureCoordinates() → (u, v)
        ├─ resolve hitMesh+face → its TEXTURE id (via submesh span → material)
        └─ stampBrush(texture, u, v, brush)   // composite a dab into that texture's pixel buffer
   ─► mark touched textures dirty; RawTexture.update() each (live)
   "Save" ─► send each dirty texture's RGBA → Rust write_tile_tex → .tex
```

Painting writes into an **in-memory RGBA buffer per texture** (the decoded
pixels), which backs a Babylon `RawTexture` on the material. Each dab updates the
buffer; we `update()` the RawTexture for live feedback. Save re-encodes each
dirty buffer to `.tex` (reuse the existing Rust `write_tile_tex` / encode path —
which now also alpha-bleeds).

### Brush stamp (Phase 1)
For a hit at UV (u,v) on a texture WxH:
- center texel = (u*W, (1-v)*H) [V flip to match texture orientation].
- radius in texels from brush size (UV-space radius × texture dims).
- for each texel in the radius: `falloff = softness(dist/radius)` (Gaussian /
  hardness curve); `strength = opacity * flow * falloff`.
- composite by blend mode: Normal = lerp(dst, color, strength); Dodge =
  dst / (1 - color*strength) clamped; Multiply = lerp(dst, dst*color, strength).
- continuous strokes: interpolate dabs between the previous and current hit UV
  (spacing ≈ radius/4) so dragging paints a line, not dots.

### Multi-texture (Phase 2)
Each dab along a stroke independently resolves its texture; a stroke naturally
writes to several buffers. Track a `Set<textureId>` of dirty textures for the
stroke; `update()` and later save each.

### Seam handling
- **Phase 1–2:** after each stroke, edge-dilate the touched textures' painted
  region (reuse the alpha-bleed algorithm) so paint that reached an island edge
  bleeds a few texels into the transparent gutter → no hard cutoff line.
- **Phase 3:** precompute a **seam adjacency map** — pairs of UV-island edges
  that are the same edge on the 3D mesh (shared 3D vertices, different UVs). When
  a dab lands near a seam edge, also stamp the mirrored position on the
  neighboring island so paint continues across the seam on the model.

## 4. Components

### Frontend
- `src/lib/babylon/paintEngine.ts` (NEW) — texture RGBA buffers, `stampBrush`,
  blend modes, falloff, stroke interpolation, dirty tracking, edge-dilation.
- `src/lib/babylon/seamMap.ts` (NEW, Phase 3) — build/query seam adjacency.
- `MapPreview.tsx` — Paint-mode toolbar (size, hardness, opacity, flow, blend
  mode, color + eyedropper, Save, Undo); pointer handlers route to paintEngine
  when in Paint mode (disables hover/identify while painting).
- `mapPreview.ts` API — `savePaintedTexture(projectPath, texturePath, rgba, w, h)`.

### Rust
- Reuse `write_tile_tex` (decode orig for format → re-encode RGBA → patch byte 8).
  Add `#[command] save_painted_texture(project_path, texture_path, rgba, width,
  height)` that resolves the texture's real path and calls the existing encoder.
  (Encoder already alpha-bleeds via the prior fix — or add it there if not.)

## 5. Data flow / state
- On load, the preview already decodes each texture to RGBA for the RawTexture.
  Paint mode keeps those buffers mutable and writes into them.
- Dirty set of texture ids; Save iterates it. Saved buffers re-uploaded so the
  preview matches disk.

## 6. Error handling
- Pick miss (no face) → no-op. Texture with no writable source (.tex missing) →
  skip + toast. Save failure for one texture → reported, others still saved.
- Dodge division guard (clamp denominator) to avoid NaN/white blowout.

## 7. Testing
- paintEngine unit tests (pure functions, Node): falloff curve, each blend mode
  math (Dodge lightens, Multiply darkens, Normal lerps), stroke interpolation
  spacing, edge-dilation fills gutter.
- Rust: `save_painted_texture` round-trips RGBA → .tex (reuse crop/encode tests).
- Manual per phase: P1 paint a glow on one rock face, live + saved correct;
  P2 paint across ground→wall, both .tex update; P3 paint across a seam, no line;
  P4 undo reverts the last stroke.

## 8. Risks / open items
- **Perf:** stamping large brushes over 2048² buffers each move — throttle to the
  render loop (one composite per frame, accumulate dabs), cap brush size.
- **pick→UV on merged meshes:** our meshes are merged by (layer,texture), so a
  face's UV is in that texture's space — must confirm `getTextureCoordinates()`
  returns the right set on merged geometry (validate first thing in Phase 1).
- **Seam map cost** (Phase 3): building adjacency over millions of tris — scope
  to per-texture, precompute lazily on first paint of that texture.
