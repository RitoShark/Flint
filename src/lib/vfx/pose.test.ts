import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { buildBabylonSkeleton, elfHash, type BoneData } from '../babylon/skeletonBuilder';
import { AnimationPlayer, type BakedAnimationDTO } from '../babylon/animationPlayer';
import { createPose } from './pose';

describe('idle particle attachment sampling', () => {
    it('samples animated parents at historical seek times without changing the displayed pose', () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const mesh = new Mesh('champion', scene);
        const joint = (id: number, parent_id: number, name: string, y: number): BoneData => ({ id, parent_id, name, local_translation: [0,y,0], local_rotation:[0,0,0,1], local_scale:[1,1,1], world_position:[0,y,0] });
        const joints = [joint(10,-1,'root',0),joint(11,10,'hand',20)];
        const built = buildBabylonSkeleton({name:'test',asset_name:'test',bones:joints,influences:[0,1]},scene);
        const clip: BakedAnimationDTO = {duration:2,fps:1,frame_count:3,tracks:[{joint_hash:elfHash('root'),frames:[0,10,20].map(x=>({translation:[x,0,0],rotation:[0,0,0,1],scale:[1,1,1]}))}]};
        const player = new AnimationPlayer(clip,built.boneIndexByHash,built.bones,joints);
        player.paused = true; player.time = 1; player.tick(0);
        mesh.position.set(3,4,5); mesh.scaling.setAll(2);
        const pose = createPose(mesh,built.skeleton,joints,()=>player);
        const hand = pose('HAND',[1,0,0])!;
        expect(hand.originAt(0.5)).toEqual([15,44,5]);
        expect(hand.originAt(1.5)).toEqual([35,44,5]);
        expect(hand.originAt(2.5)).toEqual([15,44,5]);
        expect(hand.originAt(0.5)).toEqual([15,44,5]);
        expect(built.bones[0].position.x).toBe(10);
        expect(pose('missing')).toBeNull();
        expect(pose('')!.originAt(0)).toEqual([3,4,5]);
        expect(Array.from(hand.basisInto(0,new Float32Array(9)))).toEqual([2,0,0,0,2,0,0,0,2]);
        scene.dispose(); engine.dispose();
    });
});
