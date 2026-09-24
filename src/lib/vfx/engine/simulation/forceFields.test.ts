import { describe, expect, it } from 'vitest';
import { impulsesOwed, noiseClock, noiseInto, orbitFieldInto, type SampledNoise } from './forceFields';

const field: SampledNoise = {centre: [0, 0, 0], radius: 10, axes: [1, 1, 1], delta: 3, kicks: 4, first: 0, slot: 2};

describe('particle field evaluation', () => {
    it('replays noise independently of particle iteration order and step grouping', () => {
        const together = new Float32Array(3);
        const split = new Float32Array(3);
        noiseInto(together, [0, 0, 0], field, 19);
        for (let first = 0; first < 4; first++) {
            noiseInto(new Float32Array(3), [0, 0, 0], field, 57);
            noiseInto(split, [0, 0, 0], {...field, kicks: 1, first}, 19);
        }
        expect(split).toEqual(together);
    });

    it('distributes single impulses across all axes without changing their magnitude', () => {
        const mean = [0, 0, 0];
        const positive = [0, 0, 0];
        for (let serial = 0; serial < 4096; serial++) {
            const output = new Float32Array(3);
            noiseInto(output, [0, 0, 0], {...field, kicks: 1}, serial);
            expect(Math.hypot(...output)).toBeCloseTo(3, 5);
            output.forEach((value, axis) => {
                mean[axis] += value / 4096;
                positive[axis] += Number(value > 0);
            });
        }
        for (let axis = 0; axis < 3; axis++) {
            expect(Math.abs(mean[axis])).toBeLessThan(0.1);
            expect(positive[axis]).toBeGreaterThan(1850);
            expect(positive[axis]).toBeLessThan(2250);
        }
    });

    it('ignores invalid clock inputs and bounds overdue impulses', () => {
        const clock = noiseClock();
        expect(impulsesOwed(clock, 10, NaN)).toBe(0);
        expect(clock).toEqual(noiseClock());
        expect(impulsesOwed(clock, 10, 0)).toBe(1);
        expect(impulsesOwed(clock, Infinity, 10)).toBe(0);
        expect(impulsesOwed(clock, 1000000, 1)).toBe(256);
        expect(clock.fired).toBe(257);
    });

    it('preserves speed and axial velocity under orbital constraints', () => {
        const axis = [1 / 3, 2 / 3, 2 / 3];
        const output = Float32Array.of(6, -2, 7);
        const original = [...output];
        const dot = (value: ArrayLike<number>) => axis.reduce((sum, component, index) => sum + component * value[index], 0);
        orbitFieldInto(output, [15, 3, -4], [2, -1, 5], axis);
        expect(Math.hypot(...output)).toBeCloseTo(Math.hypot(...original), 5);
        expect(dot(output)).toBeCloseTo(dot(original), 5);
    });
});
