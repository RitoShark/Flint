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

/** A triangle for screen-space painting: 3 screen points (px) + 3 UVs (0..1). */
export interface PaintTri {
    sx: [number, number, number]; // screen X of each vertex
    sy: [number, number, number]; // screen Y of each vertex
    u: [number, number, number];  // UV u of each vertex
    v: [number, number, number];  // UV v of each vertex
}

/**
 * Screen-space projection paint into one texture: rasterize a triangle's UV
 * footprint, but weight each texel by its SCREEN distance to the brush center.
 * A round brush ON SCREEN therefore makes a round mark ON THE MODEL regardless
 * of how fragmented the UVs are (no UV-disc scatter). This is the core fix.
 *
 * @param cx,cy   screen brush center (px)
 * @param radiusPx screen brush radius (px)
 * @returns number of texels painted (for debugging/bounds)
 */
export function paintTriangleScreen(
    buf: Uint8Array, w: number, h: number,
    tri: PaintTri, cx: number, cy: number, radiusPx: number, brush: Brush,
): number {
    // UV-space bounding box of the triangle in texels (V flipped).
    const tx0 = tri.u[0] * w, tx1 = tri.u[1] * w, tx2 = tri.u[2] * w;
    const ty0 = (1 - tri.v[0]) * h, ty1 = (1 - tri.v[1]) * h, ty2 = (1 - tri.v[2]) * h;
    const minX = Math.max(0, Math.floor(Math.min(tx0, tx1, tx2)));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(tx0, tx1, tx2)));
    const minY = Math.max(0, Math.floor(Math.min(ty0, ty1, ty2)));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(ty0, ty1, ty2)));

    // Barycentric setup in texel space.
    const d = (ty1 - ty2) * (tx0 - tx2) + (tx2 - tx1) * (ty0 - ty2);
    if (Math.abs(d) < 1e-9) return 0;
    let painted = 0;
    for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
            const fx = px + 0.5, fy = py + 0.5;
            const a = ((ty1 - ty2) * (fx - tx2) + (tx2 - tx1) * (fy - ty2)) / d;
            const b = ((ty2 - ty0) * (fx - tx2) + (tx0 - tx2) * (fy - ty2)) / d;
            const c = 1 - a - b;
            if (a < -0.001 || b < -0.001 || c < -0.001) continue; // outside tri
            // Interpolate the texel's SCREEN position from the triangle's verts.
            const ssx = a * tri.sx[0] + b * tri.sx[1] + c * tri.sx[2];
            const ssy = a * tri.sy[0] + b * tri.sy[1] + c * tri.sy[2];
            const sd = Math.hypot(ssx - cx, ssy - cy);
            const f = falloff(sd, radiusPx, brush.hardness);
            if (f <= 0) continue;
            const strength = brush.opacity * brush.flow * f;
            const i = (py * w + px) * 4;
            buf[i]     = blendChannel(brush.mode, buf[i],     brush.color[0], strength);
            buf[i + 1] = blendChannel(brush.mode, buf[i + 1], brush.color[1], strength);
            buf[i + 2] = blendChannel(brush.mode, buf[i + 2], brush.color[2], strength);
            painted++;
        }
    }
    return painted;
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
