import { describe, it, expect } from 'vitest';
import { PaintStroke, PaintHistory, swapPatches, addressUv, type PaintSurface, type ProjectedSample } from './paintStroke';
import { stampMask, compositeMask, compositeErase, type Brush } from './paintEngine';

function surface(w = 128, h = 128, color = [80, 100, 120, 255]): PaintSurface {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set(color, i);
    return { rgba, orig: rgba.slice(), w, h };
}
const sample = (s: PaintSurface, x = 0.5, y = 0.5, key = 0): ProjectedSample => ({ surface: s, x, y, key, radius: 0.75, coverage: 1 });
const brush: Brush = { mode: 'Normal', color: [200, 40, 10], opacity: 0.7, flow: 0.4, hardness: 0.3 };

describe('tiled paint engine', () => {
    for (const mode of ['Normal', 'Dodge', 'Multiply', 'Erase'] as const) {
        it(`matches full-image ${mode} compositing without scanning the full image`, () => {
            const s = surface(135, 129), before = s.rgba.slice(), expected = s.rgba.slice();
            s.orig.fill(42); s.rgba[3] = before[3] = expected[3] = 0;
            const stroke = new PaintStroke(), mask = new Float32Array(s.w * s.h);
            const b = { ...brush, mode: mode === 'Erase' ? 'Normal' as const : mode };
            for (const [x, y, r, coverage] of [[0, 0, 8, 1], [63, 64, 5, 0.4], [65, 65, 4, 1], [134, 128, 3, 1]]) {
                stroke.stamp({ ...sample(s, x, y), radius: r, coverage }, b, mode === 'Erase');
                stampMask(mask, s.w, s.h, x, y, r, 1, b.opacity, b.flow * coverage);
            }
            if (mode === 'Erase') compositeErase(expected, before, s.orig, mask, s.w, s.h);
            else compositeMask(expected, before, mask, s.w, s.h, mode, b.color);
            expect(s.rgba).toEqual(expected);
            expect(stroke.finish().reduce((n, p) => n + p.before.length, 0)).toBeLessThan(s.rgba.length);
        });
    }
    it('preserves cross-texture smudge pickup, alpha, undo and redo', () => {
        const a = surface(1, 1, [200, 100, 50, 255]), b = surface(1, 1, [0, 0, 0, 220]);
        const stroke = new PaintStroke();
        stroke.smudge([sample(a)], 1, 1, 0.5);
        expect(stroke.finish()).toHaveLength(0);
        stroke.smudge([sample(b)], 1, 1, 0.5);
        expect([...b.rgba]).toEqual([100, 50, 25, 220]);
        const patches = stroke.finish();
        swapPatches(patches); expect([...b.rgba]).toEqual([0, 0, 0, 220]);
        swapPatches(patches); expect([...b.rgba]).toEqual([100, 50, 25, 220]);
    });
    it('does not smear transparent padding, and resets pickup after a gap', () => {
        const a = surface(1, 1, [200, 100, 50, 0]), b = surface(1, 1);
        const stroke = new PaintStroke();
        stroke.smudge([sample(a)], 1, 1, 1);
        stroke.smudge([sample(b)], 1, 1, 1);
        expect(stroke.finish()).toHaveLength(0);
        stroke.resetTip();
        stroke.smudge([sample(a)], 1, 1, 1);
        expect([...a.rgba]).toEqual([200, 100, 50, 0]);
    });
    it('only uploads changed tiles and never stores a no-op stroke', () => {
        const s = surface(2048, 2048), stroke = new PaintStroke();
        stroke.stamp(sample(s, 100, 100), { ...brush, flow: 0 }, false);
        expect(stroke.takeUpdates()).toHaveLength(0);
        stroke.stamp(sample(s, 100, 100), brush, false);
        const updates = stroke.takeUpdates();
        expect(updates).toHaveLength(1);
        expect(updates[0].before.byteLength).toBe(64 * 64 * 4);
        expect(stroke.takeUpdates()).toHaveLength(0);
    });
    it('limits history memory and clears redo only when an edit commits', () => {
        const history = new PaintHistory(4), a = surface(1, 1);
        for (let i = 0; i < 3; i++) {
            const stroke = new PaintStroke(); stroke.stamp(sample(a), brush, false); history.commit(stroke.finish());
        }
        expect(history.undo).toHaveLength(1);
        history.swap('undo'); expect(history.redo).toHaveLength(1);
        history.commit([]); expect(history.redo).toHaveLength(1);
        const stroke = new PaintStroke(); stroke.stamp(sample(a), brush, false); history.commit(stroke.finish());
        expect(history.redo).toHaveLength(0);
    });
    it('addresses wrap, clamp and mirror without painting the wrong edge', () => {
        expect(addressUv(-0.25, 0)).toBe(0.75);
        expect(addressUv(1, 0)).toBe(0);
        expect(addressUv(-0.25, 1)).toBe(0);
        expect(addressUv(1, 1)).toBeLessThan(1);
        expect(addressUv(1.25, 2)).toBe(0.75);
        expect(addressUv(-0.25, 2)).toBe(0.25);
    });
});
