/**
 * Headless Babylon scene controller for a `.skn` preview.
 *
 * Extracted from `ModelPreview.tsx`'s effects (~1905 lines, ~18 `useEffect`s) so
 * the preview pane and the (future) 3D editor viewport share exactly one
 * implementation of the engine/camera/lights/skybox/grid/materials/skeleton
 * plumbing. Several of the choices in here fixed real, previously-shipped bugs —
 * their explanatory comments are preserved verbatim from ModelPreview so the next
 * person doesn't have to rediscover them.
 *
 * This module MUST stay headless: no React, no imports from `src/components/`.
 * Callers that need Babylon objects the handle doesn't wrap directly (the
 * `ArcRotateCamera`, the built `Skeleton`, the skinned `Mesh` list for a
 * shader-preview pass) reach into `handle.scene` — see the doc-comment on
 * `SknSceneHandle.scene`.
 */

import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { CubeTexture } from '@babylonjs/core/Materials/Textures/cubeTexture';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { SkeletonViewer } from '@babylonjs/core/Debug/skeletonViewer';
// Side-effect: registers `Scene.prototype.pick` (tree-shaken out of core by
// default). Without this, `pickAt` throws "scene.pick is not a function".
import '@babylonjs/core/Culling/ray';

import { getBundledFloorPng, getBundledSkyboxFace } from '../api/texture';
import type { SknMeshData, ScbMeshData } from '../api/mesh';
import { createEngine } from './engine';
import { buildSknMeshes, type MeshDTO } from './meshBuilder';
import {
    buildBabylonSkeleton,
    buildSkeletonOctahedrons,
    buildSkeletonJoints,
    type BoneData,
    type SklData,
} from './skeletonBuilder';
import { computeFraming, applyFraming, type BoundingBox } from './cameraFraming';

/** Adapter so cameraFraming never has to import Babylon. */
const makeVector3 = (x: number, y: number, z: number) => new Vector3(x, y, z);

// ============================================================================
// Public types
// ============================================================================

export type SkeletonOverlayMode = 'off' | 'lines' | 'octahedrons' | 'joints';
export type FloorMode = 'grid' | 'textured' | 'none';

export interface SknSceneOptions {
    /** Draw the ground grid. Default true. */
    grid?: boolean;
    /** Load the bundled skybox. Default true. */
    skybox?: boolean;
}

/**
 * Metadata the controller stamps onto the Babylon `Skeleton` it builds (via
 * `Skeleton.metadata`, a plain `any` slot Babylon reserves for exactly this).
 * `ModelPreview` still owns the `AnimationPlayer` (see the brief) and needs
 * `boneIndexByHash`/`joints` — which have no home on the Babylon `Skeleton`
 * object itself — to construct one; `bones` is available directly as
 * `skeleton.bones`. Reading this off `handle.scene.skeletons[0]` avoids adding
 * an animation-shaped method to a controller that otherwise knows nothing
 * about clips.
 */
export interface SknSkeletonMetadata {
    boneIndexByHash: Map<number, number>;
    joints: BoneData[];
}

export interface SknSceneHandle {
    /** Replace the loaded geometry. Framing runs once per call, from this
     *  mesh's own bounding box. Accepts SCB/SCO (static) payloads too, in
     *  addition to SKN — see the module-level note above `loadMesh`'s
     *  implementation for why the type is wider than the brief's example. */
    loadMesh(mesh: SknMeshData | ScbMeshData, skeleton: SklData | null): Promise<void>;
    setSubmeshVisible(name: string, visible: boolean): void;
    /** Show only this submesh; `null` shows everything not individually hidden. */
    setIsolated(name: string | null): void;
    setWireframe(on: boolean): void;
    setSkeletonOverlay(mode: SkeletonOverlayMode): void;
    /** Emissive-tint the named submesh; `null` clears. Not a HighlightLayer —
     *  that is a full-screen post-process and costs more than this needs. */
    setSelection(name: string | null): void;
    frameCamera(): void;
    /** Canvas-space pick → submesh name, or null on a miss. */
    pickAt(x: number, y: number): string | null;
    /** Rename in place, so a rename does not force a geometry reload. */
    renameSubmesh(oldName: string, newName: string): void;
    /** Show/hide the bundled cubemap skybox. Not in the brief's method list —
     *  added so ModelPreview's Environment popup keeps its existing toggle
     *  without a second copy of the skybox-loading code living outside this
     *  controller (see the file-level note in the report on this addition). */
    setSkyboxVisible(on: boolean): void;
    /** Grid lines / textured ground plane / nothing. Same rationale as
     *  `setSkyboxVisible` — ModelPreview's Environment popup already exposes
     *  this three-way choice today. */
    setFloorMode(mode: FloorMode): void;
    /** The currently-built per-submesh meshes, for a caller that needs to hand
     *  them to something the controller doesn't own (ModelPreview's opt-in
     *  shader-preview pass swaps materials on these directly). */
    getActiveMeshes(): Mesh[];
    /** The underlying scene, for callers that still need Babylon directly
     *  (the animation player, the active camera, the built skeleton). */
    readonly scene: Scene;
    dispose(): void;
}

// ============================================================================
// Internal helpers (moved verbatim from ModelPreview.tsx)
// ============================================================================

/**
 * Dispose a Babylon SkeletonViewer safely and clear the ref.
 *
 * SkeletonViewer owns its own UtilityLayerRenderer + utility scene; disposing it
 * runs `utilityScene.dispose() → engine.wipeCaches() → unbindAllAttributes()`,
 * which touches `engine._currentBufferPointers`. If the WebGL context was lost
 * or the engine is already mid-teardown, that array is undefined and Babylon
 * throws `Cannot set properties of undefined (setting 'active')` — which, thrown
 * from a React effect commit, crashed the whole ModelPreview tree. Swallow the
 * Babylon-internal failure (the viewer is being thrown away anyway).
 *
 * Takes a plain `{ current }` box rather than `React.MutableRefObject` — this
 * module has no React dependency — so the caller can pass any mutable cell.
 */
function safeDisposeSkeletonViewer(ref: { current: SkeletonViewer | null }): void {
    const viewer = ref.current;
    ref.current = null;
    if (!viewer) return;
    try {
        viewer.dispose();
    } catch (e) {
        console.debug('[SknScene] SkeletonViewer.dispose() failed (context lost / engine torn down); ignoring', e);
    }
}

/**
 * Build the line SkeletonViewer (the original, reliable display). One shared
 * builder so both create sites stay identical.
 */
function buildSkeletonViewer(skeleton: Skeleton, mesh: Mesh, scene: Scene): SkeletonViewer {
    const viewer = new SkeletonViewer(
        skeleton,
        mesh,
        scene,
        true,
        1,
        {
            displayMode: SkeletonViewer.DISPLAY_LINES,
        },
    );
    viewer.isEnabled = true;
    return viewer;
}

function disposeMeshAndMaterial(mesh: Mesh | null): void {
    if (!mesh) return;
    mesh.material?.dispose();
    mesh.dispose();
}

// ============================================================================
// Controller
// ============================================================================

export function createSknScene(canvas: HTMLCanvasElement, opts?: SknSceneOptions): SknSceneHandle {
    const wantGrid = opts?.grid !== false;
    const wantSkybox = opts?.skybox !== false;

    const engine = createEngine(canvas);
    console.debug('[engine] CREATED (live GL engines pile up if this fires per file)');

    const onWinError = (e: ErrorEvent) =>
        console.error(`[render] 💥 window error: ${e.message}`, e.error?.stack ?? e.error ?? '');
    const onRejection = (e: PromiseRejectionEvent) =>
        console.error('[render] 💥 unhandledrejection:', e.reason?.stack ?? e.reason ?? e.reason);
    const onCtxLost = (e: Event) => {
        e.preventDefault();
        console.error('[render] 💥 canvas webglcontextlost (GPU context dropped)');
    };
    const onCtxRestored = () => console.debug('[render] ✓ canvas webglcontextrestored');
    window.addEventListener('error', onWinError);
    window.addEventListener('unhandledrejection', onRejection);
    canvas.addEventListener('webglcontextlost', onCtxLost);
    canvas.addEventListener('webglcontextrestored', onCtxRestored);
    engine.onContextLostObservable.add(() => console.error('[render] 💥 Babylon onContextLost'));
    engine.onContextRestoredObservable.add(() => console.debug('[render] ✓ Babylon onContextRestored'));

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0);

    const camera = new ArcRotateCamera(
        'camera',
        Math.PI / 2 + Math.PI / 8,
        Math.PI / 3,
        5,
        Vector3.Zero(),
        scene,
    );
    camera.panningSensibility = 100;
    camera.attachControl(canvas, true);
    camera.wheelDeltaPercentage = 0.05;

    const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
    };
    canvas.addEventListener('contextmenu', handleContextMenu);

    const ambientLight = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
    ambientLight.intensity = 1.2;
    ambientLight.specular = new Color3(0, 0, 0);

    // Directional lights start off — ModelPreview's "customize lighting" effects
    // (which reach into `scene.getLightByName` directly) turn them on. A fresh
    // caller that never touches lighting gets the same flat ambient-only look
    // ModelPreview opens with by default.
    const dirLight1 = new DirectionalLight('dirLight1', new Vector3(-1, -1, -1), scene);
    dirLight1.intensity = 0.0;
    const dirLight2 = new DirectionalLight('dirLight2', new Vector3(1, 1, 1), scene);
    dirLight2.intensity = 0.0;
    const dirLight3 = new DirectionalLight('dirLight3', new Vector3(0, 1, 0), scene);
    dirLight3.intensity = 0.0;

    // ── Per-submesh mesh bookkeeping ──────────────────────────────────────
    let meshes: Mesh[] = [];
    const meshByName = new Map<string, Mesh>();
    const explicitlyHidden = new Set<string>();
    let isolated: string | null = null;
    let currentTextureCache = new Map<string, Texture>();
    let currentWireframe = false;
    let currentBbox: BoundingBox | null = null;

    let currentSkeleton: Skeleton | null = null;
    let currentSklData: SklData | null = null;
    let skeletonViewer: SkeletonViewer | null = null;
    let skeletonOverlayMesh: Mesh | null = null;

    let selectedMesh: Mesh | null = null;
    let selectedOriginalEmissive: Color3 | null = null;

    let gridMesh: ReturnType<typeof CreateLineSystem> | null = null;
    let floorMesh: Mesh | null = null;
    let floorLoadToken = 0;

    let skyboxMesh: Mesh | null = null;
    let skyboxUrls: string[] = [];
    let skyboxLoading = false;
    let skyboxLoadToken = 0;
    let skyboxVisible = false;

    // ── Render loop ────────────────────────────────────────────────────────
    // Kept minimal: this controller doesn't know about animation clips (that's
    // ModelPreview's AnimationPlayer, driven off `scene.onBeforeRenderObservable`
    // by the caller — see the `scene` doc-comment). The try/catch still covers
    // caller-registered observers too, since Babylon runs them from inside
    // `scene.render()`.
    let renderErrCount = 0;
    engine.runRenderLoop(() => {
        try {
            scene.render();
        } catch (err) {
            renderErrCount++;
            if (renderErrCount <= 5 || renderErrCount % 180 === 0) {
                console.error(`[render] frame #${renderErrCount} threw (loop kept alive):`, err);
            }
        }
    });

    // ── Resize ─────────────────────────────────────────────────────────────
    // A window resize AND a canvas ResizeObserver, matching MapPreview.tsx's
    // established pattern for this exact widget class (a panel-splitter drag
    // resizes the canvas without ever firing `window.resize`). The zero-size
    // guard is mapEnvScene.ts's fix for the same engine-level bug: calling
    // `engine.resize()` while the canvas is 0×0 (window minimized) corrupts the
    // swapchain and the model renders as a stretched/garbled band on restore.
    // Unlike mapEnvScene's map framing, `computeFraming` below never reads
    // canvas size, so there is nothing to re-frame once size comes back — the
    // guard alone is the whole fix here.
    function safeResize(): void {
        if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
        engine.resize();
    }
    const onWindowResize = () => safeResize();
    window.addEventListener('resize', onWindowResize);
    const sizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => safeResize()) : null;
    sizeObserver?.observe(canvas);

    // ============================================================================
    // Skybox
    // ============================================================================

    function disposeSkybox(): void {
        if (skyboxMesh) {
            try {
                const mat = skyboxMesh.material as StandardMaterial | null;
                mat?.reflectionTexture?.dispose();
                mat?.dispose();
                skyboxMesh.dispose();
            } catch { /* ignore */ }
            skyboxMesh = null;
        }
        skyboxUrls.forEach(u => URL.revokeObjectURL(u));
        skyboxUrls = [];
    }

    function setSkyboxVisible(on: boolean): void {
        skyboxVisible = on;

        if (!on) {
            skyboxLoadToken++; // invalidate any in-flight load's stale continuation
            skyboxLoading = false;
            disposeSkybox();
            scene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0);
            return;
        }

        // Dark clear as a fallback until the cubemap faces load.
        scene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0);
        if (skyboxMesh) {
            skyboxMesh.setEnabled(true);
            return;
        }
        if (skyboxLoading) return;
        skyboxLoading = true;
        const myToken = ++skyboxLoadToken;

        (async () => {
            try {
                // Load the 6 bundled WebP faces as blob URLs.
                //
                // ORDER IS LOAD-BEARING: Babylon's CubeTexture `files` arg is
                // consumed BY INDEX (it stores `this._files = files` verbatim and
                // never parses the names), and blob URLs carry no filename at
                // all — so the array position alone decides which GPU face each
                // image becomes. The order is positives-then-negatives,
                // [px, py, pz, nx, ny, nz], matching Babylon's own default
                // extensions list. Interleaving it as px,nx,py,… puts the sky
                // (py) on a side wall and a side wall overhead.
                const faces = ['px', 'py', 'pz', 'nx', 'ny', 'nz'];
                const urls = await Promise.all(faces.map(async (f) => {
                    const bytes = await getBundledSkyboxFace(f);
                    return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'image/webp' }));
                }));
                if (scene.isDisposed || myToken !== skyboxLoadToken) { urls.forEach(u => URL.revokeObjectURL(u)); return; }
                skyboxUrls = urls;

                // MANUAL skybox (NOT scene.createDefaultSkybox — that also sets
                // scene.environmentTexture, which re-lights/washes out the PBR
                // model).
                //
                // ZOOM-PROOF: the box FOLLOWS the camera every frame
                // (infiniteDistance) so the camera is always inside it, and it
                // writes NO depth (disableDepthWrite) so it can never occlude or
                // z-fight the model no matter how far you zoom in/out. The box
                // renders first in group 0; the model (default group) draws over
                // it. `needDepthPrePass=false` + no fog keeps it a pure backdrop.
                // Half-size (50) stays comfortably between the camera near (1)
                // and far (10000) planes at every zoom, so it never clips.
                const box = CreateBox('skybox', { size: 100 }, scene);
                const mat = new StandardMaterial('skybox-mat', scene);
                mat.backFaceCulling = false;
                mat.disableLighting = true;
                mat.disableDepthWrite = true;
                mat.reflectionTexture = new CubeTexture('', scene, null, true, urls);
                mat.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
                mat.diffuseColor = new Color3(0, 0, 0);
                mat.specularColor = new Color3(0, 0, 0);
                box.material = mat;
                box.infiniteDistance = true;
                box.isPickable = false;
                box.applyFog = false;
                box.renderingGroupId = 0;
                skyboxMesh = box;
                box.setEnabled(skyboxVisible);
            } catch (e) {
                console.warn('[SknScene] skybox load failed, using flat clear color:', e);
            } finally {
                // Only clear the flag if this is still the current attempt — a
                // cancelling `setSkyboxVisible(false)` already reset it, and a
                // newer load may have started since.
                if (myToken === skyboxLoadToken) skyboxLoading = false;
            }
        })();
    }

    // ============================================================================
    // Ground / grid
    // ============================================================================

    function disposeFloor(): void {
        floorLoadToken++; // cancel any in-flight textured-floor load
        if (gridMesh) {
            gridMesh.dispose();
            gridMesh = null;
        }
        if (floorMesh) {
            if (floorMesh.material) {
                floorMesh.material.dispose();
            }
            floorMesh.dispose();
            floorMesh = null;
        }
    }

    function setFloorMode(mode: FloorMode): void {
        disposeFloor();

        if (mode === 'grid') {
            const gridLines: Vector3[][] = [];
            const gridColors: Color4[][] = [];
            const size = 1000;
            const step = 20;
            const color = new Color4(0.29, 0.29, 0.29, 1.0);
            for (let i = -size; i <= size; i += step) {
                gridLines.push([new Vector3(i, 0, -size), new Vector3(i, 0, size)]);
                gridLines.push([new Vector3(-size, 0, i), new Vector3(size, 0, i)]);
                gridColors.push([color, color], [color, color]);
            }
            gridMesh = CreateLineSystem('grid', { lines: gridLines, colors: gridColors, useVertexAlpha: false }, scene);
            gridMesh.isPickable = false;
            gridMesh.renderingGroupId = 1; // above the skybox (group 0)
        } else if (mode === 'textured') {
            const myToken = ++floorLoadToken;

            (async () => {
                try {
                    const pngBytes = await getBundledFloorPng();
                    if (myToken !== floorLoadToken || scene.isDisposed) return;

                    const blob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' });
                    const objectUrl = URL.createObjectURL(blob);

                    const ground = CreateGround('ground', { width: 1500, height: 1500 }, scene);
                    ground.isPickable = false;
                    ground.position.y = -2;
                    const mat = new StandardMaterial('ground-mat', scene);
                    mat.backFaceCulling = false;

                    const tex = new Texture(
                        objectUrl, scene, undefined, undefined, undefined,
                        () => {
                            URL.revokeObjectURL(objectUrl);
                            console.debug('[floor] ground texture loaded (url revoked)');
                        },
                        (msg, ex) => {
                            URL.revokeObjectURL(objectUrl);
                            console.error('[floor] ground texture FAILED to load:', msg, ex);
                        },
                    );
                    mat.diffuseTexture = tex;
                    mat.specularColor = new Color3(0, 0, 0);
                    ground.material = mat;

                    ground.renderingGroupId = 1; // above the skybox (group 0)
                    floorMesh = ground;
                    console.debug(`[floor] ground created (scene meshes=${scene.meshes.length})`);

                    scene.onAfterRenderObservable.addOnce(() => {
                        const dump = scene.meshes.map(mm => {
                            const mm2 = mm as any;
                            return `${mm.name}{en=${mm.isEnabled()},vis=${mm.isVisible},a=${mm.visibility},y=${mm.position.y.toFixed(1)},` +
                                `verts=${mm.getTotalVertices()},mat=${mm2.material?.getClassName?.() ?? mm2.material?.name ?? 'none'}}`;
                        });
                        const cam = scene.activeCamera as any;
                        console.debug(
                            `[floor] AFTER-RENDER scene.meshes(${scene.meshes.length})=[${dump.join(', ')}] ` +
                            `cam.radius=${cam?.radius?.toFixed?.(1)} cam.minZ=${cam?.minZ} cam.maxZ=${cam?.maxZ} ` +
                            `clearColor=(${scene.clearColor.r.toFixed(2)},${scene.clearColor.g.toFixed(2)},${scene.clearColor.b.toFixed(2)})`
                        );
                    });
                } catch (e) {
                    console.error('Failed to load textured floor:', e);
                }
            })();
        }
    }

    // ============================================================================
    // Skeleton overlay
    // ============================================================================

    function disposeSkeletonOverlay(): void {
        const box = { current: skeletonViewer };
        safeDisposeSkeletonViewer(box);
        skeletonViewer = box.current;
        disposeMeshAndMaterial(skeletonOverlayMesh);
        skeletonOverlayMesh = null;
    }

    function setSkeletonOverlay(mode: SkeletonOverlayMode): void {
        disposeSkeletonOverlay();

        if (mode === 'off') return;

        if (mode === 'lines') {
            if (currentSkeleton && meshes.length > 0) {
                try {
                    skeletonViewer = buildSkeletonViewer(currentSkeleton, meshes[0], scene);
                } catch (e) {
                    console.error('Failed to build skeleton viewer:', e);
                }
            }
            return;
        }

        if (!currentSklData) return;
        try {
            const built = mode === 'octahedrons'
                ? buildSkeletonOctahedrons(currentSklData, scene)
                : buildSkeletonJoints(currentSklData, scene);
            skeletonOverlayMesh = built?.mesh ?? null;
        } catch (e) {
            console.error(`Failed to build skeleton ${mode} overlay:`, e);
        }
    }

    // ============================================================================
    // Mesh / material build
    // ============================================================================

    function disposeCurrentGeometry(): void {
        // Mirrors ModelPreview's two-phase teardown: dispose the previous
        // load's texture cache (which also catches any decoded texture that
        // never got assigned to a mesh), THEN dispose the meshes/materials
        // (which may double-dispose the same texture instance via
        // `mat.albedoTexture` — harmless, Babylon tolerates repeat dispose).
        currentTextureCache.forEach(tex => tex.dispose());
        currentTextureCache = new Map();

        meshes.forEach(m => {
            if (m.material) {
                const mat = m.material as PBRMaterial;
                if (mat.albedoTexture) mat.albedoTexture.dispose();
                mat.dispose();
            }
            m.dispose();
        });
        meshes = [];
        meshByName.clear();
        explicitlyHidden.clear();
        isolated = null;
        selectedMesh = null;
        selectedOriginalEmissive = null;

        if (currentSkeleton) {
            currentSkeleton.dispose();
            currentSkeleton = null;
        }
        currentSklData = null;
        disposeSkeletonOverlay();
    }

    // Deliberately NOT declared `async`: every step here is synchronous (texture
    // decode kicks off Babylon's own internal async load but doesn't block this
    // function), and a plain function that throws does so SYNCHRONOUSLY to its
    // caller. An `async function` would instead turn a `throw` into a rejected
    // promise delivered on a later microtask — which would let ModelPreview's
    // sibling `[visibleMaterials]` effect run (in the same commit) before the
    // meshes this call is building even exist. Returning `Promise.resolve()`
    // keeps the declared `Promise<void>` contract for callers (like the future
    // editor viewport) that legitimately want to `await` it.
    function loadMesh(meshData: SknMeshData | ScbMeshData, skeleton: SklData | null): Promise<void> {
        disposeCurrentGeometry();

        let babylonSkeleton: Skeleton | undefined;
        if (skeleton) {
            const built = buildBabylonSkeleton(skeleton, scene, 'skeleton');
            babylonSkeleton = built.skeleton;
            babylonSkeleton.metadata = {
                boneIndexByHash: built.boneIndexByHash,
                joints: built.joints,
            } satisfies SknSkeletonMetadata;
            currentSkeleton = babylonSkeleton;
            currentSklData = skeleton;
        }

        const isSkn = meshData.kind === 'skn';
        const meshDto: MeshDTO = {
            positions: meshData.positions,
            indices: meshData.indices,
            normals: meshData.normals,
            uvs: meshData.uvs,
            bone_indices: isSkn ? (meshData as SknMeshData).bone_indices : undefined,
            bone_weights: isSkn ? (meshData as SknMeshData).bone_weights : undefined,
            submeshes: isSkn
                ? (meshData as SknMeshData).materials.map(m => ({
                    name: m.name,
                    start_vertex: m.start_vertex,
                    vertex_count: m.vertex_count,
                    start_index: m.start_index,
                    index_count: m.index_count,
                }))
                : (meshData as ScbMeshData).materials.map(matName => {
                    const scb = meshData as ScbMeshData;
                    const range = scb.material_ranges?.[matName] || [0, scb.indices.length];
                    return {
                        name: matName,
                        start_vertex: 0,
                        vertex_count: scb.positions.length / 3,
                        start_index: range[0],
                        index_count: range[1],
                    };
                }),
            bbox: meshData.bounding_box,
        };

        const influences = skeleton?.influences;

        console.debug(
            `[MeshPreview] build ${meshData.kind}: ` +
            `pos=${meshData.positions?.length}(${(meshData.positions?.length ?? 0) / 3}v) ` +
            `idx=${meshData.indices?.length} uv=${meshData.uvs?.length} nrm=${meshData.normals?.length} ` +
            `bbox=${JSON.stringify(meshData.bounding_box)} skel=${!!babylonSkeleton} ` +
            `submeshes=${meshDto.submeshes.length}[${meshDto.submeshes.map(s => `${s.name}:v${s.start_vertex}+${s.vertex_count}/i${s.start_index}+${s.index_count}`).join('; ')}]`
        );

        let builtMeshes: Mesh[];
        try {
            builtMeshes = buildSknMeshes(meshDto, scene, babylonSkeleton, influences).meshes;
            console.debug(`[MeshPreview] buildSknMeshes OK → ${builtMeshes.length} mesh(es)`);
        } catch (err) {
            console.error(`[MeshPreview] buildSknMeshes THREW (${meshData.kind}):`, err);
            throw err;
        }
        meshes = builtMeshes;
        // Model renders in group 1 so it always draws AFTER (on top of) the
        // skybox, which lives in group 0. Without this the skybox box (drawn in
        // the same group) can paint over the whole model.
        for (const m of meshes) {
            m.renderingGroupId = 1;
            meshByName.set(m.name, m);
        }

        const textureCache = new Map<string, Texture>();
        currentTextureCache = textureCache;
        const matData = meshData.material_data;
        if (matData && Object.keys(matData).length > 0) {
            for (const [matName, data] of Object.entries(matData)) {
                try {
                    const dataUrl = 'data:image/png;base64,' + data.texture;
                    const texture = new Texture(dataUrl, scene, false, true);
                    texture.wrapU = Texture.WRAP_ADDRESSMODE;
                    texture.wrapV = Texture.WRAP_ADDRESSMODE;
                    // has_alpha from the decoder (any pixel with alpha < 255)
                    // — drives the alpha-test/blend path at material build.
                    texture.hasAlpha = !!data.has_alpha;

                    // Plain tiling only. The offset/flipbook transforms we
                    // used to apply here interacted wrongly with the PNG
                    // loader's V-flip on authored-UV materials; the base
                    // look now matches the reference viewer (plain WRAP +
                    // scale), and materials with real UV manipulation render
                    // correctly through the game-shaders pass instead.
                    if (data.uv_scale) {
                        texture.uScale = data.uv_scale[0];
                        texture.vScale = data.uv_scale[1];
                    }
                    textureCache.set(matName, texture);
                } catch (e) {
                    console.error('Failed to decode base64 texture for:', matName, e);
                }
            }
        } else if (isSkn && (meshData as SknMeshData).textures) {
            const textures = (meshData as SknMeshData).textures!;
            for (const [matName, base64Data] of Object.entries(textures)) {
                try {
                    const dataUrl = 'data:image/png;base64,' + base64Data;
                    const texture = new Texture(dataUrl, scene, false, true);
                    texture.wrapU = Texture.WRAP_ADDRESSMODE;
                    texture.wrapV = Texture.WRAP_ADDRESSMODE;
                    texture.hasAlpha = false;
                    textureCache.set(matName, texture);
                } catch (e) {
                    console.error('Failed to decode base64 texture fallback for:', matName, e);
                }
            }
        }

        meshes.forEach(m => {
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
            mat.wireframe = currentWireframe;

            if (!isSkn) {
                mat.albedoColor = new Color3(0.6, 0, 0);
                mat.albedoTexture = null;
                mat.backFaceCulling = false;
                mat.useAlphaFromAlbedoTexture = false;
                mat.transparencyMode = Material.MATERIAL_OPAQUE;
                mat.alpha = 1;
            } else if (texture) {
                mat.backFaceCulling = true;
                mat.albedoTexture = texture;
                mat.albedoColor = new Color3(1, 1, 1);
                if (texture.hasAlpha) {
                    // League charskin look (ported from the reference
                    // viewer): cutoff + per-fragment blend keeps feathered
                    // transparency at hair/cape edges, and the depth
                    // pre-pass writes the cutoff'd depth first so
                    // overlapping parts don't sort each other into black
                    // silhouettes.
                    mat.useAlphaFromAlbedoTexture = true;
                    mat.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
                    mat.alphaCutOff = 0.2;
                    mat.needDepthPrePass = true;
                } else {
                    mat.useAlphaFromAlbedoTexture = false;
                    mat.transparencyMode = Material.MATERIAL_OPAQUE;
                }
            } else {
                mat.backFaceCulling = true;
                mat.albedoColor = new Color3(1, 0, 1);
            }

            m.material = mat;
            console.debug(
                `[MeshPreview] applyMat mesh='${matName}' textureFound=${!!texture} ` +
                `albedo=${texture ? 'tex' : 'MAGENTA(no-tex)'} (visibility applied separately by the caller)`
            );
        });

        meshes.forEach((m, i) => {
            const bi = m.getBoundingInfo();
            const bb = bi.boundingBox;
            const mat = m.material as PBRMaterial | null;
            console.debug(
                `[MeshPreview] FINAL mesh[${i}] name='${m.name}' enabled=${m.isEnabled()} ` +
                `isVisible=${m.isVisible} visibility=${m.visibility} alphaIndex=${m.alphaIndex} ` +
                `gpuVerts=${m.getTotalVertices()} gpuIdx=${m.getTotalIndices()} ` +
                `pos=(${m.position.x.toFixed(1)},${m.position.y.toFixed(1)},${m.position.z.toFixed(1)}) ` +
                `scale=(${m.scaling.x},${m.scaling.y},${m.scaling.z}) ` +
                `bbMinW=(${bb.minimumWorld.x.toFixed(1)},${bb.minimumWorld.y.toFixed(1)},${bb.minimumWorld.z.toFixed(1)}) ` +
                `bbMaxW=(${bb.maximumWorld.x.toFixed(1)},${bb.maximumWorld.y.toFixed(1)},${bb.maximumWorld.z.toFixed(1)}) ` +
                `mat='${mat?.name}' matAlpha=${mat?.alpha} unlit=${mat?.unlit} wireframe=${mat?.wireframe} ` +
                `albedoColor=${mat?.albedoColor ? `(${mat.albedoColor.r},${mat.albedoColor.g},${mat.albedoColor.b})` : 'none'} ` +
                `hasAlbedoTex=${!!mat?.albedoTexture}`
            );
        });

        // Framing math lives in cameraFraming.ts so it can also be re-run on demand
        // (frameCamera()/the 'F' shortcut), and unit-tested without Babylon.
        // One-time per load: this is the only place `applyFraming` runs for a
        // given mesh identity, mirroring the original effect's `[scene, camera,
        // meshData, skeletonData]` dependency array (it never re-ran on an
        // `.anm` clip swap because clip state wasn't a dependency).
        currentBbox = meshData.bounding_box as BoundingBox;
        const framing = computeFraming(currentBbox);
        applyFraming(camera, framing, makeVector3);
        console.debug(
            `[MeshPreview] camera: radius=${framing.radius.toFixed(3)} ` +
            `target=(${framing.center.map((n) => n.toFixed(2)).join(',')})`
        );

        // No auto-reapply of a previous skeleton-overlay mode here: like the
        // original effect, the caller is expected to call `setSkeletonOverlay`
        // again after a fresh load if it wants the overlay to persist
        // (`disposeCurrentGeometry()` above already tore down any prior one).
        return Promise.resolve();
    }

    // ============================================================================
    // Visibility / isolate / wireframe / selection
    // ============================================================================

    function applyMeshVisibility(mesh: Mesh, name: string): void {
        const visible = isolated !== null ? name === isolated : !explicitlyHidden.has(name);
        mesh.setEnabled(visible);
    }

    function setSubmeshVisible(name: string, visible: boolean): void {
        if (visible) explicitlyHidden.delete(name);
        else explicitlyHidden.add(name);
        const mesh = meshByName.get(name);
        if (mesh) applyMeshVisibility(mesh, name);
    }

    function setIsolated(name: string | null): void {
        isolated = name;
        for (const [n, mesh] of meshByName) applyMeshVisibility(mesh, n);
    }

    function setWireframe(on: boolean): void {
        currentWireframe = on;
        meshes.forEach(m => {
            if (m.material) m.material.wireframe = on;
        });
    }

    function setSelection(name: string | null): void {
        if (selectedMesh && selectedOriginalEmissive) {
            const mat = selectedMesh.material as PBRMaterial | StandardMaterial | null;
            if (mat) mat.emissiveColor = selectedOriginalEmissive;
        }
        selectedMesh = null;
        selectedOriginalEmissive = null;

        if (!name) return;
        const mesh = meshByName.get(name);
        const mat = mesh?.material as PBRMaterial | StandardMaterial | null | undefined;
        if (!mesh || !mat) return;
        selectedMesh = mesh;
        selectedOriginalEmissive = mat.emissiveColor.clone();
        mat.emissiveColor = new Color3(0.35, 0.55, 1.0);
    }

    function renameSubmesh(oldName: string, newName: string): void {
        const mesh = meshByName.get(oldName);
        if (!mesh) return;
        mesh.name = newName;
        meshByName.delete(oldName);
        meshByName.set(newName, mesh);
        if (explicitlyHidden.delete(oldName)) explicitlyHidden.add(newName);
        if (isolated === oldName) isolated = newName;
    }

    function frameCamera(): void {
        if (!currentBbox) return;
        const framing = computeFraming(currentBbox);
        applyFraming(camera, framing, makeVector3);
    }

    function pickAt(x: number, y: number): string | null {
        const pickInfo = scene.pick(x, y);
        return pickInfo.pickedMesh?.name ?? null;
    }

    // ============================================================================
    // Dispose
    // ============================================================================

    function dispose(): void {
        window.removeEventListener('resize', onWindowResize);
        sizeObserver?.disconnect();
        canvas.removeEventListener('contextmenu', handleContextMenu);
        window.removeEventListener('error', onWinError);
        window.removeEventListener('unhandledrejection', onRejection);
        canvas.removeEventListener('webglcontextlost', onCtxLost);
        canvas.removeEventListener('webglcontextrestored', onCtxRestored);
        console.debug('[engine] DISPOSED');

        disposeCurrentGeometry();
        disposeFloor();
        // engine.dispose() drops the skybox mesh + cube texture with the
        // scene; only the blob URLs need manual revocation.
        skyboxMesh = null;
        skyboxUrls.forEach(u => URL.revokeObjectURL(u));
        skyboxUrls = [];

        engine.dispose();
    }

    // ── Initial environment, from opts ──────────────────────────────────────
    if (wantGrid) setFloorMode('grid');
    if (wantSkybox) setSkyboxVisible(true);

    return {
        loadMesh,
        setSubmeshVisible,
        setIsolated,
        setWireframe,
        setSkeletonOverlay,
        setSelection,
        frameCamera,
        pickAt,
        renameSubmesh,
        setSkyboxVisible,
        setFloorMode,
        getActiveMeshes: () => meshes.slice(),
        scene,
        dispose,
    };
}
