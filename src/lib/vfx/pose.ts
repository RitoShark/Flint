import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import type { AnimationPlayer } from '../babylon/animationPlayer';
import type { BoneData } from '../babylon/skeletonBuilder';
import { AnimationPose } from '../babylon/animationPose';
import type { Anchor, Point } from './engine/model/rig';

export function createPose(mesh: Mesh, skeleton: Skeleton | null, joints: BoneData[], player: () => AnimationPlayer | null) {
    const byName = new Map(joints.map((joint, at) => [joint.name.toLowerCase(), at]));
    let clip = player()?.clip;
    let sampled = new AnimationPose(joints, clip ?? null);
    const sample = (time: number) => {
        const current = player();
        if (clip !== current?.clip) {
            clip = current?.clip;
            sampled = new AnimationPose(joints, clip ?? null);
        }
        sampled.sample(time, current?.loop ?? false);
    };
    return (name: string, position: Point = [0, 0, 0]): Anchor | null => {
        const index = byName.get(name.toLowerCase());
        const liveBone = skeleton?.bones.find(bone => bone.name.toLowerCase() === name.toLowerCase());
        if (name && index === undefined && !liveBone) return null;
        const world = Matrix.Identity();
        const point = new Vector3(...position);
        const matrixAt = (time: number) => {
            sample(time);
            mesh.computeWorldMatrix(true);
            if (index !== undefined) sampled.worldMatrix(index).multiplyToRef(mesh.getWorldMatrix(), world);
            else if (liveBone) {
                skeleton!.computeAbsoluteMatrices(true);
                liveBone.getAbsoluteTransform().multiplyToRef(mesh.getWorldMatrix(), world);
            } else world.copyFrom(mesh.getWorldMatrix());
            return world;
        };
        return {
            originAt(time) { const p = Vector3.TransformCoordinates(point, matrixAt(time)); return [p.x, p.y, p.z]; },
            basisInto(time, out) {
                const m = matrixAt(time).m;
                out.set([m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]);
                return out;
            },
        };
    };
}
