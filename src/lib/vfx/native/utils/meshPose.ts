import { Matrix } from '@babylonjs/core/Maths/math.vector';
import { DataTexture, FloatType, RGBAFormat } from '../data';
import { AXIS_SIGN, type Pose } from '../types';
import { SkinPalette } from '../skinning';
import { MESHES_PER_EMITTER } from './buffers';

export { normalizedWeights as skinWeights } from '../skinning';
export interface MeshPose { readonly source: Pose; readonly texture: DataTexture; write(instance: number, time: number): void }

export function meshPose(pose: Pose): MeshPose {
    const palette = new SkinPalette(pose);
    const width = Math.max(1, palette.matrices.length);
    const pixels = new Float32Array(width * MESHES_PER_EMITTER * 16);
    const texture = new DataTexture(pixels, width * 4, MESHES_PER_EMITTER, RGBAFormat, FloatType);
    const signs = [...AXIS_SIGN, 1];
    return {
        source: pose, texture,
        write(instance, time) {
            if (!Number.isInteger(instance) || instance < 0 || instance >= MESHES_PER_EMITTER) throw new RangeError('Invalid particle mesh instance');
            palette.sample(time);
            for (let influence = 0; influence < width; influence++) {
                const matrix = palette.matrices[influence] ?? Matrix.IdentityReadOnly;
                const offset = (instance * width + influence) * 16;
                for (let cell = 0; cell < 16; cell++) pixels[offset + cell] = matrix.m[cell] * signs[cell % 4] * signs[Math.floor(cell / 4)];
            }
        },
    };
}
