# GPU UV-Buffer Projection Painting — Design Spec

**Date:** 2026-06-09
**Status:** Approved
**Branch:** backend-refactor
**Replaces:** the CPU triangle-rasterize paint core (3 failed fixes → wrong
architecture). Keeps the tested paint engine (blend/falloff/stamp/dilate/undo/save).

## 1. Goal

Paint on the 3D map so a round brush ON SCREEN makes a round mark ON THE MODEL
(stencil-like), with correct occlusion and across fragmented UVs — using the
GPU to resolve "which texture UV is under each screen pixel", the way Blender /
Substance projection paint works.

## 2. Why CPU failed (evidence)

Diagnostics proved the CPU path projected the WRONG vertices: `pick.faceId`
indexes the mesh's own buffers, the global pool is rearranged, meshes overlap,
and `proj` froze / scattered. Each fix surfaced a new desync — the signal that
per-triangle CPU rasterization is the wrong model here. The GPU already solves
"what surface is visible at this pixel" via depth test; we use that.

## 3. Architecture

```
Brush stroke segment (screen px, radius):
  1. Render an OFFSCREEN pass from the SAME camera into a RenderTargetTexture,
     where each pixel = the UV of the visible surface there (gl_FragColor =
     vec4(uv.x, uv.y, texId?, 1)). GPU depth test => only the front-most surface
     => occlusion solved, no CPU triangle work, no mesh juggling.
  2. readPixels the small brush-circle region from the RTT.
  3. For each read pixel within the brush radius: decode its UV, map to the
     texture's texel, and stampDab paint into that texture's RGBA buffer using
     the EXISTING paint engine (blend mode, soft falloff, opacity/flow).
  4. RawTexture.update() each touched texture (live). Save/undo unchanged.
```

### Multi-texture (wall + ground separate textures)
Each painted `.tex` is its own texture. The UV pass must tell which texture a
pixel belongs to. Approach: **one UV pass per candidate texture**, masking the
render list to only the meshes that use that texture (RTT
`renderList`/`getCustomRenderList`). A stroke crossing ground→wall runs the pass
for each and paints both. (Alternative — encode a texture id in B channel —
deferred; per-texture passes are simpler and proven.)

Candidate textures = the textures of meshes intersecting the brush; cheapest
correct source: the picked mesh's texture, plus any other mesh whose screen
bounds overlap the brush. Start simple: pass for the picked mesh's texture; if a
stroke needs more, extend to all meshes under the brush region.

### Precision
UV stored in 8-bit RGBA = ~1/256 ≈ 8 texels on a 2048 map. Start 8-bit; if edges
look steppy, switch the RTT to FLOAT (RGBA32F) for exact UVs. (Flagged risk.)

## 4. Components

### New — `src/lib/babylon/uvPaintPass.ts`
- `createUvPass(scene, size)` → `{ rtt: RenderTargetTexture, mat: ShaderMaterial, dispose() }`.
- ShaderMaterial: vertex passes `uv`; fragment writes `vec4(vUV, 0.0, 1.0)`.
- `renderUvFor(meshes): void` — set `rtt.renderList = meshes`, force a render.
- `readUvRegion(rtt, x, y, w, h) → Uint8Array` — readPixels of the brush bbox.

### Reused unchanged — `src/lib/babylon/paintEngine.ts`
blendChannel, falloff, stampDab, uvToTexel, strokeDabs, edgeDilate. (No changes;
only the *source of UVs* changes.) Remove the now-dead CPU-only
`paintTriangleScreen` + `seamMap.ts` (screen/GPU handles seams inherently).

### Changed — `src/components/preview/MapPreview.tsx`
- Replace CPU `paintScreenAt` with the GPU path: render UV pass for the picked
  mesh's texture → readUvRegion over the brush bbox → for each pixel in radius,
  decode UV → stampDab into that texture's buffer → update().
- Keep: paint-mode toggle, brush ring cursor, camera lock, brush controls,
  eyedropper, undo/redo, save, edge-dilate-on-save.
- Remove the `[paintdbg]` diagnostics once verified.

## 5. Data flow / state
- The paint RGBA buffers (`paintBufRef`) + RawTextures stay as-is.
- The UV pass RTT is created once per scene, reused per stroke (cheap; only the
  brush bbox is read back, not the whole frame).

## 6. Error handling
- Pick miss → no-op. RTT/shader unavailable (GL lost) → skip + log; no crash.
- Brush bbox clipped to canvas bounds before readPixels.
- Dodge denominator already guarded in blendChannel.

## 7. Testing
- paintEngine unit tests already cover the brush math (19 passing) — unchanged.
- New: a small unit for the UV-decode (8-bit RGBA → uv → texel) mapping.
- Manual gate (the real proof): paint a dab → it lands UNDER the brush ring as
  one clean mark (no offset, no scatter); occluded back-faces don't get painted;
  a stroke from ground onto wall paints both; save persists; undo reverts.

## 8. Risks
- 8-bit UV precision (mitigation: float RTT).
- Per-texture passes if a stroke spans many textures (mitigation: only meshes
  under the brush; passes are cheap since masked + small readback).
- Reading RTT pixels synchronously each segment — keep the read region tiny
  (brush bbox), throttle to one paint op per frame if needed.
