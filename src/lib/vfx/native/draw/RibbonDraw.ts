import type { EmitterModel } from '../../engine/model/model';
import { BEAM_MODE, QUAD_TYPE, TRAIL_MODE } from '../../engine/model/enums';
import { frameOf, type Source } from '../../engine/simulation/particleRead';
import { sampleCurve } from '../../engine/utils/sampleCurve';
import type { Point } from '../../engine/model/rig';
import { Vector3 } from '../data';
import type { EmitterSamplers, FrameState } from '../types';
import { fragmentTests, premultiplyInto } from '../utils/blend';
import { trailFacesTheCamera } from '../utils/drawKind';
import { ribbonMaterial } from '../utils/materials';
import { sourcesScrollInto } from '../utils/palette';
import { layersOf } from '../utils/uniforms';
import { ribbonBuffers, commitRibbon, strand, writeTrail, writeBeam, type BeamParticle } from '../utils/ribbon';
import { DrawParticle } from './particle';

export interface RibbonProps {
    emitter: EmitterModel;
    sources: readonly Source[];
    samplers: EmitterSamplers;
    rank: number;
    hidden: boolean;
}
export function RibbonDraw({ emitter, sources, samplers, hidden }: RibbonProps, beam: boolean) {
    const buffers = ribbonBuffers(beam ? 1024 : 8192);
    const material = ribbonMaterial(emitter.blendMode, samplers.base, emitter.depthBias,
        layersOf(emitter, samplers, { ramp: true, sheen: false, fade: true }), fragmentTests(emitter));
    const particle = new DrawParticle();
    const points = strand(1024);
    const ordering = new Int32Array(1024);
    const forward = new Vector3();
    const eye: Point = [0, 0, 0];
    const cursor = { vertex: 0, index: 0 };
    const local: Point = [0, 0, 0];
    const segment: BeamParticle = {
        scale: particle.scale, color: particle.color, tiling: new Float32Array(2), tilingAt: 0,
        turn: particle.rotation, local, uv: particle.textures[0], multUv: particle.textures[1],
        uvAt: 0, lookup: particle.lookup, erode: 1,
    };
    return {
        geometry: buffers.geometry, material,
        update({ camera }: FrameState) {
            cursor.vertex = cursor.index = 0;
            if (hidden || emitter.disabled || (beam ? !emitter.beam || !!emitter.mesh : !emitter.trail)) {
                commitRibbon(buffers, cursor);
                return;
            }
            sourcesScrollInto(emitter, sources, material.uniforms.paletteScroll.value);
            camera.getWorldDirection(forward);
            const view: Point = [-forward.x, forward.y, forward.z];
            eye[0] = -camera.position.x; eye[1] = camera.position.y; eye[2] = camera.position.z;
            const layers = { base: emitter.uv, mult: emitter.multUv };
            let beams = 0;
            for (const source of sources) {
                const { pool } = source;
                const frame = frameOf(source, emitter);
                if (beam && emitter.beam) {
                    const model = emitter.beam;
                    const distance = Math.hypot(...source.target.map((value, axis) => value - source.origin[axis]));
                    const tint = model.colorBoundToDistance ? sampleCurve(model.colorByDistance, distance) : [1, 1, 1, 1];
                    const ends = {
                        source: source.origin.map((value, axis) => value + model.sourceOffset[axis]) as Point,
                        target: source.target.map((value, axis) => value + model.targetOffset[axis]) as Point,
                        eye: model.mode === BEAM_MODE.arbitrary ? null : eye,
                    };
                    for (let index = 0; index < pool.count && beams < 256; index++) {
                        if (pool.emitter[index] !== emitter.index) continue;
                        particle.read(emitter, pool, index, frame).orient(emitter, pool, index, frame);
                        for (let channel = 0; channel < 4; channel++) particle.color[channel] *= tint[channel] ?? 1;
                        premultiplyInto(emitter, particle.color);
                        for (let axis = 0; axis < 3; axis++) local[axis] = particle.position.place[axis] - source.origin[axis];
                        segment.tiling.set(pool.tiling.subarray(index * 2, index * 2 + 2));
                        segment.erode = emitter.quadType === QUAD_TYPE.cameraSegmentBeam ? 0 : particle.lookup[2];
                        writeBeam(ends, segment, layers, buffers.arrays, cursor);
                        beams++;
                    }
                } else if (emitter.trail) {
                    points.count = 0;
                    for (let index = 0; index < pool.count && points.count < ordering.length; index++) {
                        if (pool.emitter[index] === emitter.index) ordering[points.count++] = index;
                    }
                    ordering.subarray(0, points.count).sort((a, b) => pool.serial[a] - pool.serial[b]);
                    for (let offset = 0; offset < points.count; offset++) {
                        const index = ordering[offset];
                        particle.read(emitter, pool, index, frame).orient(emitter, pool, index, frame);
                        premultiplyInto(emitter, particle.color);
                        points.position.set(particle.position.place, offset * 3);
                        points.color.set(particle.color, offset * 4);
                        points.width[offset] = particle.scale[0];
                        points.erode[offset] = particle.lookup[2];
                        points.odometer[offset] = pool.odometer[index];
                        points.tiling.set(pool.tiling.subarray(index * 2, index * 2 + 2), offset * 2);
                        points.lookup.set(particle.lookup.subarray(0, 2), offset * 2);
                        points.uv.set(particle.textures[0], offset * 7);
                        points.multUv.set(particle.textures[1], offset * 7);
                        for (let axis = 0; axis < 3; axis++) points.side[offset * 3 + axis] = particle.rotation[axis * 3];
                    }
                    writeTrail(points, {
                        layers, view: trailFacesTheCamera(emitter) ? view : null,
                        cutoff: emitter.trail.cutoff, smoothing: emitter.trail.smoothing,
                        wake: emitter.trail.mode === TRAIL_MODE.wake,
                    }, buffers.arrays, cursor);
                }
            }
            commitRibbon(buffers, cursor);
        },
        dispose() { buffers.geometry.dispose(); material.dispose(); },
    };
}
