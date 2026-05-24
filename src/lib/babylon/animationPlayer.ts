import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math';
import type { Bone } from '@babylonjs/core/Bones/bone';
import type { BoneData } from './skeletonBuilder';

export interface AnmFrameDTO {
    translation: [number, number, number];
    rotation: [number, number, number, number]; // xyzw
    scale: [number, number, number];
}

export interface AnmTrackDTO {
    joint_hash: number;
    frames: AnmFrameDTO[];
}

export interface BakedAnimationDTO {
    duration: number;
    fps: number;
    frame_count: number;
    tracks: AnmTrackDTO[];
}

/**
 * Handles client-side playback of pre-baked skeletal animations.
 * Performs linear/spherical interpolation without garbage collection pressure.
 */
export class AnimationPlayer {
    private animation: BakedAnimationDTO;
    private resolved: Array<{ bone: Bone; track: AnmTrackDTO }>;

    public time: number = 0;
    public paused: boolean = false;
    public loop: boolean = true;
    public speed: number = 1;

    // Pre-allocated scratch objects to avoid garbage collection stutters
    private _t = new Vector3();
    private _r = new Quaternion();
    private _s = new Vector3();
    private _ta = new Vector3();
    private _tb = new Vector3();
    private _ra = new Quaternion();
    private _rb = new Quaternion();
    private _sa = new Vector3();
    private _sb = new Vector3();

    constructor(
        animation: BakedAnimationDTO,
        boneIndexByHash: Map<number, number>,
        bones: Bone[],
        joints: BoneData[],
    ) {
        this.animation = animation;
        this.resolved = [];
        for (const track of animation.tracks) {
            const idx = boneIndexByHash.get(track.joint_hash);
            if (idx === undefined) continue;
            const bone = bones[idx];
            if (!bone) continue;
            this.resolved.push({ bone, track });
        }

        resetSkeletonToRestPose(bones, joints);
    }

    public get matchedTrackCount(): number {
        return this.resolved.length;
    }

    public get duration(): number {
        return this.animation.duration;
    }

    public tick(dt: number): void {
        const clampedDt = Math.min(Math.max(dt, 0), 0.05);
        if (!this.paused) {
            this.time += clampedDt * this.speed;
            const dur = this.animation.duration;
            if (dur > 0) {
                if (this.loop) {
                    this.time = ((this.time % dur) + dur) % dur;
                } else if (this.time > dur) {
                    this.time = dur;
                    this.paused = true;
                }
            } else {
                this.time = 0;
            }
        }

        const fc = this.animation.frame_count;
        if (fc === 0) return;
        const frameF = this.time * this.animation.fps;
        const frameA = Math.min(Math.floor(frameF), fc - 1);
        const frameB = Math.min(frameA + 1, fc - 1);
        const t = frameF - frameA;

        for (const { bone, track } of this.resolved) {
            const fa = track.frames[frameA];
            const fb = track.frames[frameB];
            if (!fa || !fb) continue;
            this._ta.set(fa.translation[0], fa.translation[1], fa.translation[2]);
            this._tb.set(fb.translation[0], fb.translation[1], fb.translation[2]);
            Vector3.LerpToRef(this._ta, this._tb, t, this._t);

            this._sa.set(fa.scale[0], fa.scale[1], fa.scale[2]);
            this._sb.set(fb.scale[0], fb.scale[1], fb.scale[2]);
            Vector3.LerpToRef(this._sa, this._sb, t, this._s);

            this._ra.set(fa.rotation[0], fa.rotation[1], fa.rotation[2], fa.rotation[3]);
            this._rb.set(fb.rotation[0], fb.rotation[1], fb.rotation[2], fb.rotation[3]);
            Quaternion.SlerpToRef(this._ra, this._rb, t, this._r);

            bone.position = this._t;
            bone.rotationQuaternion = this._r;
            bone.scaling = this._s;
        }
    }

    public reset(): void {
        this.time = 0;
        this.paused = false;
    }
}

export function resetSkeletonToRestPose(bones: Bone[], joints: BoneData[]): void {
    const restT = new Vector3();
    const restR = new Quaternion();
    const restS = new Vector3();
    for (let i = 0; i < bones.length; i++) {
        const j = joints[i];
        const b = bones[i];
        if (!j || !b) continue;
        restT.set(j.local_translation[0], j.local_translation[1], j.local_translation[2]);
        restR.set(
            j.local_rotation[0],
            j.local_rotation[1],
            j.local_rotation[2],
            j.local_rotation[3],
        );
        restS.set(j.local_scale[0], j.local_scale[1], j.local_scale[2]);
        b.position = restT;
        b.rotationQuaternion = restR;
        b.scaling = restS;
    }
}
