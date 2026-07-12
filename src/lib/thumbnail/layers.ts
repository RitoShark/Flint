export type LayerType = 'model' | 'text' | 'disc' | 'deco' | 'env';

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
}

export interface TextLayer extends BaseLayer {
  type: 'text';
  text: string;
  size: number;
  font: string;
  italic: boolean;
  spacing: number;
}

export interface ModelLayer extends BaseLayer {
  type: 'model';
  sknPath: string;
  anim: string;
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
  /** Submesh (material) names hidden for this model. Empty/undefined = all
   *  submeshes visible. Driven by the mesh-visibility popup. */
  hiddenMeshes?: string[];
  /** Camera framing: 'full' (whole body, default) or 'head' (auto-focus the
   *  detected head bone with a slight zoom — splash/portrait crop). */
  focusMode?: 'full' | 'head';
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

export type Layer = TextLayer | ModelLayer | DiscLayer | DecoLayer | EnvLayer;

/** Build a fresh Dexal map-env layer with its default (Chaos Top) variation.
 *  Placement/rotation/scale start at identity — the dev poses it in-scene, then
 *  hands back the .thumbnail.json to bake the final numbers. Slot→default-WebP
 *  bindings match the bundled GLB's material names. */
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
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    mapScale: 1,
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

export function serialize(list: Layer[]): string {
  return JSON.stringify(list);
}

export function deserialize(json: string): Layer[] {
  return JSON.parse(json) as Layer[];
}
