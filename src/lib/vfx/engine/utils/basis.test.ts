import { describe, expect, it } from 'vitest';
import { alongInto, mirrorInto, multiplyInto, standingInto, turnInto, unscaleInto } from './basis';

describe('particle transforms', () => {
    it('preserves lengths through composed rotations for arbitrary orientations', () => {
        const first = new Float32Array(9);
        const second = new Float32Array(9);
        for (let sample = 1; sample <= 100; sample++) {
            standingInto(Float32Array.of(sample * 13, sample * -7, sample * 29), 0, 11, first);
            alongInto(Float32Array.of(sample - 50, 30 - sample, sample % 7), 0, second);
            const value = Float32Array.of(3, -4, 12);
            multiplyInto(first, second, second);
            turnInto(second, value, 0);
            expect(Math.hypot(...value)).toBeCloseTo(13, 5);
        }
    });

    it('handles overlapping input and output views when mirroring', () => {
        const storage = Float32Array.from({ length: 12 }, (_, index) => index + 1);
        mirrorInto(storage, 0, storage, 3);
        expect([...storage.slice(3)]).toEqual([1, -2, -3, -4, 5, 6, -7, 8, 9]);
    });

    it('extracts scale before writing to overlapping output', () => {
        const storage = Float32Array.of(0, -2, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0);
        const scale = new Float32Array(3);
        unscaleInto(storage, 0, storage, 3, scale);
        expect([...scale]).toEqual([3, 2, 4]);
        expect([...storage.slice(3)]).toEqual([0, -1, 0, 1, 0, 0, 0, 0, 1]);
    });
});
