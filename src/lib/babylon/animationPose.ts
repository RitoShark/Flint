import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { BakedAnimationDTO, AnmTrackDTO } from './animationPlayer';
import { elfHash, type BoneData } from './skeletonBuilder';

export class AnimationPose {
    readonly parents: Int32Array;
    private readonly order: number[] = [];
    private readonly names = new Map<string, number>();
    private readonly matrices: Matrix[];
    private readonly tracks: (AnmTrackDTO | undefined)[];
    private readonly translation = Vector3.Zero();
    private readonly scaling = Vector3.One();
    private readonly rotation = Quaternion.Identity();
    private readonly fromRotation = Quaternion.Identity();
    private readonly toRotation = Quaternion.Identity();
    private sampledFrame = NaN;

    constructor(readonly bones: readonly BoneData[], readonly clip: BakedAnimationDTO | null) {
        const ids = new Map(bones.map((bone, index) => [bone.id, index]));
        const tracks = new Map(clip?.tracks.map(track => [track.joint_hash, track]));
        this.tracks = bones.map(bone => tracks.get(elfHash(bone.name)));
        this.matrices = bones.map(() => Matrix.Identity());
        this.parents = Int32Array.from(bones, bone => bone.parent_id < 0 ? -1 : ids.get(bone.parent_id) ?? -1);
        const visited = new Uint8Array(bones.length);
        for (let index = 0; index < bones.length; index++) {
            const name = bones[index].name.toLowerCase();
            if (!this.names.has(name)) this.names.set(name, index);
            const chain: number[] = [];
            let current = index;
            while (current >= 0 && visited[current] === 0) {
                visited[current] = 1;
                chain.push(current);
                current = this.parents[current];
            }
            if (current >= 0 && visited[current] === 1) this.parents[chain[chain.length - 1]] = -1;
            while (chain.length) {
                const next = chain.pop()!;
                visited[next] = 2;
                this.order.push(next);
            }
        }
    }

    findBone(name: string): number {
        return this.names.get(name.toLowerCase()) ?? -1;
    }

    sample(time: number, loop = true): void {
        const clip = this.clip;
        const duration = clip && Number.isFinite(clip.duration) && clip.duration > 0
            ? clip.duration : clip && clip.fps > 0 ? Math.max(0, clip.frame_count - 1) / clip.fps : 0;
        const seconds = Number.isFinite(time) ? time : 0;
        const phase = loop && duration > 0
            ? ((seconds % duration) + duration) % duration : Math.min(Math.max(seconds, 0), duration);
        const frame = clip && Number.isFinite(clip.fps) && clip.fps > 0
            ? Math.min(phase * clip.fps, Math.max(0, clip.frame_count - 1)) : 0;
        if (frame === this.sampledFrame) return;
        this.sampledFrame = frame;
        for (const index of this.order) {
            const bone = this.bones[index];
            const frames = this.tracks[index]?.frames;
            const start = Math.min(Math.floor(frame), (frames?.length ?? 0) - 1);
            const a = frames?.[start];
            const b = frames?.[Math.min(start + 1, frames.length - 1)];
            if (a && b) {
                const mix = Math.min(1, frame - start);
                this.translation.set(
                    a.translation[0] + (b.translation[0] - a.translation[0]) * mix,
                    a.translation[1] + (b.translation[1] - a.translation[1]) * mix,
                    a.translation[2] + (b.translation[2] - a.translation[2]) * mix,
                );
                this.scaling.set(
                    a.scale[0] + (b.scale[0] - a.scale[0]) * mix,
                    a.scale[1] + (b.scale[1] - a.scale[1]) * mix,
                    a.scale[2] + (b.scale[2] - a.scale[2]) * mix,
                );
                Quaternion.FromArrayToRef(a.rotation, 0, this.fromRotation);
                Quaternion.FromArrayToRef(b.rotation, 0, this.toRotation);
                Quaternion.SlerpToRef(this.fromRotation, this.toRotation, mix, this.rotation);
            } else {
                this.translation.copyFromFloats(...bone.local_translation);
                this.scaling.copyFromFloats(...bone.local_scale);
                Quaternion.FromArrayToRef(bone.local_rotation, 0, this.rotation);
            }
            const world = this.matrices[index];
            Matrix.ComposeToRef(this.scaling, this.rotation, this.translation, world);
            const parent = this.parents[index];
            if (parent >= 0) world.multiplyToRef(this.matrices[parent], world);
        }
    }

    worldMatrix(index: number): Matrix {
        if (!this.matrices[index]) throw new RangeError(`Bone index ${index} is outside the skeleton`);
        return this.matrices[index];
    }
}
