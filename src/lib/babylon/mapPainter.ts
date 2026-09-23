import type { Engine } from '@babylonjs/core/Engines/engine';
import type { Scene } from '@babylonjs/core/scene';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import type { BuiltMapMesh } from './mapMeshBuilder';
import { createUvPass, type UvPass, type UvGroup } from './uvPaintPass';
import { falloff, type Brush } from './paintEngine';
import { PaintStroke, addressUv, copyPatch, type PaintSurface, type PaintPatch, type ProjectedSample } from './paintStroke';

export interface MapPaintSurface extends PaintSurface { texs: RawTexture[] }
export interface PaintOptions { brush: Brush; radius: number; tool: 'brush' | 'eraser' | 'smudge'; onlyMesh: boolean; eyedrop: boolean }
interface Point { x: number; y: number }
interface Target { built: BuiltMapMesh; surface?: MapPaintSurface }

/** Upload only changed rectangles, once per frame. Lower mip levels are rebuilt
 * once on release; bilinear sampling keeps in-progress strokes visible at any zoom. */
export function uploadPaintPatches(engine: Engine, patches: PaintPatch[], finish = false) {
    const surfaces = new Set<MapPaintSurface>();
    const rows = new Map<PaintSurface, PaintPatch[]>();
    for (const p of patches) {
        const list = rows.get(p.surface);
        if (list) list.push(p); else rows.set(p.surface, [p]);
    }
    const merged: PaintPatch[] = [];
    for (const list of rows.values()) {
        list.sort((a, b) => a.y - b.y || a.x - b.x);
        let previous: PaintPatch | undefined;
        for (const p of list) {
            if (previous && previous.y === p.y && previous.h === p.h && previous.x + previous.w === p.x) previous.w += p.w;
            else { previous = { ...p }; merged.push(previous); }
        }
    }
    for (const p of merged) {
        const s = p.surface as MapPaintSurface, data = copyPatch(s, p.x, p.y, p.w, p.h);
        surfaces.add(s);
        for (const tex of s.texs) {
            const internal = tex.getInternalTexture();
            if (!internal) continue;
            if (tex.samplingMode !== Texture.BILINEAR_SAMPLINGMODE) tex.updateSamplingMode(Texture.BILINEAR_SAMPLINGMODE);
            engine.updateTextureData(internal, data, p.x, p.y, p.w, p.h, 0, 0, false);
        }
    }
    if (finish) finishPaintUploads(engine, surfaces);
}

function finishPaintUploads(engine: Engine, surfaces: Iterable<MapPaintSurface>) {
    for (const s of surfaces) for (const tex of s.texs) {
        const internal = tex.getInternalTexture();
        if (!internal) continue;
        engine.updateTextureSamplingMode(Texture.TRILINEAR_SAMPLINGMODE, internal, true);
    }
}

/** Cached screen-to-surface projection and a time-budgeted stroke queue.
 * No CPU raycasts, GPU readback, or scene renders in the per-dab hot path. */
export class MapPainter {
    private pass: UvPass | null = null;
    private pixels: Float32Array | null = null;
    private targets: Target[] = [];
    private groups: UvGroup[] = [];
    private stroke: PaintStroke | null = null;
    private options: PaintOptions | null = null;
    private points: Point[] = [];
    private head = 0;
    private last: Point | null = null;
    private ending = false;
    private selected = -1;
    private samples: ProjectedSample[] = [];
    private changed = new Set<MapPaintSurface>();
    private pendingDab: Generator<void> | null = null;
    private distanceToDab = 0;
    private observer;

    constructor(private scene: Scene, private engine: Engine,
        private meshes: () => BuiltMapMesh[],
        private surfaces: () => Map<string, MapPaintSurface>,
        private texture: (mesh: BuiltMapMesh) => BaseTexture | undefined,
        private onChange: (surface: MapPaintSurface) => void,
        private onFinish: (patches: PaintPatch[]) => void,
        private onSample: (rgb: [number, number, number]) => void,
    ) {
        this.observer = scene.activeCamera?.onViewMatrixChangedObservable.add(() => { this.pixels = null; });
    }
    get active() { return this.stroke !== null; }
    invalidate() { this.interrupt(); this.pixels = null; this.groups = []; }
    begin(point: Point, options: PaintOptions): boolean {
        if (this.active) return false;
        this.stroke = new PaintStroke();
        this.options = { ...options, brush: { ...options.brush, color: [...options.brush.color] } };
        this.points = [point]; this.head = 0; this.last = null; this.selected = -1; this.ending = false;
        this.distanceToDab = Math.max(1, options.radius / 4);
        return true;
    }
    move(point: Point) {
        if (!this.active || this.ending) return;
        const tail = this.points[this.points.length - 1];
        if (tail && tail.x === point.x && tail.y === point.y) return;
        // Coalesce nearly straight high-frequency events, preserving corners.
        const a = this.points[this.points.length - 2];
        if (a && tail && this.points.length - 2 >= this.head) {
            const dx = point.x - a.x, dy = point.y - a.y;
            const distance = Math.hypot(dx, dy);
            const deviation = distance ? Math.abs((tail.x - a.x) * dy - (tail.y - a.y) * dx) / distance : Infinity;
            const forward = (tail.x - a.x) * (point.x - tail.x) + (tail.y - a.y) * (point.y - tail.y) >= 0;
            if (deviation < 0.3 && forward) { this.points[this.points.length - 1] = point; return; }
        }
        this.points.push(point);
    }
    end(point?: Point) { if (point) this.move(point); this.ending = true; }

    private project(): boolean {
        const w = this.engine.getRenderWidth(), h = this.engine.getRenderHeight();
        if (this.pass && (this.pass.width() !== w || this.pass.height() !== h)) {
            this.pass.dispose(); this.pass = null; this.pixels = null;
        }
        if (this.pixels) return true;
        this.pass ??= createUvPass(this.scene);
        if (!this.groups.length) {
            this.targets = []; this.groups = [];
            for (const built of this.meshes()) {
                if (built.mesh.isDisposed() || !built.mesh.isEnabled()) continue;
                const id = this.targets.length;
                this.targets.push({ built, surface: built.texturePath ? this.surfaces().get(built.texturePath) : undefined });
                // Unpaintable foreground meshes still occlude surfaces behind them.
                this.groups.push({ texId: id, meshes: [built.mesh], alphaTexture: this.texture(built), alphaCutoff: built.material?.alpha_test ?? 0.5 });
            }
        }
        if (!this.pass.renderGroups(this.groups)) return false;
        this.pixels = this.pass.read(0, 0, w, h);
        return !!this.pixels;
    }

    private decode(x: number, y: number, out: ProjectedSample): number {
        const pass = this.pass!, w = pass.width(), h = pass.height();
        x = Math.round(x); y = Math.round(y);
        if (x < 0 || y < 0 || x >= w || y >= h) return -1;
        const o = (y * w + x) * 4, pixels = this.pixels!;
        if (pixels[o + 3] <= 0) return -1;
        const id = Math.round(pixels[o + 2]), target = this.targets[id], s = target?.surface;
        if (!s || !Number.isFinite(pixels[o]) || !Number.isFinite(pixels[o + 1])) return -1;
        out.surface = s;
        out.x = addressUv(pixels[o], target.built.addressU) * s.w;
        out.y = addressUv(pixels[o + 1], target.built.addressV) * s.h;
        return id;
    }

    private *dab(point: Point): Generator<void> {
        const options = this.options!, stroke = this.stroke!, pass = this.pass!;
        const scale = 1 / this.engine.getHardwareScalingLevel();
        const cx = point.x * scale, cy = point.y * scale, radius = options.radius * scale;
        const center = {} as ProjectedSample;
        const centerId = this.decode(cx, cy, center);
        if (options.eyedrop) {
            if (centerId >= 0) {
                const i = (Math.floor(center.y) * center.surface.w + Math.floor(center.x)) * 4;
                this.onSample([center.surface.rgba[i], center.surface.rgba[i + 1], center.surface.rgba[i + 2]]);
            }
            this.ending = true; this.head = this.points.length; return;
        }
        if (options.onlyMesh && this.selected < 0) this.selected = centerId;
        if (options.onlyMesh && this.selected < 0) { stroke.resetTip(); return; }
        // At most 129x129 samples regardless of monitor DPI or brush size. The
        // projected texel footprint covers the space between samples at full resolution.
        const step = Math.max(1, Math.ceil(radius / 64)), extent = Math.ceil(radius / step), diameter = extent * 2 + 1;
        const neighbor = {} as ProjectedSample;
        let count = 0;
        for (let gy = -extent; gy <= extent; gy++) for (let gx = -extent; gx <= extent; gx++) {
            const dx = gx * step, dy = gy * step;
            const coverage = falloff(Math.hypot(dx, dy), radius, options.brush.hardness);
            if (coverage <= 0) continue;
            const sx = cx + dx, sy = cy + dy;
            if (sx < 0 || sy < 0 || sx >= pass.width() || sy >= pass.height()) continue;
            const sample = this.samples[count] ?? (this.samples[count] = {} as ProjectedSample);
            const id = this.decode(sx, sy, sample);
            if (id < 0 || (options.onlyMesh && id !== this.selected)) continue;
            sample.key = (gy + extent) * diameter + gx + extent;
            sample.coverage = coverage;
            let span = 1.5;
            for (let axis = 0; axis < 2; axis++) {
                const nextId = this.decode(sx + (axis === 0 ? step : 0), sy + (axis === 1 ? step : 0), neighbor);
                if (nextId !== id) continue;
                const distance = Math.hypot(neighbor.x - sample.x, neighbor.y - sample.y);
                // Never bridge a UV island jump with a giant texel stamp.
                if (distance <= 32 * step) span = Math.max(span, distance);
            }
            sample.radius = Math.min(span * 0.75, 32);
            if (options.tool !== 'smudge') stroke.stamp(sample, options.brush, options.tool === 'eraser');
            count++;
            if (count % 128 === 0) yield;
        }
        if (options.tool === 'smudge') yield* stroke.smudgeSteps(this.samples, count, diameter * diameter, options.brush.opacity * options.brush.flow);
    }

    /** Called once by the existing render loop. Pointer handlers only enqueue. */
    frame(budgetMs = 8) {
        if (!this.stroke || !this.project()) return;
        const deadline = performance.now() + budgetMs;
        let dabs = 0;
        while ((this.pendingDab || this.head < this.points.length) && dabs < 12 && performance.now() < deadline) {
            if (this.pendingDab) {
                if (this.pendingDab.next().done) { this.pendingDab = null; dabs++; }
                continue;
            }
            const point = this.points[this.head];
            if (!this.last) { this.pendingDab = this.dab(point); this.last = point; this.head++; }
            else {
                const dx = point.x - this.last.x, dy = point.y - this.last.y, distance = Math.hypot(dx, dy);
                if (distance < 0.01) { this.head++; continue; }
                if (distance < this.distanceToDab) {
                    this.distanceToDab -= distance;
                    this.last = point; this.head++; continue;
                }
                const t = this.distanceToDab / distance;
                this.last = { x: this.last.x + dx * t, y: this.last.y + dy * t };
                this.pendingDab = this.dab(this.last);
                this.distanceToDab = Math.max(1, this.options!.radius / 4);
                if (t === 1) this.head++;
            }
        }
        const updates = this.stroke.takeUpdates();
        for (const p of updates) {
            const s = p.surface as MapPaintSurface; this.changed.add(s); this.onChange(s);
        }
        uploadPaintPatches(this.engine, updates);
        if (this.head > 256) { this.points = this.points.slice(this.head); this.head = 0; }
        if (this.ending && !this.pendingDab && this.head >= this.points.length) {
            const spacing = Math.max(1, this.options!.radius / 4);
            if (this.last && this.distanceToDab < spacing - 0.01) {
                this.pendingDab = this.dab(this.last);
                this.distanceToDab = spacing;
            } else this.interrupt();
        }
    }
    /** Commit completed work on blur, cancellation, tool exit, or scene changes. */
    interrupt() {
        if (!this.stroke) return;
        const patches = this.stroke.finish();
        finishPaintUploads(this.engine, this.changed);
        this.stroke = null; this.options = null; this.points = []; this.head = 0; this.last = null;
        this.pendingDab = null;
        this.changed.clear();
        this.onFinish(patches);
    }
    dispose() {
        this.interrupt();
        if (this.observer) this.scene.activeCamera?.onViewMatrixChangedObservable.remove(this.observer);
        this.pass?.dispose(); this.pass = null; this.pixels = null; this.samples = []; this.groups = []; this.targets = [];
    }
}
