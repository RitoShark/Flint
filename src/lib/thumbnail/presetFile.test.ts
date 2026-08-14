import { describe, expect, it } from 'vitest';
import { Layer } from './layers';
import { buildPresetFile, parsePresetFile, PRESET_FILE_VERSION } from './presetFile';

const sampleLayers: Layer[] = [
  {
    id: 'title', type: 'text', name: 'Title', hidden: false, rot: 0, locked: false,
    x: 34, y: 288, w: 280, h: 56, text: 'NEW SKIN', size: 40, font: 'Beaufort for LOL', italic: false, spacing: 1,
  },
  {
    id: 'hero', type: 'model', name: 'Hero', hidden: false, rot: 0, locked: false,
    x: 388, y: 70, w: 230, h: 270, sknPath: 'C:/x/hero.skn', animDir: 'C:/x/skin77/animations', anim: 'idle1.anm', frame: 0, maxFrame: 30, scale: 100, orbit: 0,
  },
];

describe('buildPresetFile', () => {
  it('captures the editor state into a versioned, named payload', () => {
    const file = buildPresetFile({ name: 'My Poster', base: 'riot', font: 'Beaufort for LOL', hue: 210, layers: sampleLayers });
    expect(file.kind).toBe('flint-thumbnail-preset');
    expect(file.version).toBe(PRESET_FILE_VERSION);
    expect(file.name).toBe('My Poster');
    expect(file.base).toBe('riot');
    expect(file.hue).toBe(210);
    expect(file.layers).toHaveLength(2);
  });

  it('strips the per-model sknPath so a preset is model-agnostic and portable', () => {
    const file = buildPresetFile({ name: 'P', base: 'divine', font: 'Albiero', hue: 95, layers: sampleLayers });
    const model = file.layers.find(l => l.type === 'model');
    expect(model && 'sknPath' in model ? model.sknPath : 'MISSING').toBe('');
  });

  it('strips a manually-picked animDir so a shared preset carries no local folder', () => {
    const file = buildPresetFile({ name: 'P', base: 'divine', font: 'Albiero', hue: 95, layers: sampleLayers });
    const model = file.layers.find(l => l.type === 'model');
    expect(model && 'animDir' in model ? model.animDir : undefined).toBeUndefined();
  });

  it('deep-clones layers (mutating the source array does not affect the built file)', () => {
    const file = buildPresetFile({ name: 'P', base: 'riot', font: 'F', hue: 1, layers: sampleLayers });
    sampleLayers[0].name = 'MUTATED';
    expect(file.layers[0].name).toBe('Title');
  });
});

describe('parsePresetFile', () => {
  it('round-trips a built preset file through JSON', () => {
    const file = buildPresetFile({ name: 'Round Trip', base: 'riot', font: 'Beaufort for LOL', hue: 42, layers: sampleLayers });
    const parsed = parsePresetFile(JSON.stringify(file));
    expect(parsed.name).toBe('Round Trip');
    expect(parsed.hue).toBe(42);
    expect(parsed.base).toBe('riot');
    expect(parsed.layers).toHaveLength(2);
  });

  it('rejects JSON that is not a thumbnail preset', () => {
    expect(() => parsePresetFile('{"kind":"something-else"}')).toThrow(/not a Flint thumbnail preset/i);
  });

  it('rejects malformed JSON', () => {
    expect(() => parsePresetFile('{ not json')).toThrow();
  });

  it('rejects a preset with a bad layer type', () => {
    const bad = { kind: 'flint-thumbnail-preset', version: PRESET_FILE_VERSION, name: 'x', base: 'riot', font: 'f', hue: 1, layers: [{ id: 'a', type: 'bogus' }] };
    expect(() => parsePresetFile(JSON.stringify(bad))).toThrow(/layer/i);
  });

  it('defaults a missing base to "riot" and clamps hue into range', () => {
    const file = { kind: 'flint-thumbnail-preset', version: PRESET_FILE_VERSION, name: 'x', font: 'f', hue: 400, layers: [] };
    const parsed = parsePresetFile(JSON.stringify(file));
    expect(parsed.base).toBe('riot');
    expect(parsed.hue).toBeLessThanOrEqual(360);
    expect(parsed.hue).toBeGreaterThanOrEqual(0);
  });
});

describe('suggestPresetFilename', () => {
  it('slugifies the preset name into a .json filename', async () => {
    const { suggestPresetFilename } = await import('./presetFile');
    expect(suggestPresetFilename('PROJECT: Yøne!!')).toBe('project-yone.thumbnail.json');
    expect(suggestPresetFilename('   ')).toBe('preset.thumbnail.json');
  });
});
