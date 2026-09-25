import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { AnimationPose } from '../../babylon/animationPose';
import type { BakedAnimationDTO } from '../../babylon/animationPlayer';
import type { readSklSkeleton } from '../../api/mesh';
import type { Anchor, Point } from '../engine/model/rig';

export type ParticleSkeleton = Awaited<ReturnType<typeof readSklSkeleton>>;

export class ParticlePose extends AnimationPose {
    readonly influences: Uint32Array;
    readonly inverseBind: Matrix[];

    constructor(readonly skeleton: ParticleSkeleton, clip: BakedAnimationDTO | null) {
        super(skeleton.bones, clip);
        const slots = new Map(skeleton.bones.map((bone, index) => [bone.id, index]));
        this.influences = Uint32Array.from(skeleton.influences, id => {
            const slot = slots.get(id);
            if (slot === undefined) throw new Error(`Skeleton influence ${id} has no bone`);
            return slot;
        });
        this.inverseBind = skeleton.bones.map(bone => Matrix.FromArray(bone.inverse_bind_matrix.flat()));
    }

    jointNamed(name: string): number {
        return this.findBone(name);
    }

    worldInto(index: number, time: number, output: Float32Array): Float32Array {
        this.sample(time);
        this.worldMatrix(index).copyToArray(output);
        return output;
    }
}

export type Pose = ParticlePose;

export function createPose(skeleton: ParticleSkeleton, clip: BakedAnimationDTO | null): ParticlePose {
    return new ParticlePose(skeleton, clip);
}

export function jointAnchor(pose: ParticlePose, index: number, offset: Point = [0, 0, 0], scale = 1): Anchor {
    const point = new Vector3(...offset);
    const position = Vector3.Zero();
    const axis = Vector3.Zero();
    const identity = Matrix.Identity();
    const frame = (time: number) => {
        pose.sample(time);
        return index < 0 ? identity : pose.worldMatrix(index);
    };
    return {
        originAt(time) {
            Vector3.TransformCoordinatesToRef(point, frame(time), position);
            return [position.x * scale, position.y * scale, position.z * scale];
        },
        basisInto(time, output) {
            const matrix = frame(time).m;
            for (let column = 0; column < 3; column++) {
                Vector3.FromArrayToRef(matrix, column * 4, axis);
                axis.normalize();
                output[column] = axis.x;
                output[column + 3] = axis.y;
                output[column + 6] = axis.z;
            }
            return output;
        },
    };
}
