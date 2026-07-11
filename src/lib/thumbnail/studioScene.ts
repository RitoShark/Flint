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
    tiltX?: number;
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
    /** Enter/exit interactive mode for ONE model (null to clear). Right-drag
     *  pans; rotation is via the Properties sliders (orbit/tiltX). */
    setControlModel(id: string | null): void;
    /** Re-frame a model to its default centered pose (reset an orbit). */
    resetModelView(id: string): void;
    /** Auto-rotate the model so its face/front points at the camera (like
     *  Maya's "look at face" on the view cube). Returns the yaw (Turn/orbit,
     *  degrees) it applied so the caller can persist it to the layer, or null
     *  if the facing couldn't be detected. */
    faceModelToCamera(id: string): number | null;
    /** Switch a model's framing between whole-body ('full') and head/face
     *  close-up ('head', auto-detects the head bone). */
    setModelFocus(id: string, mode: 'full' | 'head'): void;
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
    /** Kept for face-direction detection (average forward of the head/face
     *  submesh, XZ-projected) — vertex positions/normals + submesh ranges. */
    positions: Float32Array;
    normals: Float32Array;
    materials: { name: string; start_vertex: number; vertex_count: number }[];
    textures: Texture[];
    clips: AnimClip[];
    hiddenMeshes: Set<string>;
    player: AnimationPlayer | null;
    fps: number;
    maxFrame: number;
    pendingFrame: number | null;
    glowOn: boolean;
    /** Once the user manually orbits/pans this model (double-click → drag),
     *  stop auto-reframing it on box/viewport changes so we don't fight the
     *  pose they set. */
    userFramed: boolean;
    /** Framing style: 'full' = whole model fits the box; 'head' = zoom in on
     *  the detected head/face bone (portrait/splash crop). */
    focusMode: 'full' | 'head';
    // Artboard placement (design-space box) → drives this model's viewport.
    x: number;
    y: number;
    w: number;
    h: number;
    scale: number;
    orbit: number;
    tiltX: number;
}

let modelSeq = 0;

// Fixed horizontal orbit angle every model camera starts at (and the fallback
// uses). Kept as one constant so the face-to-camera solver knows exactly where
// the camera sits without re-deriving it.
const CAM_ALPHA = Math.PI / 2 + Math.PI / 8;

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
    // Transparent clear so the ONLY opaque pixels on the canvas are the models
    // themselves. This lets DOM layers painted BEHIND the canvas (the disc /
    // "circle" background separator) show through everywhere the models don't
    // cover — so the hero renders ON TOP of the circle, with the circle
    // visible around it. The dark backdrop instead comes from `.tb-env` (a DOM
    // layer below everything).
    scene.clearColor = new Color4(0, 0, 0, 0);
    scene.autoClear = true;

    // A model with no explicit box fills the whole stage; the first model
    // added seeds a default so it's visible before the artboard reconciles
    // its real x/y/w/h. The base layerMask bit reserved for "everything".
    const ALL_MASK = 0x0fffffff;

    // Fallback camera keeps the scene renderable (and screenshot-able) when
    // no model is loaded; removed from activeCameras once models exist.
    const fallbackCamera = new ArcRotateCamera(
        'thumbnail-fallback-cam',
        CAM_ALPHA,
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
        // Re-frame so the model stays centered/fully-fit for the box's new
        // aspect — unless the user has taken manual control of this model's
        // camera (then keep their pose).
        if (!m.userFramed) reframeModel(m);
    }

    /** (Re)frame a model per its focusMode: 'head' targets the detected head
     *  bone with a slight zoom (splash crop); 'full' fits the whole model.
     *  Framing uses the UNSCALED bbox so the `scale` slider visibly changes how
     *  big the model reads in its box (a smaller scale leaves headroom). The
     *  head focus point IS scaled by `m.scale/100`, because the mesh is
     *  rendered scaled and the head bone's stored position is unscaled. */
    function reframeModel(m: ModelState): void {
        const aspect = viewportAspectOf(m);
        const s = (m.scale || 100) / 100;
        if (m.focusMode === 'head') {
            const head = findHeadFocus(m);
            if (head) {
                // Slight zoom so it's head + shoulders, not an extreme close-up.
                frameCamera(m.camera, m.bbox, aspect, head.scale(s), 1.6);
                return;
            }
        }
        frameCamera(m.camera, m.bbox, aspect);
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
            // Keep the canvas transparent (models are the only opaque pixels);
            // the dark backdrop is the DOM `.tb-env` layer below the canvas.
            scene.clearColor = new Color4(0, 0, 0, 0);
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

    /** Point a FIXED camera at a model so it's centered in its viewport. This
     *  is a 2D compositor, not a photographic camera: the camera distance is
     *  LOCKED (no dolly/zoom) — the model's on-screen SIZE is controlled purely
     *  by its `scale` (mesh scaling). So the radius here just fits the UNSCALED
     *  reference bbox to the viewport once; `scale` then grows/shrinks the model
     *  within the box, and orbiting only rotates (alpha/beta). `focus` overrides
     *  the target (head bone); `zoom` shifts the reference fit a touch. */
    function frameCamera(
        cam: ArcRotateCamera,
        bbox: [[number, number, number], [number, number, number]],
        viewportAspect: number,
        focus?: Vector3 | null,
        zoom = 1,
    ): void {
        let [[minX, minY, minZ], [maxX, maxY, maxZ]] = bbox;
        const boxValid =
            [minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite) &&
            maxX >= minX && maxY >= minY && maxZ >= minZ;
        if (!boxValid) {
            minX = minY = minZ = -1;
            maxX = maxY = maxZ = 1;
        }
        const center = focus ?? new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
        const sizeX = maxX - minX;
        const sizeY = maxY - minY;
        const sizeZ = maxZ - minZ;

        const halfH = Math.max(sizeY, 0.01) / 2;
        const halfW = Math.max(sizeX, sizeZ, 0.01) / 2;

        const fovY = cam.fov || 0.8;
        const aspect = Number.isFinite(viewportAspect) && viewportAspect > 0 ? viewportAspect : 1;
        const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
        const radiusForH = halfH / Math.tan(fovY / 2);
        const radiusForW = halfW / Math.tan(fovX / 2);
        const radius = (Math.max(radiusForH, radiusForW, 0.01) * 1.25 || 5) / Math.max(0.1, zoom);

        cam.target = center;
        cam.radius = radius;
        // LOCK the distance — no dolly. Size = scale, not camera distance.
        cam.lowerRadiusLimit = radius;
        cam.upperRadiusLimit = radius;
        cam.wheelPrecision = 80 / radius;
        cam.pinchPrecision = 160 / radius;
        cam.panningSensibility = 3000 / Math.max(radius, 0.001);
        cam.speed = radius * 0.02;
        cam.alpha = CAM_ALPHA;
        cam.beta = Math.PI / 3;
        // Free horizontal orbit; keep vertical within a natural range so the
        // user can't flip under/over the model.
        cam.lowerBetaLimit = 0.15;
        cam.upperBetaLimit = Math.PI - 0.15;
        // Smoother drag: lower angularSensibility = faster rotate per pixel.
        cam.angularSensibilityX = 500;
        cam.angularSensibilityY = 500;
        // Near/far clip relative to model size so geometry never clips through
        // the near plane on zoom-in nor gets culled on zoom-out.
        cam.minZ = Math.max(radius / 1000, 0.001);
        cam.maxZ = radius * 100;
    }

    // Bone-name fragments (lowercased) that identify a head/face region, most
    // specific first. Used to auto-focus the hero on its head.
    const HEAD_BONE_HINTS = ['head', 'neck', 'hair', 'face', 'jaw'];

    /** Find a head-ish bone's world position. The backend (skl.rs) already
     *  X-negates `world_position` to match the X-negated meshes, so use it
     *  DIRECTLY (do NOT re-negate). Returns null if no skeleton / no match. */
    function findHeadFocus(m: ModelState): Vector3 | null {
        if (!m.joints || m.joints.length === 0) return null;
        for (const hint of HEAD_BONE_HINTS) {
            const bone = m.joints.find(j => j.name.toLowerCase().includes(hint));
            if (bone) {
                const [x, y, z] = bone.world_position;
                return new Vector3(x, y, z);
            }
        }
        return null;
    }

    // Submesh-name fragments (lowercased) that mark the head/face region — its
    // average normal is the most reliable "which way is the character looking"
    // signal (the face is a big front-facing surface). Body is the fallback.
    const FACE_MESH_HINTS = ['face', 'head', 'hair', 'helmet', 'hood', 'mask'];
    const BODY_MESH_HINTS = ['body', 'base', 'torso', 'chest', 'cape'];

    /** Average vertex NORMAL over a set of submeshes, projected onto the
     *  horizontal (XZ) plane and normalized — the direction the character
     *  faces in model space. Positions are X-mirrored on load, and the normal's
     *  X is mirrored with them, so this is already in the loaded mesh's space.
     *  Returns null if no usable normal (degenerate). */
    function averageFacing(m: ModelState, hints: string[]): { x: number; z: number } | null {
        const subs = m.materials.filter(s => {
            const n = s.name.toLowerCase();
            return hints.some(h => n.includes(h));
        });
        const ranges = subs.length > 0 ? subs : m.materials;
        let ax = 0;
        let az = 0;
        let count = 0;
        for (const s of ranges) {
            const end = s.start_vertex + s.vertex_count;
            for (let v = s.start_vertex; v < end; v++) {
                const nx = m.normals[v * 3];
                const nz = m.normals[v * 3 + 2];
                if (!Number.isFinite(nx) || !Number.isFinite(nz)) continue;
                // X-mirror the normal to match the X-mirrored positions.
                ax += -nx;
                az += nz;
                count++;
            }
        }
        if (count === 0) return null;
        ax /= count;
        az /= count;
        const len = Math.hypot(ax, az);
        if (len < 1e-4) return null;
        return { x: ax / len, z: az / len };
    }

    /** Auto-rotate the model so its face points toward the camera. The camera
     *  orbits at a FIXED alpha (Math.PI/2 + Math.PI/8) looking at the model, so
     *  its horizontal view direction (from camera toward the model, in world
     *  XZ) is fixed. We solve for the yaw (mesh.rotation.y) that turns the
     *  model's facing vector to point back at the camera (opposite the view
     *  dir), then persist it as `orbit`. Returns the applied degrees or null. */
    function faceModelToCamera(id: string): number | null {
        const m = models.get(id);
        if (!m) return null;
        const facing = averageFacing(m, FACE_MESH_HINTS) ?? averageFacing(m, BODY_MESH_HINTS);
        if (!facing) return null;

        // Camera alpha is fixed at CAM_ALPHA. ArcRotateCamera position (relative
        // to target) is (r·sinβ·cosα, r·cosβ, r·sinβ·sinα); its horizontal
        // component points FROM target TO camera along (cosα, sinα) in XZ. We
        // want the model's facing to point at the camera → align `facing` with
        // (cosα, sinα).
        const camDirX = Math.cos(CAM_ALPHA);
        const camDirZ = Math.sin(CAM_ALPHA);
        // Current facing angle and desired camera angle in the XZ plane.
        const faceAngle = Math.atan2(facing.z, facing.x);
        const camAngle = Math.atan2(camDirZ, camDirX);
        // A positive mesh.rotation.y rotates (x,z) by -yaw around +Y in
        // Babylon's left-handed space; solve so facing lands on the cam dir.
        let yaw = faceAngle - camAngle;
        // Normalize to (-PI, PI].
        yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
        const deg = Math.round((yaw * 180) / Math.PI);
        setModelTransform(id, { orbit: deg });
        return deg;
    }

    /** Pixel aspect (w/h) of a model's current viewport box on the canvas. */
    function viewportAspectOf(m: ModelState): number {
        const cw = engine.getRenderWidth() || stageDims.w;
        const ch = engine.getRenderHeight() || stageDims.h;
        const boxW = (m.w > 0 ? m.w : stageDims.w) / stageDims.w * cw;
        const boxH = (m.h > 0 ? m.h : stageDims.h) / stageDims.h * ch;
        return boxH > 0 ? boxW / boxH : 1;
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

        // Use meshData.bounding_box DIRECTLY (same as ModelPreview). The
        // backend (skn.rs) already recomputes this AABB from the X-negated
        // vertex positions, so it's in the exact same space as the loaded
        // meshes and correctly centered. Recomputing it from Babylon's
        // (not-yet-flushed) bounding info was returning an origin/stale box —
        // which is why models spawned at 0,0.
        const bbox = meshData.bounding_box;

        // Unique layerMask bit for this model so its camera sees only it.
        // Bit index = model index (wraps after 27; far more than any real
        // thumbnail needs).
        const bitIndex = (modelSeq - 1) % 27;
        const layerMask = 1 << bitIndex;
        for (const mesh of meshes) {
            mesh.layerMask = layerMask;
            // The recomputed AABB can be unreliable right after build (world
            // matrix not yet flushed), and a wrong bbox would frustum-cull the
            // whole model → invisible. Skip per-mesh frustum culling: these
            // are hero models that always fill their viewport anyway.
            mesh.alwaysSelectAsActiveMesh = true;
        }

        const camera = new ArcRotateCamera(
            `thumbnail-cam-${id}`,
            CAM_ALPHA,
            Math.PI / 3,
            5,
            Vector3.Zero(),
            scene,
        );
        camera.layerMask = layerMask;
        camera.wheelDeltaPercentage = 0.05;
        // Framing is applied by applyViewport (below) once the box is known so
        // it can account for the viewport aspect. Cameras are display-only by
        // default; a model becomes interactive only when setControlModel(id)
        // is called (double-click a model to orbit/pan it).

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
            positions: meshData.positions,
            normals: meshData.normals,
            materials: meshData.materials.map(mm => ({ name: mm.name, start_vertex: mm.start_vertex, vertex_count: mm.vertex_count })),
            textures,
            clips: animResult.clips,
            hiddenMeshes: new Set(),
            player: null,
            fps: 0,
            maxFrame: 0,
            pendingFrame: null,
            glowOn: false,
            userFramed: false,
            focusMode: 'full',
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            scale: 1,
            orbit: 0,
            tiltX: 0,
        };
        models.set(id, state);
        applyViewport(state);
        refreshActiveCameras();

        return { id, maxFrame: 0 };
    }

    function setModelFocus(id: string, mode: 'full' | 'head'): void {
        const m = models.get(id);
        if (!m) return;
        m.focusMode = mode;
        m.userFramed = false; // a focus change re-frames even after manual orbit
        reframeModel(m);
    }

    function removeModel(id: string): void {
        const m = models.get(id);
        if (!m) return;
        // controlCamera is set null inside disposeModel if it was the one.
        disposeModel(m);
        models.delete(id);
        refreshActiveCameras();
    }

    // ── Per-model interactive control (double-click a model to orbit/pan it) ──
    // Only ONE model is interactive at a time. Attaching control to a model's
    // camera lets the user orbit (drag) / pan (right-drag or ctrl-drag) / zoom
    // (wheel) WITHIN that model's viewport box. Passing null detaches (back to
    // display-only). The first manual orbit marks the model `userFramed` so
    // box/aspect changes stop auto-reframing it.
    function setControlModel(id: string | null): void {
        // Detach whatever camera currently has control.
        if (controlCamera) {
            controlCamera.detachControl();
            controlCamera = null;
        }
        if (!id) return;
        const m = models.get(id);
        if (!m) return;
        controlCamera = m.camera;
        // Attach Babylon control so RIGHT-DRAG PANS (the old, good pan). But
        // DISABLE rotation-by-drag (angularSensibility → Infinity) — rotation
        // is done on the Properties panel via the Turn (Y) / Tilt (X) sliders,
        // not by dragging (the user found drag-rotate confusing). Wheel is
        // removed here too; the artboard intercepts it to drive `scale`.
        m.camera.attachControl(canvas, /* noPreventDefault */ false);
        m.camera.inputs.removeByType('ArcRotateCameraMouseWheelInput');
        m.camera.angularSensibilityX = Number.POSITIVE_INFINITY;
        m.camera.angularSensibilityY = Number.POSITIVE_INFINITY;
        m.userFramed = true;
    }

    /** Re-frame a model to its default centered pose (double-click again to
     *  reset an orbit). Clears userFramed so box changes auto-frame again. */
    function resetModelView(id: string): void {
        const m = models.get(id);
        if (!m) return;
        m.userFramed = false;
        reframeModel(m);
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
            // `scale` is a percentage (100 = 1.0×). Framing uses the UNSCALED
            // model, so scale then visibly shrinks/grows it within the box —
            // a smaller scale leaves headroom (the model reads smaller).
            const s = patch.scale / 100;
            for (const mesh of m.meshes) mesh.scaling.set(s, s, s);
            // Re-frame (head focus depends on scale) unless the user has taken
            // manual camera control.
            if (!m.userFramed) reframeModel(m);
        }
        if (patch.orbit !== undefined) {
            m.orbit = patch.orbit;
            // orbit (Turn / yaw) is in DEGREES (slider -180..180) → radians.
            const rad = (patch.orbit * Math.PI) / 180;
            for (const mesh of m.meshes) mesh.rotation.y = rad;
        }
        if (patch.tiltX !== undefined) {
            m.tiltX = patch.tiltX;
            // tiltX (Tilt / pitch) in DEGREES → radians.
            const rad = (patch.tiltX * Math.PI) / 180;
            for (const mesh of m.meshes) mesh.rotation.x = rad;
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
        setControlModel,
        resetModelView,
        faceModelToCamera,
        setModelFocus,
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
