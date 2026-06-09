import { describe, it, expect } from 'vitest';
import { blendChannel, falloff, stampDab, uvToTexel, strokeDabs, edgeDilate, paintTriangleScreen, type Brush, type PaintTri } from './paintEngine';

describe('blendChannel', () => {
    it('Normal lerps dst toward src by strength', () => {
        expect(blendChannel('Normal', 100, 200, 0.5)).toBe(150);
    });
    it('Multiply darkens', () => {
        expect(blendChannel('Multiply', 200, 128, 1)).toBe(Math.round(200 * 128 / 255));
    });
    it('Dodge lightens and clamps to 255', () => {
        expect(blendChannel('Dodge', 200, 255, 1)).toBe(255);
        expect(blendChannel('Dodge', 100, 0, 1)).toBe(100); // src 0 -> no change
    });
});

describe('falloff', () => {
    it('is 1 at center', () => expect(falloff(0, 1)).toBeCloseTo(1));
    it('is 0 at/after radius', () => expect(falloff(1, 1)).toBeCloseTo(0));
    it('hardness=1 is flat (1 until edge)', () => expect(falloff(0.9, 1, 1)).toBeCloseTo(1));
    it('soft (hardness 0) fades before edge', () => expect(falloff(0.5, 1, 0)).toBeLessThan(1));
});

const opaque = (w: number, h: number): Uint8Array => {
    const buf = new Uint8Array(w * h * 4);
    for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
    return buf;
};
const brush = (over: Partial<Brush> = {}): Brush =>
    ({ mode: 'Normal', color: [255, 0, 0], opacity: 1, flow: 1, hardness: 1, ...over });

describe('stampDab', () => {
    it('paints the center texel toward the color', () => {
        const W = 4, H = 4, buf = opaque(W, H);
        stampDab(buf, W, H, 2, 2, 1.5, brush());
        const ci = (2 * W + 2) * 4;
        expect(buf[ci]).toBe(255);
        expect(buf[ci + 1]).toBe(0);
    });
    it('leaves far texels untouched', () => {
        const W = 8, H = 8, buf = opaque(W, H);
        stampDab(buf, W, H, 1, 1, 1, brush({ color: [255, 255, 255] }));
        expect(buf[(6 * W + 6) * 4]).toBe(0);
    });
    it('preserves alpha', () => {
        const W = 4, H = 4, buf = opaque(W, H);
        stampDab(buf, W, H, 2, 2, 2, brush());
        expect(buf[(2 * W + 2) * 4 + 3]).toBe(255);
    });
});

describe('uvToTexel', () => {
    it('flips V', () => expect(uvToTexel(0.5, 1.0, 100, 100)).toEqual([50, 0]));
});

describe('strokeDabs', () => {
    it('places spaced points between two texels, ends inclusive', () => {
        const pts = strokeDabs([0, 0], [10, 0], 4);
        expect(pts.length).toBeGreaterThan(5);
        expect(pts[0]).toEqual([0, 0]);
        expect(pts[pts.length - 1]).toEqual([10, 0]);
    });
});

describe('paintTriangleScreen', () => {
    // A UV triangle filling the whole 8x8 texture, projected to a screen region.
    const W = 8, H = 8;
    const fullUvTri: PaintTri = {
        // UV: (0,1),(1,1),(0,0)  -> covers a corner half of the texture
        u: [0, 1, 0], v: [1, 1, 0],
        sx: [0, 100, 0], sy: [0, 0, 100], // screen positions
    };
    it('paints texels whose SCREEN position is under the brush', () => {
        const buf = new Uint8Array(W * H * 4); for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
        // Brush centered at screen (5,5) with big radius covers the near corner.
        const n = paintTriangleScreen(buf, W, H, fullUvTri, 5, 5, 40,
            { mode: 'Normal', color: [255, 0, 0], opacity: 1, flow: 1, hardness: 1 });
        expect(n).toBeGreaterThan(0);
    });
    it('paints nothing when the brush is far from the triangle on screen', () => {
        const buf = new Uint8Array(W * H * 4); for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
        const n = paintTriangleScreen(buf, W, H, fullUvTri, 5000, 5000, 10,
            { mode: 'Normal', color: [255, 0, 0], opacity: 1, flow: 1, hardness: 1 });
        expect(n).toBe(0);
    });
});

describe('edgeDilate', () => {
    it('bleeds opaque RGB into adjacent transparent texels, alpha kept', () => {
        const W = 3, H = 1, buf = new Uint8Array(W * H * 4);
        buf[0] = 10; buf[1] = 200; buf[2] = 40; buf[3] = 255; // (0,0) opaque green
        buf[4] = 255; buf[5] = 255; buf[6] = 255; buf[7] = 0; // (1,0) transparent white
        buf[8] = 255; buf[9] = 255; buf[10] = 255; buf[11] = 0;
        edgeDilate(buf, W, H, 1);
        expect(buf[4]).toBe(10);
        expect(buf[5]).toBe(200);
        expect(buf[7]).toBe(0);
    });
});
