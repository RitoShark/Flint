import { afterEach, describe, expect, it, vi } from 'vitest';
import { motionDuration } from './motion';

afterEach(() => vi.unstubAllGlobals());

describe('motionDuration', () => {
    it('preserves the exit duration with full motion enabled', () => {
        vi.stubGlobal('document', { documentElement: { dataset: { fps: 'off' } } });
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        expect(motionDuration(280)).toBe(280);
    });

    it('removes exit delays as soon as FPS mode changes', () => {
        const dataset = { fps: 'off' };
        vi.stubGlobal('document', { documentElement: { dataset } });
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        expect(motionDuration(180)).toBe(180);
        dataset.fps = 'on';
        expect(motionDuration(180)).toBe(0);
    });

    it('honors the system reduced-motion preference', () => {
        vi.stubGlobal('document', { documentElement: { dataset: { fps: 'off' } } });
        vi.stubGlobal('matchMedia', () => ({ matches: true }));
        expect(motionDuration(140)).toBe(0);
    });

    it('does not delay rendering without a document', () => {
        vi.stubGlobal('document', undefined);
        expect(motionDuration(280)).toBe(0);
    });
});
