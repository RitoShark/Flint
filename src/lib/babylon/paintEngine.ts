export type BlendMode = 'Normal' | 'Dodge' | 'Multiply';

/** Texels with alpha below this are cutout transparent/edge texels (dark/garbage
 *  RGB, alpha-tested away by the material) — never paint them, or the black edge
 *  silhouette bleeds into the stroke. ~0.8 of full leaves only solid interior. */
const SOLID_ALPHA = 200;

export interface Brush {
    mode: BlendMode;
    color: [number, number, number]; // 0..255 RGB
    opacity: number;                 // 0..1 max strength
    flow: number;                    // 0..1 build per dab
    hardness: number;                // 0..1  (0 soft → 1 hard edge)
}

/** Composite one 0..255 channel. strength = opacity*flow*falloff (0..1). */
export function blendChannel(mode: BlendMode, dst: number, src: number, strength: number): number {
    let out: number;
    if (mode === 'Normal') {
        out = dst + (src - dst) * strength;
    } else if (mode === 'Multiply') {
        const m = (dst * src) / 255;
        out = dst + (m - dst) * strength;
    } else {
        // Dodge — GIMP legacy formula: comp = 256 * base / (256 - blend),
        // clamped to 255. (Equivalent to base/(1-blend) but matching GIMP's
        // exact constants.) `strength` lerps the result toward it.
        const full = src >= 255 ? 255 : Math.min(255, (256 * dst) / (256 - src));
        out = dst + (full - dst) * strength;
    }
    return Math.max(0, Math.min(255, Math.round(out)));
}

/** Brush falloff: dist & radius in same units; hardness 0(soft)..1(hard) → 0..1.
 *  Low hardness = a much more drastic, gradual fade: the soft-band curve is
 *  raised to a power that grows as hardness drops (≈4 at hardness 0, →1 near 1),
 *  so a soft brush concentrates strongly at the center and trails far out. */
export function falloff(dist: number, radius: number, hardness = 0.5): number {
    if (radius <= 0) return dist === 0 ? 1 : 0;
    const t = dist / radius;
    if (t >= 1) return 0;
    if (t <= hardness) return 1;
    const x = (t - hardness) / (1 - hardness); // 0..1 across the soft band
    const base = 1 - x * x;                     // smooth fade to 0
    const power = 1 + (1 - hardness) * 3;       // 1 (hard) … 4 (very soft)
    return Math.pow(base, power);
}

/**
 * Accumulate a round dab into a per-stroke COVERAGE mask (0..1 per texel) using
 * MAX, not addition — so overlapping dabs WITHIN one stroke don't compound into
 * a blow-out. The mask is clamped to `opacity` (the stroke's ceiling); `flow`
 * scales how strongly each dab builds.
 */
export function stampMask(
    mask: Float32Array, w: number, h: number,
    cx: number, cy: number, radius: number, hardness: number, opacity: number, flow: number,
): void {
    const r = Math.ceil(radius);
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            const f = falloff(Math.sqrt(dx * dx + dy * dy), radius, hardness);
            if (f <= 0) continue;
            const cov = Math.min(opacity, f * flow);
            const i = y * w + x;
            if (cov > mask[i]) mask[i] = cov; // MAX: no within-stroke buildup
        }
    }
}

/**
 * Composite a finished stroke: for each texel the mask covers, blend the brush
 * color over the ORIGINAL (pre-stroke) base by the blend mode, then lerp from
 * base→blended by the mask coverage. Writing into `out` from `base0` each time
 * means re-compositing the same stroke is idempotent (safe to call per frame).
 *   out = lerp(base0, blend(base0, color), coverage)
 */
export function compositeMask(
    out: Uint8Array, base0: Uint8Array, mask: Float32Array, w: number, h: number,
    mode: BlendMode, color: [number, number, number],
): void {
    const n = w * h;
    for (let i = 0; i < n; i++) {
        const cov = mask[i];
        if (cov <= 0) continue;
        const o = i * 4;
        // Skip transparent AND semi-transparent EDGE texels of cutouts: those
        // edge texels have dark/garbage RGB (and the material alpha-tests them
        // away anyway), so painting them blends black into the silhouette. Only
        // paint solidly-opaque texels (alpha ≥ threshold).
        if (base0[o + 3] < SOLID_ALPHA) continue;
        for (let c = 0; c < 3; c++) {
            const b = base0[o + c];
            const blended = blendChannel(mode, b, color[c], 1);
            out[o + c] = Math.round(b + (blended - b) * cov);
        }
    }
}

/**
 * Eraser: lerp each masked texel from the pre-stroke base toward the ORIGINAL
 * (never-painted) texture by coverage. Composited from base0 each frame so it's
 * idempotent like compositeMask. coverage 1 = fully back to original.
 */
export function compositeErase(
    out: Uint8Array, base0: Uint8Array, orig: Uint8Array, mask: Float32Array, w: number, h: number,
): void {
    const n = w * h;
    for (let i = 0; i < n; i++) {
        const cov = mask[i];
        if (cov <= 0) continue;
        const o = i * 4;
        if (base0[o + 3] < SOLID_ALPHA) continue; // skip transparent/edge texels
        for (let c = 0; c < 3; c++) {
            const b = base0[o + c];
            out[o + c] = Math.round(b + (orig[o + c] - b) * cov);
        }
    }
}

/** Points from a..b spaced ~radius/4 apart (both ends inclusive). */
export function strokeDabs(a: [number, number], b: [number, number], radius: number): [number, number][] {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    const spacing = Math.max(radius / 4, 0.5);
    const n = Math.max(1, Math.floor(len / spacing));
    const out: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        out.push([a[0] + dx * t, a[1] + dy * t]);
    }
    return out;
}

/** Bleed RGB from opaque texels into adjacent transparent ones, `passes` rings,
 *  so paint doesn't cut off at UV-island edges. */
export function edgeDilate(buf: Uint8Array, w: number, h: number, passes = 4): void {
    const N = w * h;
    const filled = new Uint8Array(N);
    for (let p = 0; p < N; p++) filled[p] = buf[p * 4 + 3] !== 0 ? 1 : 0;
    const nb = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (let pass = 0; pass < passes; pass++) {
        const add: number[] = [];
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = y * w + x;
                if (filled[p]) continue;
                let r = 0, g = 0, b = 0, c = 0;
                for (const [dx, dy] of nb) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                    const np = ny * w + nx;
                    if (filled[np]) { const o = np * 4; r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; c++; }
                }
                if (c) { const o = p * 4; buf[o] = (r / c) | 0; buf[o + 1] = (g / c) | 0; buf[o + 2] = (b / c) | 0; add.push(p); }
            }
        }
        if (!add.length) break;
        for (const p of add) filled[p] = 1;
    }
}
