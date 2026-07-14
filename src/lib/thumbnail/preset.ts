import { Layer } from './layers';
import riotPresetJson from './presets/riot.json';
import divinePresetJson from './presets/divine.json';

export type PresetId = 'riot' | 'divine';

export interface Preset {
  preset: PresetId;
  font: string;
  hue: number;
  canvas: { w: number; h: number; ratio: string };
  layers: Layer[];
}

const RAW: Record<PresetId, unknown> = {
  riot: riotPresetJson,
  divine: divinePresetJson,
};

function isLayerType(t: unknown): t is Layer['type'] {
  return t === 'model' || t === 'text' || t === 'disc' || t === 'deco' || t === 'env' || t === 'frame';
}

/** Lightweight shape validation — enough to catch a malformed preset JSON
 *  early (missing fields, wrong layer `type`) without pulling in a full
 *  schema library. Throws with a descriptive message on failure. */
function validatePreset(raw: unknown, id: PresetId): Preset {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Preset "${id}": not an object`);
  }
  const p = raw as Record<string, unknown>;
  if (p.preset !== id) {
    throw new Error(`Preset "${id}": preset field mismatch (got ${String(p.preset)})`);
  }
  if (typeof p.font !== 'string' || !p.font) {
    throw new Error(`Preset "${id}": missing font`);
  }
  if (typeof p.hue !== 'number') {
    throw new Error(`Preset "${id}": missing/invalid hue`);
  }
  const canvas = p.canvas as Record<string, unknown> | undefined;
  if (!canvas || typeof canvas.w !== 'number' || typeof canvas.h !== 'number' || typeof canvas.ratio !== 'string') {
    throw new Error(`Preset "${id}": missing/invalid canvas`);
  }
  if (!Array.isArray(p.layers)) {
    throw new Error(`Preset "${id}": missing layers array`);
  }
  for (const layer of p.layers) {
    const l = layer as Record<string, unknown>;
    if (!isLayerType(l.type)) {
      throw new Error(`Preset "${id}": layer has invalid type "${String(l.type)}"`);
    }
    if (typeof l.id !== 'string' || !l.id) {
      throw new Error(`Preset "${id}": layer "${l.name as string}" missing id`);
    }
  }

  // Deep-clone the layers so every `loadPreset()` call hands back a fresh,
  // independently-mutable array — the imported JSON module is a singleton
  // (re-imports resolve to the same cached object), so without this a
  // caller mutating one loaded preset's layers would corrupt every future
  // `loadPreset()` call for that id.
  const layers = JSON.parse(JSON.stringify(p.layers)) as Layer[];

  return {
    preset: id,
    font: p.font,
    hue: p.hue,
    canvas: { w: canvas.w as number, h: canvas.h as number, ratio: canvas.ratio as string },
    layers,
  };
}

/** Load a shipped preset by id, validated + typed. Presets are static JSON
 *  bundled at build time (see `src/lib/thumbnail/presets/*.json`). Layer
 *  ids in the shipped JSON are stable/author-assigned, NOT regenerated
 *  here — so the same preset id always maps to the same layer ids
 *  (deterministic across loads). Each call returns a deep-cloned `layers`
 *  array (see `validatePreset`), so callers are free to mutate the result. */
export function loadPreset(id: PresetId): Preset {
  const raw = RAW[id];
  if (!raw) throw new Error(`Unknown preset "${id}"`);
  return validatePreset(raw, id);
}

/** Extract the layer list from a loaded preset, ready to hand to the editor
 *  (e.g. `history.set(presetToLayers(loadPreset('riot')), true)`). */
export function presetToLayers(preset: Preset): Layer[] {
  return preset.layers;
}
