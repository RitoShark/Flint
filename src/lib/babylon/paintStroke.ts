import { blendChannel, type Brush } from './paintEngine';

export interface PaintSurface { rgba: Uint8Array; orig: Uint8Array; w: number; h: number }
export interface PaintPatch { surface: PaintSurface; x: number; y: number; w: number; h: number; before: Uint8Array }
interface Tile extends PaintPatch { mask: Float32Array; dirty: boolean }
export interface ProjectedSample { surface: PaintSurface; x: number; y: number; radius: number; coverage: number; key: number }
const TILE = 64;

export function copyPatch(s: PaintSurface, x: number, y: number, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) out.set(s.rgba.subarray(((y + row) * s.w + x) * 4, ((y + row) * s.w + x + w) * 4), row * w * 4);
    return out;
}

/** Each patch swaps in place, serving both undo and redo without a second copy. */
export function swapPatches(patches: PaintPatch[]): void {
    for (const p of patches) {
        const current = copyPatch(p.surface, p.x, p.y, p.w, p.h);
        for (let row = 0; row < p.h; row++) p.surface.rgba.set(p.before.subarray(row * p.w * 4, (row + 1) * p.w * 4), ((p.y + row) * p.surface.w + p.x) * 4);
        p.before = current;
    }
}

/** Bounded history; edits across several texture files remain one undo action. */
export class PaintHistory {
    undo: PaintPatch[][] = [];
    redo: PaintPatch[][] = [];
    constructor(private budget = 128 * 1024 * 1024) {}
    clear() { this.undo = []; this.redo = []; }
    commit(patches: PaintPatch[]) {
        if (!patches.length) return;
        this.redo = [];
        this.undo.push(patches);
        let bytes = this.undo.reduce((n, stroke) => n + stroke.reduce((b, p) => b + p.before.byteLength, 0), 0);
        while (this.undo.length > 1 && (bytes > this.budget || this.undo.length > 30)) {
            bytes -= this.undo.shift()!.reduce((b, p) => b + p.before.byteLength, 0);
        }
    }
    swap(direction: 'undo' | 'redo'): PaintPatch[] {
        const patches = this[direction].pop();
        if (!patches) return [];
        swapPatches(patches);
        this[direction === 'undo' ? 'redo' : 'undo'].push(patches);
        return patches;
    }
}

/** Lazy 64px tiles hold pre-stroke color and coverage. There is no full-image
 * mask allocation, recomposite pass, or full-image copy at pointer down. */
export class PaintStroke {
    private tiles = new Map<PaintSurface, Map<number, Tile>>();
    private pending = new Set<Tile>();
    private scratch = new Map<Tile, Float32Array>();
    private tip = new Float32Array(0);
    private nextTip = new Float32Array(0);

    private tile(s: PaintSurface, x: number, y: number): Tile {
        let tiles = this.tiles.get(s);
        if (!tiles) { tiles = new Map(); this.tiles.set(s, tiles); }
        const tx = Math.floor(x / TILE) * TILE, ty = Math.floor(y / TILE) * TILE;
        const key = ty * s.w + tx;
        let t = tiles.get(key);
        if (!t) {
            const w = Math.min(TILE, s.w - tx), h = Math.min(TILE, s.h - ty);
            t = { surface: s, x: tx, y: ty, w, h, before: copyPatch(s, tx, ty, w, h), mask: new Float32Array(w * h), dirty: false };
            tiles.set(key, t);
        }
        return t;
    }

    private visit(s: PaintSurface, cx: number, cy: number, radius: number, prepare: (t: Tile) => (local: number, offset: number) => void) {
        if (![cx, cy, radius].every(Number.isFinite) || radius <= 0) return;
        const x0 = Math.max(0, Math.ceil(cx - radius - 0.5)), x1 = Math.min(s.w - 1, Math.floor(cx + radius - 0.5));
        const y0 = Math.max(0, Math.ceil(cy - radius - 0.5)), y1 = Math.min(s.h - 1, Math.floor(cy + radius - 0.5));
        const r2 = radius * radius;
        // Get each tile once per stamp, not once per pixel.
        for (let ty = Math.floor(y0 / TILE) * TILE; ty <= y1; ty += TILE) {
            for (let tx = Math.floor(x0 / TILE) * TILE; tx <= x1; tx += TILE) {
                let t: Tile | undefined;
                let pixel: ((local: number, offset: number) => void) | undefined;
                for (let y = Math.max(y0, ty); y <= Math.min(y1, ty + TILE - 1); y++) {
                    const dy2 = (y + 0.5 - cy) ** 2;
                    for (let x = Math.max(x0, tx); x <= Math.min(x1, tx + TILE - 1); x++) {
                        if ((x + 0.5 - cx) ** 2 + dy2 >= r2) continue;
                        const o = (y * s.w + x) * 4;
                        if (s.rgba[o + 3] < 200) continue;
                        if (!t) { t = this.tile(s, x, y); pixel = prepare(t); }
                        pixel!((y - t.y) * t.w + x - t.x, o);
                    }
                }
            }
        }
    }

    stamp(sample: ProjectedSample, brush: Brush, erase: boolean) {
        const cov = Math.min(brush.opacity, brush.flow * sample.coverage);
        if (cov <= 0) return;
        this.visit(sample.surface, sample.x, sample.y, sample.radius, t => (i, o) => {
            if (cov <= t.mask[i]) return;
            t.mask[i] = cov;
            const rgba = t.surface.rgba;
            let changed = false;
            for (let c = 0; c < 3; c++) {
                const base = t.before[i * 4 + c];
                const target = erase ? t.surface.orig[o + c] : blendChannel(brush.mode, base, brush.color[c], 1);
                const value = Math.round(base + (target - base) * cov);
                if (value !== rgba[o + c]) { rgba[o + c] = value; changed = true; }
            }
            if (changed) { t.dirty = true; this.pending.add(t); }
        });
    }

    resetTip() { this.tip.fill(0); }

    smudge(samples: ProjectedSample[], count: number, tipSize: number, strength: number) {
        for (const _step of this.smudgeSteps(samples, count, tipSize, strength)) { void _step; }
    }

    *smudgeSteps(samples: ProjectedSample[], count: number, tipSize: number, strength: number): Generator<void> {
        if (this.tip.length !== tipSize * 4) {
            this.tip = new Float32Array(tipSize * 4);
            this.nextTip = new Float32Array(tipSize * 4);
        }
        this.nextTip.fill(0);
        const used = new Set<Tile>();
        // Sample every source before applying any destination, including across files.
        for (let n = 0; n < count; n++) {
            if (n % 64 === 0) yield;
            const s = samples[n], rgba = s.surface.rgba;
            const offset = (Math.floor(s.y) * s.surface.w + Math.floor(s.x)) * 4;
            if (rgba[offset + 3] < 200) continue;
            const key = s.key * 4, a = Math.min(1, Math.max(0, strength * s.coverage));
            const hasSource = this.tip[key + 3] > 0;
            const r = this.tip[key], g = this.tip[key + 1], b = this.tip[key + 2];
            this.nextTip[key] = hasSource ? rgba[offset] + (r - rgba[offset]) * a : rgba[offset];
            this.nextTip[key + 1] = hasSource ? rgba[offset + 1] + (g - rgba[offset + 1]) * a : rgba[offset + 1];
            this.nextTip[key + 2] = hasSource ? rgba[offset + 2] + (b - rgba[offset + 2]) * a : rgba[offset + 2];
            this.nextTip[key + 3] = 1;
            if (!hasSource || a <= 0) continue;
            this.visit(s.surface, s.x, s.y, s.radius, t => {
                let accum = this.scratch.get(t);
                if (!accum) { accum = new Float32Array(t.w * t.h * 5); this.scratch.set(t, accum); }
                if (!used.has(t)) { accum.fill(0); used.add(t); }
                const values = accum;
                return i => {
                    const p = i * 5;
                    values[p] += r * a; values[p + 1] += g * a; values[p + 2] += b * a;
                    values[p + 3] += a; values[p + 4] = Math.max(values[p + 4], a);
                };
            });
        }
        for (const t of used) {
            yield;
            const accum = this.scratch.get(t)!, rgba = t.surface.rgba;
            let changed = false;
            for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
                const p = (y * t.w + x) * 5, weight = accum[p + 3];
                if (!weight) continue;
                const o = ((t.y + y) * t.surface.w + t.x + x) * 4;
                for (let c = 0; c < 3; c++) {
                    const v = Math.round(rgba[o + c] + (accum[p + c] / weight - rgba[o + c]) * accum[p + 4]);
                    if (v !== rgba[o + c]) { rgba[o + c] = v; changed = true; }
                }
            }
            if (changed) { t.dirty = true; this.pending.add(t); }
        }
        const previous = this.tip; this.tip = this.nextTip; this.nextTip = previous;
    }

    takeUpdates(): PaintPatch[] {
        const updates = [...this.pending]; this.pending.clear(); return updates;
    }
    finish(): PaintPatch[] {
        const patches: PaintPatch[] = [];
        for (const tiles of this.tiles.values()) for (const t of tiles.values()) {
            if (t.dirty) patches.push({ surface: t.surface, x: t.x, y: t.y, w: t.w, h: t.h, before: t.before });
        }
        return patches;
    }
}

/** Authored sampler addressing, including negative/mirrored UVs and exact edges. */
export function addressUv(value: number, mode: number): number {
    if (mode === 0) return value - Math.floor(value);
    if (mode === 2) { const period = ((value % 2) + 2) % 2; return Math.min(1 - 1e-7, period <= 1 ? period : 2 - period); }
    return Math.max(0, Math.min(1 - 1e-7, value));
}
