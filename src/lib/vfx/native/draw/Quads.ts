import type { EmitterModel } from '../../engine/model/model';
import { SIMPLE_ORIENTATION } from '../../engine/model/enums';
import { frameOf, drawnPlace, drawnPlaceInto, particleBasisInto, spinOf, stretchOf, type Source } from '../../engine/simulation/particleRead';
import { mirrorInto, multiplyInto } from '../../engine/utils/basis';
import { AXIS_SIGN, type EmitterSamplers, type FrameState } from '../types';
import { fragmentTests, premultiplyInto, sortsBackToFront } from '../utils/blend';
import { quadBuffers, QUADS_PER_EMITTER, written } from '../utils/buffers';
import { drawsAsQuad, facesTheCamera, isRay, isUnitQuad } from '../utils/drawKind';
import { quadMaterial } from '../utils/materials';
import { sourcesScrollInto } from '../utils/palette';
import { layersOf } from '../utils/uniforms';
import { DrawParticle } from './particle';

export interface QuadsProps {
    emitter: EmitterModel;
    sources: readonly Source[];
    samplers: EmitterSamplers;
    rank: number;
    hidden: boolean;
    room?: number;
}
export function Quads({ emitter, sources, samplers, hidden, room = QUADS_PER_EMITTER }: QuadsProps) {
    const buffers = quadBuffers(room);
    const { geometry } = buffers;
    const material = quadMaterial(emitter.blendMode, samplers.base,
        { bias: emitter.depthBias, pushPull: emitter.depthPushPull }, {
            billboard: facesTheCamera(emitter) || !!emitter.legacySimple,
            directed: facesTheCamera(emitter) && emitter.directionOriented && !emitter.legacySimple,
            ray: isRay(emitter) && !emitter.legacySimple,
            plane: emitter.legacySimple?.orientation ?? SIMPLE_ORIENTATION.camera,
            unitQuad: isUnitQuad(emitter), pivotUp: emitter.pivotUp,
        }, layersOf(emitter, samplers, { ramp: true, sheen: false, fade: true }), fragmentTests(emitter));
    const particle = new DrawParticle();
    const position = drawnPlace();
    const orientation = new Float32Array(9);
    const mirrored = new Float32Array(9);
    const indices = new Int32Array(room);
    const owners = new Int32Array(room);
    const sequence = new Int32Array(room);
    const distances = new Float32Array(room);
    const sort = emitter.customMaterial && !emitter.customMaterial.missing
        ? emitter.customMaterial.renderState.blending !== 'opaque' : sortsBackToFront(emitter.blendMode);
    return {
        geometry, material,
        update({ camera }: FrameState) {
            geometry.instanceCount = 0;
            if (hidden || emitter.disabled || !drawsAsQuad(emitter)) return;
            sourcesScrollInto(emitter, sources, material.uniforms.paletteScroll.value);
            const frames = sources.map(source => frameOf(source, emitter));
            let count = 0;
            for (let owner = 0; owner < sources.length && count < room; owner++) {
                const { pool } = sources[owner];
                for (let index = 0; index < pool.count && count < room; index++) {
                    if (pool.emitter[index] !== emitter.index) continue;
                    indices[count] = index; owners[count] = owner; sequence[count] = count;
                    if (sort) {
                        drawnPlaceInto(pool, index, frames[owner], position);
                        distances[count] = position.place.reduce((sum, component, axis) => {
                            const eye = [camera.position.x, camera.position.y, camera.position.z][axis];
                            return sum + (component * AXIS_SIGN[axis] - eye) ** 2;
                        }, 0);
                    }
                    count++;
                }
            }
            if (sort) sequence.subarray(0, count).sort((a, b) => distances[b] - distances[a]);
            for (let instance = 0; instance < count; instance++) {
                const selected = sequence[instance];
                const index = indices[selected];
                const owner = owners[selected];
                const pool = sources[owner].pool;
                const frame = frames[owner];
                particle.read(emitter, pool, index, frame);
                premultiplyInto(emitter, particle.color);
                particle.writeTextures(buffers, instance);
                buffers.color.array.set(particle.color, instance * 4);
                buffers.lookup.array.set(particle.lookup, instance * 3);
                const p = particle.position.place;
                buffers.center.setXYZ(instance, -p[0], p[1], p[2]);
                buffers.size.setXYZ(instance, particle.scale[0], particle.scale[1] * stretchOf(pool, index, emitter), particle.scale[2]);
                buffers.roll.setX(instance, -spinOf(pool, index, emitter, frame.now) * Math.PI / 180);
                particleBasisInto(pool, index, emitter, frame, orientation);
                if (particle.position.orbited) multiplyInto(particle.position.turn, orientation, orientation);
                mirrorInto(orientation, 0, mirrored, 0);
                [buffers.basisX, buffers.basisY, buffers.basisZ].forEach((attribute, axis) => {
                    attribute.setXYZ(instance, mirrored[axis], mirrored[axis + 3], mirrored[axis + 6]);
                });
            }
            geometry.instanceCount = count;
            if (count) for (const attribute of Object.values(geometry.attributes)) {
                if (attribute.instanced) written(attribute, count);
            }
        },
        dispose() { geometry.dispose(); material.dispose(); },
    };
}
