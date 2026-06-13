/**
 * maskPaint.ts — single-channel (blue) mask compositing for the Animated
 * Loadscreen Banner editor.
 *
 * Reuses the channel-agnostic brush math from `babylon/paintEngine.ts`
 * (`falloff`, `stampMask`, `strokeDabs`) and adds flat-2D composites that write
 * ONLY the blue channel of an RGBA buffer — the mask the banner shader reads.
 * R/G (the scroll pattern) and A are untouched.
 *
 * CONVENTION (Photoshop-style "paint to protect"):
 *   In the shader, blue HIGH = animated VFX shows there. The artist authors the
 *   mask by painting the CHAMPION to keep it CLEAN, so the brush MASKS OUT:
 *
 *   brush:  blue = min(blue, (1-coverage)*255)   (drive DOWN to 0 — protect)
 *   eraser: blue = max(blue, coverage*255)       (drive UP to 255 — restore VFX)
 *
 *   A fresh mask starts blue=255 everywhere (whole banner glows); you paint the
 *   champion to carve it out of the effect.
 */

export { falloff, stampMask, strokeDabs } from './babylon/paintEngine';

/**
 * Brush stroke = MASK OUT (protect). Drive the blue channel DOWN toward 0 where
 * painted, so the painted region (the champion) gets NO VFX. MIN keeps it
 * idempotent and stops overlapping dabs from carving past the floor.
 * Works from `base0` (pre-stroke buffer) so it can be re-run every frame.
 *   out.B = min(base0.B, (1-coverage)*255)
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
        const carved = Math.round((1 - cov) * 255);
        out[o + 2] = carved < b0 ? carved : b0;
    }
}

/**
 * Eraser = RESTORE VFX. Drive the blue channel UP toward 255 by coverage, so an
 * over-masked region gets the effect back. Idempotent from `base0`.
 *   out.B = max(base0.B, round(coverage*255))
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
        const restored = Math.round(cov * 255);
        out[o + 2] = restored > b0 ? restored : b0;
    }
}

/**
 * Build a display RGBA (for the on-canvas overlay) from the mask buffer. The
 * user paints the PROTECTED region (blue LOW), so highlight where blue is LOW
 * with a soft red tint — that's "this stays clean / no VFX". Where blue is high
 * (VFX), the overlay is transparent so the loadscreen shows through.
 */
export function maskToDisplayRgba(rgba: Uint8Array): Uint8ClampedArray {
    const out = new Uint8ClampedArray(rgba.length);
    for (let o = 0; o < rgba.length; o += 4) {
        const b = rgba[o + 2];
        // Red-ish highlight where PROTECTED (blue low); transparent where VFX.
        out[o] = 255;
        out[o + 1] = 70;
        out[o + 2] = 70;
        out[o + 3] = 255 - b; // intensity = how protected (inverse of blue)
    }
    return out;
}
