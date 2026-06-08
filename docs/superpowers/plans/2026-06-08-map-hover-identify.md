# Map Hover / Click-to-Identify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hovering geometry in the 3D map preview shows the exact material + texture in a bottom status bar; clicking shows an info card with a thumbnail, the texture path, Copy-path, and Open-in-editor.

**Architecture:** Keep the existing per-`(layer,texture)` mesh merge (performance), but record, per merged mesh, the triangle span of each original submesh. Babylon `scene.pick().faceId` → the span under the cursor → its material name + texture. Hover/click resolution is pure frontend data; "Open in editor" reuses existing Flint commands.

**Tech Stack:** TypeScript/React, Babylon.js 9 (`scene.pick`, `onPointerObservable`, `PickingInfo.faceId`), existing Flint APIs (`resolveAssetPath`, `openWithDefaultApp`, `loadMapTexture`).

**Spec:** `docs/superpowers/specs/2026-06-08-map-hover-identify-design.md`

---

## Key facts the implementer must know

- **Builder merge loop** is in `src/lib/babylon/mapMeshBuilder.ts`, function `buildMapMeshes`. Each merged mesh is built from a `group: SubmeshRange[]`; the loop copies each submesh's indices into `gIdx` using a running cursor `iWrite` (in indices). One triangle = 3 indices, so the face cursor is `iWrite / 3`.
- **`input.materials`** (`Record<string,string>`) maps a submesh name → its diffuse texture bin path (e.g. `ASSETS/.../foo.tex`). Used to fill each span's `texturePath`.
- **`BuiltMapMesh.mesh.name`** is `"<layer>::<texturePath-or-__notex__name>"` — not the material name. The material name lives on each submesh (`SubmeshRange.name`); that's what we now preserve per span.
- **Babylon picking:** `scene.pick(scene.pointerX, scene.pointerY)` → `PickingInfo` with `.hit`, `.pickedMesh`, `.faceId` (triangle index). `scene.onPointerObservable` with `PointerEventTypes.POINTERMOVE` / `POINTERPICK`.
- **Existing APIs to reuse (do NOT add new ones unless noted):**
  - `resolveAssetPath(assetPath, binPath)` — already exported (`src/lib/api/mesh.ts:231` → `api.resolveAssetPath`). Turns a bin `ASSETS/...` path into a real on-disk path. `binPath` = the project's discovered materials-bin dir; simplest is to pass the project's mapgeometry dir. We will pass the `projectPath` joined with the mapgeometry folder — but the existing `load_map_texture` already resolves internally, so for Open/Copy we add a tiny command (Task 6) that returns the resolved path, reusing the same Rust resolution the preview uses.
  - `openWithDefaultApp(path)` — `src/lib/api/file.ts:96` → `api.openWithDefaultApp`.
  - `loadMapTexture(projectPath, texturePath)` — for the thumbnail (already used by the renderer).
- **UI style:** match the self-contained inline-style panel already in `MapPreview.tsx` (the Layers panel uses inline style objects, not app CSS classes, because the standalone window doesn't reliably load them).

## File structure

**Modified:**
- `src/lib/babylon/mapMeshBuilder.ts` — add `SubmeshSpan`, add `spans` to `BuiltMapMesh`, populate in the merge loop, add `resolveFace` helper.
- `src/components/preview/MapPreview.tsx` — mesh→BuiltMapMesh ref map, pointer observers, hover state + status bar, click state + info card.
- `src/lib/api/mapPreview.ts` — add `resolveMapTexturePath` binding.
- `src-tauri/src/commands/project/map_preview.rs` — add `resolve_map_texture_path` command.
- `src-tauri/src/main.rs` — register the new command.

No new files.

---

## Task 1: Builder — add SubmeshSpan type + spans field

**Files:**
- Modify: `src/lib/babylon/mapMeshBuilder.ts`

- [ ] **Step 1: Add the SubmeshSpan interface and extend BuiltMapMesh**

In `src/lib/babylon/mapMeshBuilder.ts`, find the `BuiltMapMesh` interface and add a `spans` field, and define `SubmeshSpan` just above it:

```ts
/** One original submesh's triangle range inside a merged mesh, kept so a picked
 *  faceId resolves to the exact material under the cursor. */
export interface SubmeshSpan {
    name: string;               // original submesh / material name
    texturePath: string | null; // its diffuse texture bin path
    startFace: number;          // first triangle index within the merged mesh
    faceCount: number;          // number of triangles
}
```

Then add to `BuiltMapMesh` (after `baronStage`):

```ts
    /** Triangle spans of the submeshes merged into this mesh (for pick identity). */
    spans: SubmeshSpan[];
```

- [ ] **Step 2: Verify it type-checks (will fail until Task 2 populates spans)**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "spans"`
Expected: a nonzero count (the `out.push(...)` is missing `spans`) — that's expected; Task 2 fixes it. Do not commit yet.

---

## Task 2: Builder — populate spans in the merge loop + resolveFace helper

**Files:**
- Modify: `src/lib/babylon/mapMeshBuilder.ts`

- [ ] **Step 1: Track each submesh's face span while merging**

In `buildMapMeshes`, the inner loop iterates `for (const sm of group)` and maintains `iWrite` (index cursor). Add span tracking. Replace the inner loop body's start/end bookkeeping so it records a span per submesh. Find this block:

```ts
        let vWrite = 0; // vertex write cursor (in vertices)
        let iWrite = 0; // index write cursor

        for (const sm of group) {
            const vStart = sm.start_vertex;
            const vCount = sm.vertex_count;
            const iStart = sm.start_index;
            const iCount = sm.index_count;
```

Replace it with (adds a `spans` accumulator and records each submesh's face range):

```ts
        let vWrite = 0; // vertex write cursor (in vertices)
        let iWrite = 0; // index write cursor
        const spans: SubmeshSpan[] = [];

        for (const sm of group) {
            const vStart = sm.start_vertex;
            const vCount = sm.vertex_count;
            const iStart = sm.start_index;
            const iCount = sm.index_count;
            // Span: this submesh's triangles occupy [iWrite/3, (iWrite+iCount)/3).
            spans.push({
                name: sm.name,
                texturePath: materials[sm.name] ?? null,
                startFace: iWrite / 3,
                faceCount: iCount / 3,
            });
```

(Note: `materials` is already destructured at the top of `buildMapMeshes` as
`const { positions, uvs, indices, submeshes, materials } = input;` — confirm it
is; if not, add `materials` to that destructure.)

- [ ] **Step 2: Include spans in the pushed BuiltMapMesh**

Find:

```ts
        out.push({ mesh, texturePath, layer, variants, replaceKeys, baronStage });
```

Replace with:

```ts
        out.push({ mesh, texturePath, layer, variants, replaceKeys, baronStage, spans });
```

- [ ] **Step 3: Add the resolveFace helper at the end of the file**

After `buildMapMeshes`'s closing brace, add:

```ts
/** Resolve a picked faceId (triangle index in a merged mesh) to the submesh
 *  span it falls in, or null if out of range. */
export function resolveFace(built: BuiltMapMesh, faceId: number): SubmeshSpan | null {
    for (const s of built.spans) {
        if (faceId >= s.startFace && faceId < s.startFace + s.faceCount) return s;
    }
    return null;
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "mapMeshBuilder"`
Expected: no output (clean). The earlier `spans`-missing error is resolved.

- [ ] **Step 5: Commit**

```bash
git add src/lib/babylon/mapMeshBuilder.ts
git commit -m "feat(map-identify): track per-submesh triangle spans in merged meshes"
```

---

## Task 3: Builder — unit test for span tracking + resolveFace

**Files:**
- Create: `src/lib/babylon/mapMeshBuilder.test.ts`

NOTE: Check whether the repo runs TS unit tests (look for `vitest`/`jest` in
`package.json`). If NO test runner is configured, SKIP creating this file and
instead verify `resolveFace` logic by inspection in Task 2; note the skip here
and move on. If a runner exists, add the test below.

- [ ] **Step 1: Check for a test runner**

Run: `grep -E "vitest|jest|\"test\"" package.json`
Expected: shows a runner, or nothing. If nothing → skip to Task 4 (no TS test
infra; the logic is covered by manual verification in Task 8).

- [ ] **Step 2: (If a runner exists) Write the test**

Create `src/lib/babylon/mapMeshBuilder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveFace, type BuiltMapMesh, type SubmeshSpan } from './mapMeshBuilder';

function fakeMesh(spans: SubmeshSpan[]): BuiltMapMesh {
    return {
        mesh: {} as any,
        texturePath: null,
        layer: 1,
        variants: ['Base'],
        replaceKeys: [],
        baronStage: null,
        spans,
    };
}

describe('resolveFace', () => {
    const m = fakeMesh([
        { name: 'A_MAT', texturePath: 'a.tex', startFace: 0, faceCount: 10 },
        { name: 'B_MAT', texturePath: 'b.tex', startFace: 10, faceCount: 20 },
    ]);
    it('resolves a face in the first span', () => {
        expect(resolveFace(m, 5)?.name).toBe('A_MAT');
    });
    it('resolves a face in the second span', () => {
        expect(resolveFace(m, 25)?.name).toBe('B_MAT');
    });
    it('returns null out of range', () => {
        expect(resolveFace(m, 100)).toBeNull();
    });
});
```

- [ ] **Step 3: Run it**

Run: `npx vitest run src/lib/babylon/mapMeshBuilder.test.ts`
Expected: 3 passing.

- [ ] **Step 4: Commit**

```bash
git add src/lib/babylon/mapMeshBuilder.test.ts
git commit -m "test(map-identify): resolveFace span resolution"
```

---

## Task 4: Rust — resolve_map_texture_path command

**Files:**
- Modify: `src-tauri/src/commands/project/map_preview.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add the command**

In `map_preview.rs`, after `load_map_texture`, add a command that returns the
real on-disk path for a bin texture path (reusing the same resolution
`load_map_texture` already does):

```rust
/// Resolve a bin texture path (e.g. "ASSETS/.../foo.tex") to its real on-disk
/// path inside the open map project. Used by the preview's identify card for
/// Copy-path / Open-in-editor. Returns an error if the file can't be found.
#[tauri::command]
pub async fn resolve_map_texture_path(
    project_path: String,
    texture_path: String,
) -> Result<String, String> {
    let project = PathBuf::from(&project_path);
    let source = discover_map_source(&project)?;
    let bin_dir = source
        .materials
        .parent()
        .ok_or("materials bin has no parent dir")?
        .to_string_lossy()
        .to_string();
    crate::commands::mesh::resolve_asset_path(texture_path.clone(), bin_dir)
        .await
        .map_err(|e| format!("Could not resolve texture '{texture_path}': {e}"))
}
```

- [ ] **Step 2: Register it**

In `src-tauri/src/main.rs`, inside `generate_handler![ ... ]`, after the existing
`commands::map_preview::open_map_preview_window,` line add:

```rust
            commands::map_preview::resolve_map_texture_path,
```

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --lib 2>&1 | tail -3`
Expected: `Finished`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/project/map_preview.rs src-tauri/src/main.rs
git commit -m "feat(map-identify): resolve_map_texture_path command"
```

---

## Task 5: Frontend API — resolveMapTexturePath binding

**Files:**
- Modify: `src/lib/api/mapPreview.ts`

- [ ] **Step 1: Add the binding**

In `src/lib/api/mapPreview.ts`, after `loadMapTexture`, add:

```ts
/** Resolve a bin texture path to its real on-disk path in the open project. */
export async function resolveMapTexturePath(
    projectPath: string,
    texturePath: string,
): Promise<string> {
    return invokeCommand('resolve_map_texture_path', { projectPath, texturePath });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "mapPreview"`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api/mapPreview.ts
git commit -m "feat(map-identify): resolveMapTexturePath api binding"
```

---

## Task 6: Renderer — mesh→BuiltMapMesh map + hover status bar

**Files:**
- Modify: `src/components/preview/MapPreview.tsx`

- [ ] **Step 1: Imports + refs + hover state**

Add to the imports from mapMeshBuilder (extend the existing import list):

```ts
import {
    buildMapMeshes,
    MAP_VARIANTS,
    BARON_STAGES,
    layerVisibleForVariant,
    resolveFace,
    type BuiltMapMesh,
    type MapVariant,
    type BaronStage,
    type SubmeshSpan,
} from '../../lib/babylon/mapMeshBuilder';
```

Add Babylon picking imports near the other Babylon imports:

```ts
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import type { Mesh as BMesh } from '@babylonjs/core/Meshes/mesh';
```

Add refs + state near the other refs (`meshesRef`, etc.):

```ts
    const meshByBabylonRef = useRef<Map<BMesh, BuiltMapMesh>>(new Map());
    const [hoverInfo, setHoverInfo] = useState<IdentifyInfo | null>(null);
    const [pinnedInfo, setPinnedInfo] = useState<IdentifyInfo | null>(null);
    const [pinnedTexPath, setPinnedTexPath] = useState<string | null>(null);
```

Define the `IdentifyInfo` type near the top of the file (after `MapPreviewProps`):

```ts
interface IdentifyInfo {
    materialName: string;
    textureFile: string;        // basename for the status bar
    texturePath: string | null; // full bin path
    variants: MapVariant[];
    baronStage: BaronStage | null;
    layer: number;
}
```

- [ ] **Step 2: Populate meshByBabylonRef when the scene is built**

In `buildScene`, right after `builtRef.current = builtMeshes;`, add:

```ts
            meshByBabylonRef.current = new Map(builtMeshes.map(b => [b.mesh, b]));
```

- [ ] **Step 3: Add a span→IdentifyInfo helper (above the engine effect)**

```ts
    const spanToInfo = useCallback((built: BuiltMapMesh, span: SubmeshSpan): IdentifyInfo => {
        const file = (span.texturePath ?? span.name).split(/[\\/]/).pop() ?? span.name;
        return {
            materialName: span.name,
            textureFile: file,
            texturePath: span.texturePath,
            variants: built.variants,
            baronStage: built.baronStage,
            layer: built.layer,
        };
    }, []);
```

- [ ] **Step 4: Wire pointer observers in the engine effect**

Inside the engine `useEffect`, after the camera/lights are set up and before
`engine.runRenderLoop(...)`, add hover + click handling:

```ts
        // Hover/click identify. Throttle hover by skipping when the picked
        // (mesh, span) is unchanged since last move.
        let lastHoverKey = '';
        scene.onPointerObservable.add((pi) => {
            if (pi.type === PointerEventTypes.POINTERMOVE) {
                const pick = scene.pick(scene.pointerX, scene.pointerY);
                const built = pick?.pickedMesh
                    ? meshByBabylonRef.current.get(pick.pickedMesh as BMesh)
                    : undefined;
                if (!built || !pick || pick.faceId < 0) {
                    if (lastHoverKey !== '') { lastHoverKey = ''; setHoverInfo(null); }
                    return;
                }
                const span = resolveFace(built, pick.faceId);
                const key = `${built.mesh.name}#${span?.startFace ?? -1}`;
                if (key === lastHoverKey) return;
                lastHoverKey = key;
                setHoverInfo(span ? spanToInfo(built, span) : null);
            } else if (pi.type === PointerEventTypes.POINTERPICK) {
                const pick = pi.pickInfo;
                const built = pick?.pickedMesh
                    ? meshByBabylonRef.current.get(pick.pickedMesh as BMesh)
                    : undefined;
                if (!built || !pick || pick.faceId < 0) { setPinnedInfo(null); return; }
                const span = resolveFace(built, pick.faceId);
                setPinnedInfo(span ? spanToInfo(built, span) : null);
            }
        });
```

- [ ] **Step 5: Render the bottom status bar**

In the component's returned JSX, add a status bar element (use the existing inline
style approach). Add near the `badge` element at the bottom of the root div:

```tsx
            {hoverInfo && (
                <div style={hoverBar}>
                    <span style={{ color: '#fff' }}>{hoverInfo.materialName}</span>
                    <span style={{ color: '#888' }}>  ·  {hoverInfo.textureFile}</span>
                    <span style={{ color: '#6cf' }}>
                        {'  ·  '}
                        {hoverInfo.baronStage
                            ? `Baron ${hoverInfo.baronStage}`
                            : hoverInfo.variants.filter(v => v !== 'Base')[0] ?? 'Base'}
                    </span>
                </div>
            )}
```

Add the style constant near the other style constants (`overlay`, `badge`):

```ts
const hoverBar: React.CSSProperties = {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    padding: '4px 10px', background: 'rgba(20,20,20,0.92)',
    borderTop: '1px solid #333', color: '#ddd', font: '12px system-ui',
    pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden',
    textOverflow: 'ellipsis',
};
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "MapPreview"`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/components/preview/MapPreview.tsx
git commit -m "feat(map-identify): hover status bar via faceId span resolution"
```

---

## Task 7: Renderer — click info card (thumbnail, copy, open)

**Files:**
- Modify: `src/components/preview/MapPreview.tsx`

- [ ] **Step 1: Resolve the on-disk path when an item is pinned**

Add an effect that resolves the pinned texture's real path (for Copy/Open). After
the other effects:

```ts
    useEffect(() => {
        let cancelled = false;
        setPinnedTexPath(null);
        if (pinnedInfo?.texturePath) {
            api.resolveMapTexturePath(projectPath, pinnedInfo.texturePath)
                .then(p => { if (!cancelled) setPinnedTexPath(p); })
                .catch(() => { if (!cancelled) setPinnedTexPath(null); });
        }
        return () => { cancelled = true; };
    }, [pinnedInfo, projectPath]);
```

- [ ] **Step 2: Render the info card**

Add to the JSX (near the hover bar / Layers panel). Uses a texture thumbnail via
a small inline loader and the existing `openWithDefaultApp`:

```tsx
            {pinnedInfo && (
                <div style={infoCard}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontWeight: 600, fontSize: 12 }}>Texture</span>
                        <button style={{ ...textBtn, padding: '2px 8px' }} onClick={() => setPinnedInfo(null)}>×</button>
                    </div>
                    <div style={{ fontSize: 12, color: '#ddd', wordBreak: 'break-all', marginBottom: 6 }}>
                        {pinnedInfo.materialName}
                    </div>
                    <div style={{ fontSize: 11, color: '#9af', wordBreak: 'break-all', marginBottom: 8 }}>
                        {pinnedInfo.texturePath ?? '(no texture)'}
                    </div>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
                        {pinnedInfo.baronStage ? `Baron ${pinnedInfo.baronStage} · ` : ''}
                        {pinnedInfo.variants.join(', ')} · layer 0x{pinnedInfo.layer.toString(16)}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                        <button
                            style={textBtn}
                            disabled={!pinnedTexPath}
                            onClick={() => { if (pinnedTexPath) void navigator.clipboard.writeText(pinnedTexPath); }}
                        >Copy path</button>
                        <button
                            style={textBtn}
                            disabled={!pinnedTexPath}
                            onClick={() => { if (pinnedTexPath) void api.openWithDefaultApp(pinnedTexPath.replace(/\//g, '\\')); }}
                        >Open in editor</button>
                    </div>
                </div>
            )}
```

Add the `infoCard` style constant (the `textBtn` constant already exists from the
Layers panel — reuse it):

```ts
const infoCard: React.CSSProperties = {
    position: 'absolute', bottom: 36, left: 8, width: 300,
    background: 'rgba(24,24,24,0.97)', border: '1px solid #444', borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)', padding: 10, color: '#ddd',
    font: '13px system-ui',
};
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -cE "error TS"`
Expected: `4` (only the pre-existing repo errors; none in our files — verify none mention MapPreview).

- [ ] **Step 4: Commit**

```bash
git add src/components/preview/MapPreview.tsx
git commit -m "feat(map-identify): click info card with copy-path + open-in-editor"
```

---

## Task 8: Manual verification

**Files:** none (run the app).

- [ ] **Step 1: Launch**

Run: `npm run tauri dev -- --release`
Expected: app launches.

- [ ] **Step 2: Open the SRX map project, open Preview Map**

Expected: 3D map renders.

- [ ] **Step 3: Hover geometry**

Move the mouse over the dragon pit, a wall, a camp.
Expected: the bottom bar updates live, e.g.
`Maps/.../Ground_D4_DragonPit_A_MAT · ground_d4_dragonpit_a.tex · Base`.
Different surfaces show different material names (proves faceId → span works,
not just one-texture-per-mesh).

- [ ] **Step 4: Click geometry**

Expected: info card appears with material name, full texture path,
variant/layer, and Copy path / Open in editor buttons enabled.

- [ ] **Step 5: Copy + Open**

Click Copy path → paste somewhere → it's the real on-disk `.tex` path. Click
Open in editor → the texture opens in the OS default app.

- [ ] **Step 6: Edge cases**

Hover empty space → bar clears. Click empty space or × → card closes. Hover a
grey/untextured piece (e.g. FaeLights) → shows material name with `(no texture)`
in the card; Copy/Open disabled.

- [ ] **Step 7: Commit any tweaks**

```bash
git add -A
git commit -m "fix(map-identify): verification tweaks"
```

---

## Self-review notes (addressed)

- **Spec coverage:** hover bar (T6), click card with thumbnail-area/path/copy/open
  (T7), material+variant+layer detail (T7), faceId→span identity keeping the merge
  (T1–T2), path resolution reusing existing logic (T4–T5), perf throttle (T6 step 4),
  error/empty handling (T6/T7/T8). All spec sections map to a task.
- **Thumbnail note:** the spec lists a texture thumbnail; T7 shows the path/details
  card. A decoded thumbnail can reuse the cached `RawTexture`/`loadMapTexture`, but
  to keep T7 self-contained the card ships path+details first; adding an `<img>`
  thumbnail from `loadMapTexture` RGBA is a trivial follow-up if wanted. Flagged,
  not silently dropped.
- **Types:** `SubmeshSpan`/`IdentifyInfo`/`resolveFace` names consistent across
  T1, T2, T3, T6, T7. `resolveMapTexturePath` matches the Rust command name.
- **Reuse:** no duplicate path-resolution (T4 reuses `resolve_asset_path`); no new
  open-with logic (T7 reuses `openWithDefaultApp`).
