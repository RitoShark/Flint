import { describe, expect, it } from 'vitest';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { AnimationPose } from './animationPose';
import { elfHash, type BoneData } from './skeletonBuilder';
import type { BakedAnimationDTO } from './animationPlayer';

const bone = (id: number, parent_id: number, name: string, x: number): BoneData => ({
    id, parent_id, name, local_translation: [x, 0, 0], local_rotation: [0, 0, 0, 1],
    local_scale: [1, 1, 1], world_position: [0, 0, 0],
});
const clip: BakedAnimationDTO = {
    duration: 2, fps: 1, frame_count: 3,
    tracks: [{ joint_hash: elfHash('root'), frames: [0, 8, 16].map(x => ({
        translation: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    })) }],
};

describe('animation pose sampling', () => {
    it('resolves sparse IDs and parents stored after children', () => {
        const pose = new AnimationPose([bone(17, 93, 'hand', 3), bone(93, -1, 'root', 0)], clip);
        pose.sample(0.5);
        expect(pose.worldMatrix(0).getTranslation().asArray()).toEqual([7, 0, 0]);
        expect(pose.findBone('HAND')).toBe(0);
        expect(pose.findBone('missing')).toBe(-1);
    });

    it('supports backward seeks, negative loop times and clamped playback', () => {
        const pose = new AnimationPose([bone(93, -1, 'root', 0)], clip);
        for (const [time, loop, expected] of [[1.5, true, 12], [0.5, true, 4], [-0.5, true, 12], [2, true, 0], [2, false, 16], [-1, false, 0]] as const) {
            pose.sample(time, loop);
            expect(pose.worldMatrix(0).m[12]).toBe(expected);
        }
    });

    it('interpolates rotation and scale in parent space', () => {
        const rotated: BakedAnimationDTO = {
            duration: 1, fps: 1, frame_count: 2,
            tracks: [{joint_hash: elfHash('root'), frames: [
                {translation: [0,0,0], rotation: [0,0,0,1], scale: [1,1,1]},
                {translation: [0,0,0], rotation: [0,0,1,0], scale: [3,3,3]},
            ]}],
        };
        const pose = new AnimationPose([bone(1, -1, 'root', 0), bone(2, 1, 'tip', 1)], rotated);
        pose.sample(0.5);
        const tip = Vector3.TransformCoordinates(Vector3.Zero(), pose.worldMatrix(1));
        expect(tip.x).toBeCloseTo(0);
        expect(tip.y).toBeCloseTo(2);
    });

    it('uses rest transforms for missing tracks and handles single-frame clips', () => {
        const single = { ...clip, duration: 0, frame_count: 1, tracks: [{
            joint_hash: elfHash('root'), frames: [clip.tracks[0].frames[1]],
        }] };
        const pose = new AnimationPose([bone(1, -1, 'root', 0), bone(2, 1, 'tip', 3)], single);
        pose.sample(100);
        expect(pose.worldMatrix(1).m[12]).toBe(11);
    });

    it('keeps malformed hierarchies finite and independent of prior samples', () => {
        const pose = new AnimationPose([bone(1, 2, 'root', 1), bone(2, 1, 'tip', 2), bone(3, 500, 'orphan', 4)], null);
        pose.sample(0);
        const first = Array.from(pose.worldMatrix(0).m);
        pose.sample(20);
        expect(Array.from(pose.worldMatrix(0).m)).toEqual(first);
        expect(pose.worldMatrix(2).m[12]).toBe(4);
        expect(() => pose.worldMatrix(99)).toThrow(RangeError);
    });

    it('does not recurse through long bone chains', () => {
        const bones = Array.from({length: 12000}, (_, id) => bone(id, id - 1, `bone${id}`, 1)).reverse();
        const pose = new AnimationPose(bones, null);
        pose.sample(0);
        expect(pose.worldMatrix(0).m[12]).toBe(12000);
    });
});
