import { describe, it, expect } from 'vitest';
import { computeFraming, HOME_ALPHA, HOME_BETA } from './cameraFraming';

type Box = [[number, number, number], [number, number, number]];

const box = (min: [number, number, number], max: [number, number, number]): Box => [min, max];

describe('computeFraming', () => {
    it('centres on the bounding-box midpoint', () => {
        const f = computeFraming(box([-2, 0, -2], [4, 10, 4]));
        expect(f.center).toEqual([1, 5, 1]);
    });

    it('weights height so tall silhouettes get vertical room', () => {
        // A tall model (Aatrox's wings, etc.) would be clipped if radius came from
        // the largest raw dimension.
        const f = computeFraming(box([-1, 0, -1], [1, 10, 1]));
        expect(f.radius).toBeCloseTo(10 * 1.4);
    });

    it('uses the widest horizontal extent when the model is flat', () => {
        const f = computeFraming(box([-6, 0, -1], [6, 1, 1]));
        expect(f.radius).toBeCloseTo(12);
    });

    it('derives control constants from the framed radius', () => {
        const f = computeFraming(box([-1, 0, -1], [1, 10, 1]));
        const r = f.radius;
        expect(f.lowerRadiusLimit).toBeCloseTo(r * 0.02);
        expect(f.upperRadiusLimit).toBeCloseTo(r * 50);
        expect(f.wheelPrecision).toBeCloseTo(80 / r);
        expect(f.pinchPrecision).toBeCloseTo(160 / r);
        expect(f.panningSensibility).toBeCloseTo(8000 / r);
        expect(f.speed).toBeCloseTo(r * 0.02);
    });

    it('uses the canonical home orientation', () => {
        const f = computeFraming(box([0, 0, 0], [1, 1, 1]));
        expect(f.alpha).toBeCloseTo(HOME_ALPHA);
        expect(f.beta).toBeCloseTo(HOME_BETA);
    });

    it('never returns a zero or negative radius, so the camera cannot be trapped', () => {
        const degenerate = computeFraming(box([5, 5, 5], [5, 5, 5]));
        expect(degenerate.radius).toBeGreaterThan(0);
        expect(degenerate.lowerRadiusLimit).toBeGreaterThan(0);
    });
});

describe('computeFraming — invalid boxes', () => {
    it('falls back to a unit box when coordinates are not finite', () => {
        const f = computeFraming(box([NaN, 0, 0], [1, 1, 1]));
        expect(f.center).toEqual([0, 0, 0]);
        expect(f.radius).toBeCloseTo(2 * 1.4);
    });

    it('falls back when the box is inverted', () => {
        const f = computeFraming(box([5, 5, 5], [-5, -5, -5]));
        expect(f.center).toEqual([0, 0, 0]);
        expect(f.radius).toBeCloseTo(2 * 1.4);
    });

    it('falls back when Infinity appears', () => {
        const f = computeFraming(box([-Infinity, 0, 0], [1, 1, 1]));
        expect(f.center).toEqual([0, 0, 0]);
    });
});
