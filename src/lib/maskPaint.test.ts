import { describe, it, expect } from 'vitest';
import {
    compositeMaskBlue,
    compositeEraseBlue,
    maskToDisplayRgba,
} from './maskPaint';

function buf(values: number[][]): Uint8Array {
    const out = new Uint8Array(values.length * 4);
    values.forEach((px, i) => out.set(px, i * 4));
    return out;
}

describe('compositeMaskBlue (brush = mask out, drives blue DOWN)', () => {
    it('carves blue toward 0 by coverage, leaves R/G/A untouched, builds with MIN', () => {
        const base = buf([[10, 20, 255, 255], [10, 20, 220, 255]]);
        const out = new Uint8Array(base);
        const mask = new Float32Array([1, 0.5]);
        compositeMaskBlue(out, base, mask, 2, 1);
        expect(out[2]).toBe(0);
        expect(out[6]).toBe(128);
        expect(out[0]).toBe(10);
        expect(out[1]).toBe(20);
        expect(out[3]).toBe(255);
    });

    it('never raises existing blue (MIN) — only carves down', () => {
        const base = buf([[0, 0, 50, 255]]);
        const out = new Uint8Array(base);
        const mask = new Float32Array([0.1]);
        compositeMaskBlue(out, base, mask, 1, 1);
        expect(out[2]).toBe(50);
    });

    it('zero coverage copies base blue through', () => {
        const base = buf([[0, 0, 77, 255]]);
        const out = new Uint8Array(4);
        compositeMaskBlue(out, base, new Float32Array([0]), 1, 1);
        expect(out[2]).toBe(77);
    });
});

describe('compositeEraseBlue (eraser = restore VFX, drives blue UP)', () => {
    it('raises blue toward 255 by coverage, MAX', () => {
        const base = buf([[0, 0, 50, 255], [0, 0, 50, 255]]);
        const out = new Uint8Array(base);
        const mask = new Float32Array([1, 0.5]);
        compositeEraseBlue(out, base, mask, 2, 1);
        expect(out[2]).toBe(255);
        expect(out[6]).toBe(128);
    });

    it('never lowers existing blue (MAX)', () => {
        const base = buf([[0, 0, 200, 255]]);
        const out = new Uint8Array(base);
        const mask = new Float32Array([0.1]);
        compositeEraseBlue(out, base, mask, 1, 1);
        expect(out[2]).toBe(200);
    });
});

describe('maskToDisplayRgba (highlights the PROTECTED region)', () => {
    it('maps inverse-blue to overlay alpha — protected (low blue) is opaque', () => {
        const src = buf([[0, 0, 255, 255], [0, 0, 55, 255]]);
        const out = maskToDisplayRgba(src);
        expect(out[3]).toBe(0);
        expect(out[7]).toBe(200);
    });
});
