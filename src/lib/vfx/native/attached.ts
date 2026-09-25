import { Matrix } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import type { SknMeshData } from '../../api/mesh';
import type { EmitterModel } from '../engine/model/model';
import { frameOf, type Source } from '../engine/simulation/particleRead';
import { DrawParticle } from './draw/particle';
import { geometryOf } from './geometry';
import { meshGeometry } from './assets';
import { meshBuffers, written } from './utils/buffers';
import { attachedMaterial } from './utils/materials';
import { layersOf } from './utils/uniforms';
import { fragmentTests, premultiplyInto } from './utils/blend';
import { sourcesScrollInto } from './utils/palette';
import { rangesDrawn } from './utils/submeshes';
import { DoubleSide, FrontSide, AttributeData, TextureData } from './data';
import type { EmitterSamplers } from './types';
export interface CharacterOptions {
    meshData: SknMeshData; mesh: Mesh; skeleton: Skeleton | null; influences: number[]; hidden(): string[];
}
export function attachedDraw(emitter: EmitterModel, sources: Source[], samplers: EmitterSamplers, character: CharacterOptions) {
    const model = meshGeometry(character.meshData);
    const geometry = geometryOf(model, { submeshes: [], submeshesAlways: [] });
    const buffers = meshBuffers(geometry);
    const material = attachedMaterial(emitter.blendMode, samplers.base, emitter.depthBias,
        layersOf(emitter, samplers, { ramp: false, sheen: true, fade: false }), fragmentTests(emitter), emitter.backfaceCull ? FrontSide : DoubleSide);
    const particle = new DrawParticle();
    const mirror = Matrix.Scaling(-1, 1, 1);
    const world = Matrix.Identity(), bone = Matrix.Identity(), scale = Matrix.Identity(), transform = Matrix.Identity();
    const bones = Math.max(1, character.skeleton?.bones.length ?? 0), capacity = 8;
    const paletteData = new Float32Array(bones * 16 * capacity);
    const paletteTexture = new TextureData(paletteData, bones * 4, capacity);
    if (character.skeleton && model.skinIndices && model.skinWeights) {
        geometry.setAttribute('skinIndex', new AttributeData(Uint16Array.from(model.skinIndices, index => character.influences[index] ?? index), 4));
        geometry.setAttribute('skinWeight', new AttributeData(model.skinWeights, 4));
        material.defines.PARTICLE_SKINNING = 1;
        material.uniforms.particleBones = { value: paletteTexture };
    }
    const instances = { count: 0 };
    let visibility: string | null = null;
    return {
        geometry, material, instances,
        update() {
            const hidden = character.hidden();
            const key = hidden.join('\0');
            if (visibility !== key) {
                const selected = rangesDrawn(model.ranges, hidden, emitter.mesh?.submeshes ?? [], emitter.mesh?.submeshesAlways ?? []);
                const indices: number[] = [];
                model.ranges.forEach((range, index) => {
                    if (!selected[index]) return;
                    for (let at = range.startIndex; at < range.startIndex + range.indexCount; at += 3) {
                        indices.push(model.indices[at], model.indices[at + 2], model.indices[at + 1]);
                    }
                });
                geometry.index.array = Uint32Array.from(indices);
                geometry.index.needsUpdate = true;
                visibility = key;
            }
            character.skeleton?.prepare();
            const palette = character.skeleton?.getTransformMatrices(character.mesh);
            mirror.multiplyToRef(character.mesh.computeWorldMatrix(true), world);
            world.multiplyToRef(mirror, world);
            if (palette) {
                for (let joint = 0; joint < bones; joint++) {
                    Matrix.FromArrayToRef(palette, joint * 16, bone);
                    mirror.multiplyToRef(bone, bone); bone.multiplyToRef(mirror, bone);
                    bone.copyToArray(paletteData, joint * 16);
                }
                for (let instance = 1; instance < capacity; instance++) paletteData.copyWithin(instance * bones * 16, 0, bones * 16);
                paletteTexture.needsUpdate = true;
            }
            instances.count = 0;
            if (emitter.disabled) return;
            for (const source of sources) {
                const frame = frameOf(source, emitter);
                for (let index = 0; index < source.pool.count && instances.count < capacity; index++) {
                    if (source.pool.emitter[index] !== emitter.index) continue;
                    const instance = instances.count++;
                    particle.read(emitter, source.pool, index, frame);
                    premultiplyInto(emitter, particle.color);
                    particle.writeTextures(buffers, instance);
                    buffers.tint.array.set(particle.color, instance * 4);
                    buffers.erode.setX(instance, particle.lookup[2]);
                    Matrix.ScalingToRef(particle.scale[0], particle.scale[1], particle.scale[2], scale);
                    world.multiplyToRef(scale, transform);
                    transform.copyToArray(buffers.instanceMatrix.array as Float32Array, instance * 16);
                }
            }
            sourcesScrollInto(emitter, sources, material.uniforms.paletteScroll.value);
            if (instances.count) for (const attribute of Object.values(geometry.attributes)) {
                if (attribute.instanced) written(attribute, instances.count);
            }
        },
        dispose() { geometry.dispose(); material.dispose(); paletteTexture.dispose(); },
    };
}
