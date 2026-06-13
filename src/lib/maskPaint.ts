/**
 * maskPaint.ts — single-channel (blue) mask compositing for the Animated
 * Loadscreen Banner editor.
 *
 * Reuses the channel-agnostic brush math from `babylon/paintEngine.ts`
 * (`falloff`, `stampMask`, `strokeDabs`) and adds flat-2D composites that write
 * ONLY the blue channel of an RGBA buffer — the mask the banner shader reads.
 * R and G stay 0, A stays 255, so the saved `.tex` is a clean blue mask.
 *
 *   paint:  blue = max(blue, coverage*255)   (build up, never reduce)
 *   erase:  blue = blue * (1 - coverage)     (reduce toward 0)
 */

export { falloff, stampMask, strokeDabs } from './babylon/paintEngine';

/**
 * Composite a finished paint stroke into the blue channel. For each masked
 * texel, raise blue toward `coverage*255` (MAX, so re-compositing the same
 * stroke is idempotent and overlapping dabs don't compound past the ceiling).
 * Works from `base0` (the pre-stroke buffer) so it can be re-run every frame.
 *   out.B = max(base0.B, coverage*255)
 */
export function compositeMaskBlue(
    out: Uint8Array,
    base0: Uint8Array,
    mask: Float32Array,
    w: number,
    h: number,
): void {
    const n = w * h;
    for (let i = 0; i < n; i++) {
        const cov = mask[i];
        const o = i * 4;
        const b0 = base0[o + 2];
        if (cov <= 0) {
            out[o + 2] = b0;
            continue;
        }
        const painted = Math.round(cov * 255);
        out[o + 2] = painted > b0 ? painted : b0;
    }
}

/**
 * Eraser: reduce the blue channel toward 0 by coverage. Idempotent from
 * `base0`. coverage 1 = fully erased to 0.
 *   out.B = round(base0.B * (1 - coverage))
 */
export function compositeEraseBlue(
    out: Uint8Array,
    base0: Uint8Array,
    mask: Float32Array,
    w: number,
    h: number,
): void {
    const n = w * h;
    for (let i = 0; i < n; i++) {
        const cov = mask[i];
        const o = i * 4;
        const b0 = base0[o + 2];
        if (cov <= 0) {
            out[o + 2] = b0;
            continue;
        }
        out[o + 2] = Math.round(b0 * (1 - cov));
    }
}

/**
 * Normalize an arbitrary RGBA buffer into clean mask form: keep the blue
 * channel, zero R and G, set A to 255. Used right before saving so the `.tex`
 * is a pure blue mask regardless of what the source texture carried.
 */
export function normalizeMaskRgba(rgba: Uint8Array): Uint8Array {
    const out = new Uint8Array(rgba.length);
    for (let o = 0; o < rgba.length; o += 4) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = rgba[o + 2];
        out[o + 3] = 255;
    }
    return out;
}

/**
 * Build a display RGBA (for the on-canvas overlay) from the mask buffer: show
 * the blue channel as a soft cyan tint so the user sees what they've painted
 * over the dimmed loadscreen. Alpha follows the blue intensity.
 */
export function maskToDisplayRgba(rgba: Uint8Array): Uint8ClampedArray {
    const out = new Uint8ClampedArray(rgba.length);
    for (let o = 0; o < rgba.length; o += 4) {
        const b = rgba[o + 2];
        // Cyan-ish highlight where painted; transparent where not.
        out[o] = 40;
        out[o + 1] = 200;
        out[o + 2] = 255;
        out[o + 3] = b; // intensity = painted blue
    }
    return out;
}
