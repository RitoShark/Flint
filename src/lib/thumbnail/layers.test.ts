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
