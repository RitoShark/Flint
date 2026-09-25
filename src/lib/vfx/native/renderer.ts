import type { Scene } from '@babylonjs/core/scene';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { DepthRenderer } from '@babylonjs/core/Rendering/depthRenderer';
import '@babylonjs/core/Rendering/depthRendererSceneComponent';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Driver } from '../engine/simulation/driver';
import type { Source } from '../engine/simulation/particleRead';
import type { EmitterModel } from '../engine/model/model';
import type { EmissionSampler } from '../engine/simulation/emissionSurface';
import type { Joints } from '../engine/model/rig';
import { jointAnchor } from './pose';
import { fnv1a32 } from '../binHash';
import { drawnEmitters } from './utils/definitions';
import { drawsAsMesh, drawsAsQuad, drawsAsTrail, drawsAsBeam, drawsTheAttachment, distorts } from './utils/drawKind';
import { fades } from './utils/softParticle';
import { meshSurface, skeletonSurface } from './utils/emissionSurface';
import { meshPose, skinWeights } from './utils/meshPose';
import { loadMesh, loadPose, loadTexture } from './assets';
import { geometryOf } from './geometry';
import { meshBuffers } from './utils/buffers';
import { AttributeData } from './data';
import type { EmitterSamplers } from './types';
import { cameraState, mountDraw, type DrawData, type Targets } from './gpu';
import { Quads } from './draw/Quads';
import { Meshes } from './draw/Meshes';
import { Beams } from './draw/Beams';
import { Trails } from './draw/Trails';
import { attachedDraw, type CharacterOptions } from './attached';
export interface RunningEffect {
    driver: Driver;
    drawn: ReturnType<typeof drawnEmitters>;
}
export function createRenderer(scene: Scene, effects: RunningEffect[], path: string, report: (message: string) => void, character: CharacterOptions) {
    let disposed = false;
    const mounted: {
        source: Source[];
        effect: RunningEffect;
        branch: string;
        draw: ReturnType<typeof mountDraw>;
    }[] = [];
    const textures = new Set<BaseTexture>();
    const all = effects.flatMap(e => e.drawn);
    const engine = scene.getEngine();
    const size = () => ({ width: engine.getRenderWidth(), height: engine.getRenderHeight() });
    const depth = all.some(d => fades(d.emitter)) ? new DepthRenderer(scene, Constants.TEXTURETYPE_FLOAT, scene.activeCamera, true, Texture.NEAREST_SAMPLINGMODE) : null;
    const color = all.some(d => distorts(d.emitter)) ? new RenderTargetTexture('idle-vfx-scene', size(), scene, false, true, Constants.TEXTURETYPE_UNSIGNED_BYTE) : null;
    const targets: Targets = { depth: depth?.getDepthMap() ?? null, frame: color };
    const captures = [depth?.getDepthMap(), color].filter((t): t is RenderTargetTexture => !!t);
    captures.forEach(target => { target.ignoreCameraViewport = true; target.activeCamera = scene.activeCamera; scene.customRenderTargets.push(target); });
    const blank = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    textures.add(blank);
    const groupStates = [1, 2].map(group => ({ ...scene.getAutoClearDepthStencilSetup(group) }));
    const queue: {
        run(): void;
        cancel(): void;
    }[] = [];
    let running = 0;
    function pump() { while (!disposed && running < 2 && queue.length) {
        running++;
        queue.shift()!.run();
    } }
    function texture(asset: string, cube = false): Promise<BaseTexture | null> {
        return new Promise(resolve => {
            queue.push({ cancel: () => resolve(null), run: () => {
                    void loadTexture(asset, path, scene, cube).then(loaded => {
                        if (disposed) {
                            loaded.dispose();
                            resolve(null);
                        }
                        else {
                            textures.add(loaded);
                            resolve(loaded);
                        }
                    }).catch(error => { if (!disposed)
                        report(`${asset}: ${String(error)}`); resolve(null); }).finally(() => { running--; pump(); });
                } });
            pump();
        });
    }
    async function samplers(emitter: EmitterModel): Promise<EmitterSamplers> {
        const names = { base: emitter.texture, mult: emitter.multTexture, color: emitter.colorTexture, palette: emitter.palette?.texture, erosion: emitter.erosion?.map, normal: emitter.distortion?.map, reflection: emitter.reflection?.map };
        const result: EmitterSamplers = { base: emitter.texture === null ? blank : null, mult: null, color: null, palette: null, erosion: null, normal: null, reflection: null };
        await Promise.all(Object.entries(names).map(async ([slot, named]) => { if (named)
            result[slot as keyof EmitterSamplers] = await texture(named.path, slot === 'reflection'); }));
        return result;
    }
    for (const effect of effects) {
        const surfaces = new Map<EmitterModel, EmissionSampler>();
        const joints = new Map<string, Joints>();
        const pending = effect.drawn.map(async (definition) => {
            const emitter = definition.emitter;
            if (emitter.disabled)
                return;
            try {
                const source: Source[] = [];
                const held = await samplers(emitter);
                if (disposed)
                    return;
                const common = { emitter, sources: source, samplers: held, rank: definition.rank, hidden: false };
                let draw: DrawData | null = null;
                if (drawsAsQuad(emitter))
                    draw = Quads(common);
                else if (drawsAsTrail(emitter))
                    draw = Trails(common);
                else if (drawsAsBeam(emitter))
                    draw = Beams(common);
                else if (drawsTheAttachment(emitter))
                    draw = attachedDraw(emitter, source, held, character);
                else if (drawsAsMesh(emitter)) {
                    const model = emitter.mesh!;
                    const variant = model.animationVariants.length ? model.animationVariants[fnv1a32(`${model.path ?? ''}:${definition.key}`) % model.animationVariants.length] : model.animation;
                    const [data, pose] = await Promise.all([loadMesh(model.path ?? (model.asset.kind === 'file' ? model.asset.path : ''), path), model.skinned ? loadPose(model.skeleton, variant, path) : null]);
                    if (disposed)
                        return;
                    const geometry = geometryOf(data, model);
                    const buffers = meshBuffers(geometry);
                    if (pose && data.skinIndices && data.skinWeights) {
                        geometry.setAttribute('skinIndex', new AttributeData(data.skinIndices, 4));
                        geometry.setAttribute('skinWeight', new AttributeData(skinWeights(data, pose.influences.length), 4));
                        Object.assign(buffers, { pose: meshPose(pose) });
                        joints.set(definition.key, name => { const slot = pose.jointNamed(name); return slot < 0 ? null : jointAnchor(pose, slot); });
                    }
                    draw = Meshes({ ...common, buffers });
                }
                if (draw)
                    mounted.push({ source, effect, branch: definition.path, draw: mountDraw(scene, draw, definition.rank, targets, distorts(emitter)) });
                const model = emitter.emissionSurface;
                if (model) {
                    const [mesh, pose] = await Promise.all([model.mesh ? loadMesh(model.mesh.path, path) : null, loadPose(model.skeleton, model.animation, path)]);
                    const surface = model.kind === 'skeleton' ? pose && skeletonSurface(model, pose) : mesh && meshSurface(model, mesh, pose);
                    if (surface)
                        surfaces.set(emitter, surface);
                    else if (!disposed)
                        report(`${emitter.name}: emission surface asset is missing`);
                }
            }
            catch (error) {
                if (!disposed)
                    report(`${emitter.name}: ${String(error)}`);
            }
        });
        void Promise.all(pending).then(() => { if (disposed)
            return; effect.driver.setSurfaces(surfaces); effect.driver.setMeshJoints(joints); });
    }
    return {
        update() {
            if (disposed || !scene.activeCamera)
                return;
            const frame = cameraState(scene);
            for (const entry of mounted) {
                entry.source.splice(0, entry.source.length, ...(entry.branch === '' ? [entry.effect.driver] : entry.effect.driver.sources(entry.branch)));
                entry.draw.update(frame);
            }
            const objects = scene.meshes.filter(m => !m.metadata?.idleVfx);
            if (depth)
                depth.getDepthMap().renderList = objects;
            if (color)
                color.renderList = scene.meshes.filter(m => !m.metadata?.distort);
            for (const target of captures) {
                const dimensions = target.getSize(), next = size();
                if (dimensions.width !== next.width || dimensions.height !== next.height)
                    target.resize(next);
                target.activeCamera = scene.activeCamera;
            }
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            queue.splice(0).forEach(request => request.cancel());
            mounted.forEach(entry => entry.draw.dispose());
            textures.forEach(t => t.dispose());
            for (const target of captures) {
                const at = scene.customRenderTargets.indexOf(target);
                if (at >= 0)
                    scene.customRenderTargets.splice(at, 1);
            }
            // Directly constructed depth renderers are not in Babylon's disposal registry.
            depth?.getDepthMap().dispose();
            depth?.dispose();
            color?.dispose();
            groupStates.forEach((state, index) => scene.setRenderingAutoClearDepthStencil(index + 1, state.autoClear, state.depth, state.stencil));
        },
    };
}
