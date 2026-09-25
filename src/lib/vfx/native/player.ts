import type { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import type { IdleEffectData } from '../../api/idleEffects';
import type { SknMeshData } from '../../api/mesh';
import type { AnimationPlayer } from '../../babylon/animationPlayer';
import type { BoneData } from '../../babylon/skeletonBuilder';
import { createPose } from '../pose';
import { readVfxSystem } from '../engine/parsing/readVfxSystem';
import { createDriver } from '../engine/simulation/driver';
import { withMaterialPreviews } from '../materialPreview';
import { drawnEmitters } from './utils/definitions';
import { isUndrawn } from './utils/drawKind';
import { createRenderer, type RunningEffect } from './renderer';
interface Options {
    meshData: SknMeshData;
    joints: BoneData[];
    influences: number[];
    animation(): AnimationPlayer | null;
    hidden(): string[];
}
export function playIdleEffects(scene: Scene, mesh: Mesh, skeleton: Skeleton | null, data: IdleEffectData, path: string, report: (message: string) => void, options: Options) {
    let disposed = false, speed = 1;
    let lastClip = options.animation()?.clip;
    let previousTime = options.animation()?.time ?? 0;
    const pose = createPose(mesh, skeleton, options.joints, options.animation);
    const effects: RunningEffect[] = [];
    for (const attachment of data.attachments) {
        const named = pose(attachment.bone, attachment.position);
        if (!named)
            report(`Idle particle bone “${attachment.bone}” was not found; using the character root`);
        const anchor = named ?? pose('', attachment.position)!;
        const system = readVfxSystem(withMaterialPreviews(attachment.system));
        const driver = createDriver(1337);
        driver.swap(system);
        driver.steer({ motion: { kind: 'bone', anchor, target: attachment.targetBone ? pose(attachment.targetBone) : null }, life: 'once', height: 0, joints: name => pose(name) });
        driver.seek(previousTime);
        const drawn = drawnEmitters(system, skeleton !== null);
        for (const { emitter } of drawn) {
            if (emitter.disabled)
                continue;
            if (isUndrawn(emitter))
                report(`${emitter.name}: particle primitive is not supported by this renderer`);
            if (emitter.childSet?.children.some(child => child === null))
                report(`${emitter.name}: a child effect could not be resolved`);
        }
        effects.push({ driver, drawn });
    }
    const renderer = createRenderer(scene, effects, path, report, { ...options, mesh, skeleton });
    function seek(time: number) { effects.forEach(e => e.driver.seek(time)); previousTime = time; }
    return {
        setSpeed(value: number) { speed = value; }, seek,
        render(dt: number) {
            if (disposed || !scene.activeCamera)
                return;
            const player = options.animation();
            if (lastClip !== player?.clip) {
                lastClip = player?.clip;
                effects.forEach(e => e.driver.restart());
                seek(player?.time ?? 0);
            }
            else {
                const next = player?.time;
                const delta = next === undefined ? Math.min(dt, 0.05) * speed : next < previousTime && player?.loop ? player.duration - previousTime + next : Math.max(0, next - previousTime);
                effects.forEach(e => e.driver.advance(delta));
                previousTime = next ?? 0;
            }
            renderer.update();
        },
        dispose() { if (disposed)
            return; disposed = true; renderer.dispose(); },
    };
}
