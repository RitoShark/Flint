export type LayerType = 'model' | 'text' | 'disc' | 'deco' | 'env' | 'frame';

export interface BaseLayer {
  id: string;
  type: LayerType;
  name: string;
  hidden: boolean;
  rot: number;
  locked: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Drop-shadow layer style (Task: shadow-as-layer-style). When `shadow` is
   *  true the layer casts a soft drop-shadow of its own silhouette — a CSS
   *  `filter: drop-shadow(...)` in the preview and a canvas shadow in the
   *  export. Off by default so existing layers are unchanged. Blur/offset are
   *  authored in the fixed 640×360 stage space (scaled up on export). */
  shadow?: boolean;
  shadowBlur?: number;    // default 8
  shadowOffsetX?: number; // default 0
  shadowOffsetY?: number; // default 6
  shadowOpacity?: number; // 0..1, default 0.5
}

export interface TextLayer extends BaseLayer {
  type: 'text';
  text: string;
  size: number;
  font: string;
  italic: boolean;
  spacing: number;
  /** Semantic role, shared across ALL presets so the editor's auto-fill and
   *  naming are consistent: 'title' = the mod name, 'champion' = the champion /
   *  character name. Auto-fill targets layers by role (not hardcoded ids), so
   *  Riot and Divine behave identically. Absent = a plain custom text layer. */
  role?: 'title' | 'champion';
  /** How strongly this text pulls toward the theme hue (0 = stay white/cream,
   *  1 = fully the hue color). Per-layer so a title can be strongly colored
   *  while a subtitle stays near-white with a faint tint. `undefined` falls
   *  back to the preset-wide default (subtle for Riot, strong for Divine). */
  hueMix?: number;
  /** Colored glow behind the text, in the SAME color as the text (so the hue
   *  slider drives both). Off by default. */
  glow?: boolean;
  /** Glow strength 0..1 (blur radius + layered passes). Default ~0.6. */
  glowStrength?: number;
  /** Base color the hue mixes FROM (before `hueMix`). Default is the shared
   *  cream/gold; Divine text layers use pure white so the subtitle reads white
   *  with only a faint hue and the title colors up from white. */
  baseColor?: string;
}

export interface ModelLayer extends BaseLayer {
  type: 'model';
  sknPath: string;
  anim: string;
  /** Manually-picked folder of `.anm` files, overriding skin-BIN clip
   *  derivation. Set by the Clip dropdown's folder button; persisted so the
   *  override survives a save/reload and is re-applied when the layer reloads.
   *  Undefined means "derive clips from the skin BIN" (the normal path). */
  animDir?: string;
  /** Clip this model against the disc's circle. Defaults ON (undefined =
   *  clipped). No-op when there is no visible disc layer. */
  clipToDisc?: boolean;
  /** WHICH SIDE of the circle survives the clip. The two modes are
   *  complementary halves of one composition: the hero occupies 'inside', a
   *  full-body model occupies 'outside', and together they tile the frame with
   *  the ring as the seam. Both cut at the SAME black-fill ellipse, so the
   *  halves meet exactly — different radii would leave a gap or a
   *  double-drawn sliver. Defaults to 'inside'. */
  clipMode?: 'inside' | 'outside';
  frame: number;
  maxFrame: number;
  scale: number;
  /** Turn / yaw rotation in degrees (-180..180) — face the character left/right. */
  orbit: number;
  /** Tilt / pitch rotation in degrees (-180..180) — lean the character fwd/back. */
  tiltX?: number;
  /** Roll / Z rotation in degrees (-180..180) — spin the character clockwise/ccw
   *  in the picture plane (the third axis for full orientation control). */
  rollZ?: number;
  /** 3D translation of the mesh WITHIN the scene (world units), independent of
   *  size — moves the model in the 3D space (X left/right, Y up/down, Z depth)
   *  without re-centering the camera. Default 0 = at origin. */
  posX?: number;
  posY?: number;
  posZ?: number;
  /** Flip the model across its own vertical axis so a pose faces the other way.
   *  Not the same as `orbit + 180`, which shows the model's back. */
  mirrored?: boolean;
  /** Submesh (material) names hidden for this model. Empty/undefined = all
   *  submeshes visible. Driven by the mesh-visibility popup. */
  hiddenMeshes?: string[];
  /** Camera framing: 'full' (whole body, default) or 'head' (auto-focus the
   *  detected head bone with a slight zoom — splash/portrait crop). */
  focusMode?: 'full' | 'head';
  /** Selected gear form (index into the skin BIN's `mGearSkinUpgrades`), or
   *  undefined/-1 for the base look. Persisted only so the switcher can show
   *  which form the artist picked — the visibility it produced already lives in
   *  `hiddenMeshes`, which stays the single source of truth. */
  form?: number;
  /** Folder of texture files applied across the model by name match. Individual
   *  entries in `textureOverrides` win over it. */
  textureDir?: string;
  /** Submesh name → absolute texture file path. Replaces that submesh's albedo,
   *  overriding both the skin's own texture and the folder match. */
  textureOverrides?: Record<string, string>;
}

export interface DiscLayer extends BaseLayer {
  type: 'disc';
  opacity: number; // fixed composite
}

export interface DecoLayer extends BaseLayer {
  type: 'deco';
  asset: string;
  z: 'front' | 'behind';
}

/** One saved texture set for the map env layer — the map's "chroma". Maps each
 *  GLB material-slot name to an image (a bundled asset name or an abs path). */
export interface EnvVariation {
  name: string;
  textures: Record<string, string>;
}

/** The 3D map-environment layer: a bundled GLB rendered as a live 3D backdrop
 *  behind the character models. Placement/rotation/scale are LOCKED in the UI
 *  (baked defaults tuned by the dev, then normalized via the .thumbnail.json)
 *  — only the texture variations are user-editable. See the map-env design doc. */
export interface EnvLayer extends BaseLayer {
  type: 'env';
  /** Bundled GLB asset name served by `load_thumbnail_asset` (e.g. 'dexal.glb'). */
  glb: string;
  /** Baked, UI-locked world transform of the map in the Babylon scene. */
  position: [number, number, number];
  rotation: [number, number, number]; // radians
  mapScale: number;
  /** Name of the currently applied variation. */
  activeVariation: string;
  variations: EnvVariation[];
}

/** A bundled line-art frame overlay (the STROKE.png corner brackets in the
 *  reference splash). The art is white on transparent; `tint` mixes the theme
 *  hue INTO the white (0 = stays white, 1 = fully the hue color) so the frame
 *  recolors with the slider. Placement is a normal x/y/w/h box (movable), and
 *  it seeds locked in the Divine preset. */
export interface FrameLayer extends BaseLayer {
  type: 'frame';
  /** Bundled asset name served by `load_thumbnail_asset` (e.g. 'stroke'). */
  asset: string;
  /** 0..1 — how strongly to tint the white art toward the theme hue. */
  tint: number;
}

export type Layer = TextLayer | ModelLayer | DiscLayer | DecoLayer | EnvLayer | FrameLayer;

/** Build a fresh Dexal map-env layer with its default (Chaos Top) variation.
 *  Placement/rotation/scale are the dev-tuned defaults (baked from the posed
 *  only-map.thumbnail.json); the map is LOCKED environment — not user-editable.
 *  Slot→default-WebP bindings match the bundled GLB's material names. */
export function makeDefaultEnvLayer(): EnvLayer {
  return {
    id: 'map-env',
    type: 'env',
    name: 'Map (Dexal)',
    hidden: false,
    rot: 0,
    locked: true,
    // Fills the whole stage viewport by default (0 box = full stage).
    x: 0, y: 0, w: 0, h: 0,
    glb: 'dexal.glb',
    // Baked default pose (dev-tuned in only-map.thumbnail.json). This IS the
    // map's "zero" — it always spawns here and can't be moved in the UI.
    position: [-50.5, 10, 27],
    rotation: [0, 1.6057029118347832, 0],
    mapScale: 1.5,
    activeVariation: 'Chaos Top',
    variations: [
      {
        name: 'Chaos Top',
        textures: {
          Ground_B1_ChaosTop_A_MAT: 'Ground_B1_ChaosTop_A.webp',
          Ground_C1_ChaosTop_A_MAT: 'Ground_C1_ChaosTop_A.webp',
          Periph_Top_G_MAT: 'Periph_Top_G_1bitalpha.webp',
          Periph_Top_H_MAT: 'Periph_Top_H_1bitalpha.webp',
          Periph_Top_I_MAT: 'Periph_Top_I_1bitalpha.webp',
        },
      },
    ],
  };
}

export function addLayer(list: Layer[], layer: Layer): Layer[] {
  return [layer, ...list];
}

export function removeLayer(list: Layer[], id: string): Layer[] {
  return list.filter(l => l.id !== id);
}

export function updateLayer(list: Layer[], id: string, patch: Partial<Layer>): Layer[] {
  return list.map(l => (l.id === id ? ({ ...l, ...patch } as Layer) : l));
}

export function toggleLock(list: Layer[], id: string): Layer[] {
  return list.map(l => (l.id === id ? { ...l, locked: !l.locked } : l));
}

/** Move the layer with `id` so it lands immediately BEFORE `beforeId` in the
 *  array (or to the end when `beforeId` is null). Array order drives z-order —
 *  earlier index = rendered on top — so this reorders the visual stack. */
export function reorderLayer(list: Layer[], id: string, beforeId: string | null): Layer[] {
  if (id === beforeId) return list; // dropping onto itself — no change
  const moving = list.find(l => l.id === id);
  if (!moving) return list;
  const without = list.filter(l => l.id !== id);
  if (beforeId === null) return [...without, moving];
  const idx = without.findIndex(l => l.id === beforeId);
  if (idx < 0) return [...without, moving];
  return [...without.slice(0, idx), moving, ...without.slice(idx)];
}

/** Move an ordered run of layers (identified by `ids`, in their current order)
 *  so the run lands immediately BEFORE `beforeId` (or at the end when null).
 *  Used to drag a whole category group in the Layers panel. `beforeId` must not
 *  be one of `ids` (dropping a group onto itself is a no-op). */
export function reorderGroup(list: Layer[], ids: string[], beforeId: string | null): Layer[] {
  const idSet = new Set(ids);
  if (beforeId !== null && idSet.has(beforeId)) return list; // onto itself
  const moving = list.filter(l => idSet.has(l.id));
  if (moving.length === 0) return list;
  const without = list.filter(l => !idSet.has(l.id));
  if (beforeId === null) return [...without, ...moving];
  const idx = without.findIndex(l => l.id === beforeId);
  if (idx < 0) return [...without, ...moving];
  return [...without.slice(0, idx), ...moving, ...without.slice(idx)];
}

export function serialize(list: Layer[]): string {
  return JSON.stringify(list);
}

export function deserialize(json: string): Layer[] {
  return JSON.parse(json) as Layer[];
}
