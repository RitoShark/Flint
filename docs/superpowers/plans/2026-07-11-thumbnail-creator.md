# Thumbnail Creator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone-window Thumbnail Creator that composes a League skin poster from live 3D SKN models, a fixed decorative disc, and editable text, exported as a still WebP/PNG.

**Architecture:** A separate OS window (map-preview pattern) mounts a React editor. Composition = three stacked planes: a Babylon 3D scene (models + env + glow) behind a DOM decoration overlay behind a DOM text overlay. Presets are JSON. Export composites the Babylon screenshot + overlays onto a 2D canvas → WebP/PNG.

**Tech Stack:** Rust/Tauri 2 (window + IPC), React 18 + TS, Babylon.js (reusing Flint's `src/lib/babylon/*`), Vitest, design-lab CSS.

## Global Constraints

- **NEVER run `cargo build`/`cargo check` standalone** — the dev server compiles Rust. To verify Rust, use `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return` (safe, no cache wipe).
- **TS typecheck:** `npx tsc --noEmit` (safe).
- **JS/TS unit tests:** `npx vitest run <file>`.
- **No `Co-Authored-By:` in commits.** Short imperative messages.
- **No `#[allow(dead_code)]` / `#[allow(unused_*)]`** — delete unused code instead.
- **All new UI uses design-lab `.dl-*`** classes (Flint theme: `themes/default.css` red accent). Editor chrome/selection/handles read `--accent-primary`.
- **Binary IPC uses raw bytes**, not JSON `Vec<u8>` (see CLAUDE.md "Raw-bytes IPC").
- **ritoshark pinned rev must stay identical** in `src-tauri/Cargo.toml` AND `crates/flint-ltk/Cargo.toml` (don't touch unless required).
- **Window label:** `thumbnail`. **Preset ids:** `riot`, `divine`. **Canvas authoring size:** 640×360 (16:9).
- Reuse, do NOT fork: `src/lib/babylon/{meshBuilder,skeletonBuilder,animationPlayer,engine}.ts`; commands `read_skn_mesh`, `read_skl_skeleton`, `read_animation_list`, `read_animation`, `resolve_asset_path`, `decode_texture_disk`, `save_file_bytes`.

---

## Phase 1 — Window shell + launch

### Task 1: Rust command to open the thumbnail window

**Files:**
- Create: `src-tauri/src/commands/project/thumbnail_window.rs`
- Modify: `src-tauri/src/commands/project/mod.rs` (add `pub mod thumbnail_window;` + re-export)
- Modify: `src-tauri/src/main.rs` (register command in `invoke_handler`)
- Modify: `src-tauri/capabilities/default.json` (add `"thumbnail"` to `windows`)

**Interfaces:**
- Produces: `#[tauri::command] async fn open_thumbnail_window(app, project_path: String, skn_path: String) -> Result<(), String>` — opens/focuses a window labeled `thumbnail` at `index.html#thumbnail?project=<enc>&skn=<enc>`.

- [ ] **Step 1: Write the command** (mirror `map_preview.rs::open_map_preview_window` + `encode_query_component`)

```rust
//! Opens the separate Thumbnail Creator window. Mirrors the map-preview window
//! pattern: reuse-by-label, unique WebView2 data dir + matching browser args on
//! Windows (the 0x8007139F guard). See CLAUDE.md "Multi-window pattern".

/// Percent-encode a path for a URL hash query (dependency-free).
fn encode_query_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[tauri::command]
pub async fn open_thumbnail_window(
    app: tauri::AppHandle,
    project_path: String,
    skn_path: String,
) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    const LABEL: &str = "thumbnail";

    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.set_focus();
        return Ok(());
    }

    let url = format!(
        "index.html#thumbnail?project={}&skn={}",
        encode_query_component(&project_path),
        encode_query_component(&skn_path),
    );

    // MUST match `additionalBrowserArgs` in tauri.conf.json.
    const MAIN_BROWSER_ARGS: &str =
        "--disable-features=msSmartScreenProtection --disable-background-networking --disable-translate";
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("webview-thumbnail");
    let _ = std::fs::create_dir_all(&data_dir);

    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App(url.into()))
        .title("Flint — Thumbnail Creator")
        .inner_size(1280.0, 800.0)
        .resizable(true)
        .additional_browser_args(MAIN_BROWSER_ARGS)
        .data_directory(data_dir)
        .build()
        .map_err(|e| format!("Failed to open thumbnail window: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encodes_reserved_chars() {
        assert_eq!(encode_query_component("a/b c"), "a%2Fb%20c");
        assert_eq!(encode_query_component("Skin.skn"), "Skin.skn");
    }
}
```

- [ ] **Step 2: Wire module + registration + capability**

In `commands/project/mod.rs` add `pub mod thumbnail_window;` and (matching the file's existing re-export style) `pub use thumbnail_window::*;`.
In `main.rs` `invoke_handler![...]` add `commands::project::open_thumbnail_window,` (near `open_map_preview_window`).
In `capabilities/default.json`, add `"thumbnail"` to the `windows` array.

- [ ] **Step 3: Verify clippy is clean**

Run: `cargo clippy --lib --bins -- -D warnings -A clippy::needless_return`
Expected: no warnings/errors for the new file.

- [ ] **Step 4: Run the unit test**

Run: `cargo test -p flint --lib thumbnail_window`  (or the binary crate's test name)
Expected: `encodes_reserved_chars` PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/project/thumbnail_window.rs src-tauri/src/commands/project/mod.rs src-tauri/src/main.rs src-tauri/capabilities/default.json
git commit -m "feat: open_thumbnail_window command + capability"
```

---

### Task 2: Frontend window bootstrap + empty editor

**Files:**
- Create: `src/components/thumbnail/ThumbnailWindow.tsx`
- Create: `src/components/thumbnail/ThumbnailEditor.tsx`
- Create: `src/lib/thumbnail/params.ts`
- Modify: `src/main.tsx` (mount `ThumbnailWindow` on `#thumbnail`)
- Test: `src/lib/thumbnail/params.test.ts`

**Interfaces:**
- Produces: `parseThumbnailParams(hash: string): { project: string; skn: string }` in `params.ts`.
- Produces: `<ThumbnailWindow/>` (reads params, renders `<ThumbnailEditor project skn/>`).
- Produces: `<ThumbnailEditor project: string; skn: string/>` — the editor shell (empty in this task).

- [ ] **Step 1: Write the failing test for param parsing**

```ts
// src/lib/thumbnail/params.test.ts
import { describe, it, expect } from 'vitest';
import { parseThumbnailParams } from './params';

describe('parseThumbnailParams', () => {
  it('decodes project + skn from the hash query', () => {
    const p = parseThumbnailParams('#thumbnail?project=C%3A%2Fp&skn=hero.skn');
    expect(p).toEqual({ project: 'C:/p', skn: 'hero.skn' });
  });
  it('returns empties when missing', () => {
    expect(parseThumbnailParams('#thumbnail')).toEqual({ project: '', skn: '' });
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/lib/thumbnail/params.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `params.ts`**

```ts
// src/lib/thumbnail/params.ts
export interface ThumbnailParams { project: string; skn: string; }

export function parseThumbnailParams(hash: string): ThumbnailParams {
  const q = hash.indexOf('?');
  const search = q >= 0 ? hash.slice(q + 1) : '';
  const sp = new URLSearchParams(search);
  return { project: sp.get('project') ?? '', skn: sp.get('skn') ?? '' };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run src/lib/thumbnail/params.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the editor shell + window**

```tsx
// src/components/thumbnail/ThumbnailEditor.tsx
import '../../styles/design-lab.css';

export function ThumbnailEditor({ project, skn }: { project: string; skn: string }) {
  return (
    <div className="dl-root" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 12, borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>Thumbnail Creator</strong>
        <span className="dl-badge">{skn.split(/[\\/]/).pop()}</span>
      </div>
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
        Editor mounts here — project: {project || '(none)'}
      </div>
    </div>
  );
}
```

```tsx
// src/components/thumbnail/ThumbnailWindow.tsx
import { parseThumbnailParams } from '../../lib/thumbnail/params';
import { ThumbnailEditor } from './ThumbnailEditor';

export function ThumbnailWindow() {
  const { project, skn } = parseThumbnailParams(window.location.hash);
  return <ThumbnailEditor project={project} skn={skn} />;
}
```

- [ ] **Step 6: Bootstrap in `main.tsx`**

Add an import `import { ThumbnailWindow } from './components/thumbnail/ThumbnailWindow';`.
Add `const isThumbnail = typeof window !== 'undefined' && window.location.hash.startsWith('#thumbnail');`.
In the `root.render(...)` ternary, add — BEFORE the `isMapPreview` branch — `isThumbnail ? React.createElement(ThumbnailWindow) : isMapPreview ? ... `. (No StrictMode, matching map-preview.)

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/thumbnail/ src/lib/thumbnail/params.ts src/lib/thumbnail/params.test.ts src/main.tsx
git commit -m "feat: thumbnail window bootstrap + empty editor"
```

---

### Task 3: Right-click launch

**Files:**
- Modify: `src/lib/editor/fileContextMenuOptions.ts` (add "Create Thumbnail…" for `.skn`)
- Create: `src/lib/api/thumbnail.ts`

**Interfaces:**
- Consumes: `open_thumbnail_window` command (Task 1).
- Produces: `openThumbnailWindow(project: string, skn: string): Promise<void>` in `api/thumbnail.ts`.

- [ ] **Step 1: Add the API wrapper**

```ts
// src/lib/api/thumbnail.ts
import { invoke } from '@tauri-apps/api/core';
export function openThumbnailWindow(project: string, skn: string): Promise<void> {
  return invoke('open_thumbnail_window', { projectPath: project, sknPath: skn });
}
```

- [ ] **Step 2: Add the context-menu item**

In `fileContextMenuOptions.ts`, for a file whose extension is `skn`, add an option `{ label: 'Create Thumbnail…', action: () => openThumbnailWindow(<projectPath>, <absoluteFilePath>) }`. Derive `projectPath` the same way sibling options in that file do (follow the existing pattern for how project path + file path are obtained — do not invent a new mechanism). Import `openThumbnailWindow` from `../api/thumbnail`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual smoke (documented, not automated)**

In `npm run tauri dev`: right-click a `.skn` → "Create Thumbnail…" opens a window titled "Flint — Thumbnail Creator" showing the SKN filename badge. (No automated test — window opening is integration-level.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/thumbnail.ts src/lib/editor/fileContextMenuOptions.ts
git commit -m "feat: right-click .skn to open Thumbnail Creator"
```

---

## Phase 2 — Editor UX port (layers, artboard, interactions)

The prototype at `.superpowers/brainstorm/1048-1783710866/content/editor-v10.html` is the reference implementation for ALL Phase-2 behavior — port its logic into typed React/TS modules. Read it for exact drag/resize/zoom math.

### Task 4: Layer model + operations (pure, unit-tested)

**Files:**
- Create: `src/lib/thumbnail/layers.ts`
- Test: `src/lib/thumbnail/layers.test.ts`

**Interfaces:**
- Produces types:
```ts
export type LayerType = 'model' | 'text' | 'disc' | 'deco' | 'env';
export interface BaseLayer { id: string; type: LayerType; name: string; hidden: boolean; rot: number; locked: boolean; x: number; y: number; w: number; h: number; }
export interface TextLayer extends BaseLayer { type: 'text'; text: string; size: number; font: string; italic: boolean; spacing: number; }
export interface ModelLayer extends BaseLayer { type: 'model'; sknPath: string; anim: string; frame: number; maxFrame: number; scale: number; orbit: number; }
export interface DiscLayer extends BaseLayer { type: 'disc'; opacity: number; } // fixed composite
export interface DecoLayer extends BaseLayer { type: 'deco'; asset: string; z: 'front' | 'behind'; }
export type Layer = TextLayer | ModelLayer | DiscLayer | DecoLayer;
```
- Produces fns: `addLayer(list, layer): Layer[]`, `removeLayer(list, id): Layer[]`, `updateLayer(list, id, patch): Layer[]`, `toggleLock(list, id): Layer[]`, `serialize(list): string`, `deserialize(json): Layer[]`.

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/thumbnail/layers.test.ts
import { describe, it, expect } from 'vitest';
import { addLayer, removeLayer, updateLayer, toggleLock, serialize, deserialize } from './layers';

const t = (over = {}): any => ({ id: 'a', type: 'text', name: 'T', hidden: false, rot: 0, locked: false, x: 0, y: 0, w: 10, h: 10, text: 'X', size: 20, font: 'F', italic: false, spacing: 0, ...over });

describe('layers', () => {
  it('adds to front (index 0)', () => { const l = addLayer([t({ id: 'a' })], t({ id: 'b' })); expect(l[0].id).toBe('b'); });
  it('removes by id', () => { expect(removeLayer([t({ id: 'a' }), t({ id: 'b' })], 'a').map(x => x.id)).toEqual(['b']); });
  it('updates a patch', () => { expect(updateLayer([t({ id: 'a', x: 0 })], 'a', { x: 5 })[0].x).toBe(5); });
  it('toggles lock', () => { expect(toggleLock([t({ id: 'a', locked: false })], 'a')[0].locked).toBe(true); });
  it('round-trips via serialize/deserialize', () => { const l = [t({ id: 'a' })]; expect(deserialize(serialize(l))).toEqual(l); });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run src/lib/thumbnail/layers.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `layers.ts`** (types above + pure fns)

```ts
// (types as in Interfaces block)
export function addLayer(list: Layer[], layer: Layer): Layer[] { return [layer, ...list]; }
export function removeLayer(list: Layer[], id: string): Layer[] { return list.filter(l => l.id !== id); }
export function updateLayer(list: Layer[], id: string, patch: Partial<Layer>): Layer[] {
  return list.map(l => (l.id === id ? ({ ...l, ...patch } as Layer) : l));
}
export function toggleLock(list: Layer[], id: string): Layer[] {
  return list.map(l => (l.id === id ? { ...l, locked: !l.locked } : l));
}
export function serialize(list: Layer[]): string { return JSON.stringify(list); }
export function deserialize(json: string): Layer[] { return JSON.parse(json) as Layer[]; }
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run src/lib/thumbnail/layers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/thumbnail/layers.ts src/lib/thumbnail/layers.test.ts
git commit -m "feat: thumbnail layer model + ops"
```

---

### Task 5: Undo/redo store (snapshot-based, unit-tested)

**Files:**
- Create: `src/lib/thumbnail/history.ts`
- Test: `src/lib/thumbnail/history.test.ts`

**Interfaces:**
- Consumes: `Layer[]` + `serialize`/`deserialize` (Task 4).
- Produces: `createHistory(initial: Layer[])` → `{ get(): Layer[]; set(next: Layer[], record?: boolean): void; undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean; }`. `set(next, true)` pushes the PREVIOUS state onto the undo stack (mirrors prototype `act()`); `set(next, false)` replaces without recording.

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/thumbnail/history.test.ts
import { describe, it, expect } from 'vitest';
import { createHistory } from './history';
const L = (x: number): any => [{ id: 'a', type: 'text', name: 'T', hidden: false, rot: 0, locked: false, x, y: 0, w: 1, h: 1, text: '', size: 1, font: '', italic: false, spacing: 0 }];

describe('history', () => {
  it('undo restores previous recorded state', () => {
    const h = createHistory(L(0));
    h.set(L(5), true);
    expect(h.get()[0].x).toBe(5);
    h.undo();
    expect(h.get()[0].x).toBe(0);
  });
  it('redo re-applies', () => { const h = createHistory(L(0)); h.set(L(5), true); h.undo(); h.redo(); expect(h.get()[0].x).toBe(5); });
  it('canUndo/canRedo flags', () => { const h = createHistory(L(0)); expect(h.canUndo()).toBe(false); h.set(L(1), true); expect(h.canUndo()).toBe(true); });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/lib/thumbnail/history.test.ts` → FAIL.

- [ ] **Step 3: Implement `history.ts`**

```ts
import { Layer } from './layers';
export function createHistory(initial: Layer[]) {
  let current = JSON.stringify(initial);
  const undo: string[] = [], redo: string[] = [];
  return {
    get: (): Layer[] => JSON.parse(current),
    set(next: Layer[], record = false) {
      const s = JSON.stringify(next);
      if (record && s !== current) { undo.push(current); if (undo.length > 100) undo.shift(); redo.length = 0; }
      current = s;
    },
    undo() { if (undo.length) { redo.push(current); current = undo.pop()!; } },
    redo() { if (redo.length) { undo.push(current); current = redo.pop()!; } },
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
  };
}
```

- [ ] **Step 4: Run, verify pass** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/thumbnail/history.ts src/lib/thumbnail/history.test.ts
git commit -m "feat: thumbnail undo/redo history"
```

---

### Task 6: Artboard component — render + drag/resize/zoom/pan/overlay-handles

**Files:**
- Create: `src/components/thumbnail/ThumbnailArtboard.tsx`
- Create: `src/styles/thumbnail.css`
- Modify: `src/components/thumbnail/ThumbnailEditor.tsx` (host artboard + panels; will be filled across Phase 2)

**Interfaces:**
- Consumes: `Layer[]`, `updateLayer` (Task 4).
- Produces: `<ThumbnailArtboard layers selId onSelect(id) onChange(next, record) />`. Renders each layer as a positioned DOM element (placeholder bodies for model/deco this phase); selection chrome (box + 4 corner handles) rendered in a SEPARATE overlay above all elements (`z-index:999`, `overflow:visible`) so handles beat selection and are grabbable outside the artboard. Zoom via Alt+wheel to cursor; Ctrl+0/1/9 fit/100%/fit-sel; Space/middle-drag pan. Shift = axis-lock (move) / aspect-lock (resize). Locked layers: no handles, no move/resize.

Port the exact math from prototype `editor-v10.html` functions: `centerOn`, `fitView`, `fullView`, `fitSelection`, the Alt-wheel handler, `startMove` (with `ev.shiftKey` axis-lock), `startResize` (with `ev.shiftKey` aspect-lock + opposite-corner pinning), `renderSelOverlay`.

- [ ] **Step 1: Port artboard structure + CSS** — Create `thumbnail.css` from the prototype's app CSS `.viewport`/`.stage`/`.stage-wrap`/`.el`/`#selOverlay`/`.selbox2`/`.hnd` blocks (theme-driven `--accent-primary`). Create the component rendering `viewport > stageWrap(transform) > stage(640×360, overflow hidden) > env + elements`, plus a sibling `#selOverlay` in `stageWrap`.

- [ ] **Step 2: Port interactions** — drag-move, corner-resize (overlay handles with their own pointerdown + stopPropagation), Alt-wheel zoom, Ctrl+0/1/9, Space/middle pan, Shift constrain, locked guard. Every committed gesture calls `onChange(next, /*record*/true)`; live drag frames call `onChange(next, false)`.

- [ ] **Step 3: Host it in the editor** — `ThumbnailEditor` holds `history` (Task 5) + `selId` state; passes `history.get()` as `layers`, `onChange=(n,rec)=>{history.set(n,rec); forceRender();}`. Wire Ctrl+Z/Shift+Z to `history.undo/redo`.

- [ ] **Step 4: Typecheck + manual smoke**

Run: `npx tsc --noEmit` → no errors.
Manual (dev): open the window, a placeholder text layer drags/resizes; Alt+scroll zooms; Ctrl+0 fits; Ctrl+Z undoes a move.

- [ ] **Step 5: Commit**

```bash
git add src/components/thumbnail/ThumbnailArtboard.tsx src/styles/thumbnail.css src/components/thumbnail/ThumbnailEditor.tsx
git commit -m "feat: thumbnail artboard with drag/resize/zoom/undo"
```

---

### Task 7: Layers panel + Properties panel + draggable divider

**Files:**
- Create: `src/components/thumbnail/LayersPanel.tsx`
- Create: `src/components/thumbnail/PropertiesPanel.tsx`
- Modify: `src/components/thumbnail/ThumbnailEditor.tsx` (right sidebar: Layers top, divider, Properties bottom; artboard left)
- Modify: `src/styles/thumbnail.css` (sidebar + splitter, from prototype)

**Interfaces:**
- Consumes: `Layer[]`, `toggleLock`, `removeLayer`, `updateLayer` (Task 4).
- Produces: `<LayersPanel layers selId onSelect onToggleHidden onToggleLock onDelete />` (grouped rows: Foreground/Models/Behind/Background; per-row eye + 🔒 lock + ✕ delete). `<PropertiesPanel layer onChange />` (switches per layer type: text → content/size/spacing/italic; model → anim/frame/scale/orbit; disc → opacity; deco → asset/depth; all types → lock toggle; NO text color picker — that's Phase 6 hue).

- [ ] **Step 1: Build LayersPanel** — port `renderLayers`/`layerRow` from the prototype into a React component using `.dl-*`/`.layer` classes. Lock icon toggles via `onToggleLock`.

- [ ] **Step 2: Build PropertiesPanel** — port `renderProps` per-type branches into React, using `.dl-input`/`.dl-select`/`.rng`/`.seg`. Every input change → `onChange(patch, record=true on commit, false on live drag)`.

- [ ] **Step 3: Sidebar layout + draggable divider** — right column with Layers (top), a draggable `.side-split` (port the prototype's splitter pointer handlers), Properties (bottom). Artboard occupies the left.

- [ ] **Step 4: Typecheck + manual smoke**

Run: `npx tsc --noEmit` → no errors.
Manual: select a layer → its props show; lock icon pins it; divider drags.

- [ ] **Step 5: Commit**

```bash
git add src/components/thumbnail/LayersPanel.tsx src/components/thumbnail/PropertiesPanel.tsx src/components/thumbnail/ThumbnailEditor.tsx src/styles/thumbnail.css
git commit -m "feat: thumbnail layers + properties panels + divider"
```

---

## Phase 3 — SKN 3D scene

### Task 8: `studioScene.ts` — Babylon scene host (SKN load + anim + frame scrub + screenshot)

**Files:**
- Create: `src/lib/thumbnail/studioScene.ts`

**Interfaces:**
- Consumes: `buildSknMeshes` (meshBuilder), `buildBabylonSkeleton` (skeletonBuilder), `AnimationPlayer` (animationPlayer), `createEngine` (engine); commands `read_skn_mesh`, `read_skl_skeleton`, `read_animation_list`, `read_animation`. Read `ModelPreview.tsx` (lines ~450–740) for the EXACT load+anim call sequence and DTO types — reuse them verbatim.
- Produces: `createThumbnailScene(canvas): { addModel(sknPath): Promise<ModelHandle>; removeModel(id); setModelTransform(id, {x,y,w,h,scale,orbit}); setModelAnim(id, anim); setModelFrame(id, frame); listAnims(id): AnimClip[]; setEnvImage(path, fit); setGlow(id, on, intensity); screenshot(w,h): Promise<Blob>; dispose(); }`. `ModelHandle = { id: string; maxFrame: number }`.

Model screen-space placement: render each model into its own `RenderTargetTexture` sized to the model layer's w/h, then the DOM `model` element shows that RT as its background (via a canvas). This decouples model placement from the shared camera so each model's artboard x/y/w/h positions it independently. Frame scrub = advance the model's `AnimationPlayer` to `frame/maxFrame * duration` then pause.

- [ ] **Step 1: Port the SKN load path** — Adapt `ModelPreview.tsx`'s load sequence (read_skn_mesh → buildSknMeshes; read_skl_skeleton → buildBabylonSkeleton; textures via existing path) into `addModel`. Keep the same camera-framing (Y-weighted radius) as ModelPreview.

- [ ] **Step 2: Port animation** — `listAnims` via `read_animation_list`; `setModelAnim`/`setModelFrame` construct/drive an `AnimationPlayer` (read_animation → baked DTO), paused at the scrub frame.

- [ ] **Step 3: Env background + glow + screenshot** — port Jade `studioScene.ts` `setBackground(image, fit)` (`applyBgLayerTransform` cover/contain/stretch) and glow layer; `screenshot(w,h)` via `Tools.CreateScreenshotUsingRenderTarget`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit` → no errors.

- [ ] **Step 5: Manual verification (SKN correctness gate)** — In dev, load a real champion `.skn` (e.g. the reference Yone), confirm textures render, an animation lists + scrubs to a frame, and the model appears in the artboard.

- [ ] **Step 6: Commit**

```bash
git add src/lib/thumbnail/studioScene.ts
git commit -m "feat: thumbnail Babylon scene (SKN load, anim scrub, screenshot)"
```

---

### Task 9: Wire model layers to the scene

**Files:**
- Modify: `src/components/thumbnail/ThumbnailArtboard.tsx` (mount a canvas per model layer; drive scene from model-layer props)
- Modify: `src/components/thumbnail/PropertiesPanel.tsx` (populate anim dropdown from `listAnims`)

**Interfaces:**
- Consumes: `createThumbnailScene` (Task 8), `ModelLayer` (Task 4).

- [ ] **Step 1: Instantiate the scene** once per artboard; for each `model` layer call `addModel(sknPath)`, then reflect its x/y/w/h/scale/orbit via `setModelTransform`, `anim`/`frame` via `setModelAnim`/`setModelFrame`. Remove on layer delete.
- [ ] **Step 2: Anim dropdown** in PropertiesPanel filled from `listAnims(layerId)`; frame slider max = `maxFrame`.
- [ ] **Step 3: Typecheck + manual** — model layer shows the real SKN; changing anim/frame updates it; dragging moves the render.
- [ ] **Step 4: Commit**

```bash
git add src/components/thumbnail/ThumbnailArtboard.tsx src/components/thumbnail/PropertiesPanel.tsx
git commit -m "feat: bind model layers to Babylon scene"
```

---

## Phase 4 — Presets + disc

### Task 10: Preset engine + shipped presets + disc assets

**Files:**
- Create: `src/lib/thumbnail/preset.ts`
- Create: `src/lib/thumbnail/presets/riot.json` (from the user's saved state; 3 disc pieces collapsed to one `disc` layer)
- Create: `src/lib/thumbnail/presets/divine.json`
- Create: `src-tauri/resources/thumbnail/ring.webp`, `glow.webp` (convert `circle-precut.png`/`circle-glow-bg-precut.png`)
- Modify: `src-tauri/tauri.conf.json` (bundle `resources/thumbnail/*`)
- Create: Rust command `load_thumbnail_asset(name) -> raw bytes` in `thumbnail_window.rs`
- Test: `src/lib/thumbnail/preset.test.ts`

**Interfaces:**
- Produces: `Preset` type `{ preset: 'riot'|'divine'; font: string; hue: number; canvas: {w,h,ratio}; layers: Layer[] }`; `loadPreset(id): Preset`; `presetToLayers(p): Layer[]`.
- Produces: `#[tauri::command] async fn load_thumbnail_asset(app, name: String) -> Result<tauri::ipc::Response, String>` returning the webp bytes for `ring`/`glow`.

- [ ] **Step 1: Convert PNGs → WebP** — convert the two circle PNGs (in `e:/RitoShark/Flint/`) to WebP, place under `src-tauri/resources/thumbnail/`. Add the dir to `tauri.conf.json` `bundle.resources`.
- [ ] **Step 2: Author `riot.json`** — the user's saved preset, with the ring + black-fill + interior-disc merged into ONE `disc` layer (`type:'disc'`, `locked:true`, `opacity:20`, geometry = the saved ring/disc box). Title "MOD NAME", subtitle "Character". `font:"Beaufort for LOL"`, `hue:210`. Author `divine.json` (Albiero, Teemo-style positions; no disc).
- [ ] **Step 3: Write failing test** for `loadPreset('riot')` → returns a preset whose layers include exactly one `disc` (locked) and two `text` layers.
- [ ] **Step 4: Implement `preset.ts`** (import JSON, validate shape, return typed `Preset`). Run test → PASS.
- [ ] **Step 5: Rust asset command** — `load_thumbnail_asset` resolves `resource_dir()/thumbnail/<name>.webp`, returns raw bytes (register in main.rs). Clippy clean.
- [ ] **Step 6: Render disc** — in `ThumbnailArtboard`, a `disc` layer renders the interior-disc webp (behind models) + a 20%-opacity black circle + ring webp (front) at the fixed geometry; no handles, delete-only.
- [ ] **Step 7: Preset picker** — topbar dropdown swaps preset via `presetToLayers`.
- [ ] **Step 8: Typecheck + vitest + manual + commit**

```bash
git add src/lib/thumbnail/preset.ts src/lib/thumbnail/presets/ src/lib/thumbnail/preset.test.ts src-tauri/resources/thumbnail/ src-tauri/tauri.conf.json src-tauri/src/commands/project/thumbnail_window.rs src-tauri/src/main.rs src/components/thumbnail/ThumbnailArtboard.tsx
git commit -m "feat: thumbnail preset engine + riot/divine presets + disc composite"
```

---

## Phase 5 — Text: auto-shrink + multi-line

### Task 11: `textFit.ts` — fit + multi-line layout

**Files:**
- Create: `src/lib/thumbnail/textFit.ts`
- Test: `src/lib/thumbnail/textFit.test.ts`
- Modify: `src/components/thumbnail/ThumbnailArtboard.tsx` (apply fit; Enter inserts newline; bottom-anchored)

**Interfaces:**
- Produces: `fitFontSize(measure: (text: string, size: number) => {w:number;h:number}, lines: string[], boxW: number, boxH: number, maxSize: number, minSize?: number): number` — largest size ≤ maxSize where every line fits `boxW` and total height fits `boxH`. Pure (measure injected → testable with a fake).

- [ ] **Step 1: Failing test** with a fake measure (`w = text.length * size * 0.6`, `h = size`):
```ts
import { fitFontSize } from './textFit';
const measure = (t: string, s: number) => ({ w: t.length * s * 0.6, h: s });
// "WIDE" (4 chars) in a 100px box: 4*0.6*s <= 100 → s <= ~41
expect(fitFontSize(measure, ['WIDE'], 100, 200, 60)).toBeLessThanOrEqual(42);
expect(fitFontSize(measure, ['A'], 1000, 1000, 40)).toBe(40); // fits at max
```
- [ ] **Step 2: Run, fail.** **Step 3: Implement** (step down from maxSize until every line's `w<=boxW` and `Σh<=boxH`). **Step 4: Run, pass.**
- [ ] **Step 5: Apply in artboard** — text rendered size = `fitFontSize(canvasMeasure, layer.text.split('\n'), w, h, layer.size)`. Inline edit: **Enter inserts `\n`** (not commit); text block is **bottom-anchored** (rows grow upward — CSS `justify-content:flex-end` on a column, or top adjusts by added row height). Shift+Enter/Escape/blur commits.
- [ ] **Step 6: Typecheck + vitest + manual + commit**

```bash
git add src/lib/thumbnail/textFit.ts src/lib/thumbnail/textFit.test.ts src/components/thumbnail/ThumbnailArtboard.tsx
git commit -m "feat: thumbnail text auto-shrink + multi-line"
```

---

## Phase 6 — Global hue theme

### Task 12: `hue.ts` + Theme panel

**Files:**
- Create: `src/lib/thumbnail/hue.ts`
- Test: `src/lib/thumbnail/hue.test.ts`
- Create: `src/components/thumbnail/ThemePanel.tsx`
- Modify: `ThumbnailArtboard.tsx` (text color + glow tint from hue), `ThumbnailEditor.tsx` (hold `hue` state + ThemePanel)

**Interfaces:**
- Produces: `resolveTextColor(preset: 'riot'|'divine', hue: number, baseHex: string): string` — Riot mixes ~12% hue into base (subtle); Divine mixes ~80% (significant). `resolveGlowColor(hue): string`. Pure, unit-tested.

- [ ] **Step 1: Failing tests** — Riot output stays close to base (small delta); Divine output is close to the pure hue color; both valid hex.
- [ ] **Step 2: Run, fail. Step 3: Implement** hue→rgb + mix ratios per preset. **Step 4: Run, pass.**
- [ ] **Step 5: Wire** — text layers render with `resolveTextColor(preset, hue, layer baseColor)`; glow uses `resolveGlowColor(hue)`. Remove any leftover per-text color UI. `ThemePanel` = one hue slider (0–360) writing `hue` state; artboard re-renders.
- [ ] **Step 6: Typecheck + vitest + manual + commit**

```bash
git add src/lib/thumbnail/hue.ts src/lib/thumbnail/hue.test.ts src/components/thumbnail/ThemePanel.tsx src/components/thumbnail/ThumbnailArtboard.tsx src/components/thumbnail/ThumbnailEditor.tsx
git commit -m "feat: thumbnail global hue theme"
```

---

## Phase 7 — Export

### Task 13: `export.ts` — composite → WebP/PNG

**Files:**
- Create: `src/lib/thumbnail/export.ts`
- Test: `src/lib/thumbnail/export.test.ts`
- Modify: `ThumbnailEditor.tsx` (Export button + format/ratio pickers), `src/lib/api/thumbnail.ts` (save via `save_file_bytes`)

**Interfaces:**
- Consumes: scene `screenshot(w,h)` (Task 8), layers, hue resolvers, `fitFontSize`.
- Produces: `resolveOutputSize(ratio: string): {w:number;h:number}` (16:9→1920×1080, 16:10→1920×1200, 4:3→1440×1080, 1:1→1080×1080); `composeThumbnail(opts): Promise<Blob>` — draws scene screenshot + disc/deco images + hue-resolved auto-shrunk text onto an offscreen canvas, `convertToBlob({type})` for `image/webp`|`image/png`.

- [ ] **Step 1: Failing test** for `resolveOutputSize` (the 4 ratios → exact sizes).
- [ ] **Step 2: Run fail. Step 3: Implement `resolveOutputSize`. Step 4: Run pass.**
- [ ] **Step 5: Implement `composeThumbnail`** — scene screenshot at output size, drawImage disc/deco webps at scaled positions, fillText for each text layer (hue-resolved color, fitted size, multi-line, bottom-anchored), `canvas.convertToBlob`.
- [ ] **Step 6: Export button** — default WebP; format picker (WebP/PNG/JPG) + ratio picker; on click, `composeThumbnail` → `save_file_bytes` (raw-bytes IPC) via a save dialog.
- [ ] **Step 7: Typecheck + vitest + manual (export a real poster, verify the WebP opens) + commit**

```bash
git add src/lib/thumbnail/export.ts src/lib/thumbnail/export.test.ts src/components/thumbnail/ThumbnailEditor.tsx src/lib/api/thumbnail.ts
git commit -m "feat: thumbnail export to WebP/PNG"
```

---

## Self-Review notes (coverage map)

- Spec §2 window → Tasks 1–3. §3 composition/layers → 4,6,7,9. §4 presets → 10. §5 text → 11. §6 disc → 10 (disc layer, locked/delete-only). §7 hue → 12. §8 SKN → 8,9. §9 export → 13. §10 styling/interactions → 6,7 (design-lab + ported interactions). §11 layout → matches Tasks. §12 phased build → phases mirror the plan.
- Deferred (spec §13): corner/logo image slots (DecoLayer type exists, assets later), animated export, WAD models, sat/lum hue — no tasks, intentionally.
