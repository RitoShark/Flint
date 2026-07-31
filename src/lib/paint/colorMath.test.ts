import { describe, expect, it } from 'vitest';
import { hexToVec4, vec4ToCss, vec4ToHex } from './colorMath';
import type { Vec4 } from './colorMath';

describe('vec4ToHex', () => {
    it('rounds channels to bytes', () => {
        expect(vec4ToHex([1, 0, 0, 1])).toBe('#ff0000');
        expect(vec4ToHex([0, 0, 0, 1])).toBe('#000000');
        expect(vec4ToHex([0.5, 0.5, 0.5, 1])).toBe('#808080');
    });

    it('clamps out-of-range channels rather than emitting bad hex', () => {
        // Some bins carry HDR-ish values above 1; a swatch must still render.
        expect(vec4ToHex([2, -1, 0.5, 1])).toBe('#ff0080');
    });

    it('ignores alpha — it is edited on its own control', () => {
        expect(vec4ToHex([1, 0, 0, 0.25])).toBe('#ff0000');
    });
});

describe('hexToVec4', () => {
    it('parses the three accepted forms', () => {
        expect(hexToVec4('#f00')).toEqual([1, 0, 0, 1]);
        expect(hexToVec4('#ff0000')).toEqual([1, 0, 0, 1]);
        expect(hexToVec4('#ff000080')?.[3]).toBeCloseTo(128 / 255, 5);
    });

    it('accepts a missing leading hash', () => {
        expect(hexToVec4('00ff00')).toEqual([0, 1, 0, 1]);
    });

    it('keeps the caller-supplied alpha for 6-digit input', () => {
        expect(hexToVec4('#ff0000', 0.4)?.[3]).toBeCloseTo(0.4, 5);
    });

    it('returns null on junk so callers keep the previous color', () => {
        // Writing black on a typo would silently destroy the user's value.
        expect(hexToVec4('')).toBeNull();
        expect(hexToVec4('#12345')).toBeNull();
        expect(hexToVec4('#gggggg')).toBeNull();
    });

    it('round-trips through hex', () => {
        const original: Vec4 = [0.2, 0.4, 0.6, 1];
        const back = hexToVec4(vec4ToHex(original));
        expect(back![0]).toBeCloseTo(original[0], 2);
        expect(back![1]).toBeCloseTo(original[1], 2);
        expect(back![2]).toBeCloseTo(original[2], 2);
    });
});

describe('vec4ToCss', () => {
    it('carries alpha so translucent keyframes read as translucent', () => {
        expect(vec4ToCss([1, 0, 0, 0.5])).toBe('rgba(255, 0, 0, 0.500)');
    });
});

