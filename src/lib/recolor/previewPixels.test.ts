import { describe, it, expect } from 'vitest';
import { applyHueShift, applyColorize, applyGrayscaleTint, rgbToHsl } from './previewPixels';

/* Build an RGBA buffer from [r,g,b,a] tuples. */
const buf = (...px: [number, number, number, number][]) =>
    new Uint8ClampedArray(px.flat());

describe('applyHueShift', () => {
    it('is identity at 0° / 1x / 1x', () => {
        const d = buf([200, 100, 50, 255]);
        applyHueShift(d, 0, 1, 1);
        expect([...d]).toEqual([200, 100, 50, 255]);
    });

    it('leaves alpha untouched', () => {
        const d = buf([200, 100, 50, 128]);
        applyHueShift(d, 90, 1.5, 0.5);
        expect(d[3]).toBe(128);
    });

    it('brightness 0 blacks out an opaque pixel', () => {
        const d = buf([200, 100, 50, 255]);
        applyHueShift(d, 0, 1, 0);
        expect([d[0], d[1], d[2]]).toEqual([0, 0, 0]);
    });
});

describe('applyColorize', () => {
    it('drives all opaque pixels to (near) the target hue', () => {
        const d = buf([200, 40, 40, 255], [40, 200, 40, 255]);
        applyColorize(d, 210, true); // blue-ish
        const h1 = rgbToHsl(d[0], d[1], d[2])[0];
        const h2 = rgbToHsl(d[4], d[5], d[6])[0];
        expect(Math.abs(h1 - 210)).toBeLessThan(2);
        expect(Math.abs(h2 - 210)).toBeLessThan(2);
    });

    it('keeps distinct lightness between a light and a dark pixel', () => {
        const d = buf([230, 210, 210, 255], [60, 40, 40, 255]);
        applyColorize(d, 120, true);
        const l1 = rgbToHsl(d[0], d[1], d[2])[2];
        const l2 = rgbToHsl(d[4], d[5], d[6])[2];
        expect(l1).toBeGreaterThan(l2 + 0.2);
    });

    it('preserve=false yields lower saturation than preserve=true on a saturated pixel', () => {
        const on = buf([220, 30, 30, 255]);
        const off = buf([220, 30, 30, 255]);
        applyColorize(on, 120, true);
        applyColorize(off, 120, false);
        const sOn = rgbToHsl(on[0], on[1], on[2])[1];
        const sOff = rgbToHsl(off[0], off[1], off[2])[1];
        expect(sOff).toBeLessThan(sOn);
    });

    it('leaves alpha untouched', () => {
        const d = buf([220, 30, 30, 77]);
        applyColorize(d, 120, false);
        expect(d[3]).toBe(77);
    });
});

describe('applyGrayscaleTint', () => {
    it('produces a low-saturation tint (not the original hue)', () => {
        const d = buf([220, 30, 30, 255]); // vivid red
        applyGrayscaleTint(d, 210);
        const [, s] = rgbToHsl(d[0], d[1], d[2]);
        expect(s).toBeLessThan(0.5);
    });
});
