import { describe, expect, it } from 'vitest';
import { sampleEffectValue } from './idleEffectValues';

describe('idle effect values', () => {
    it('multiplies birth constants by a clamped lifetime curve', () => {
        const value = { constantValue: [20, 10, 5], dynamics: { times: [0, 1], values: [[0, 1, 1], [1, 0, 2]] } };
        expect(sampleEffectValue(value, 0.5, [1, 1, 1])).toEqual([10, 5, 7.5]);
        expect(sampleEffectValue(value, 4, [1, 1, 1])).toEqual([20, 0, 10]);
    });
    it('keeps per-particle probability rolls stable across updates', () => {
        const value = { constantValue: 10, dynamics: { probabilityTables: [{ keyTimes: [0, 1], keyValues: [0.5, 1.5] }] } };
        expect(sampleEffectValue(value, 0, [1], [0.25])).toEqual([7.5]);
        expect(sampleEffectValue(value, 1, [1], [0.25])).toEqual([7.5]);
    });
    it('handles absent, malformed and duplicate keys without NaN', () => {
        expect(sampleEffectValue(undefined, 0, [1, 2, 3])).toEqual([1, 2, 3]);
        expect(sampleEffectValue({ constantValue: 2, dynamics: { times: [0, 0, 1], values: [0, 1, 2] } }, 0, [1])).toEqual([2]);
        expect(sampleEffectValue({ constantValue: NaN }, 0, [4])).toEqual([4]);
    });
});
