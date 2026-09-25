import { describe, expect, it } from 'vitest';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import { elfHash } from '../../babylon/skeletonBuilder';
import { createPose, jointAnchor, type ParticleSkeleton } from './pose';
import type { BakedAnimationDTO } from '../../babylon/animationPlayer';
function skeleton(): ParticleSkeleton {
    const bones: ParticleSkeleton['bones'] = ['pivot', 'socket'].map((name, index) => ({
        name, id: 101 + index * 100, parent_id: index ? 101 : -1,
        local_translation: [0, index * 3, 0], local_rotation: [0, 0, 0, 1], local_scale: [1, 1, 1],
        world_position: [0, index * 3, 0], inverse_bind_matrix: Array.from({ length: 4 }, (_, row) =>
            Array.from(Matrix.Translation(0, -index * 3, 0).m).slice(row * 4, row * 4 + 4)) as ParticleSkeleton['bones'][number]['inverse_bind_matrix'],
    }));
    return { name: 'fixture', asset_name: '', bones, influences: [201, 101] };
}
const clip: BakedAnimationDTO = { fps: 1, duration: 1, frame_count: 2, tracks: [{ joint_hash: elfHash('socket'), frames: [3, 9].map(y => ({ translation: [0, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] })) }] };
describe('particle skeletons', () => {
    it('resolves influence IDs and evaluates independent particle ages', () => {
        const pose = createPose(skeleton(), clip);
        expect(Array.from(pose.influences)).toEqual([1, 0]);
        const output = new Float32Array(16);
        expect(pose.worldInto(1, .5, output)[13]).toBe(6);
        expect(pose.worldInto(1, 0, output)[13]).toBe(3);
        expect(pose.worldInto(1, 1.5, output)[13]).toBe(6);
        expect(() => createPose({ ...skeleton(), influences: [800] }, clip)).toThrow('has no bone');
    });
    it('transforms joint offsets while keeping orientation independent of scale', () => {
        const rig = skeleton();
        rig.bones[0].local_scale = [2, 3, 4];
        const pose = createPose(rig, null);
        const anchor = jointAnchor(pose, 1, [0, 1, 0], 2);
        expect(anchor.originAt(0)).toEqual([0, 24, 0]);
        expect(Array.from(anchor.basisInto(0, new Float32Array(9)))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        expect(jointAnchor(pose, -1, [2, 4, 6], 2).originAt(.5)).toEqual([4, 8, 12]);
    });
    it('handles reflection and a collapsed bone axis without nonfinite values', () => {
        const rig = skeleton();
        rig.bones[0].local_scale = [-3, 0, 5];
        const output = jointAnchor(createPose(rig, null), 0).basisInto(0, new Float32Array(9));
        expect([output[0], output[4], output[8]]).toEqual([-1, 0, 1]);
        expect(Array.from(output).every(Number.isFinite)).toBe(true);
    });
});
