import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { EmitterModel } from '../../engine/model/model';
import { frameOf, standingFrameInto, stretchOf, type Source } from '../../engine/simulation/particleRead';
import { alongInto, standingInto } from '../../engine/utils/basis';
import { DoubleSide, FrontSide } from '../data';
import type { EmitterSamplers, FrameState } from '../types';
import { fragmentTests, premultiplyInto } from '../utils/blend';
import { type MeshBuffers, MESHES_PER_EMITTER, written } from '../utils/buffers';
import { meshMaterial } from '../utils/materials';
import { sourcesScrollInto } from '../utils/palette';
import { layersOf } from '../utils/uniforms';
import { DrawParticle } from './particle';

export interface MeshesProps {
    emitter: EmitterModel;
    sources: readonly Source[];
    buffers: MeshBuffers;
    samplers: EmitterSamplers;
    rank: number;
    hidden: boolean;
}
export function Meshes({ emitter, sources, buffers, samplers, hidden }: MeshesProps) {
    const material = meshMaterial(emitter.blendMode, samplers.base, emitter.depthBias,
        layersOf(emitter, samplers, { ramp: false, sheen: true, fade: true }),
        fragmentTests(emitter), emitter.backfaceCull ? FrontSide : DoubleSide);
    if (buffers.pose) {
        material.defines.PARTICLE_SKINNING = 1;
        material.uniforms.particleBones = { value: buffers.pose.texture };
    }
    const instances = { count: 0, instanceMatrix: buffers.instanceMatrix };
    const particle = new DrawParticle();
    const basis = new Float32Array(9);
    const matrix = Matrix.Identity();
    const transform = Matrix.Identity();
    const rotation = Quaternion.Identity();
    const spin = Quaternion.Identity();
    const orbit = Quaternion.Identity();
    const position = Vector3.Zero();
    const scale = Vector3.One();
    const facing = Vector3.Zero();
    const right = Vector3.Zero();
    const up = Vector3.Zero();
    const cameraUp = Vector3.Zero();
    const readBasis = () => {
        Matrix.FromValuesToRef(basis[0], -basis[3], -basis[6], 0,
            -basis[1], basis[4], basis[7], 0, -basis[2], basis[5], basis[8], 0, 0, 0, 0, 1, matrix);
    };
    return {
        geometry: buffers.geometry, material, instances,
        update({ camera }: FrameState) {
            instances.count = 0;
            if (hidden || emitter.disabled) return;
            sourcesScrollInto(emitter, sources, material.uniforms.paletteScroll.value);
            for (const source of sources) {
                const { pool } = source;
                const frame = frameOf(source, emitter);
                for (let index = 0; index < pool.count && instances.count < MESHES_PER_EMITTER; index++) {
                    if (pool.emitter[index] !== emitter.index) continue;
                    const instance = instances.count++;
                    particle.read(emitter, pool, index, frame);
                    premultiplyInto(emitter, particle.color);
                    particle.writeTextures(buffers, instance);
                    buffers.pose?.write(instance, particle.age);
                    position.set(-particle.position.place[0], particle.position.place[1], particle.position.place[2]);
                    scale.setAll(1);
                    standingInto(pool.rotation, index * 3, 0, basis);
                    readBasis();
                    Quaternion.FromRotationMatrixToRef(matrix, spin);
                    if (emitter.directionOriented) {
                        alongInto(pool.travel, index * 3, basis);
                        readBasis();
                        Quaternion.FromRotationMatrixToRef(matrix, rotation);
                        scale.z = stretchOf(pool, index, emitter);
                    } else {
                        const mesh = emitter.mesh;
                        facing.set(mesh?.alignYaw ? camera.position.x - position.x : 0,
                            mesh?.alignPitch ? camera.position.y - position.y : 0, camera.position.z - position.z);
                        cameraUp.set(camera.up.x, camera.up.y, camera.up.z);
                        Vector3.CrossToRef(cameraUp, facing, right);
                        const aim = mesh && (mesh.alignYaw || mesh.alignPitch) && facing.lengthSquared() > 0 && right.lengthSquared() > 0;
                        if (aim) {
                            facing.normalize(); right.normalize();
                            Vector3.CrossToRef(facing, right, up);
                            if (!mesh.skinned) { right.negateInPlace(); facing.negateInPlace(); }
                            Matrix.FromXYZAxesToRef(right, up, facing, matrix);
                            Quaternion.FromRotationMatrixToRef(matrix, rotation);
                        } else {
                            standingFrameInto(pool, index, emitter, frame, basis);
                            readBasis();
                            const data = matrix.m;
                            scale.set(Math.hypot(data[0], data[1], data[2]), Math.hypot(data[4], data[5], data[6]), Math.hypot(data[8], data[9], data[10]));
                            const elements = Array.from(data);
                            [scale.x, scale.y, scale.z].forEach((length, column) => {
                                for (let row = 0; row < 3; row++) elements[column * 4 + row] = length > 0 ? elements[column * 4 + row] / length : Number(row === column);
                            });
                            Matrix.FromArrayToRef(elements, 0, matrix);
                            Quaternion.FromRotationMatrixToRef(matrix, rotation);
                        }
                        rotation.multiplyToRef(spin, rotation);
                    }
                    if (particle.position.orbited) {
                        basis.set(particle.position.turn);
                        readBasis();
                        Quaternion.FromRotationMatrixToRef(matrix, orbit);
                        orbit.multiplyToRef(rotation, rotation);
                    }
                    scale.multiplyInPlace(Vector3.FromArray(particle.scale));
                    Matrix.ComposeToRef(scale, rotation, position, transform);
                    transform.copyToArray(buffers.instanceMatrix.array as Float32Array, instance * 16);
                    buffers.tint.array.set(particle.color, instance * 4);
                    buffers.erode.setX(instance, particle.lookup[2]);
                }
            }
            if (instances.count) {
                if (buffers.pose) buffers.pose.texture.needsUpdate = true;
                for (const attribute of Object.values(buffers.geometry.attributes)) {
                    if (attribute.instanced) written(attribute, instances.count);
                }
            }
        },
        dispose() { buffers.geometry.dispose(); material.dispose(); },
    };
}
