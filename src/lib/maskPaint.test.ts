import { describe, it, expect } from 'vitest';
import {
    compositeMaskBlue,
    compositeEraseBlue,
    maskToDisplayRgba,
} from './maskPaint';

// 2x1 RGBA buffer helper.
function buf(values: number[][]): Uint8Array {
    const out = new Uint8Array(values.length * 4);
    values.forEach((px, i) => out.set(px, i * 4));
    return out;
}

describe('compositeMaskBlue', () => {
    it('writes coverage into blue, leaves R/G/A untouched, builds with MAX', () => {
        const base = buf([[10, 20, 30, 255], [10, 20, 40, 255]]);
        const out = new Uint8Array(base);
        const mask = new Float32Array([1, 0.5]);
        compositeMaskBlue(out, base, mask, 2, 1);
        // px0: cov 1 -> blue 255
        expect(out[2]).toBe(255);
        // px1: cov 0.5 -> 128, but base blue 40 is lower, so MAX keeps 128
        expect(out[6]).toBe(128);
        // R/G/A unchanged
        expect(out[0]).toBe(10);
        expect(out[1]).toBe(20);
        expect(out[3]).toBe(255);
    });

    it('never reduces existing blue (MAX)', () => {
        const base = buf([[0, 0, 200, 255]]);
        const out = new Uint8Array(base);
        const mask = new Float32Array([0.1]); // 0.1*255 = 26 < 200
        compositeMaskBlue(out, base, mask, 1, 1);
        expect(out[2]).toBe(200);
    });

    it('zero coverage copies base blue through', () => {
        const base = buf([[0, 0, 77, 255]]);
        const out = new Uint8Array(4);
        compositeMaskBlue(out, base, new Float32Array([0]), 1, 1);
        expect(out[2]).toBe(77);
    });
});

describe('compositeEraseBlue', () => {
    it('drives blue toward 0 by coverage', () => {
        const base = buf([[0, 0, 200, 255], [0, 0, 200, 255]]);
        const out = new Uint8Array(base);
        const mask = new Float32Array([1, 0.5]);
        compositeEraseBlue(out, base, mask, 2, 1);
        expect(out[2]).toBe(0); // fully erased
        expect(out[6]).toBe(100); // 200 * (1 - 0.5)
    });
});

describe('maskToDisplayRgba', () => {
    it('maps blue intensity to overlay alpha', () => {
        const src = buf([[0, 0, 0, 255], [0, 0, 200, 255]]);
        const out = maskToDisplayRgba(src);
        expect(out[3]).toBe(0); // unpainted -> transparent
        expect(out[7]).toBe(200); // painted -> alpha follows blue
    });
});
