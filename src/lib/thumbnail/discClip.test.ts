import { describe, it, expect } from 'vitest';
import { discClipEllipse, discClipInModelSpace, clipPathFor, clipPathOutside } from './discClip';

// The disc box from the shipped Riot preset (the RING piece is the anchor).
const disc = { x: 330, y: 0, w: 123, h: 360 };

describe('discClipEllipse', () => {
    it('uses the BLACK FILL rect, not the disc layer box', () => {
        const e = discClipEllipse(disc);
        // Fill rect = layer origin + BLACK_OFFSET (dx:16, dy:-26, 407x412).
        expect(e.cx).toBeCloseTo(330 + 16 + 407 / 2);
        expect(e.cy).toBeCloseTo(0 - 26 + 412 / 2);
        expect(e.rx).toBeCloseTo(407 / 2);
        expect(e.ry).toBeCloseTo(412 / 2);
    });

    it('is a true ellipse — the fill is slightly taller than wide', () => {
        const e = discClipEllipse(disc);
        expect(e.ry).toBeGreaterThan(e.rx);
    });

    it('translates with the disc box', () => {
        const moved = discClipEllipse({ ...disc, x: disc.x + 50, y: disc.y + 20 });
        const base = discClipEllipse(disc);
        expect(moved.cx - base.cx).toBeCloseTo(50);
        expect(moved.cy - base.cy).toBeCloseTo(20);
    });

    it('carries the disc rotation', () => {
        expect(discClipEllipse({ ...disc, rot: 30 }).rot).toBe(30);
    });

    it('defaults rotation to 0 when the disc has none', () => {
        expect(discClipEllipse(disc).rot).toBe(0);
    });
});

describe('discClipInModelSpace', () => {
    it('offsets the ellipse by the model box origin', () => {
        const model = { x: 100, y: 40, w: 200, h: 260 };
        const stageE = discClipEllipse(disc);
        const local = discClipInModelSpace(disc, model);
        expect(local.cx).toBeCloseTo(stageE.cx - 100);
        expect(local.cy).toBeCloseTo(stageE.cy - 40);
    });

    it('keeps radii unchanged — only the origin moves', () => {
        const local = discClipInModelSpace(disc, { x: 100, y: 40, w: 200, h: 260 });
        expect(local.rx).toBeCloseTo(407 / 2);
        expect(local.ry).toBeCloseTo(412 / 2);
    });

    it('treats a zero-sized model box as filling the stage (origin 0,0)', () => {
        const stageE = discClipEllipse(disc);
        const local = discClipInModelSpace(disc, { x: 999, y: 999, w: 0, h: 0 });
        expect(local.cx).toBeCloseTo(stageE.cx);
        expect(local.cy).toBeCloseTo(stageE.cy);
    });
});

describe('clipPathFor', () => {
    it('emits a CSS ellipse() for an unrotated disc', () => {
        const css = clipPathFor({ cx: 100, cy: 50, rx: 20, ry: 25, rot: 0 });
        expect(css).toBe('ellipse(20px 25px at 100px 50px)');
    });

    it('falls back to a polygon when rotated, since ellipse() cannot express it', () => {
        const css = clipPathFor({ cx: 100, cy: 50, rx: 20, ry: 25, rot: 45 });
        expect(css.startsWith('polygon(')).toBe(true);
    });

    it('cuts BOTH modes at the same ellipse, so the two halves tile without a seam', () => {
        // The inside and outside clips must share one boundary — a mismatch
        // would leave a gap or a double-drawn sliver where they meet.
        const e = discClipEllipse(disc);
        const outside = clipPathOutside(e, { w: 640, h: 360 });
        // The punch-out ring must sample the very same ellipse the inside clip
        // uses: its extreme X must reach cx ± rx.
        const xs = [...outside.matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)].map(m => parseFloat(m[1]));
        expect(Math.max(...xs.filter(x => x <= e.cx + e.rx + 0.5))).toBeCloseTo(e.cx + e.rx, 0);
    });

    it('outside mode spans the whole model box so everything but the circle survives', () => {
        const e = discClipEllipse(disc);
        const css = clipPathOutside(e, { w: 640, h: 360 });
        expect(css.startsWith('polygon(')).toBe(true);
        expect(css).toContain('0px 0px');
        expect(css).toContain('640px 0px');
        expect(css).toContain('640px 360px');
    });

    it('outside mode winds the hole opposite the rect (nonzero rule needs it)', () => {
        const e = { cx: 100, cy: 100, rx: 50, ry: 50, rot: 0 };
        const css = clipPathOutside(e, { w: 200, h: 200 });
        const pts = [...css.matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)].map(m => [parseFloat(m[1]), parseFloat(m[2])]);
        // Skip the 4 rect corners + the repeated closing point.
        const ring = pts.slice(5, 5 + 8);
        // Signed area of the sampled ring must be negative (opposite winding to
        // the clockwise outer rect); a positive area would fill, not punch.
        let area = 0;
        for (let i = 0; i < ring.length - 1; i += 1) {
            area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        }
        expect(area).toBeLessThan(0);
    });

    it('keeps the rotated polygon centred on the ellipse centre', () => {
        const css = clipPathFor({ cx: 100, cy: 50, rx: 20, ry: 20, rot: 45 });
        const nums = [...css.matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)];
        const xs = nums.map(m => parseFloat(m[1]));
        const ys = nums.map(m => parseFloat(m[2]));
        // A rotated circle's sampled points still average to the centre.
        expect(xs.reduce((a, b) => a + b, 0) / xs.length).toBeCloseTo(100, 1);
        expect(ys.reduce((a, b) => a + b, 0) / ys.length).toBeCloseTo(50, 1);
    });
});
