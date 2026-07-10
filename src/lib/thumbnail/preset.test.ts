import { describe, it, expect } from 'vitest';
import { loadPreset, presetToLayers } from './preset';

describe('loadPreset', () => {
  it('riot: returns a preset with exactly one locked disc layer and two text layers', () => {
    const p = loadPreset('riot');
    expect(p.preset).toBe('riot');
    expect(p.font).toBe('Beaufort for LOL');
    expect(p.hue).toBe(210);
    expect(p.canvas).toEqual({ w: 640, h: 360, ratio: '16:9' });

    const discs = p.layers.filter(l => l.type === 'disc');
    const texts = p.layers.filter(l => l.type === 'text');
    expect(discs).toHaveLength(1);
    expect(texts).toHaveLength(2);
    expect(discs[0].locked).toBe(true);
  });

  it('divine: returns a valid preset with no disc layer', () => {
    const p = loadPreset('divine');
    expect(p.preset).toBe('divine');
    expect(p.font).toBe('Albiero');
    expect(p.canvas).toEqual({ w: 640, h: 360, ratio: '16:9' });

    const discs = p.layers.filter(l => l.type === 'disc');
    expect(discs).toHaveLength(0);
    expect(p.layers.length).toBeGreaterThan(0);
  });

  it('every layer has a unique, non-empty id', () => {
    for (const id of ['riot', 'divine'] as const) {
      const p = loadPreset(id);
      const ids = p.layers.map(l => l.id);
      expect(ids.every(x => typeof x === 'string' && x.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('text layers never carry a color field (color comes from global hue)', () => {
    const p = loadPreset('riot');
    for (const l of p.layers) {
      if (l.type === 'text') {
        expect((l as unknown as Record<string, unknown>).color).toBeUndefined();
      }
    }
  });
});

describe('presetToLayers', () => {
  it('returns the layers array from the preset', () => {
    const p = loadPreset('riot');
    const layers = presetToLayers(p);
    expect(layers).toHaveLength(p.layers.length);
    expect(layers.map(l => l.type)).toEqual(p.layers.map(l => l.type));
  });
});
