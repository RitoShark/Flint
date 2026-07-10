/**
 * Babylon.js scene host for the Thumbnail Creator.
 *
 * Loads real League SKN models (mesh + skeleton + textures), plays/scrubs
 * their animations, renders an environment background, and produces a
 * screenshot for the compositor. Reuses Flint's existing builders
 * (`buildSknMeshes`, `buildBabylonSkeleton`, `AnimationPlayer`,
 * `createEngine`) and the SKN/anim IPC commands verbatim — the load
 * sequence mirrors `ModelPreview.tsx` (lines ~450-760).
 *
 * Placement model: ONE shared scene + ONE ArcRotateCamera (framed on the
 * first model added / whichever model is re-framed). Each model's artboard
 * x/y/w/h + per-model `orbit` are stored on its `ModelState` and returned to
 * the caller (`ModelHandle`) as plain data — the Thumbnail Creator's
 * compositor (Task 13) is responsible for placing each model's rendered
 * region on the artboard canvas. A full per-model `RenderTargetTexture`
 * approach (separate camera/light rig per model, composited post-render)
 * was considered but is disproportionate: `layers.ts`'s `ModelLayer` already
 * models x/y/w/h/scale/orbit as plain per-layer data, implying the
 * compositor — not the scene host — owns final screen-space placement.
 */

import '@babylonjs/core';

import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import { Layer } from '@babylonjs/core/Layers/layer';
import { Tools } from '@babylonjs/core/Misc/tools';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import type { Bone } from '@babylonjs/core/Bones/bone';
import { convertFileSrc } from '@tauri-apps/api/core';

import { createEngine } from '../babylon/engine';
import { buildSknMeshes, type MeshDTO } from '../babylon/meshBuilder';
import { buildBabylonSkeleton, type BoneData } from '../babylon/skeletonBuilder';
import { AnimationPlayer, type BakedAnimationDTO } from '../babylon/animationPlayer';
import { invokeCommand } from '../api/core';
import { readSknMesh, readSklSkeleton, readAnimationList, type SknMeshData } from '../api/mesh';

// ============================================================================
// Public types
// ============================================================================

export interface AnimClip {
    name: string;
    track_name: string | null;
    animation_path: string;
}

export interface ModelHandle {
    id: string;
    /** Highest scrubbable frame index (frame_count - 1) of the CURRENTLY
     *  selected animation. 0 until `setModelAnim` loads a clip. */
    maxFrame: number;
}

export type BackgroundFit = 'cover' | 'contain' | 'stretch';

export interface ModelTransformPatch {
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    scale?: number;
    orbit?: number;
}

export interface ThumbnailScene {
    addModel(sknPath: string): Promise<ModelHandle>;
    removeModel(id: string): void;
    setModelTransform(id: string, patch: ModelTransformPatch): void;
    setModelAnim(id: string, anim: string): Promise<void>;
    setModelFrame(id: string, frame: number): void;
    listAnims(id: string): AnimClip[];
    /** Highest scrubbable frame index (frame_count - 1) of the model's
     *  CURRENTLY selected animation; 0 if no clip is loaded. Additive to
     *  the base contract — `setModelAnim` resolves `Promise<void>`, so
     *  this is how a caller re-reads the max after switching clips. */
    getMaxFrame(id: string): number;
    setEnvImage(path: string | null, fit: BackgroundFit): void;
    setGlow(id: string, on: boolean, intensity: number): void;
    screenshot(w: number, h: number): Promise<Blob>;
    dispose(): void;
}

// ============================================================================
// Internal state
// ============================================================================

interface ModelState {
    id: string;
    sknPath: string;
    meshes: Mesh[];
    skeleton: Skeleton | null;
    boneIndexByHash: Map<number, number>;
    bones: Bone[];
    joints: BoneData[];
    textures: Texture[];
    clips: AnimClip[];
    player: AnimationPlayer | null;
    /** fps of the currently loaded clip — needed to convert a scrub frame
     *  index to seconds (`AnimationPlayer.time`), since `AnimationPlayer`
     *  itself doesn't expose fps publicly. */
    fps: number;
    /** frame_count - 1 of the currently loaded clip; 0 with no clip loaded. */
    maxFrame: number;
    /** frame explicitly requested via setModelFrame, applied once the
     *  player for the (possibly still-loading) clip exists. */
    pendingFrame: number | null;
    glowOn: boolean;
    // Artboard placement, stored for the compositor (Task 13) — not
    // consumed by this scene host directly (single shared camera).
    x: number;
    y: number;
    w: number;
    h: number;
    scale: number;
    orbit: number;
}

let modelSeq = 0;

export function createThumbnailScene(canvas: HTMLCanvasElement): ThumbnailScene {
    const engine = createEngine(canvas);
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0);

    const camera = new ArcRotateCamera(
        'thumbnail-cam',
        Math.PI / 2 + Math.PI / 8,
        Math.PI / 3,
        5,
        Vector3.Zero(),
        scene,
    );
    camera.attachControl(canvas, true);
    camera.wheelDeltaPercentage = 0.05;
    camera.panningSensibility = 100;

    const ambientLight = new HemisphericLight('thumbnail-ambient', new Vector3(0, 1, 0), scene);
    ambientLight.intensity = 1.2;
    ambientLight.specular = new Color3(0, 0, 0);

    const dirLight1 = new DirectionalLight('thumbnail-dir1', new Vector3(-1, -1, -1), scene);
    dirLight1.intensity = 0;
    const dirLight2 = new DirectionalLight('thumbnail-dir2', new Vector3(1, 1, 1), scene);
    dirLight2.intensity = 0;

    const glowLayer = new GlowLayer('thumbnail-glow', scene, {
        mainTextureRatio: 0.5,
        mainTextureSamples: 1,
        blurKernelSize: 64,
    });
    glowLayer.intensity = 0.8;
    glowLayer.isEnabled = false;

    // ── Environment background ──────────────────────────────────────
    // Same NDC-quad + counter-texture-matrix trick as Jade's studioScene:
    // the Layer's `scale`/`offset` size+position the quad, and the texture
    // matrix counteracts Babylon's UV-to-quad coupling so cover/contain/
    // stretch fit the FULL image regardless of quad size.
    let bgLayer: Layer | null = null;
    let bgFit: BackgroundFit = 'cover';

    function applyBgLayerTransform(): void {
        if (!bgLayer) return;
        const tex = bgLayer.texture as Texture | null;
        const ts = tex ? tex.getSize() : { width: 0, height: 0 };
        if (!tex || !ts.width || !ts.height) return;
        const imgAspect = ts.width / ts.height;
        const canvasAspect = Math.max(1e-3, engine.getRenderWidth() / engine.getRenderHeight());

        let sx = 1;
        let sy = 1;
        if (bgFit === 'stretch') {
            sx = 1;
            sy = 1;
        } else {
            const wider = imgAspect > canvasAspect;
            if (bgFit === 'contain') {
                if (wider) { sx = 1; sy = canvasAspect / imgAspect; }
                else { sy = 1; sx = imgAspect / canvasAspect; }
            } else {
                if (wider) { sy = 1; sx = imgAspect / canvasAspect; }
                else { sx = 1; sy = canvasAspect / imgAspect; }
            }
        }
        bgLayer.scale.set(sx, sy);
        bgLayer.offset.set(0, 0);

        const rawMinX = (0 - sx) * 0.5 + 0.5;
        const rawMinY = (0 - sy) * 0.5 + 0.5;
        tex.uScale = 1 / sx;
        tex.vScale = 1 / sy;
        tex.uOffset = -rawMinX / sx;
        tex.vOffset = -rawMinY / sy;
    }

    function setEnvImage(path: string | null, fit: BackgroundFit): void {
        bgFit = fit;
        if (bgLayer) {
            try { bgLayer.dispose(); } catch { /* ignore */ }
            bgLayer = null;
        }
        if (!path) {
            scene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0);
            return;
        }
        scene.clearColor = new Color4(0, 0, 0, 0);
        const url = convertFileSrc(path);
        bgLayer = new Layer('thumbnail-bg', url, scene, /* isBackground */ true);
        const bgTex = bgLayer.texture as Texture | null;
        if (bgTex) {
            bgTex.wrapU = Texture.CLAMP_ADDRESSMODE;
            bgTex.wrapV = Texture.CLAMP_ADDRESSMODE;
            bgTex.onLoadObservable.addOnce(() => applyBgLayerTransform());
        }
        applyBgLayerTransform();
    }

    // ── Render loop ──────────────────────────────────────────────────
    let lastTickTime = 0;
    engine.runRenderLoop(() => {
        const now = performance.now();
        if (lastTickTime !== 0) {
            const dt = (now - lastTickTime) / 1000;
            for (const m of models.values()) {
                m.player?.tick(dt);
            }
        }
        lastTickTime = now;
        scene.render();
    });

    const handleResize = () => {
        engine.resize();
        applyBgLayerTransform();
    };
    window.addEventListener('resize', handleResize);

    const models = new Map<string, ModelState>();

    function disposeModel(m: ModelState): void {
        for (const mesh of m.meshes) {
            const mat = mesh.material as PBRMaterial | null;
            if (mat) {
                if (mat.albedoTexture) mat.albedoTexture.dispose();
                mat.dispose();
            }
            mesh.dispose();
        }
        for (const tex of m.textures) tex.dispose();
        m.skeleton?.dispose();
    }

    /** Y-weighted bbox framing, identical to ModelPreview.tsx's camera
     *  logic — tall/winged silhouettes get extra vertical headroom. */
    function frameCameraOnBBox(bbox: [[number, number, number], [number, number, number]]): void {
        let [[minX, minY, minZ], [maxX, maxY, maxZ]] = bbox;
        const boxValid =
            [minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite) &&
            maxX >= minX && maxY >= minY && maxZ >= minZ;
        if (!boxValid) {
            minX = minY = minZ = -1;
            maxX = maxY = maxZ = 1;
        }
        const center = new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
        const sizeX = maxX - minX;
        const sizeY = maxY - minY;
        const sizeZ = maxZ - minZ;
        const radius = Math.max(sizeY * 1.4, sizeX, sizeZ, 0.01) || 5;

        camera.target = center;
        camera.radius = radius;
        camera.lowerRadiusLimit = radius * 0.02;
        camera.upperRadiusLimit = radius * 50.0;
        camera.wheelPrecision = 80 / radius;
        camera.pinchPrecision = 160 / radius;
        camera.panningSensibility = 8000 / Math.max(radius, 0.001);
        camera.speed = radius * 0.02;
        camera.alpha = Math.PI / 2 + Math.PI / 8;
        camera.beta = Math.PI / 3;
    }

    function applyTexturesAndMaterials(meshes: Mesh[], meshData: SknMeshData): Texture[] {
        const textureCache = new Map<string, Texture>();
        const matData = meshData.material_data;
        if (matData && Object.keys(matData).length > 0) {
            for (const [matName, data] of Object.entries(matData)) {
                try {
                    const dataUrl = 'data:image/png;base64,' + data.texture;
                    const texture = new Texture(dataUrl, scene, false, true);
                    texture.wrapU = Texture.WRAP_ADDRESSMODE;
                    texture.wrapV = Texture.WRAP_ADDRESSMODE;
                    texture.hasAlpha = false;
                    if (data.uv_scale) {
                        texture.uScale = data.uv_scale[0];
                        texture.vScale = data.uv_scale[1];
                    }
                    if (data.uv_offset) {
                        texture.uOffset = data.uv_offset[0];
                        texture.vOffset = data.uv_offset[1];
                    }
                    if (data.flipbook_size) {
                        const [cols, rows] = data.flipbook_size;
                        const frame = data.flipbook_frame || 0;
                        const col = Math.floor(frame % cols);
                        const row = Math.floor(frame / cols);
                        texture.uScale = 1 / cols;
                        texture.vScale = 1 / rows;
                        texture.uOffset = col / cols;
                        texture.vOffset = 1 - (row + 1) / rows;
                    }
                    textureCache.set(matName, texture);
                } catch (e) {
                    console.error('[studioScene] failed to decode material_data texture for', matName, e);
                }
            }
        } else if (meshData.textures) {
            for (const [matName, base64Data] of Object.entries(meshData.textures)) {
                try {
                    const dataUrl = 'data:image/png;base64,' + base64Data;
                    const texture = new Texture(dataUrl, scene, false, true);
                    texture.wrapU = Texture.WRAP_ADDRESSMODE;
                    texture.wrapV = Texture.WRAP_ADDRESSMODE;
                    texture.hasAlpha = false;
                    textureCache.set(matName, texture);
                } catch (e) {
                    console.error('[studioScene] failed to decode embedded texture fallback for', matName, e);
                }
            }
        }

        for (const m of meshes) {
            const matName = m.name;
            let texture = textureCache.get(matName);
            if (!texture && matName.startsWith('mesh_')) {
                texture = textureCache.get(matName.substring(5));
            }
            if (!texture) {
                texture = textureCache.get(`mesh_${matName}`);
            }
            if (!texture) {
                const lower = matName.toLowerCase();
                for (const [key, tex] of textureCache) {
                    if (key.toLowerCase() === lower) {
                        texture = tex;
                        break;
                    }
                }
            }

            const mat = new PBRMaterial(matName + '_material', scene);
            mat.unlit = true;
            mat.twoSidedLighting = true;
            mat.metallic = 0;
            mat.roughness = 1;
            mat.environmentIntensity = 0;
            mat.needDepthPrePass = false;

            if (texture) {
                mat.backFaceCulling = true;
                texture.hasAlpha = false;
                mat.albedoTexture = texture;
                mat.albedoColor = new Color3(1, 1, 1);
                mat.useAlphaFromAlbedoTexture = false;
                mat.transparencyMode = Material.MATERIAL_OPAQUE;
            } else {
                mat.backFaceCulling = true;
                mat.albedoColor = new Color3(1, 0, 1);
            }

            m.material = mat;
            m.setEnabled(true);
        }

        return [...textureCache.values()];
    }

    async function addModel(sknPath: string): Promise<ModelHandle> {
        const [meshData, sklResult, animResult] = await Promise.all([
            readSknMesh(sknPath),
            readSklSkeleton(sknPath.replace(/\.skn$/i, '.skl')).catch(() => null),
            readAnimationList(sknPath).catch(() => ({ clips: [] as AnimClip[] })),
        ]);

        let skeleton: Skeleton | null = null;
        let boneIndexByHash = new Map<number, number>();
        let bones: Bone[] = [];
        let joints: BoneData[] = [];
        if (sklResult) {
            const built = buildBabylonSkeleton(sklResult, scene, `skeleton-${modelSeq}`);
            skeleton = built.skeleton;
            boneIndexByHash = built.boneIndexByHash;
            bones = built.bones;
            joints = built.joints;
        }

        const meshDto: MeshDTO = {
            positions: meshData.positions,
            indices: meshData.indices,
            normals: meshData.normals,
            uvs: meshData.uvs,
            bone_indices: meshData.bone_indices,
            bone_weights: meshData.bone_weights,
            submeshes: meshData.materials.map(m => ({
                name: m.name,
                start_vertex: m.start_vertex,
                vertex_count: m.vertex_count,
                start_index: m.start_index,
                index_count: m.index_count,
            })),
            bbox: meshData.bounding_box,
        };

        const { meshes } = buildSknMeshes(meshDto, scene, skeleton ?? undefined, sklResult?.influences);
        const textures = applyTexturesAndMaterials(meshes, meshData);

        const id = `model-${++modelSeq}`;
        const state: ModelState = {
            id,
            sknPath,
            meshes,
            skeleton,
            boneIndexByHash,
            bones,
            joints,
            textures,
            clips: animResult.clips,
            player: null,
            fps: 0,
            maxFrame: 0,
            pendingFrame: null,
            glowOn: false,
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            scale: 1,
            orbit: 0,
        };
        models.set(id, state);

        // Frame the camera on this model — with a single shared camera, the
        // most-recently-added model wins (matches ModelPreview's single-model
        // framing behavior; multi-model framing is a compositor concern).
        frameCameraOnBBox(meshData.bounding_box);

        return { id, maxFrame: 0 };
    }

    function removeModel(id: string): void {
        const m = models.get(id);
        if (!m) return;
        // AnimationPlayer holds no scene resources of its own (just bone
        // refs) — disposing the mesh/skeleton is sufficient teardown.
        disposeModel(m);
        models.delete(id);
    }

    function setModelTransform(id: string, patch: ModelTransformPatch): void {
        const m = models.get(id);
        if (!m) return;
        if (patch.x !== undefined) m.x = patch.x;
        if (patch.y !== undefined) m.y = patch.y;
        if (patch.w !== undefined) m.w = patch.w;
        if (patch.h !== undefined) m.h = patch.h;
        if (patch.scale !== undefined) {
            m.scale = patch.scale;
            for (const mesh of m.meshes) mesh.scaling.set(patch.scale, patch.scale, patch.scale);
        }
        if (patch.orbit !== undefined) {
            m.orbit = patch.orbit;
            for (const mesh of m.meshes) mesh.rotation.y = patch.orbit;
        }
    }

    async function setModelAnim(id: string, anim: string): Promise<void> {
        const m = models.get(id);
        if (!m) return;
        const clip = m.clips.find(c => c.animation_path === anim) ?? m.clips.find(c => c.name === anim);
        if (!clip) {
            m.player = null;
            return;
        }
        const baked = await invokeCommand<BakedAnimationDTO>('read_animation', {
            path: clip.animation_path,
            basePath: m.sknPath,
        });
        // sknPath may have changed underneath an in-flight load if the model
        // was removed — guard against a stale write.
        if (!models.has(id)) return;

        const player = new AnimationPlayer(baked, m.boneIndexByHash, m.bones, m.joints);
        player.paused = true;
        m.fps = baked.fps || 1;
        m.maxFrame = Math.max(0, baked.frame_count - 1);
        m.player = player;
        if (m.pendingFrame !== null) {
            const frame = m.pendingFrame;
            m.pendingFrame = null;
            setModelFrame(id, frame);
        }
    }

    /** Frame-scrub recipe: pause the player, set `time = frame / fps`
     *  (seconds), then `tick(0)` to apply the pose at that time without
     *  advancing it. */
    function setModelFrame(id: string, frame: number): void {
        const m = models.get(id);
        if (!m) return;
        if (!m.player) {
            // No clip loaded yet — remember the request so a subsequent
            // setModelAnim can seek to it immediately.
            m.pendingFrame = frame;
            return;
        }
        m.player.paused = true;
        m.player.time = frame / (m.fps || 1);
        m.player.tick(0);
    }

    function listAnims(id: string): AnimClip[] {
        return models.get(id)?.clips ?? [];
    }

    function getMaxFrame(id: string): number {
        return models.get(id)?.maxFrame ?? 0;
    }

    function setGlow(id: string, on: boolean, intensity: number): void {
        const m = models.get(id);
        if (!m) return;
        m.glowOn = on;
        glowLayer.isEnabled = [...models.values()].some(x => x.glowOn);
        glowLayer.intensity = Math.max(0, intensity);
        for (const mesh of m.meshes) {
            const mat = mesh.material as PBRMaterial | null;
            if (!mat) continue;
            if (on && mat.albedoTexture) {
                mat.emissiveTexture = mat.albedoTexture;
                mat.emissiveColor = new Color3(1, 1, 1);
            } else {
                mat.emissiveTexture = null;
                mat.emissiveColor = new Color3(0, 0, 0);
            }
        }
    }

    async function screenshot(w: number, h: number): Promise<Blob> {
        const dataUrl = await new Promise<string>((resolve, reject) => {
            try {
                Tools.CreateScreenshotUsingRenderTarget(
                    engine,
                    camera,
                    { width: w, height: h },
                    (data) => resolve(data),
                    'image/png',
                    4,
                );
            } catch (e) {
                reject(e);
            }
        });
        const res = await fetch(dataUrl);
        return res.blob();
    }

    function dispose(): void {
        window.removeEventListener('resize', handleResize);
        for (const m of models.values()) disposeModel(m);
        models.clear();
        if (bgLayer) {
            try { bgLayer.dispose(); } catch { /* ignore */ }
            bgLayer = null;
        }
        engine.stopRenderLoop();
        scene.dispose();
        engine.dispose();
    }

    return {
        addModel,
        removeModel,
        setModelTransform,
        setModelAnim,
        setModelFrame,
        listAnims,
        getMaxFrame,
        setEnvImage,
        setGlow,
        screenshot,
        dispose,
    };
}
