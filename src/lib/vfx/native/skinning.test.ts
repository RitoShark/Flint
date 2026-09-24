import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { describe, expect, it } from 'vitest';
import { createPose } from './pose';
import { normalizedWeights, SkinPalette } from './skinning';
import type { MeshGeometry } from './types';
import { meshPose } from './utils/meshPose';

const mesh: MeshGeometry = {positions: Float32Array.of(3, 0, 0), normals: null, uvs: null, indices: new Uint32Array(), ranges: [],
    skinIndices: Uint8Array.of(0, 0, 255, 0), skinWeights: Float32Array.of(2, 3, 99, -1)};
const pose = () => createPose({name: 'test', asset_name: 'test', influences: [42], bones: [{id: 42, name: 'joint', parent_id: -1,
    local_translation: [7, 0, 0], local_rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], local_scale: [1, 1, 1], world_position: [7, 0, 0],
    inverse_bind_matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [-2, 0, 0, 1]],
}]}, null);

describe('native particle skinning', () => {
    it('applies inverse bind before world rotation and translation', () => {
        const palette = new SkinPalette(pose());
        palette.sample(0);
        const output = Vector3.Zero();
        palette.vertexInto(mesh, 0, 4, output);
        expect(output.x).toBeCloseTo(7);
        expect(output.y).toBeCloseTo(1);
        expect(output.z).toBeCloseTo(0);
        const weights = normalizedWeights(mesh, 1);
        expect(weights[0]).toBeCloseTo(0.4);
        expect(weights[1]).toBeCloseTo(0.6);
        expect([...weights.slice(2)]).toEqual([0, 0]);
    });

    it('leaves vertices in bind space when joint weights are unavailable', () => {
        const palette = new SkinPalette(pose());
        palette.sample(0);
        const output = Vector3.Zero();
        palette.vertexInto({...mesh, skinWeights: null}, 0, 4, output);
        expect(output.asArray()).toEqual([3, 0, 0]);
        palette.vertexInto(mesh, 0, 0, output);
        expect(output.asArray()).toEqual([3, 0, 0]);
    });

    it('writes the same deformation in mirrored renderer space without overwriting other instances', () => {
        const palette = meshPose(pose());
        palette.write(1, 0);
        const data = palette.texture.image.data as Float32Array;
        expect([...data.slice(0, 16)]).toEqual(Array(16).fill(0));
        const result = Vector3.TransformCoordinates(new Vector3(-3, 0, 0), Matrix.FromArray(data, 16));
        expect(result.x).toBeCloseTo(-7);
        expect(result.y).toBeCloseTo(1);
        expect(() => palette.write(-1, 0)).toThrow(RangeError);
        palette.texture.dispose();
    });
});
