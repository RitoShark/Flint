import { describe, it, expect } from 'vitest';
import { computeDrawRect, calculateBudget } from './spritesheet';

describe('computeDrawRect', () => {
    it('stretch fills the whole frame regardless of source AR', () => {
        // 4:3 source into a 16:9 frame.
        const r = computeDrawRect(800, 600, 1920, 1080, 'stretch');
        expect(r).toEqual({ dx: 0, dy: 0, dw: 1920, dh: 1080 });
    });

    it('cover scales to fill and crops (source taller/narrower than frame)', () => {
        // 4:3 source (1.333) into 16:9 frame (1.778): must scale to width, crop top/bottom.
        const r = computeDrawRect(800, 600, 1920, 1080, 'cover');
        expect(r.dw).toBe(1920);
        expect(r.dh).toBeCloseTo(1440, 3); // 1920 / (4/3)
        expect(r.dx).toBe(0);
        expect(r.dy).toBeCloseTo((1080 - 1440) / 2, 3); // negative → overflow cropped
        expect(r.dy).toBeLessThan(0);
    });

    it('cover scales to fill and crops (source wider than frame)', () => {
        // 21:9 ultrawide (2.333) into 16:9 frame: scale to height, crop sides.
        const r = computeDrawRect(2560, 1080, 1920, 1080, 'cover');
        expect(r.dh).toBe(1080);
        expect(r.dw).toBeCloseTo(1080 * (2560 / 1080), 3); // 2560 → wider than 1920
        expect(r.dw).toBeGreaterThan(1920);
        expect(r.dx).toBeLessThan(0);
        expect(r.dy).toBe(0);
    });

    it('contain fits inside and letterboxes (source wider than frame)', () => {
        // 4:3 source into 16:9: constrain by height, pillarbox left/right.
        const r = computeDrawRect(800, 600, 1920, 1080, 'contain');
        expect(r.dh).toBe(1080);
        expect(r.dw).toBeCloseTo(1080 * (800 / 600), 3); // 1440, narrower than 1920
        expect(r.dw).toBeLessThan(1920);
        expect(r.dx).toBeGreaterThan(0); // pillarbox gap
        expect(r.dy).toBe(0);
    });

    it('contain letterboxes an ultrawide source into 16:9', () => {
        const r = computeDrawRect(2560, 1080, 1920, 1080, 'contain');
        expect(r.dw).toBe(1920); // constrain by width
        expect(r.dh).toBeLessThan(1080);
        expect(r.dy).toBeGreaterThan(0);
    });

    it('same-AR source is identical under all fit modes', () => {
        for (const mode of ['stretch', 'cover', 'contain'] as const) {
            const r = computeDrawRect(1920, 1080, 1280, 720, mode);
            expect(r.dx).toBeCloseTo(0, 3);
            expect(r.dy).toBeCloseTo(0, 3);
            expect(r.dw).toBeCloseTo(1280, 3);
            expect(r.dh).toBeCloseTo(720, 3);
        }
    });
});

describe('calculateBudget forced dims', () => {
    it('uses forced 16:9 dims instead of source AR when provided', () => {
        // Source is 4:3 (800×600) but forced to 1920×1080 at 50% scale.
        const b = calculateBudget({
            videoWidth: 800,
            videoHeight: 600,
            scaleFactor: 0.5,
            fps: 30,
            trimStart: 0,
            trimEnd: 1,
            forcedWidth: 1920,
            forcedHeight: 1080,
        });
        expect(b.frameW).toBe(960); // 1920 * 0.5
        expect(b.frameH).toBe(540); // 1080 * 0.5, NOT 600*0.5=300
    });

    it('falls back to source dims without forced values', () => {
        const b = calculateBudget({
            videoWidth: 800,
            videoHeight: 600,
            scaleFactor: 0.5,
            fps: 30,
            trimStart: 0,
            trimEnd: 1,
        });
        expect(b.frameW).toBe(400);
        expect(b.frameH).toBe(300);
    });
});
