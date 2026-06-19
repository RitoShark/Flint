import { describe, it, expect } from 'vitest';
import { blendChannel, falloff, stampMask, compositeMask, strokeDabs, edgeDilate } from './paintEngine';

describe('blendChannel', () => {
    it('Normal lerps dst toward src by strength', () => {
        expect(blendChannel('Normal', 100, 200, 0.5)).toBe(150);
    });
    it('Multiply darkens', () => {
        expect(blendChannel('Multiply', 200, 128, 1)).toBe(Math.round(200 * 128 / 255));
    });
    it('Dodge lightens and clamps to 255', () => {
        expect(blendChannel('Dodge', 200, 255, 1)).toBe(255);
        expect(blendChannel('Dodge', 100, 0, 1)).toBe(100);
    });
});

describe('falloff', () => {
    it('is 1 at center', () => expect(falloff(0, 1)).toBeCloseTo(1));
    it('is 0 at/after radius', () => expect(falloff(1, 1)).toBeCloseTo(0));
    it('hardness=1 is flat (1 until edge)', () => expect(falloff(0.9, 1, 1)).toBeCloseTo(1));
    it('soft (hardness 0) fades before edge', () => expect(falloff(0.5, 1, 0)).toBeLessThan(1));
});

describe('strokeDabs', () => {
    it('places spaced points between two texels, ends inclusive', () => {
        const pts = strokeDabs([0, 0], [10, 0], 4);
        expect(pts.length).toBeGreaterThan(5);
        expect(pts[0]).toEqual([0, 0]);
        expect(pts[pts.length - 1]).toEqual([10, 0]);
    });
});

describe('stampMask + compositeMask', () => {
    it('overlapping dabs use MAX (no buildup beyond opacity)', () => {
        const W = 4, H = 4, mask = new Float32Array(W * H);
        stampMask(mask, W, H, 2, 2, 1, 1, 0.6, 1);
        stampMask(mask, W, H, 2, 2, 1, 1, 0.6, 1);
        // Center coverage is capped at opacity, not summed to 1.2.
        expect(mask[2 * W + 2]).toBeCloseTo(0.6);
    });
    it('Dodge composite does not blow out past a single application', () => {
        const W = 2, H = 2;
        const base = new Uint8Array([100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255]);
        const base0 = new Uint8Array(base);
        const mask = new Float32Array(W * H).fill(0.5);
        compositeMask(base, base0, mask, W, H, 'Dodge', [128, 128, 128]);
        const full = blendChannel('Dodge', 100, 128, 1);
        const expected = Math.round(100 + (full - 100) * 0.5);
        expect(base[0]).toBe(expected);
        compositeMask(base, base0, mask, W, H, 'Dodge', [128, 128, 128]);
        expect(base[0]).toBe(expected);
    });
});

describe('edgeDilate', () => {
    it('bleeds opaque RGB into adjacent transparent texels, alpha kept', () => {
        const W = 3, H = 1, buf = new Uint8Array(W * H * 4);
        buf[0] = 10; buf[1] = 200; buf[2] = 40; buf[3] = 255;
        buf[4] = 255; buf[5] = 255; buf[6] = 255; buf[7] = 0;
        buf[8] = 255; buf[9] = 255; buf[10] = 255; buf[11] = 0;
        edgeDilate(buf, W, H, 1);
        expect(buf[4]).toBe(10);
        expect(buf[5]).toBe(200);
        expect(buf[7]).toBe(0);
    });
});
