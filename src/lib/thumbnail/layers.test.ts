import { describe, it, expect } from 'vitest';
import { addLayer, removeLayer, updateLayer, toggleLock, serialize, deserialize, makeDefaultEnvLayer } from './layers';

const t = (over = {}): any => ({ id: 'a', type: 'text', name: 'T', hidden: false, rot: 0, locked: false, x: 0, y: 0, w: 10, h: 10, text: 'X', size: 20, font: 'F', italic: false, spacing: 0, ...over });

describe('layers', () => {
  it('adds to front (index 0)', () => { const l = addLayer([t({ id: 'a' })], t({ id: 'b' })); expect(l[0].id).toBe('b'); });
  it('removes by id', () => { expect(removeLayer([t({ id: 'a' }), t({ id: 'b' })], 'a').map(x => x.id)).toEqual(['b']); });
  it('updates a patch', () => { expect(updateLayer([t({ id: 'a', x: 0 })], 'a', { x: 5 })[0].x).toBe(5); });
  it('toggles lock', () => { expect(toggleLock([t({ id: 'a', locked: false })], 'a')[0].locked).toBe(true); });
  it('round-trips via serialize/deserialize', () => { const l = [t({ id: 'a' })]; expect(deserialize(serialize(l))).toEqual(l); });
});

describe('makeDefaultEnvLayer', () => {
  it('is a locked env layer with the Dexal GLB and the baked default pose', () => {
    const env = makeDefaultEnvLayer();
    expect(env.type).toBe('env');
    expect(env.locked).toBe(true);
    expect(env.glb).toBe('dexal.glb');
    expect(env.mapScale).toBe(1.5);
    expect(env.position).toEqual([-50.5, 10, 27]);
    expect(env.rotation[1]).toBeCloseTo(1.6057, 3);
  });
  it('seeds one variation binding all 5 material slots', () => {
    const env = makeDefaultEnvLayer();
    expect(env.variations).toHaveLength(1);
    expect(env.activeVariation).toBe('Chaos Top');
    const slots = Object.keys(env.variations[0].textures);
    expect(slots).toHaveLength(5);
    // Every periph slot binds a 1bit-alpha cutout; grounds bind ground webps.
    expect(env.variations[0].textures.Periph_Top_G_MAT).toContain('1bitalpha');
    expect(env.variations[0].textures.Ground_B1_ChaosTop_A_MAT).toContain('Ground_B1');
  });
  it('round-trips through serialize/deserialize', () => {
    const env = makeDefaultEnvLayer();
    expect(deserialize(serialize([env]))).toEqual([env]);
  });
});
