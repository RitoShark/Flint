import { describe, expect, it } from 'vitest';
import { Rng } from '../utils/Rng';
import { birth, sampleShape } from './spawnShape';

describe('Babylon spawn transforms', () => {
    it('rotates the combined legacy offset and translation around the authored axis', () => {
        const flat = (...constant: number[]) => ({constant, keys: [], tables: []});
        const output = birth();
        sampleShape({kind: 'legacy', offset: flat(2, 0, 0), translation: flat(0, 1, 0), angles: [flat(90)], axes: [[0, 0, 3]]}, new Rng(5), 0, 0, output);
        expect(output.offset[0]).toBeCloseTo(-1);
        expect(output.offset[1]).toBeCloseTo(2);
        expect(output.offset[2]).toBeCloseTo(0);
    });

    it('keeps separate scratch buffers independent and clears a reused rotation', () => {
        const first = birth();
        const second = birth();
        sampleShape({kind: 'sphere', volume: false, radius: 7}, new Rng(8), 0, 0, first);
        const saved = first.offset.slice();
        sampleShape({kind: 'cylinder', volume: true, radius: 3, height: 5}, new Rng(8), 0, 0, second);
        expect(first.offset).toEqual(saved);
        sampleShape({kind: 'point', offset: [1, 2, 3]}, new Rng(8), 0, 0, first);
        expect(Array.from(first.offset)).toEqual([1, 2, 3]);
        expect(Array.from(first.turn)).toEqual([1,0,0,0,1,0,0,0,1]);
        expect(first.turned).toBe(false);
    });

    it('keeps spherical surface births on the radius across seeds', () => {
        const output = birth();
        for (let seed = 0; seed < 100; seed++) {
            sampleShape({kind: 'sphere', volume: false, radius: 7}, new Rng(seed), 0, 0, output);
            expect(Math.hypot(...output.offset)).toBeCloseTo(7, 5);
        }
    });
});
