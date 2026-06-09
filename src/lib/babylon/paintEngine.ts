/**
 * paintEngine.ts — pure projection-painting math (no Babylon/DOM deps).
 *
 * Composites brush dabs into per-texture RGBA buffers: blend modes, soft brush
 * falloff, round-dab stamping, stroke interpolation, UV→texel mapping, and
 * edge-dilation (paint bled past UV-island edges so seams don't leave a line).
 * MapPreview wires pointer picks (→ texture + UV) to these.
 */

export type BlendMode = 'Normal' | 'Dodge' | 'Multiply';

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
        // Dodge: dst / (1 - src), guarded against divide-by-zero / blowout.
        const s = (src / 255) * strength;
        const denom = 1 - s;
        out = denom <= 1e-4 ? 255 : dst / denom;
    }
    return Math.max(0, Math.min(255, Math.round(out)));
}

/** Brush falloff: dist & radius in same units; hardness 0(soft)..1(hard). 0..1. */
export function falloff(dist: number, radius: number, hardness = 0.5): number {
    if (radius <= 0) return dist === 0 ? 1 : 0;
    const t = dist / radius;
    if (t >= 1) return 0;
    if (t <= hardness) return 1;
    const x = (t - hardness) / (1 - hardness); // 0..1 across the soft band
    return 1 - x * x;                           // smooth fade to 0
}

/** Composite a round dab centered at texel (cx,cy), radius in texels. Alpha kept. */
export function stampDab(
    buf: Uint8Array, w: number, h: number,
    cx: number, cy: number, radius: number, brush: Brush,
): void {
    const r = Math.ceil(radius);
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
            const f = falloff(Math.sqrt(dx * dx + dy * dy), radius, brush.hardness);
            if (f <= 0) continue;
            const strength = brush.opacity * brush.flow * f;
            const i = (y * w + x) * 4;
            buf[i]     = blendChannel(brush.mode, buf[i],     brush.color[0], strength);
            buf[i + 1] = blendChannel(brush.mode, buf[i + 1], brush.color[1], strength);
            buf[i + 2] = blendChannel(brush.mode, buf[i + 2], brush.color[2], strength);
            // alpha untouched — don't punch holes in cutouts.
        }
    }
}

/** UV (0..1) → texel (V flipped to match texture top-left origin). */
export function uvToTexel(u: number, v: number, w: number, h: number): [number, number] {
    return [u * w, (1 - v) * h];
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

/** Bleed RGB from opaque texels into adjacent transparent ones, `passes` rings.
 *  Mirrors the alpha-bleed fix; keeps paint from cutting off at island edges. */
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
