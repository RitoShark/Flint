# Thumbnail Map Environment Layer — Design (Phase 1)

Date: 2026-07-13
Feature branch: `feat/thumbnail-creator`

## Goal

Give the Thumbnail Creator a **live 3D map background** so thumbnails read as
"from in-game," not photoshopped. A cut-down Summoner's Rift chunk
(`dexal.glb`, 5 meshes / 5 materials, 546 KB) renders as a 3D backdrop behind
the character model layers, in the same Babylon scene. Its ground/periph
textures are external WebPs bound per material slot and switchable as named
**variations** (the map's own "chroma" system).

Phase 1 = geometry + textures + placement + variations. **Shadows and scene
lighting are Phase 2** (deliberately deferred to de-risk).

## Assets (bundled)

Ship as Tauri app resources under `src-tauri/resources/thumbnail-map/`:

- `dexal.glb` — glTF 2.0 binary, 5 meshes / 5 primitives / 5 materials, **no
  embedded textures/images** (geometry + material slots only). Material names:
  - `Ground_B1_ChaosTop_A_MAT`
  - `Ground_C1_ChaosTop_A_MAT`
  - `Periph_Top_G_MAT`, `Periph_Top_H_MAT`, `Periph_Top_I_MAT`
- 5 default WebPs (~540 KB total): `Ground_B1_ChaosTop_A.webp`,
  `Ground_C1_ChaosTop_A.webp`, `Periph_Top_G_1bitalpha.webp`,
  `Periph_Top_H_1bitalpha.webp`, `Periph_Top_I_1bitalpha.webp`.

The `Periph_*` textures are **1-bit alpha cutouts** → their materials get
`alphaMode: MASK`. Detected by the `1bitalpha` filename token OR the `Periph_`
material-name prefix.

One Dexal map for everyone (bundled, not per-project). A command resolves the
resource dir and returns absolute paths for Babylon to load.

## Data model

New `EnvLayer` in `src/lib/thumbnail/layers.ts` (the `'env'` LayerType already
exists; add the interface + include it in the `Layer` union):

```ts
export interface EnvVariation {
  name: string;                       // e.g. "Chaos Top"
  textures: Record<string, string>;   // materialName -> image path (abs or bundled id)
}

export interface EnvLayer extends BaseLayer {
  type: 'env';
  glb: string;                        // bundled id, resolved to abs path at load
  position: [number, number, number]; // baked, UI-LOCKED
  rotation: [number, number, number]; // baked, UI-LOCKED (radians)
  scale: number;                      // baked, UI-LOCKED
  activeVariation: string;            // name of the selected variation
  variations: EnvVariation[];
}
```

`position/rotation/scale` are **locked in the UI**. The dev poses the map once,
tunes it live, then hands the exported `.thumbnail.json` back; the baked numbers
become the seed default (same workflow already used for body-model placement via
`new test.thumbnail.json`). No move/scale/rotate handles are exposed for the map.

## Architecture / units

### `src/lib/thumbnail/mapEnvScene.ts` (new)
Owns everything map-specific, isolated from `studioScene.ts` so character logic
is untouched. Responsibilities:
- Load the GLB via Babylon `SceneLoader.ImportMeshAsync` into the existing scene.
- Tag its meshes with a dedicated `layerMask` bit and give it a fixed
  `ArcRotateCamera` + `viewport` (same fixed-camera pattern as model layers).
- Apply the locked `position/rotation/scale`.
- Bind WebP textures per material name (`StandardMaterial` with `diffuseTexture`;
  Phase 1 uses `emissiveTexture`/high emissive or `disableLighting` so textures
  read flat and bright with no light yet). Periph materials → `alphaMode: MASK`.
- `applyVariation(vari)` — re-bind the ≤5 textures; NO geometry reload.
- `freezeActiveMeshes()` after load (map never moves at render time → ~0
  per-frame cost).
- Public: `loadMap`, `applyVariation`, `setTransform`, `getMaterialSlots`,
  `dispose`, plus the camera handle for render-order registration.

### `src/lib/thumbnail/studioScene.ts` (thin additions)
- Register the map camera into `scene.activeCameras` with the **lowest**
  `renderOrder` so it draws FIRST (behind Hero + Full-body). Reuses the existing
  `autoClear=false` + single-manual-clear-per-frame machinery unchanged.
- Add/remove/update-map passthroughs on the scene handle.
- **Remove the auto-face-on-fresh-load** call (see "Behavior changes").

### `src/lib/thumbnail/layers.ts`
- Add `EnvVariation` + `EnvLayer`; extend the `Layer` union.

### `src/components/thumbnail/MapEnvPanel.tsx` (new)
Design-lab (`.dl-*`) panel shown when the env layer is selected:
- **Variation dropdown** + "New variation" (duplicates current picks under a new
  name) + rename/delete.
- **5 slot rows** (one per material): slot name + an image picker. Picker sources
  images the same way disc/deco layers do (project images or file browse).
  Assigning re-binds that one material live via `applyVariation`.
- **No** move/scale/rotate controls — the map is locked environment.

### Backend
- `get_thumbnail_map_asset(name) -> String` (or a small `list`/`resolve` pair) in
  a thumbnail command module: resolves `src-tauri/resources/thumbnail-map/<name>`
  to an absolute path for Babylon. Bundled via `tauri.conf.json` `resources`.

## Rendering & isolation

- GLB loads into the **same** Babylon scene as the models; its meshes carry a
  unique `layerMask` bit and are drawn by their own fixed camera/viewport.
- The map camera is added to `scene.activeCameras` sorted so its `renderOrder`
  is the lowest (draws first = behind everything). The existing per-frame single
  `engine.clear(...)` (autoClear off) already prevents viewport cross-cutting —
  no change needed there, and the screenshot path inherits it, so the map shows
  in exports automatically.
- Materials `StandardMaterial`, Phase-1 unlit look (`disableLighting = true` or
  strong `emissiveTexture`) so textures read in-game-bright without a sun.
- `freezeActiveMeshes()` → the 5 static meshes cost ~nothing per frame.

## Behavior changes (this feature)

- **No auto-face-camera on model spawn.** Strip the `isFresh` auto-face block in
  `ThumbnailArtboard.tsx` (currently lines ~399–405: `scene.faceModelToCamera`
  on fresh load). Fresh models spawn with their seeded `orbit/tiltX` (default 0)
  so the dev controls the spawn pose. The **Face camera button stays** (manual,
  on demand). The default-idle-anim pick on fresh load is unchanged.

## Out of scope (Phase 1)

- **Shadows / sun / scene lighting** → Phase 2 (character→ground real shadows via
  a shared directional light + `ShadowGenerator`; map ground = receiver).
- **User-facing map move/rotate/scale** — locked; tuned by dev→JSON only.
- **Character facing-system rework** — separate track, not touched here.
- **Multiple bundled maps** — only Dexal for now; the resolver is name-based so
  more can be added later without a schema change.

## Testing

- `mapEnvScene`: unit-test material-slot extraction and the `MASK` classification
  (periph vs ground) with a small fixture; variation re-bind swaps the right
  texture map.
- `layers.ts`: `EnvLayer` serialize/deserialize round-trip.
- Manual: load a thumbnail with an env layer, confirm the map renders behind both
  character boxes, switch variations (textures hot-swap), export screenshot shows
  the map, and a fresh model spawns WITHOUT auto-facing.
- Gates: `npx tsc --noEmit`, `npx vitest run`, `npx vite build` all green.
