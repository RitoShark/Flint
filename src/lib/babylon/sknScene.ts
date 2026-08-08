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
import { Vector3, Color3, Color4, Matrix } from '@babylonjs/core/Maths/math';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { SkeletonViewer } from '@babylonjs/core/Debug/skeletonViewer';
// Registers Scene.prototype.pick (tree-shaken out of core by default) — without this, pickAt throws "scene.pick is not a function".
import '@babylonjs/core/Culling/ray';

import { getBundledFloorPng, getBundledSkyboxFace } from '../api/texture';
import type { SknMeshData, ScbMeshData } from '../api/mesh';
import { createEngine } from './engine';
import { buildSknMeshes, type MeshDTO } from './meshBuilder';
import {
    buildBabylonSkeleton,
    buildSkeletonMaya,
    jointMarkerRadius,
    type BoneData,
    type SklData,
} from './skeletonBuilder';
import { computeFraming, applyFraming, type BoundingBox } from './cameraFraming';
import { attachMayaCameraControls } from './mayaCamera';

// This module must stay headless — no React, no imports from src/components/.
const makeVector3 = (x: number, y: number, z: number) => new Vector3(x, y, z);

export type SkeletonOverlayMode = 'off' | 'lines' | 'bones';
export type FloorMode = 'grid' | 'textured' | 'none';

export interface SknSceneOptions {
    grid?: boolean;
    skybox?: boolean;
    navigation?: 'default' | 'maya';
}

export interface SknSkeletonMetadata {
    boneIndexByHash: Map<number, number>;
    joints: BoneData[];
}

export interface SknSubmeshRange {
    name: string;
    startVertex: number;
    vertexCount: number;
}

export interface SurfaceHit {
    point: Vector3;
    submesh: string;
}

export interface SknSceneHandle {
    loadMesh(mesh: SknMeshData | ScbMeshData, skeleton: SklData | null): Promise<void>;
    setSubmeshVisible(name: string, visible: boolean): void;
    setIsolated(name: string | null): void;
    setWireframe(on: boolean): void;
    setSkeletonOverlay(mode: SkeletonOverlayMode): void;
    setSkeletonXray(on: boolean): void;
    setJointHighlights(active: number | null, hovered: number | null): void;
    setSelection(name: string | null): void;
    frameCamera(): void;
    pickAt(x: number, y: number): string | null;
    pickSurfaceAt(x: number, y: number): SurfaceHit | null;
    pickJointAt(x: number, y: number): number | null;
    projectRadiusToPixels(point: Vector3, worldRadius: number): number;
    renameSubmesh(oldName: string, newName: string): void;
    setSkyboxVisible(on: boolean): void;
    setFloorMode(mode: FloorMode): void;
    getActiveMeshes(): Mesh[];
    getSubmeshRanges(): SknSubmeshRange[];
    setVertexColors(colors: Float32Array | null): void;
    updateVertexColors(colors: Float32Array, submeshNames: Iterable<string>): void;
    updateSkinning(jointIds: Uint16Array, weights: Float32Array): void;
    readonly scene: Scene;
    dispose(): void;
}

function safeDisposeSkeletonViewer(ref: { current: SkeletonViewer | null }): void {
    const viewer = ref.current;
    ref.current = null;
    if (!viewer) return;
    try {
        viewer.dispose();
    } catch (e) {
        // SkeletonViewer.dispose() can throw if the WebGL context is lost or the engine is mid-teardown; swallow it so a React effect commit doesn't crash the tree.
        console.debug('[SknScene] SkeletonViewer.dispose() failed (context lost / engine torn down); ignoring', e);
    }
}

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

    const detachMayaControls = opts?.navigation === 'maya'
        ? attachMayaCameraControls(camera, canvas)
        : null;

    const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
    };
    canvas.addEventListener('contextmenu', handleContextMenu);

    const ambientLight = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
    ambientLight.intensity = 1.2;
    ambientLight.specular = new Color3(0, 0, 0);

    // Off by default — ModelPreview's lighting popup turns these on via scene.getLightByName('dirLight1'/2/3), so don't rename these lights.
    const dirLight1 = new DirectionalLight('dirLight1', new Vector3(-1, -1, -1), scene);
    dirLight1.intensity = 0.0;
    const dirLight2 = new DirectionalLight('dirLight2', new Vector3(1, 1, 1), scene);
    dirLight2.intensity = 0.0;
    const dirLight3 = new DirectionalLight('dirLight3', new Vector3(0, 1, 0), scene);
    dirLight3.intensity = 0.0;

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
    let skeletonOverlayMeshes: Mesh[] = [];
    let skeletonOverlayMode: SkeletonOverlayMode = 'off';
    let skeletonXray = false;
    let jointPickRadius = 1;
    let jointRadius = 1;
    let activeJointMarker: Mesh | null = null;
    let hoveredJointMarker: Mesh | null = null;

    let submeshRanges: SknSubmeshRange[] = [];
    const shadedMaterialByMesh = new Map<string, Material>();
    let weightMaterial: PBRMaterial | null = null;

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

    // A window resize AND a ResizeObserver (a panel-splitter drag resizes the canvas without firing window.resize). The zero-size guard prevents engine.resize() from corrupting the swapchain when the canvas is 0x0 (window minimized).
    function safeResize(): void {
        if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
        engine.resize();
    }
    const onWindowResize = () => safeResize();
    window.addEventListener('resize', onWindowResize);
    const sizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => safeResize()) : null;
    sizeObserver?.observe(canvas);

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
            skyboxLoadToken++;
            skyboxLoading = false;
            disposeSkybox();
            scene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0);
            return;
        }

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
                const faces = ['px', 'py', 'pz', 'nx', 'ny', 'nz'];
                const urls = await Promise.all(faces.map(async (f) => {
                    const bytes = await getBundledSkyboxFace(f);
                    return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'image/webp' }));
                }));
                if (scene.isDisposed || myToken !== skyboxLoadToken) { urls.forEach(u => URL.revokeObjectURL(u)); return; }
                skyboxUrls = urls;

                // Babylon's CubeTexture `files` array is consumed by index (blob URLs carry no filename), so the order must be [px, py, pz, nx, ny, nz], matching Babylon's own default extensions list.
                // Manual skybox, not scene.createDefaultSkybox — that also sets environmentTexture, which washes out the PBR model; infiniteDistance + disableDepthWrite keeps it a backdrop that can't occlude or z-fight at any zoom.
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
                if (myToken === skyboxLoadToken) skyboxLoading = false;
            }
        })();
    }

    function disposeFloor(): void {
        floorLoadToken++;
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
            gridMesh.renderingGroupId = 1;
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

                    ground.renderingGroupId = 1;
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

    function disposeSkeletonOverlay(): void {
        const box = { current: skeletonViewer };
        safeDisposeSkeletonViewer(box);
        skeletonViewer = box.current;
        skeletonOverlayMeshes.forEach(disposeMeshAndMaterial);
        skeletonOverlayMeshes = [];
        disposeMeshAndMaterial(activeJointMarker);
        activeJointMarker = null;
        disposeMeshAndMaterial(hoveredJointMarker);
        hoveredJointMarker = null;
    }

    // Rendering group 2 rather than a depth-func override: Babylon clears the depth buffer between
    // rendering groups by default, so a higher group is drawn on top of the model for free.
    function applyXrayTo(mesh: { renderingGroupId: number; material?: Material | null } | null): void {
        if (!mesh) return;
        mesh.renderingGroupId = skeletonXray ? 2 : 1;
        const mat = mesh.material as StandardMaterial | null | undefined;
        if (mat) {
            mat.disableDepthWrite = skeletonXray;
            mat.alpha = skeletonXray ? 0.9 : 1;
        }
    }

    function applyXrayToOverlay(): void {
        skeletonOverlayMeshes.forEach(applyXrayTo);
        applyXrayTo(activeJointMarker);
        applyXrayTo(hoveredJointMarker);
        const debugMesh = skeletonViewer?.debugMesh;
        if (debugMesh) applyXrayTo(debugMesh as unknown as Mesh);
    }

    function setSkeletonOverlay(mode: SkeletonOverlayMode): void {
        disposeSkeletonOverlay();
        skeletonOverlayMode = mode;

        if (mode === 'off') return;

        if (mode === 'lines') {
            if (currentSkeleton && meshes.length > 0) {
                try {
                    skeletonViewer = buildSkeletonViewer(currentSkeleton, meshes[0], scene);
                } catch (e) {
                    console.error('Failed to build skeleton viewer:', e);
                }
            }
            applyXrayToOverlay();
            return;
        }

        if (!currentSklData) return;
        try {
            const built = buildSkeletonMaya(currentSklData, scene);
            skeletonOverlayMeshes = built?.meshes ?? [];
        } catch (e) {
            console.error('Failed to build the skeleton overlay:', e);
        }
        applyXrayToOverlay();
    }

    function setSkeletonXray(on: boolean): void {
        skeletonXray = on;
        applyXrayToOverlay();
    }

    function positionJointMarker(
        existing: Mesh | null,
        name: string,
        color: Color3,
        scale: number,
        index: number | null,
    ): Mesh | null {
        const bone = index !== null ? currentSklData?.bones[index] : null;
        if (!bone || skeletonOverlayMode === 'off') {
            disposeMeshAndMaterial(existing);
            return null;
        }
        const marker = existing ?? (() => {
            const sphere = CreateSphere(name, { diameter: 2, segments: 10 }, scene);
            sphere.isPickable = false;
            const mat = new StandardMaterial(`${name}-mat`, scene);
            mat.diffuseColor = color;
            mat.specularColor = new Color3(0, 0, 0);
            mat.emissiveColor = color.scale(0.65);
            mat.backFaceCulling = false;
            sphere.material = mat;
            return sphere;
        })();
        const r = jointRadius * scale;
        marker.scaling.set(r, r, r);
        marker.position.set(...bone.world_position);
        applyXrayTo(marker);
        return marker;
    }

    function setJointHighlights(active: number | null, hovered: number | null): void {
        activeJointMarker = positionJointMarker(
            activeJointMarker,
            'skeleton-joint-active',
            new Color3(0.35, 1.0, 0.45),
            1.7,
            active,
        );
        hoveredJointMarker = positionJointMarker(
            hoveredJointMarker,
            'skeleton-joint-hovered',
            new Color3(1.0, 0.85, 0.25),
            1.4,
            hovered === active ? null : hovered,
        );
    }

    function disposeCurrentGeometry(): void {
        // Puts each mesh's own material back first, or the loop below disposes the shared weight
        // material N times and leaks every textured material it was standing in for.
        setVertexColors(null);

        // Texture cache is disposed before meshes/materials; this double-disposes any texture also referenced via mat.albedoTexture, which Babylon tolerates safely.
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
        submeshRanges = [];
        shadedMaterialByMesh.clear();
        weightMaterial?.dispose();
        weightMaterial = null;

        if (currentSkeleton) {
            currentSkeleton.dispose();
            currentSkeleton = null;
        }
        currentSklData = null;
        disposeSkeletonOverlay();
    }

    // Deliberately not `async`: a plain function throws synchronously to its caller, while an async function would turn it into a rejected promise on a later microtask — letting a sibling effect run before these meshes exist.
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
        // Rendering group 1 so the model always draws after (on top of) the skybox in group 0 — otherwise the skybox box can paint over the whole model.
        for (const m of meshes) {
            m.renderingGroupId = 1;
            meshByName.set(m.name, m);
        }
        submeshRanges = meshDto.submeshes.map((s) => ({
            name: s.name,
            startVertex: s.start_vertex,
            vertexCount: s.vertex_count,
        }));

        if (skeleton && skeleton.bones.length > 0) {
            jointRadius = jointMarkerRadius(skeleton.bones);
            // ~2.5× the drawn marker, so hovering a joint doesn't need pixel precision.
            jointPickRadius = Math.max(0.1, jointRadius * 2.5);
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
                    texture.hasAlpha = !!data.has_alpha;

                    // The offset/flipbook transforms this used to apply clashed with the PNG loader's V-flip on authored-UV materials; plain tiling matches the reference viewer, and real UV manipulation renders through the game-shaders pass instead.
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
                    // Cutoff + per-fragment blend keeps feathered edges (hair/cape); the depth pre-pass writes cutoff'd depth first so overlapping parts don't sort into black silhouettes.
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

        currentBbox = meshData.bounding_box as BoundingBox;
        const framing = computeFraming(currentBbox);
        applyFraming(camera, framing, makeVector3);
        console.debug(
            `[MeshPreview] camera: radius=${framing.radius.toFixed(3)} ` +
            `target=(${framing.center.map((n) => n.toFixed(2)).join(',')})`
        );

        // loadMesh does not reapply a previous skeleton-overlay mode — the caller must call setSkeletonOverlay again after a fresh load.
        return Promise.resolve();
    }

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
        const range = submeshRanges.find((r) => r.name === oldName);
        if (range) range.name = newName;
        const shaded = shadedMaterialByMesh.get(oldName);
        if (shaded) {
            shadedMaterialByMesh.delete(oldName);
            shadedMaterialByMesh.set(newName, shaded);
        }
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

    function pickSurfaceAt(x: number, y: number): SurfaceHit | null {
        const pickInfo = scene.pick(x, y, (m) => m.isEnabled() && meshByName.has(m.name));
        if (!pickInfo?.hit || !pickInfo.pickedPoint || !pickInfo.pickedMesh) return null;
        return { point: pickInfo.pickedPoint.clone(), submesh: pickInfo.pickedMesh.name };
    }

    // Ray-vs-point against the bind-pose joint positions rather than GPU picking: it is exact against
    // what the overlay draws, needs no proxy geometry, and 200 joints is nothing on the CPU.
    function pickJointAt(x: number, y: number): number | null {
        if (skeletonOverlayMode === 'off' || !currentSklData) return null;
        const bones = currentSklData.bones;
        if (bones.length === 0) return null;

        const ray = scene.createPickingRay(x, y, Matrix.Identity(), camera);
        const r2 = jointPickRadius * jointPickRadius;
        let best = -1;
        let bestDistanceAlongRay = Infinity;

        for (let i = 0; i < bones.length; i++) {
            const [px, py, pz] = bones[i].world_position;
            if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
            const dx = px - ray.origin.x;
            const dy = py - ray.origin.y;
            const dz = pz - ray.origin.z;
            const along = dx * ray.direction.x + dy * ray.direction.y + dz * ray.direction.z;
            if (along < 0) continue;
            const perpX = dx - ray.direction.x * along;
            const perpY = dy - ray.direction.y * along;
            const perpZ = dz - ray.direction.z * along;
            if (perpX * perpX + perpY * perpY + perpZ * perpZ > r2) continue;
            if (along < bestDistanceAlongRay) {
                bestDistanceAlongRay = along;
                best = i;
            }
        }
        return best >= 0 ? best : null;
    }

    function projectRadiusToPixels(point: Vector3, worldRadius: number): number {
        const view = scene.getViewMatrix();
        const projection = scene.getProjectionMatrix();
        const viewport = camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
        const centre = Vector3.Project(point, Matrix.Identity(), view.multiply(projection), viewport);
        const right = camera.getDirection(Vector3.Right()).scale(worldRadius).addInPlace(point);
        const edge = Vector3.Project(right, Matrix.Identity(), view.multiply(projection), viewport);
        return Math.hypot(edge.x - centre.x, edge.y - centre.y) / engine.getHardwareScalingLevel();
    }

    function ensureWeightMaterial(): PBRMaterial {
        if (weightMaterial) return weightMaterial;
        const mat = new PBRMaterial('weight-paint-mat', scene);
        mat.unlit = true;
        mat.albedoColor = new Color3(1, 1, 1);
        mat.metallic = 0;
        mat.roughness = 1;
        mat.environmentIntensity = 0;
        mat.backFaceCulling = false;
        mat.transparencyMode = Material.MATERIAL_OPAQUE;
        weightMaterial = mat;
        return mat;
    }

    function writeSubmeshColors(mesh: Mesh, range: SknSubmeshRange, colors: Float32Array, update: boolean): void {
        const slice = new Float32Array(range.vertexCount * 4);
        slice.set(colors.subarray(range.startVertex * 4, (range.startVertex + range.vertexCount) * 4));
        if (update && mesh.isVerticesDataPresent(VertexBuffer.ColorKind)) {
            mesh.updateVerticesData(VertexBuffer.ColorKind, slice);
        } else {
            mesh.setVerticesData(VertexBuffer.ColorKind, slice, true, 4);
        }
    }

    function setVertexColors(colors: Float32Array | null): void {
        if (!colors) {
            for (const mesh of meshes) {
                mesh.useVertexColors = false;
                const original = shadedMaterialByMesh.get(mesh.name);
                if (original) mesh.material = original;
            }
            shadedMaterialByMesh.clear();
            return;
        }

        const weightMat = ensureWeightMaterial();
        weightMat.wireframe = currentWireframe;
        for (let i = 0; i < meshes.length; i++) {
            const mesh = meshes[i];
            const range = submeshRanges[i];
            if (!range) continue;
            if (mesh.material && mesh.material !== weightMat && !shadedMaterialByMesh.has(mesh.name)) {
                shadedMaterialByMesh.set(mesh.name, mesh.material);
            }
            writeSubmeshColors(mesh, range, colors, false);
            mesh.useVertexColors = true;
            mesh.material = weightMat;
        }
    }

    function updateVertexColors(colors: Float32Array, submeshNames: Iterable<string>): void {
        const wanted = new Set(submeshNames);
        for (let i = 0; i < meshes.length; i++) {
            const range = submeshRanges[i];
            if (!range || !wanted.has(range.name)) continue;
            writeSubmeshColors(meshes[i], range, colors, true);
        }
    }

    // jointIds carry the SKL joint id, matching the matricesIndices convention meshBuilder writes.
    function updateSkinning(jointIds: Uint16Array, weights: Float32Array): void {
        for (let i = 0; i < meshes.length; i++) {
            const mesh = meshes[i];
            const range = submeshRanges[i];
            if (!range || !mesh.isVerticesDataPresent(VertexBuffer.MatricesIndicesKind)) continue;
            const from = range.startVertex * 4;
            const to = from + range.vertexCount * 4;
            const indexSlice = new Float32Array(range.vertexCount * 4);
            for (let k = from; k < to; k++) indexSlice[k - from] = jointIds[k];
            mesh.updateVerticesData(VertexBuffer.MatricesIndicesKind, indexSlice);
            mesh.updateVerticesData(VertexBuffer.MatricesWeightsKind, weights.slice(from, to));
        }
    }


    function dispose(): void {
        window.removeEventListener('resize', onWindowResize);
        sizeObserver?.disconnect();
        detachMayaControls?.();
        canvas.removeEventListener('contextmenu', handleContextMenu);
        window.removeEventListener('error', onWinError);
        window.removeEventListener('unhandledrejection', onRejection);
        canvas.removeEventListener('webglcontextlost', onCtxLost);
        canvas.removeEventListener('webglcontextrestored', onCtxRestored);
        console.debug('[engine] DISPOSED');

        disposeCurrentGeometry();
        disposeFloor();
        // engine.dispose() drops the skybox mesh + cube texture with the scene; only the blob URLs need manual revocation.
        skyboxMesh = null;
        skyboxUrls.forEach(u => URL.revokeObjectURL(u));
        skyboxUrls = [];

        engine.dispose();
    }

    if (wantGrid) setFloorMode('grid');
    if (wantSkybox) setSkyboxVisible(true);

    return {
        loadMesh,
        setSubmeshVisible,
        setIsolated,
        setWireframe,
        setSkeletonOverlay,
        setSkeletonXray,
        setJointHighlights,
        setSelection,
        frameCamera,
        pickAt,
        pickSurfaceAt,
        pickJointAt,
        projectRadiusToPixels,
        renameSubmesh,
        setSkyboxVisible,
        setFloorMode,
        getActiveMeshes: () => meshes.slice(),
        getSubmeshRanges: () => submeshRanges.slice(),
        setVertexColors,
        updateVertexColors,
        updateSkinning,
        scene,
        dispose,
    };
}
