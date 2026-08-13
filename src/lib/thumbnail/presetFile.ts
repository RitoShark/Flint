import { Layer } from './layers';
import { PresetId } from './preset';

/** Bumped when the on-disk preset shape changes incompatibly. */
export const PRESET_FILE_VERSION = 1;

const KIND = 'flint-thumbnail-preset';

/**
 * A saved/exported thumbnail preset. This is the portable, on-disk form the
 * user creates via "Save preset" and shares via "Export preset" — a superset
 * of a shipped `Preset` (it also carries a display `name`) and, unlike the
 * bundled JSON, its model layers are stripped of `sknPath` so a preset never
 * hard-codes one machine's file path.
 */
export interface PresetFile {
  kind: typeof KIND;
  version: number;
  name: string;
  /** Which built-in style this was based on (drives the hue-mix strength etc.). */
  base: PresetId;
  font: string;
  hue: number;
  layers: Layer[];
}

const LAYER_TYPES: ReadonlySet<string> = new Set(['model', 'text', 'disc', 'deco', 'env']);

function clampHue(h: unknown): number {
  const n = typeof h === 'number' && Number.isFinite(h) ? h : 0;
  return Math.max(0, Math.min(360, Math.round(n)));
}

/** Deep-clone + strip machine-specific model paths so the preset is portable.
 *  `animDir` (a manually-picked `.anm` folder) is as machine-specific as
 *  `sknPath`, so it goes too — a shared preset must not carry one machine's
 *  animation folder. */
function toPortableLayers(layers: Layer[]): Layer[] {
  const cloned = JSON.parse(JSON.stringify(layers)) as Layer[];
  return cloned.map(l => (l.type === 'model' ? { ...l, sknPath: '', animDir: undefined } : l));
}

export interface BuildPresetArgs {
  name: string;
  base: PresetId;
  font: string;
  hue: number;
  layers: Layer[];
}

/** Capture the current editor state into a portable, versioned preset file. */
export function buildPresetFile({ name, base, font, hue, layers }: BuildPresetArgs): PresetFile {
  return {
    kind: KIND,
    version: PRESET_FILE_VERSION,
    name: name.trim() || 'Untitled preset',
    base,
    font,
    hue: clampHue(hue),
    layers: toPortableLayers(layers),
  };
}

/** Parse + validate a preset file's JSON text. Throws with a clear message on any problem. */
export function parsePresetFile(json: string): PresetFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Preset file is not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Preset file is not a Flint thumbnail preset.');
  }
  const p = raw as Record<string, unknown>;
  if (p.kind !== KIND) {
    throw new Error('Preset file is not a Flint thumbnail preset.');
  }
  if (!Array.isArray(p.layers)) {
    throw new Error('Preset file is missing its layers.');
  }
  for (const layer of p.layers) {
    const l = layer as Record<string, unknown>;
    if (typeof l !== 'object' || l === null || !LAYER_TYPES.has(l.type as string)) {
      throw new Error(`Preset file has a layer with an invalid type "${String(l?.type)}".`);
    }
    if (typeof l.id !== 'string' || !l.id) {
      throw new Error('Preset file has a layer without an id.');
    }
  }
  const base: PresetId = p.base === 'divine' ? 'divine' : 'riot';
  return {
    kind: KIND,
    version: typeof p.version === 'number' ? p.version : PRESET_FILE_VERSION,
    name: typeof p.name === 'string' && p.name.trim() ? p.name : 'Imported preset',
    base,
    font: typeof p.font === 'string' && p.font ? p.font : 'Beaufort for LOL',
    hue: clampHue(p.hue),
    layers: JSON.parse(JSON.stringify(p.layers)) as Layer[],
  };
}

/** Turn a preset display name into a safe `<slug>.thumbnail.json` filename. */
export function suggestPresetFilename(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics left by NFKD
    .replace(/ø/gi, 'o')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'preset'}.thumbnail.json`;
}
