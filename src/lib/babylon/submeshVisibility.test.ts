import { describe, it, expect } from 'vitest';
import { fnv1a32Lower, SubmeshVisibilityTimeline } from './submeshVisibility';
import type { SubmeshVisEvent } from '../api/mesh';

describe('fnv1a32Lower', () => {
    it('matches the verified Rust value for a real submesh name', () => {
        // Same value asserted in the Rust test (submesh_visibility.rs).
        expect(fnv1a32Lower('Kayn_Skin20_Slayer_Hair_MAT') >>> 0).toBe(0xa973e905);
    });

    it('is case-insensitive (folds A–Z)', () => {
        expect(fnv1a32Lower('Body_MAT')).toBe(fnv1a32Lower('body_mat'));
    });
});

const NAMES = ['Body_MAT', 'Hair_MAT', 'Wings', 'Sword'];

function ev(startFrame: number, hide: string[], show: string[]): SubmeshVisEvent {
    return {
        start_frame: startFrame,
        hide_hashes: hide.map((n) => fnv1a32Lower(n)),
        show_hashes: show.map((n) => fnv1a32Lower(n)),
    };
}

describe('SubmeshVisibilityTimeline', () => {
    it('applies the initial-hide baseline before any event', () => {
        const t = new SubmeshVisibilityTimeline({
            submeshNames: NAMES,
            initialHide: ['Wings'],
            events: [],
            fps: 30,
        });
        expect(t.baselineHidden()).toEqual(new Set(['Wings']));
        expect(t.hiddenAt(0)).toEqual(new Set(['Wings']));
        expect(t.visibleAt(0)).toEqual(new Set(['Body_MAT', 'Hair_MAT', 'Sword']));
    });

    it('folds hide-then-show events cumulatively over time', () => {
        const t = new SubmeshVisibilityTimeline({
            submeshNames: NAMES,
            initialHide: [],
            events: [
                ev(30, ['Hair_MAT'], []), // frame 30 = 1.0s: hide hair
                ev(60, [], ['Hair_MAT']), // frame 60 = 2.0s: show hair again
                ev(60, ['Sword'], []), // and hide sword
            ],
            fps: 30,
        });
        // Before any event.
        expect(t.hiddenAt(0.5)).toEqual(new Set([]));
        // After the first event (1.0s).
        expect(t.hiddenAt(1.0)).toEqual(new Set(['Hair_MAT']));
        expect(t.hiddenAt(1.5)).toEqual(new Set(['Hair_MAT']));
        // After the 2.0s events: hair shown again, sword hidden.
        expect(t.hiddenAt(2.0)).toEqual(new Set(['Sword']));
    });

    it('show wins when a submesh is both hidden and shown at the same time', () => {
        const t = new SubmeshVisibilityTimeline({
            submeshNames: NAMES,
            initialHide: ['Body_MAT'],
            events: [ev(0, ['Body_MAT'], ['Body_MAT'])], // hide then show → visible
            fps: 30,
        });
        expect(t.hiddenAt(0)).toEqual(new Set([]));
    });

    it('recomputes from baseline when scrubbing backward', () => {
        const t = new SubmeshVisibilityTimeline({
            submeshNames: NAMES,
            initialHide: [],
            events: [ev(30, ['Sword'], [])],
            fps: 30,
        });
        // Forward past the event, then back before it — hiddenAt is stateless, so scrubbing
        // back correctly returns to the pre-event state.
        expect(t.hiddenAt(2.0)).toEqual(new Set(['Sword']));
        expect(t.hiddenAt(0.5)).toEqual(new Set([]));
    });

    it('ignores event hashes that match no submesh (stale/other-skin refs)', () => {
        const t = new SubmeshVisibilityTimeline({
            submeshNames: NAMES,
            initialHide: [],
            events: [{ start_frame: 0, hide_hashes: [0xdeadbeef], show_hashes: [] }],
            fps: 30,
        });
        expect(t.hiddenAt(1.0)).toEqual(new Set([]));
    });
});
