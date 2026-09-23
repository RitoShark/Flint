import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '@babylonjs/core/Engines/engine';
import type { Scene } from '@babylonjs/core/scene';
import type { BuiltMapMesh } from './mapMeshBuilder';
import { MapPainter, type MapPaintSurface, type PaintOptions } from './mapPainter';

vi.mock('./uvPaintPass', () => ({ createUvPass: () => ({
    width: () => 64, height: () => 64, renderGroups: () => true, dispose: () => {},
    read: () => {
        const uv = new Float32Array(64 * 64 * 4);
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) uv.set([(x % 32 + 0.5) / 32, (y + 0.5) / 64, x < 32 ? 0 : 1, 1], (y * 64 + x) * 4);
        return uv;
    },
}) }));

function fixture(tool: PaintOptions['tool'], onlyMesh = false) {
    const make = (red: number): MapPaintSurface => {
        const rgba = new Uint8Array(32 * 64 * 4);
        for (let i = 0; i < rgba.length; i += 4) rgba.set([red, 50, 255 - red, 255], i);
        return { rgba, orig: rgba.slice(), w: 32, h: 64, texs: [] };
    };
    const a = make(200), b = make(20), surfaces = new Map([['a', a], ['b', b]]);
    const targets = ['a', 'b'].map(texturePath => ({ texturePath, addressU: 1, addressV: 1,
        mesh: { isDisposed: () => false, isEnabled: () => true } })) as unknown as BuiltMapMesh[];
    const engine = { getRenderWidth: () => 64, getRenderHeight: () => 64, getHardwareScalingLevel: () => 1 } as Engine;
    const done = vi.fn();
    const painter = new MapPainter({} as Scene, engine, () => targets, () => surfaces, () => undefined, () => {}, done, () => {});
    const options: PaintOptions = { tool, onlyMesh, eyedrop: false, radius: 16,
        brush: { mode: 'Normal', color: [0, 255, 0], flow: 0.5, opacity: 0.6, hardness: 0.3 } };
    return { a, b, painter, done, options };
}

describe('queued map painter', () => {
    it('keeps smudge strength independent of pointer-event frequency', () => {
        const run = (step: number) => {
            const f = fixture('smudge');
            f.painter.begin({ x: 12, y: 30 }, f.options); f.painter.frame(Infinity);
            for (let x = 12 + step; x <= 52; x += step) { f.painter.move({ x, y: 30 }); f.painter.frame(Infinity); }
            f.painter.end({ x: 52, y: 30 });
            for (let i = 0; f.painter.active && i < 100; i++) f.painter.frame(Infinity);
            expect(f.painter.active).toBe(false);
            expect(f.done).toHaveBeenCalledTimes(1);
            f.painter.dispose();
            return [f.a.rgba, f.b.rgba];
        };
        expect(run(1)).toEqual(run(20));
    });
    it('locks only-this-mesh to the initial mesh while crossing another', () => {
        const f = fixture('brush', true), right = f.b.rgba.slice();
        f.painter.begin({x: 20, y: 30}, f.options);
        f.painter.move({x: 45, y: 30}); f.painter.end();
        for (let i = 0; f.painter.active && i < 100; i++) f.painter.frame(Infinity);
        expect(f.b.rgba).toEqual(right);
        expect(f.a.rgba).not.toEqual(f.a.orig);
        f.painter.dispose();
    });
    it('commits a short stroke endpoint instead of dropping sub-spacing motion', () => {
        const f = fixture('brush');
        f.painter.begin({x: 20, y: 30}, f.options);
        f.painter.move({x: 22, y: 30}); f.painter.end();
        for (let i = 0; f.painter.active && i < 100; i++) f.painter.frame(Infinity);
        expect(f.painter.active).toBe(false);
        expect(f.done).toHaveBeenCalledTimes(1);
        expect(f.done.mock.calls[0][0].length).toBeGreaterThan(0);
        f.painter.dispose();
    });
});
