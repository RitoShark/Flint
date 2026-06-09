# Mesh Projection Painting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paint light/recolor directly onto the 3D map (pick → UV → composite into the texture → live update → save to .tex), with soft brushes, blend modes, multi-texture strokes, and seam handling.

**Architecture:** A pure-function paint engine (`paintEngine.ts`) composites brush dabs into per-texture RGBA buffers; `MapPreview.tsx` routes pointer events in Paint mode to it (resolving each hit to its texture+UV via Babylon `getTextureCoordinates()` + `resolveFace`), live-updates the `RawTexture`, and saves dirty buffers to `.tex` via the existing Rust encoder.

**Tech Stack:** Babylon.js 9 (RawTexture, scene.pick), React/TS, Tauri (Rust `write_tile_tex`), Vitest for engine unit tests.

---

## Test infra note

The repo has no JS test runner wired yet. Task 0 adds Vitest for the pure engine functions (no Babylon/DOM needed). Rust tests use the existing `cargo test`.

---

## Phase 1 — Core brush, single texture

### Task 0: Vitest setup

**Files:**
- Modify: `package.json` (add vitest devDep + `test` script)
- Create: `vitest.config.ts`

- [ ] **Step 1: Add vitest config**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['src/**/*.test.ts'] } });
```

- [ ] **Step 2: Add script + dep**

In `package.json` scripts add: `"test": "vitest run"`. Install: `npm i -D vitest`.

- [ ] **Step 3: Verify** — Run `npx vitest run` → "No test files found" (exit 0 ok).

- [ ] **Step 4: Commit** — `git add package.json vitest.config.ts package-lock.json && git commit -m "chore: add vitest for paint-engine unit tests"`

---

### Task 1: Blend-mode math

**Files:**
- Create: `src/lib/babylon/paintEngine.ts`
- Test: `src/lib/babylon/paintEngine.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { blendChannel } from './paintEngine';

describe('blendChannel', () => {
  it('Normal lerps dst toward src by strength', () => {
    expect(blendChannel('Normal', 100, 200, 0.5)).toBe(150);
  });
  it('Multiply darkens', () => {
    // dst*src normalized, lerped by strength=1
    expect(blendChannel('Multiply', 200, 128, 1)).toBe(Math.round(200 * 128 / 255));
  });
  it('Dodge lightens and clamps to 255', () => {
    expect(blendChannel('Dodge', 200, 255, 1)).toBe(255);
    expect(blendChannel('Dodge', 100, 0, 1)).toBe(100); // src 0 -> no change
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/lib/babylon/paintEngine.test.ts` → "blendChannel is not a function".

- [ ] **Step 3: Implement**

```ts
export type BlendMode = 'Normal' | 'Dodge' | 'Multiply';

/** Composite one 0..255 channel. strength = opacity*flow*falloff (0..1). */
export function blendChannel(mode: BlendMode, dst: number, src: number, strength: number): number {
  let out: number;
  if (mode === 'Normal') {
    out = dst + (src - dst) * strength;
  } else if (mode === 'Multiply') {
    const m = (dst * src) / 255;
    out = dst + (m - dst) * strength;
  } else { // Dodge: dst / (1 - src), guarded
    const s = (src / 255) * strength;
    const denom = 1 - s;
    out = denom <= 1e-4 ? 255 : (dst / denom);
  }
  return Math.max(0, Math.min(255, Math.round(out)));
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** — `git add src/lib/babylon/paintEngine.ts src/lib/babylon/paintEngine.test.ts && git commit -m "feat(paint): blend-mode channel math (Normal/Dodge/Multiply)"`

---

### Task 2: Brush falloff

**Files:** Modify `paintEngine.ts`, `paintEngine.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { falloff } from './paintEngine';
describe('falloff', () => {
  it('is 1 at center', () => expect(falloff(0, 1)).toBeCloseTo(1));
  it('is 0 at/after radius', () => expect(falloff(1, 1)).toBeCloseTo(0));
  it('hardness=1 is flat (1 until edge)', () => expect(falloff(0.9, 1, 1)).toBeCloseTo(1));
  it('soft (hardness 0) fades before edge', () => expect(falloff(0.5, 1, 0)).toBeLessThan(1));
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```ts
/** dist, radius in same units; hardness 0(soft)..1(hard). Returns 0..1. */
export function falloff(dist: number, radius: number, hardness = 0.5): number {
  if (radius <= 0) return dist === 0 ? 1 : 0;
  const t = dist / radius;
  if (t >= 1) return 0;
  if (t <= hardness) return 1;
  const x = (t - hardness) / (1 - hardness); // 0..1 across the soft band
  return 1 - x * x; // smooth fade to 0
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(paint): brush falloff (hardness)"`

---

### Task 3: Stamp a dab into an RGBA buffer

**Files:** Modify `paintEngine.ts`, `paintEngine.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { stampDab } from './paintEngine';
describe('stampDab', () => {
  it('paints the center texel toward the color (Normal)', () => {
    const W = 4, H = 4;
    const buf = new Uint8Array(W * H * 4).fill(0); // black, alpha 0
    for (let i = 3; i < buf.length; i += 4) buf[i] = 255; // opaque
    stampDab(buf, W, H, 2, 2, /*radiusTexels*/1.5,
      { mode: 'Normal', color: [255, 0, 0], opacity: 1, flow: 1, hardness: 1 });
    const ci = (2 * W + 2) * 4;
    expect(buf[ci]).toBe(255);     // R painted
    expect(buf[ci + 1]).toBe(0);
  });
  it('leaves far texels untouched', () => {
    const W = 8, H = 8;
    const buf = new Uint8Array(W * H * 4); for (let i=3;i<buf.length;i+=4) buf[i]=255;
    stampDab(buf, W, H, 1, 1, 1, { mode:'Normal', color:[255,255,255], opacity:1, flow:1, hardness:1 });
    const far = (6 * W + 6) * 4;
    expect(buf[far]).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```ts
export interface Brush {
  mode: BlendMode;
  color: [number, number, number]; // 0..255 RGB
  opacity: number; // 0..1 max strength
  flow: number;    // 0..1 per-dab build
  hardness: number; // 0..1
}

/** Composite a round dab centered at texel (cx,cy) with radius in texels. */
export function stampDab(buf: Uint8Array, w: number, h: number,
  cx: number, cy: number, radius: number, brush: Brush): void {
  const r = Math.ceil(radius);
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const f = falloff(dist, radius, brush.hardness);
      if (f <= 0) continue;
      const strength = brush.opacity * brush.flow * f;
      const i = (y * w + x) * 4;
      buf[i]     = blendChannel(brush.mode, buf[i],     brush.color[0], strength);
      buf[i + 1] = blendChannel(brush.mode, buf[i + 1], brush.color[1], strength);
      buf[i + 2] = blendChannel(brush.mode, buf[i + 2], brush.color[2], strength);
      // alpha left as-is (don't punch holes in cutouts)
    }
  }
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(paint): stampDab — composite a round brush dab into an RGBA buffer"`

---

### Task 4: Stroke interpolation (UV → texel, spaced dabs)

**Files:** Modify `paintEngine.ts`, `paintEngine.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { strokeDabs, uvToTexel } from './paintEngine';
describe('stroke', () => {
  it('uvToTexel flips V', () => {
    expect(uvToTexel(0.5, 1.0, 100, 100)).toEqual([50, 0]); // v=1 -> top
  });
  it('strokeDabs places spaced points between two texels', () => {
    const pts = strokeDabs([0,0], [10,0], /*radius*/4); // spacing = radius/4 = 1
    expect(pts.length).toBeGreaterThan(5);
    expect(pts[0]).toEqual([0,0]);
    expect(pts[pts.length-1]).toEqual([10,0]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```ts
export function uvToTexel(u: number, v: number, w: number, h: number): [number, number] {
  return [u * w, (1 - v) * h];
}

/** Points from a..b spaced ~radius/4 apart (inclusive of both ends). */
export function strokeDabs(a: [number, number], b: [number, number], radius: number): [number, number][] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  const spacing = Math.max(radius / 4, 0.5);
  const n = Math.max(1, Math.floor(len / spacing));
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([a[0] + dx * t, a[1] + dy * t]);
  }
  return out;
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(paint): uvToTexel + stroke interpolation"`

---

### Task 5: Edge-dilation (seam-line guard, reuse alpha bleed)

**Files:** Modify `paintEngine.ts`, `paintEngine.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { edgeDilate } from './paintEngine';
describe('edgeDilate', () => {
  it('bleeds opaque RGB into adjacent transparent texels', () => {
    const W=3,H=1; const buf=new Uint8Array(W*H*4);
    buf[0]=10; buf[1]=200; buf[2]=40; buf[3]=255; // (0,0) opaque green
    // (1,0),(2,0) transparent white
    buf[4]=255;buf[5]=255;buf[6]=255;buf[7]=0;
    buf[8]=255;buf[9]=255;buf[10]=255;buf[11]=0;
    edgeDilate(buf, W, H, 1);
    expect(buf[4]).toBe(10); expect(buf[5]).toBe(200); expect(buf[7]).toBe(0); // bled, alpha kept
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** (one-pass-per-call, `passes` arg; mirrors the Rust/Py alpha-bleed)

```ts
/** Bleed RGB from opaque texels into adjacent transparent ones, `passes` rings. */
export function edgeDilate(buf: Uint8Array, w: number, h: number, passes = 4): void {
  const N = w * h;
  let filled = new Uint8Array(N);
  for (let p = 0; p < N; p++) filled[p] = buf[p * 4 + 3] !== 0 ? 1 : 0;
  const nb = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
  for (let pass = 0; pass < passes; pass++) {
    const add: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x; if (filled[p]) continue;
      let r=0,g=0,b=0,c=0;
      for (const [dx,dy] of nb) { const nx=x+dx,ny=y+dy;
        if (nx<0||nx>=w||ny<0||ny>=h) continue; const np=ny*w+nx;
        if (filled[np]) { const o=np*4; r+=buf[o];g+=buf[o+1];b+=buf[o+2];c++; } }
      if (c) { const o=p*4; buf[o]=(r/c)|0; buf[o+1]=(g/c)|0; buf[o+2]=(b/c)|0; add.push(p); }
    }
    if (!add.length) break; for (const p of add) filled[p]=1;
  }
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(paint): edgeDilate — bleed paint past island edges (seam guard)"`

---

### Task 6: Rust save command

**Files:**
- Modify: `src-tauri/src/commands/project/map_tiles.rs` (add command, reuse `write_tile_tex` + path resolve)
- Modify: `src-tauri/src/main.rs` (register)
- Modify: `src/lib/api/mapPreview.ts` (binding)

- [ ] **Step 1: Add the command** (resolve the bin texture path to the real .tex, then encode the RGBA). Reuse the existing `resolve_map_texture_path` logic and `write_tile_tex`.

```rust
/// Save a painted RGBA buffer back to its .tex (re-encode in original format).
#[tauri::command]
pub async fn save_painted_texture(
    project_path: String,
    texture_path: String, // bin path, e.g. ASSETS/.../foo.tex
    rgba: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let _guard = PSD_OP_LOCK.lock().await;
    if rgba.len() != (width * height * 4) as usize {
        return Err("rgba size mismatch".into());
    }
    let project = PathBuf::from(&project_path);
    let real = crate::commands::map_preview::resolve_tex_path(&project, &texture_path)
        .ok_or("texture not found")?;
    let img = image::RgbaImage::from_raw(width, height, rgba).ok_or("bad rgba buffer")?;
    write_tile_tex(&real, &img)
}
```

If `resolve_tex_path` is not a reusable fn, inline the same path-resolution used by `resolve_map_texture_path` (read that command and mirror it).

- [ ] **Step 2: Register** in `main.rs` after `save_painted_texture`'s neighbors:
```rust
commands::map_tiles::save_painted_texture,
```

- [ ] **Step 3: Build** — `cd src-tauri && cargo build --lib` → Finished, no errors.

- [ ] **Step 4: Binding** in `mapPreview.ts`:
```ts
export async function savePaintedTexture(projectPath: string, texturePath: string, rgba: Uint8Array, width: number, height: number): Promise<void> {
  return invokeCommand('save_painted_texture', { projectPath, texturePath, rgba: Array.from(rgba), width, height });
}
```

- [ ] **Step 5: Commit** — `git commit -am "feat(paint): save_painted_texture command + binding"`

---

### Task 7: Paint mode wiring in MapPreview (single texture, live)

**Files:** Modify `src/components/preview/MapPreview.tsx`

- [ ] **Step 1: Keep texture buffers mutable.** In `applyTexture`, store the `rgba` buffer alongside the RawTexture so paint can mutate + `update()`. Add a ref:
```ts
const paintBufRef = useRef<Map<string, { tex: RawTexture; rgba: Uint8Array; w: number; h: number }>>(new Map());
```
Populate it where `RawTexture.CreateRGBATexture(rgba, width, height, ...)` is called (store `{tex, rgba: new Uint8Array(rgba), w: width, h: height}` keyed by texPath).

- [ ] **Step 2: Paint state + toolbar.** Add `const [paintMode,setPaintMode]=useState(false)` and brush state (size, hardness, opacity, flow, mode, color). Render a small toolbar when `paintMode`. (Inline-styled, like the existing panel.)

- [ ] **Step 3: Pointer handler.** When `paintMode`, on pointer down/drag: `const pick = scene.pick(x,y); if(!pick?.hit) return; const uv = pick.getTextureCoordinates(); const built = builtRef.current.find(b=>b.mesh===pick.pickedMesh); const span = built && resolveFace(built, pick.faceId); const texPath = span?.texturePath ?? built?.texturePath;` → look up `paintBufRef` entry → `uvToTexel` → `strokeDabs` from last UV → `stampDab` each → `entry.tex.update(entry.rgba)` → mark dirty set. Disable hover/identify while `paintMode`.

- [ ] **Step 4: Save button.** For each dirty texPath, `edgeDilate(entry.rgba, w, h)` then `await api.savePaintedTexture(projectPath, texPath, entry.rgba, w, h)`; toast result; clear dirty.

- [ ] **Step 5: Type-check** — `npx tsc --noEmit` → only pre-existing errors.

- [ ] **Step 6: Commit** — `git commit -am "feat(paint): Phase 1 — projection brush paints one texture live + save"`

---

### Task 8: Phase 1 manual verification gate

- [ ] Launch dev, open a map, enable Paint, pick red + Dodge + soft brush, paint a rock face → it lightens live; Save → reload shows it persisted in the .tex. (If `getTextureCoordinates()` returns wrong UVs on merged meshes, STOP and fix the UV-set resolution before Phase 2 — this is the spec's flagged risk.)

---

## Phase 2 — Multi-texture strokes

### Task 9: Per-dab texture resolution already routes per hit (verify) + dirty set spanning textures

**Files:** Modify `MapPreview.tsx`, add `paintEngine.test.ts` case if logic extracted.

- [ ] The Task 7 handler already resolves texPath per pick, so a stroke crossing ground→wall naturally writes to multiple `paintBufRef` entries. Add: track `dirty: Set<string>`; Save iterates all. Verify by painting across a ground/wall boundary; both `.tex` update.
- [ ] Commit — `git commit -am "feat(paint): Phase 2 — strokes span multiple textures (ground+wall)"`

---

## Phase 3 — True seam bleed

### Task 10: Seam adjacency map

**Files:** Create `src/lib/babylon/seamMap.ts` + `seamMap.test.ts`

- [ ] Build, per texture, pairs of UV edges that share the same 3D edge (same world positions, different UVs). Function `buildSeamMap(positions, uvs, indices) -> Array<{uvA:[number,number,number,number], uvB:[...]}>` (each entry = a seam edge in both islands' UV space). Unit-test on a 2-triangle quad split into 2 UV islands sharing one 3D edge.
- [ ] Commit.

### Task 11: Bleed dab across seams

- [ ] When a dab's texel is within `radius` of a seam edge, also stamp the mirrored position on the neighbor island (map the point across the seam edge via barycentric/edge param). Wire into the stamp path behind a "seam bleed" toggle (default on). Manual: paint across a seam → continuous on the model.
- [ ] Commit — `git commit -am "feat(paint): Phase 3 — neighbor-aware seam bleed"`

---

## Phase 4 — Undo/redo

### Task 12: Per-stroke snapshot undo

**Files:** Modify `MapPreview.tsx`

- [ ] On pointer-down, snapshot the dirty textures' buffers (copy). On pointer-up, push the before-snapshot to an undo stack (cap N). Undo (Ctrl+Z) restores + `update()`. Redo symmetric.
- [ ] Commit — `git commit -am "feat(paint): Phase 4 — per-stroke undo/redo"`

---

## Self-review notes
- Spec coverage: brushes (T1-4), blend modes (T1), soft/fading (T2), size/opacity/flow (T3 brush fields), eyedropper (add in T7 toolbar — sample buf at hit texel), edge-dilation seam guard (T5), save (T6), multi-texture (T9), true seam bleed (T10-11), undo (T12). Eyedropper: in T7 toolbar, add a button that on next click sets brush.color from the picked texel.
- pick→UV merged-mesh risk gated explicitly at Task 8.
- Types consistent: `Brush`, `BlendMode`, `stampDab`, `falloff`, `blendChannel`, `strokeDabs`, `uvToTexel`, `edgeDilate` all defined in Task 1-5 and used as-is later.
