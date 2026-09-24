import { describe, expect, it } from 'vitest';
import { drawCurve, drawCurveInto, sampleCurve } from './sampleCurve';
import type { ValueCurve } from '../model/model';

describe('particle curve buffer evaluation', () => {
    it('applies all probability multipliers before rounding to a float buffer', () => {
        const value: ValueCurve = {
            constant: [1 / 3, 2 / 3], keys: [],
            tables: [{channel: 0, single: 11 / 7, keys: []}, {channel: 0, single: 13 / 9, keys: []}],
        };
        const output = new Float32Array(5).fill(-1);
        drawCurveInto(value, 0.6, 0.2, output, 2);
        expect(Array.from(output)).toEqual([-1, -1, ...Float32Array.from(drawCurve(value, 0.6, 0.2)), -1]);
    });

    it('selects the last coincident key and clamps both keyed ranges', () => {
        const value: ValueCurve = {
            constant: [999],
            keys: [{time: 2, values: [2]}, {time: 2, values: [3]}, {time: 4, values: [7]}],
            tables: [{channel: 0, single: 999, keys: [{time: 0.3, values: [2]}, {time: 0.7, values: [4]}]}],
        };
        expect(sampleCurve(value, 1)).toEqual([2]);
        expect(sampleCurve(value, 2)).toEqual([3]);
        expect(drawCurve(value, 3, 0)).toEqual([10]);
        expect(drawCurve(value, 6, 1)).toEqual([28]);
    });

    it('does not multiply unrelated buffer channels by out-of-range tables', () => {
        const value: ValueCurve = {constant: [4], keys: [], tables: [
            {channel: -1, single: 2, keys: []}, {channel: 1, single: 3, keys: []},
        ]};
        const output = Float32Array.of(8, 8, 8);
        drawCurveInto(value, 0, 0, output, 1);
        expect(Array.from(output)).toEqual([8, 4, 8]);
    });
});
