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
 * Placement model: ONE shared scene, but ONE ArcRotateCamera PER MODEL. Each
 * camera renders into its own screen-space `viewport` (derived from the
 * model layer's artboard x/y/w/h) and, via a unique `layerMask` bit, sees
 * ONLY its own model's meshes. So every model lands exactly where its box is
 * on the artboard, framed on its own bounding box — two models never overlap
 * at the origin (the old single-shared-camera bug), and a model dragged to a
 * new box moves with it. `scene.activeCameras` holds all model cameras; a
 * dummy fallback camera keeps the scene renderable when no model is loaded.
 */

import '@babylonjs/core';

import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import { Layer } from '@babylonjs/core/Layers/layer';
import { Vector3, Color3, Color4, Viewport } from '@babylonjs/core/Maths/math';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import type { Bone } from '@babylonjs/core/Bones/bone';
import { convertFileSrc } from '@tauri-apps/api/core';

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

export interface MeshInfo {
    /** Submesh (material) name — stable id used by setMeshHidden. */
    name: string;
    hidden: boolean;
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

/** The artboard's design-space dimensions (STAGE_W × STAGE_H). Model boxes
 *  (x/y/w/h) are expressed in this space; the scene converts them to Babylon
 *  camera viewports (normalized 0-1, bottom-left origin). */
export interface StageDims {
    w: number;
    h: number;
}

export interface ThumbnailScene {
    addModel(sknPath: string): Promise<ModelHandle>;
    removeModel(id: string): void;
    setModelTransform(id: string, patch: ModelTransformPatch): void;
    setModelAnim(id: string, anim: string): Promise<void>;
    setModelFrame(id: string, frame: number): void;
    listAnims(id: string): AnimClip[];
    /** Submesh list for a model with per-submesh hidden state (drives the
     *  mesh-visibility popup). Empty until the model has loaded. */
    listMeshes(id: string): MeshInfo[];
    /** Show/hide a single submesh by name. */
    setMeshHidden(id: string, meshName: string, hidden: boolean): void;
    /** Bulk-apply the hidden-submesh set (names not present are shown). */
    setHiddenMeshes(id: string, hiddenNames: string[]): void;
    /** Highest scrubbable frame index (frame_count - 1) of the model's
     *  CURRENTLY selected animation; 0 if no clip is loaded. */
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
    camera: ArcRotateCamera;
    /** Unique renderingGroup/layerMask bit so this model's camera renders
     *  only this model's meshes. */
    layerMask: number;
    /** Model-space bounding box (X-mirrored on load, same as the meshes) —
     *  used to (re)frame this model's own camera. */
    bbox: [[number, number, number], [number, number, number]];
    meshes: Mesh[];
    skeleton: Skeleton | null;
    boneIndexByHash: Map<number, number>;
    bones: Bone[];
    joints: BoneData[];
    textures: Texture[];
    clips: AnimClip[];
    hiddenMeshes: Set<string>;
    player: AnimationPlayer | null;
    fps: number;
    maxFrame: number;
    pendingFrame: number | null;
    glowOn: boolean;
    // Artboard placement (design-space box) → drives this model's viewport.
    x: number;
    y: number;
    w: number;
    h: number;
    scale: number;
    orbit: number;
}

let modelSeq = 0;

export function createThumbnailScene(canvas: HTMLCanvasElement, stage: StageDims): ThumbnailScene {
    const stageDims: StageDims = { w: stage.w || 640, h: stage.h || 360 };

    // preserveDrawingBuffer:true is REQUIRED here (unlike the shared
    // createEngine): the thumbnail scene renders MULTIPLE cameras into
    // separate viewports via scene.activeCameras, and Babylon's
    // CreateScreenshotUsingRenderTarget forces a SINGLE-camera render
    // (it nulls scene.activeCameras internally). So export instead reads the
    // live multi-viewport canvas back directly — which needs the drawing
    // buffer preserved.
    const engine = new Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: false,
        antialias: true,
        adaptToDeviceRatio: true,
        alpha: true,
        premultipliedAlpha: false,
    });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0);

    // A model with no explicit box fills the whole stage; the first model
    // added seeds a default so it's visible before the artboard reconciles
    // its real x/y/w/h. The base layerMask bit reserved for "everything".
    const ALL_MASK = 0x0fffffff;

    // Fallback camera keeps the scene renderable (and screenshot-able) when
    // no model is loaded; removed from activeCameras once models exist.
    const fallbackCamera = new ArcRotateCamera(
        'thumbnail-fallback-cam',
        Math.PI / 2 + Math.PI / 8,
        Math.PI / 3,
        5,
        Vector3.Zero(),
        scene,
    );
    fallbackCamera.layerMask = ALL_MASK;

    // The user only ever interacts with the FIRST model's camera (controls
    // attach to it); other cameras are display-only viewports.
    let controlCamera: ArcRotateCamera | null = null;

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

    const models = new Map<string, ModelState>();

    // scene.activeCameras drives multi-viewport rendering. Rebuild it from the
    // live model set (or the fallback when empty). Order doesn't matter since
    // viewports don't overlap in practice, but keep the control camera first.
    function refreshActiveCameras(): void {
        const cams = [...models.values()].map(m => m.camera);
        if (cams.length === 0) {
            scene.activeCameras = [fallbackCamera];
        } else {
            scene.activeCameras = cams;
        }
    }
    refreshActiveCameras();

    // ── Per-model camera viewport ────────────────────────────────────────
    // Convert a model's design-space box (top-left origin, STAGE_W×STAGE_H)
    // into a Babylon viewport (normalized 0-1, BOTTOM-left origin). A zero/
    // unset box means "fill the whole stage".
    function applyViewport(m: ModelState): void {
        const sw = stageDims.w;
        const sh = stageDims.h;
        let { x, y, w, h } = m;
        if (w <= 0 || h <= 0) {
            x = 0; y = 0; w = sw; h = sh;
        }
        const vx = x / sw;
        const vw = w / sw;
        const vh = h / sh;
        // flip Y: design-space top → viewport bottom
        const vy = 1 - (y / sh) - vh;
        m.camera.viewport = new Viewport(vx, vy, vw, vh);
    }

    // ── Environment background ──────────────────────────────────────
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
        if (m.camera !== controlCamera) {
            m.camera.dispose();
        } else {
            m.camera.dispose();
            controlCamera = null;
        }
    }

    /** Y-weighted bbox framing on a SPECIFIC camera, identical to
     *  ModelPreview.tsx's logic — tall/winged silhouettes get vertical
     *  headroom. Frames the given camera so the model fills its viewport. */
    function frameCamera(cam: ArcRotateCamera, bbox: [[number, number, number], [number, number, number]]): void {
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

        cam.target = center;
        cam.radius = radius;
        cam.lowerRadiusLimit = radius * 0.02;
        cam.upperRadiusLimit = radius * 50.0;
        cam.wheelPrecision = 80 / radius;
        cam.pinchPrecision = 160 / radius;
        cam.panningSensibility = 8000 / Math.max(radius, 0.001);
        cam.speed = radius * 0.02;
        cam.alpha = Math.PI / 2 + Math.PI / 8;
        cam.beta = Math.PI / 3;
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

        // Recompute the bbox from the actual (X-mirrored) vertex positions
        // rather than trusting the stored box — same reasoning as
        // ModelPreview/skn.rs: positions are negated on X at load, and some
        // SKNs ship a zeroed/garbage box that would collapse framing.
        const bbox = computeBBox(meshes) ?? meshData.bounding_box;

        // Unique layerMask bit for this model so its camera sees only it.
        // Bit index = model index (wraps after 27; far more than any real
        // thumbnail needs).
        const bitIndex = (modelSeq - 1) % 27;
        const layerMask = 1 << bitIndex;
        for (const mesh of meshes) mesh.layerMask = layerMask;

        const camera = new ArcRotateCamera(
            `thumbnail-cam-${id}`,
            Math.PI / 2 + Math.PI / 8,
            Math.PI / 3,
            5,
            Vector3.Zero(),
            scene,
        );
        camera.layerMask = layerMask;
        camera.wheelDeltaPercentage = 0.05;
        frameCamera(camera, bbox);

        // First model's camera receives user input; the rest are display-only.
        if (!controlCamera) {
            controlCamera = camera;
            camera.attachControl(canvas, true);
        }

        const state: ModelState = {
            id,
            sknPath,
            camera,
            layerMask,
            bbox,
            meshes,
            skeleton,
            boneIndexByHash,
            bones,
            joints,
            textures,
            clips: animResult.clips,
            hiddenMeshes: new Set(),
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
        applyViewport(state);
        refreshActiveCameras();

        return { id, maxFrame: 0 };
    }

    function removeModel(id: string): void {
        const m = models.get(id);
        if (!m) return;
        disposeModel(m);
        models.delete(id);
        // If the control camera was removed, promote another model's camera.
        if (!controlCamera && models.size > 0) {
            const next = models.values().next().value as ModelState;
            controlCamera = next.camera;
            next.camera.attachControl(canvas, true);
        }
        refreshActiveCameras();
    }

    function setModelTransform(id: string, patch: ModelTransformPatch): void {
        const m = models.get(id);
        if (!m) return;
        let boxChanged = false;
        if (patch.x !== undefined) { m.x = patch.x; boxChanged = true; }
        if (patch.y !== undefined) { m.y = patch.y; boxChanged = true; }
        if (patch.w !== undefined) { m.w = patch.w; boxChanged = true; }
        if (patch.h !== undefined) { m.h = patch.h; boxChanged = true; }
        if (boxChanged) applyViewport(m);
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

    function setModelFrame(id: string, frame: number): void {
        const m = models.get(id);
        if (!m) return;
        if (!m.player) {
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

    function listMeshes(id: string): MeshInfo[] {
        const m = models.get(id);
        if (!m) return [];
        return m.meshes.map(mesh => ({ name: mesh.name, hidden: m.hiddenMeshes.has(mesh.name) }));
    }

    function setMeshHidden(id: string, meshName: string, hidden: boolean): void {
        const m = models.get(id);
        if (!m) return;
        if (hidden) m.hiddenMeshes.add(meshName);
        else m.hiddenMeshes.delete(meshName);
        for (const mesh of m.meshes) {
            if (mesh.name === meshName) mesh.setEnabled(!hidden);
        }
    }

    function setHiddenMeshes(id: string, hiddenNames: string[]): void {
        const m = models.get(id);
        if (!m) return;
        const next = new Set(hiddenNames);
        m.hiddenMeshes = next;
        for (const mesh of m.meshes) mesh.setEnabled(!next.has(mesh.name));
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
        // Read the LIVE multi-viewport canvas (see the engine construction
        // note): render one fresh frame so the drawing buffer is current,
        // then grab it via a temp 2D canvas scaled to the requested output
        // size. This preserves every model's per-camera viewport — unlike
        // CreateScreenshotUsingRenderTarget, which would only capture one
        // camera. The 2D copy must happen in the SAME frame as the render
        // (preserveDrawingBuffer keeps it valid across the await, but we
        // render explicitly to be safe).
        scene.render();
        const gl = engine.getRenderingCanvas();
        if (!gl) throw new Error('screenshot: no rendering canvas');
        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;
        const ctx = out.getContext('2d');
        if (!ctx) throw new Error('screenshot: no 2D context');
        // The scene canvas already has the dark clear color baked in (opaque),
        // so drawing it scaled to the output size reproduces the preview.
        ctx.drawImage(gl, 0, 0, gl.width, gl.height, 0, 0, w, h);
        return new Promise<Blob>((resolve, reject) => {
            out.toBlob(
                (blob) => (blob ? resolve(blob) : reject(new Error('screenshot: toBlob returned null'))),
                'image/png',
            );
        });
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
        listMeshes,
        setMeshHidden,
        setHiddenMeshes,
        getMaxFrame,
        setEnvImage,
        setGlow,
        screenshot,
        dispose,
    };
}

/** Recompute an AABB from actual mesh vertex positions (post X-mirror), so
 *  framing never trusts a zeroed/garbage stored bbox. Returns null if no
 *  mesh has positions. */
function computeBBox(meshes: Mesh[]): [[number, number, number], [number, number, number]] | null {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let any = false;
    for (const mesh of meshes) {
        const info = mesh.getBoundingInfo?.();
        if (!info) continue;
        const bb = info.boundingBox;
        const lo = bb.minimumWorld;
        const hi = bb.maximumWorld;
        minX = Math.min(minX, lo.x); minY = Math.min(minY, lo.y); minZ = Math.min(minZ, lo.z);
        maxX = Math.max(maxX, hi.x); maxY = Math.max(maxY, hi.y); maxZ = Math.max(maxZ, hi.z);
        any = true;
    }
    if (!any || !Number.isFinite(minX)) return null;
    return [[minX, minY, minZ], [maxX, maxY, maxZ]];
}
