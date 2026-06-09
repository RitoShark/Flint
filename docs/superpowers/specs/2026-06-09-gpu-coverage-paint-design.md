# GPU Coverage-Pass Painting (render-to-texture) — Design Spec

**Date:** 2026-06-09
**Status:** Approved
**Branch:** backend-refactor
**Replaces:** the screen-space UV readback path + the slow multiPick "paint
through" path. Keeps the tested CPU paint engine (compositeMask/Erase, undo, save).

## 1. Goal

Paint on the 3D map the way Blender's projection paint works: a round brush on
screen = a round mark on the model, at full texture resolution (no dots), fast
(no per-pixel rays), with a correct **Occlude on/off** toggle. Occlude OFF =
paint through to occluded/back surfaces (Blender's "Occlude off").

## 2. Why the current approach fails

- Screen-space UV pass + CPU readback loop: one screen pixel maps to many texels,
  so dabs either stipple or need a gap-fill heuristic. Front-only.
- "Paint through" via `scene.multiPick` on a grid: hundreds of CPU ray-casts per
  dab (×~180 meshes) = severe lag, and the grid shows as visible dots.

Root realization (from Blender's GPU texture-paint design): don't locate texels
from screen space. Render the mesh **into texture space** — the GPU rasterizes
every covered texel at full resolution in one pass.

## 3. Architecture — render to UV, write coverage

For each texture under the brush, per dab:

```
Coverage pass (GPU, render target = a coverage texture sized to the .tex):
  vertex shader:   gl_Position = vec4(uv * 2 - 1, 0, 1);   // UV → clip space
                   vScreen = project(worldPos);             // texel's screen pos
  fragment shader: float d = distance(vScreen.xy, brushCenterPx);
                   float cov = falloff(d / brushRadiusPx, hardness);
                   if (occludeOn) { if (notFrontMost(vScreen)) discard; }
                   gl_FragColor = vec4(cov, 0, 0, 1);
```

- **Every texel** the brush covers gets a coverage value — full res, no dots.
- **Occlude ON:** sample a camera depth pre-pass; discard texels whose surface
  isn't front-most at their screen position → front-only.
- **Occlude OFF:** skip the depth check → all triangles under the brush write
  coverage (front, back, occluded). One-line difference. No rays.

Then (unchanged tested engine):
```
read coverage texture (dirty region) → Float32 per texel
→ compositeMask(rgba, base0, coverage, mode, color)   (or compositeErase)
→ RawTexture.update()
```

### Multi-texture / multi-mesh
Run the coverage pass per texture whose meshes are under the brush (meshes are
grouped by texturePath, as already done). A stroke crossing textures paints each.

### Depth pre-pass (occlude-on only)
Render scene depth from the camera once per dab into a depth RTT; the coverage
shader compares each texel's projected depth to it (with a small bias) to decide
front-most. (Babylon: a DepthRenderer or a simple depth RTT.)

## 4. Components

### `src/lib/babylon/coveragePass.ts` (NEW; replaces uvPaintPass.ts)
- `createCoveragePass(scene)` → `{ render(meshes, texW, texH, brush, occlude, depthTex?), read(region) → Float32Array, dispose() }`.
- A `ShaderMaterial` (uv→clip vertex, coverage fragment) rendered into a
  RenderTargetTexture sized to the texture being painted (FLOAT so coverage is
  smooth). Uniforms: viewProjection, world, brushCenterPx, brushRadiusPx,
  hardness, viewportPx, occludeFlag, depthSampler.
- `read()` uses `_readPixelsSync` over the dirty bbox (coverage texels).

### `src/lib/babylon/depthPass.ts` (NEW, small) — or reuse Babylon DepthRenderer
- Camera-space linear depth RTT for the occlude-on front-most test.

### `paintEngine.ts` — UNCHANGED
compositeMask, compositeErase, falloff, stampMask, blendChannel reused as-is.

### `MapPreview.tsx`
- `paintScreenAt`: for each texture group under the brush, render the coverage
  pass (occlude flag = !paintThrough), read coverage, composite via the engine,
  update. DELETE the multiPick branch and the screen-space readback loop.
- Keep: brush ring (with color), eraser, presets, undo/save, camera panel,
  paint-through toggle (now drives the occlude flag).

## 5. Coverage texel → texture buffer mapping
The coverage RTT is in the SAME UV layout as the texture (we rendered uv→clip),
so coverage texel (x,y) maps 1:1 to texture texel (x,y) — but note the
clip-space Y flip: account for it once (read flips Y like the current pass).
Mesh UVs are pre-V-flipped by the builder; the shader uses raw mesh uv, and the
1:1 mapping means no extra per-texel flip in the composite (verify on first run).

## 6. Error handling
- Pick miss → no-op. Shader/RTT unavailable → skip + log; no crash.
- Coverage RTT reused/resized per painted texture (cache by size).
- Dodge guard already in blendChannel.

## 7. Testing
- paintEngine units unchanged (15 pass).
- New: coveragePass shader is GPU — not unit-testable headless; validate
  manually. Add a unit for any pure helper (e.g. dirty-bbox math).
- Manual gate: (a) front paint solid, no dots, lands under brush; (b) occlude
  OFF paints behind/shadowed surfaces, NO dots, NO lag; (c) multi-texture stroke;
  (d) Dodge/eraser/undo/save still correct.

## 8. Risks
- Per-dab RTT render+readback at texture resolution. Mitigation: render only when
  the dab moved; read only the dirty bbox; if needed, accumulate coverage on the
  GPU across dabs and composite once per frame.
- Depth pre-pass cost for occlude-on: one depth render per dab; cheap vs
  multiPick. Could cache per frame.
- Y-flip / UV orientation between coverage RTT and texture buffer: verify first
  thing (the one likely first-run gotcha).
