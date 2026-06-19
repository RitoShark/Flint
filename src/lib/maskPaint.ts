export { falloff, stampMask, strokeDabs } from './babylon/paintEngine';

/**
 * Brush = MASK OUT (protect): `out.B = min(base0.B, (1-coverage)*255)`, working
 * from `base0` (pre-stroke buffer) so it can be re-run every frame.
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

/** Eraser = RESTORE VFX: `out.B = max(base0.B, round(coverage*255))`. */
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
 * Build the on-canvas overlay RGBA from the mask buffer: a red tint whose alpha
 * tracks how protected each pixel is (inverse of blue), transparent where VFX.
 */
export function maskToDisplayRgba(rgba: Uint8Array): Uint8ClampedArray {
    const out = new Uint8ClampedArray(rgba.length);
    for (let o = 0; o < rgba.length; o += 4) {
        const b = rgba[o + 2];
        out[o] = 255;
        out[o + 1] = 70;
        out[o + 2] = 70;
        out[o + 3] = 255 - b;
    }
    return out;
}
