import { describe, expect, it } from 'vitest';
import type { VfxValue } from '../bindings';
import { nameHash, fnv1a32 } from '../binHash';
import { readVfxSystem } from '../engine/parsing/readVfxSystem';
import { constant } from '../engine/parsing/properties';
import { plainUvLayer, type EmitterModel, type SystemModel } from '../engine/model/model';
import { ADDRESS_MODE, BLEND_MODE, QUAD_TYPE, UV_MODE } from '../engine/model/enums';
import { createDriver } from '../engine/simulation/driver';
import { createPool, UV, uvAt } from '../engine/simulation/pool';
import { Rng } from '../engine/utils/Rng';
import { identityInto } from '../engine/utils/basis';
import { Vector3, GeometryData, TextureData, DoubleSide, OneFactor, ZeroFactor, OneMinusSrcColorFactor, OneMinusSrcAlphaFactor, SrcAlphaFactor } from './data';
import type { EmitterSamplers, FrameState, MeshGeometry } from './types';
import { Quads } from './draw/Quads';
import { Meshes } from './draw/Meshes';
import { Trails } from './draw/Trails';
import { Beams } from './draw/Beams';
import { blendState } from './utils/blend';
import { layersOf } from './utils/uniforms';
import { meshMaterial, ribbonMaterial, attachedMaterial } from './utils/materials';
import { drawnEmitters } from './utils/definitions';
import { meshBuffers } from './utils/buffers';
import { drawnIndices, rangesDrawn } from './utils/submeshes';
import { uvDraw, uvTransformInto } from './utils/uvTransform';
import { strand, ribbonBuffers, writeTrail, writeBeam, commitRibbon } from './utils/ribbon';

function model(changes: Partial<EmitterModel> = {}): SystemModel {
    const node = (name: string, fields: Record<string, VfxValue> = {}): VfxValue & {type: 'struct'} => ({
        type: 'struct', class: name, classHash: nameHash(name), object: null,
        fields: Object.entries(fields).map(([name, value]) => ({ name, hash: nameHash(name), value })),
    });
    const root = node('VfxSystemDefinitionData', { complexEmitterDefinitionData: { type: 'container', items: [node('VfxEmitterDefinitionData')] } });
    const result = readVfxSystem({ root, entry: 'native-test', name: null, class: root.class, classHash: root.classHash, materials: [] });
    return { ...result, emitters: [{ ...result.emitters[0], rate: constant(6), particleLifetime: constant(4), birthVelocity: constant(0, 1, 0), ...changes }] };
}
const emptyTextures: EmitterSamplers = { base: null, mult: null, color: null, palette: null, erosion: null, normal: null, reflection: null };
const frame: FrameState = { camera: { position: new Vector3(0, 0, -10), up: new Vector3(0, 1, 0), getWorldDirection: out => out.set(0, 0, 1) } };
const tests = { depthTest: true, alphaRef: 0 };
const features = { ramp: true, sheen: true, fade: true };

describe('native render preparation', () => {
    it.each(Object.values(BLEND_MODE))('builds finite blend state for mode %i', mode => {
        const state = blendState(mode);
        expect(state.depthWrite).toBe(mode === BLEND_MODE.none);
        expect(state.transparent).toBe(mode !== BLEND_MODE.none);
        expect([state.blendSrc, state.blendDst, state.blendSrcAlpha, state.blendDstAlpha].every(Number.isFinite)).toBe(true);
    });

    it('preserves separate color and alpha factors for subtractive and additive blending', () => {
        expect(blendState(BLEND_MODE.subtract)).toMatchObject({ blendSrc: ZeroFactor, blendDst: OneMinusSrcColorFactor, blendDstAlpha: OneMinusSrcAlphaFactor });
        expect(blendState(BLEND_MODE.add)).toMatchObject({ blendSrc: OneFactor, blendDst: OneFactor });
        expect(blendState(BLEND_MODE.alphaAdd)).toMatchObject({ blendSrc: SrcAlphaFactor, blendDst: OneFactor });
    });

    it.each([Quads, Trails, Beams])('uploads visible particles and clears a hidden draw', factory => {
        const system = model({ quadType: QUAD_TYPE.cameraQuad,
            trail: { mode: 0, smoothing: 0, cutoff: 0, maxAddedPerFrame: 10, tiling: constant(1, 1) },
            beam: { mode: 0, trailMode: 0, segments: 1, tiling: constant(1, 1), colorByDistance: constant(1, 1, 1, 1), colorBoundToDistance: false, sourceOffset: [0, 0, 0], targetOffset: [0, 0, 0] },
        });
        const driver = createDriver(73);
        driver.swap(system); driver.seek(1);
        const options = { emitter: system.emitters[0], sources: [driver], samplers: emptyTextures, rank: 0, hidden: false };
        const visible = factory(options), hidden = factory({ ...options, hidden: true });
        visible.update(frame); hidden.update(frame);
        expect(Object.values(visible.geometry.attributes).every(attribute => Array.from(attribute.array).every(Number.isFinite))).toBe(true);
        expect(factory === Quads ? visible.geometry.instanceCount : visible.geometry.drawRange.count).toBeGreaterThan(0);
        expect(factory === Quads ? hidden.geometry.instanceCount : hidden.geometry.drawRange.count).toBe(0);
        visible.dispose(); hidden.dispose();
    });

    it('writes mirrored mesh transforms into instance buffers', () => {
        const system = model({ birthVelocity: constant(2, 0, 0) });
        const driver = createDriver(9); driver.swap(system); driver.seek(1);
        const buffers = meshBuffers(new GeometryData());
        const draw = Meshes({ emitter: system.emitters[0], sources: [driver], buffers, samplers: emptyTextures, rank: 0, hidden: false });
        draw.update(frame);
        expect(draw.instances.count).toBe(driver.pool.count);
        expect(buffers.instanceMatrix.array[12]).toBeLessThan(0);
        expect(buffers.instanceMatrix.version).toBeGreaterThan(0);
        expect(Array.from(buffers.instanceMatrix.array).every(Number.isFinite)).toBe(true);
    });

    it.each(Object.values(ADDRESS_MODE))('keeps animated UV transforms finite with address mode %i', addressMode => {
        const pool = createPool(1), at = uvAt(0, 0);
        pool.uv[at + UV.birthOffsetX] = -.25;
        pool.uv[at + UV.birthScrollX] = -2;
        pool.uv[at + UV.frameRate] = -3;
        const uv = uvDraw();
        uvTransformInto(pool, 0, { ...plainUvLayer(), addressMode, emitterScrollRate: [.2, .3], book: { ...plainUvLayer().book, divisions: [4, 2], frames: 8 } }, 0, 2, .5, 2, uv);
        expect(Object.values(uv).every(Number.isFinite)).toBe(true);
        expect([uv.cellU, uv.cellV]).toEqual([.5, 0]);
        if (addressMode === ADDRESS_MODE.wrap) expect(uv.offsetU).toBeCloseTo(.15);
        if (addressMode === ADDRESS_MODE.mirror) expect(uv.offsetU).toBeCloseTo(1.15);
    });

    it('packs reflection, erosion and depth fade without cross-enabling color ramps', () => {
        const image = new TextureData(new Uint8Array(4), 1, 1);
        const emitter = model({
            soft: { beginIn: 2, deltaIn: 4, beginOut: 8, deltaOut: 2 },
            reflection: { fresnel: .3, fresnelColor: [.2, .4, .6, .8], reflectionFresnel: .5, reflectionFresnelColor: [.1, .2, .3, .4], opacityDirect: .7, opacityGlancing: .9, map: { path: 'synthetic', asset: null } },
            erosion: { map: null, addressMode: 0, mixer: constant(0, 0, 0, 1), drive: constant(.5), lingerDrive: null, driveSource: 0, featherIn: 0, featherOut: 2, sliceWidth: .1 },
        }).emitters[0];
        const layers = layersOf(emitter, { ...emptyTextures, color: image, reflection: image }, features);
        const mesh = meshMaterial(BLEND_MODE.alpha, image, [0, 0], layers, tests, DoubleSide);
        expect(mesh.uniforms.fresnel.value).toEqual([.2, .4, .6, .3]);
        expect(mesh.uniforms.reflectionTint.value).toEqual([.1, .2, .3]);
        expect(mesh.uniforms.softParams.value).toEqual([2, 14, .25, .5]);
        expect(mesh.uniforms.featherRate.value).toEqual([10000, .5]);
        expect(mesh.defines).toHaveProperty('REFLECTS');
        expect(mesh.defines).not.toHaveProperty('HAS_RAMP');
        const attached = attachedMaterial(BLEND_MODE.alpha, image, [0, 0], layers, tests, DoubleSide);
        expect(attached.defines).not.toHaveProperty('SOFT');
        expect(attached.polygonOffsetFactor).toBe(-1);
        const locked = layersOf({ ...emitter, uvMode: UV_MODE.lockAlpha }, emptyTextures, features);
        expect(locked.erosion).toBeNull(); expect(locked.soft).toBeNull();
        expect(ribbonMaterial(BLEND_MODE.alpha, image, [0, 0], layers, tests).defines).not.toHaveProperty('HAS_RAMP');
    });

    it('keeps child rendering definitions bounded and source paths stable', () => {
        let system = model();
        for (let i = 0; i < 8; i++) system = model({ childSet: { children: [system], bones: [], probability: constant(0), onDeath: false, inheritance: null } });
        const definitions = drawnEmitters(system);
        expect(definitions).toHaveLength(5);
        expect(new Set(definitions.map(definition => definition.key)).size).toBe(5);
        expect(definitions[1].path).toBe('0.0');
    });

    it('selects submeshes by hash while allowing forced visibility', () => {
        const mesh: MeshGeometry = { positions: new Float32Array(9), indices: Uint32Array.of(0, 1, 2, 2, 1, 0), normals: null, uvs: null, skinIndices: null, skinWeights: null,
            ranges: [{ name: 'shell', startIndex: 0, indexCount: 3 }, { name: 'halo', startIndex: 3, indexCount: 3 }] };
        expect(drawnIndices(mesh, [nameHash('missing')], [])).toBe(mesh.indices);
        expect(Array.from(drawnIndices(mesh, [nameHash('HALO')], []))).toEqual([2, 1, 0]);
        expect(rangesDrawn(mesh.ranges, ['HALO'], [nameHash('halo')], [nameHash('halo')])).toEqual([false, true]);
        expect(fnv1a32('Vfx')).toBe(fnv1a32('VFX'));
    });

    it('bounds ribbon writes and clears geometry after particles disappear', () => {
        const points = strand(3), buffers = ribbonBuffers(6), cursor = { vertex: 0, index: 0 };
        points.count = 3; points.position.set([0, 0, 0, 0, 0, 2, 0, 0, 5]); points.width.fill(1); points.color.fill(1); points.tiling.fill(1);
        for (let index = 0; index < 3; index++) points.uv.set([0, 1, 1, 0, 0, 0, 0], index * 7);
        writeTrail(points, { view: [0, 1, 0], wake: false, smoothing: 0, cutoff: 0, layers: { base: plainUvLayer(), mult: null } }, buffers.arrays, cursor);
        expect(cursor).toEqual({ vertex: 6, index: 12 });
        commitRibbon(buffers, cursor); expect(buffers.geometry.drawRange.count).toBe(12);
        const snapshot = buffers.arrays.position.slice();
        writeBeam({ source: [0, 0, 0], target: [0, 0, 4], eye: [0, 1, 0] }, {
            scale: Float32Array.of(1, 0, 0), color: Float32Array.of(1, 1, 1, 1), tiling: Float32Array.of(1, 1), tilingAt: 0,
            turn: identityInto(new Float32Array(9)), local: [0, 0, 0], uv: points.uv, uvAt: 0, multUv: points.uv, lookup: Float32Array.of(0, 0), erode: 0,
        }, { base: plainUvLayer(), mult: null }, buffers.arrays, cursor);
        expect(buffers.arrays.position).toEqual(snapshot);
        commitRibbon(buffers, { vertex: 0, index: 0 }); expect(buffers.geometry.drawRange.count).toBe(0);
    });

    it('replays independent random streams from snapshots', () => {
        const random = new Rng(0);
        for (let i = 0; i < 20; i++) random.unitFloat();
        const saved = random.clone();
        const expected = Array.from({ length: 200 }, () => random.unitFloat());
        expect(Array.from({ length: 200 }, () => saved.unitFloat())).toEqual(expected);
        expect(expected.every(value => value >= 0 && value < 1)).toBe(true);
    });
});
