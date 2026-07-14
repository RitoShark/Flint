/**
 * Submesh-visibility timeline for the SKN preview.
 *
 * League skins hide/show submeshes two ways:
 *  - a static baseline (`initialSubmeshToHide` on the skin BIN), applied at load;
 *  - per-animation-clip `SubmeshVisibilityEventData` events that toggle submeshes at a frame.
 *
 * Event lists store submeshes as FNV1a-32 (lowercased) hashes of the submesh name. We hash
 * each SKN submesh name the same way and match numerically — no hash dictionary needed.
 *
 * Visibility is a cumulative fold: start from the baseline, then apply every event whose
 * frame is at or before the current time, in order, hiding first then showing (show wins on a
 * tie). Because it's cumulative, scrubbing or looping must recompute from the baseline.
 */

import type { SubmeshVisEvent } from '../api/mesh';

/** FNV1a-32 over the lowercased ASCII bytes of `s`. Matches `ritoshark::hash::fnv1a` and the
 *  bin `hash` / `list[hash]` convention: A–Z fold to a–z, other bytes pass through. */
export function fnv1a32Lower(s: string): number {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < s.length; i += 1) {
        let c = s.charCodeAt(i);
        if (c >= 0x41 && c <= 0x5a) c |= 0x20; // ASCII tolower, gated to A–Z
        h = (h ^ c) >>> 0;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

export interface SubmeshTimelineInit {
    /** All submesh names in the mesh (the SKN material-range names). */
    submeshNames: string[];
    /** Names hidden at load, before any animation (`initialSubmeshToHide`). */
    initialHide: string[];
    /** This clip's visibility events, sorted by `start_frame`. */
    events: SubmeshVisEvent[];
    /** Frames per second of the clip's `.anm`, for frame→seconds conversion. */
    fps: number;
}

/**
 * Computes which submesh names are hidden at any point in a clip's playback.
 *
 * All name comparisons are case-insensitive (names are normalized to lowercase internally);
 * the returned sets contain the ORIGINAL submesh names so callers can drive Babylon meshes by
 * their real name.
 */
export class SubmeshVisibilityTimeline {
    private readonly fps: number;
    private readonly events: SubmeshVisEvent[];
    /** Lowercased baseline-hidden names. */
    private readonly baseHiddenLower: Set<string>;
    /** hash → original submesh name, for resolving event hash lists back to names. */
    private readonly nameByHash: Map<number, string>;
    /** lowercased name → original name, for the baseline. */
    private readonly originalByLower: Map<string, string>;

    constructor(init: SubmeshTimelineInit) {
        this.fps = init.fps > 0 ? init.fps : 30;
        // Events are expected pre-sorted by the backend; sort defensively in case.
        this.events = [...init.events].sort((a, b) => a.start_frame - b.start_frame);

        this.nameByHash = new Map();
        this.originalByLower = new Map();
        for (const name of init.submeshNames) {
            const lower = name.toLowerCase();
            this.nameByHash.set(fnv1a32Lower(name), name);
            this.originalByLower.set(lower, name);
        }

        this.baseHiddenLower = new Set(init.initialHide.map((n) => n.toLowerCase()));
    }

    /** The baseline hidden set (original names), before any animation event fires. */
    baselineHidden(): Set<string> {
        const out = new Set<string>();
        for (const lower of this.baseHiddenLower) {
            out.add(this.originalByLower.get(lower) ?? lower);
        }
        return out;
    }

    /** Whether this clip has any visibility events at all. */
    hasEvents(): boolean {
        return this.events.length > 0;
    }

    /**
     * Hidden submesh names (original casing) at time `tSeconds`: baseline folded with every
     * event whose frame is at or before `tSeconds` (hide then show per event; show wins).
     */
    hiddenAt(tSeconds: number): Set<string> {
        const hidden = new Set(this.baseHiddenLower);
        for (const ev of this.events) {
            if (ev.start_frame / this.fps > tSeconds) break; // events are sorted
            for (const h of ev.hide_hashes) {
                const name = this.nameByHash.get(h >>> 0);
                if (name) hidden.add(name.toLowerCase());
            }
            for (const h of ev.show_hashes) {
                const name = this.nameByHash.get(h >>> 0);
                if (name) hidden.delete(name.toLowerCase());
            }
        }
        // Map back to original names.
        const out = new Set<string>();
        for (const lower of hidden) {
            out.add(this.originalByLower.get(lower) ?? lower);
        }
        return out;
    }

    /**
     * The set of VISIBLE submesh names at `tSeconds` — the complement of `hiddenAt` over all
     * submesh names. Convenient for driving a `visibleMaterials` set directly.
     */
    visibleAt(tSeconds: number): Set<string> {
        const hidden = this.hiddenAt(tSeconds);
        const visible = new Set<string>();
        for (const name of this.originalByLower.values()) {
            if (!hidden.has(name)) visible.add(name);
        }
        return visible;
    }
}
