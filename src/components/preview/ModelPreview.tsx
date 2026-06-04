/**
 * Flint - ModelPreview Component
 * 3D preview for SKN mesh files using Babylon.js and client-side animation playback.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { Bone } from '@babylonjs/core/Bones/bone';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { SkeletonViewer } from '@babylonjs/core/Debug/skeletonViewer';

import * as api from '../../lib/api';
import { useAppMetadataStore } from '../../lib/stores';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { deferCleanup } from '../../lib/ui-helpers/deferCleanup';

// Import our custom Babylon wrappers
import { createEngine } from '../../lib/babylon/engine';
import { buildSknMeshes, type MeshDTO } from '../../lib/babylon/meshBuilder';
import { buildBabylonSkeleton, type BoneData } from '../../lib/babylon/skeletonBuilder';
import { AnimationPlayer } from '../../lib/babylon/animationPlayer';

// ============================================================================
// Types
// ============================================================================

type SknMeshData = api.SknMeshData;
type ScbMeshData = api.ScbMeshData;
type MeshData = SknMeshData | ScbMeshData;

interface ModelPreviewProps {
    filePath: string;
    meshType?: 'skinned' | 'static';  // skinned = SKN, static = SCB/SCO
}

// ============================================================================
// Main Component
// ============================================================================

// Settings persistence key
const SETTINGS_KEY = 'flint-model-preview-settings';

// Load settings from localStorage
const loadSettings = () => {
    try {
        const saved = localStorage.getItem(SETTINGS_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch {
        // Ignore parse errors
    }
    return {
        wireframe: false,
        showSkybox: true,
        floorMode: 'grid',
        ambientIntensity: 0.8,
        directionalIntensity: 1.5,
        showSkeleton: true,
        customizeLighting: false,
    };
};

export const ModelPreview: React.FC<ModelPreviewProps> = ({ filePath, meshType = 'skinned' }) => {
    const [meshData, setMeshData] = useState<MeshData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Load persisted settings
    const savedSettings = useMemo(() => loadSettings(), []);
    const [wireframe, setWireframe] = useState(savedSettings.wireframe);
    const [visibleMaterials, setVisibleMaterials] = useState<Set<string>>(new Set());

    // Environment controls (persisted)
    const [showSkybox, setShowSkybox] = useState(savedSettings.showSkybox);
    const [floorMode, setFloorMode] = useState<'grid' | 'textured' | 'none'>(savedSettings.floorMode);
    const [ambientIntensity, setAmbientIntensity] = useState(savedSettings.ambientIntensity);
    const [directionalIntensity, setDirectionalIntensity] = useState(savedSettings.directionalIntensity);
    const [customizeLighting, setCustomizeLighting] = useState(savedSettings.customizeLighting ?? false);

    // Popup states for controls
    const [activePopup, setActivePopup] = useState<'display' | 'environment' | 'materials' | 'animations' | null>(null);

    // Subscribe to file version changes for hot reload
    const fileVersion = useAppMetadataStore((state) => {
        void state.fileVersionsRev;
        return state.getFileVersion(filePath);
    });

    // Animation state (only for skinned meshes)
    const [animations, setAnimations] = useState<{ name: string; animation_path: string }[]>([]);
    const [selectedAnimation, setSelectedAnimation] = useState<string>('');
    const [isPlaying, setIsPlaying] = useState(false);

    // Animation playback state
    const [animationData, setAnimationData] = useState<{ duration: number; fps: number; joint_count: number; joint_hashes: number[] } | null>(null);
    const [currentTime, setCurrentTime] = useState(0);

    // Skeleton state (only for skinned meshes, persisted)
    const [skeletonData, setSkeletonData] = useState<any | null>(null);
    const [showSkeleton, setShowSkeleton] = useState(savedSettings.showSkeleton);

    // Texture preview state
    const [hoveredMaterial, setHoveredMaterial] = useState<string | null>(null);
    const [previewPosition, setPreviewPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

    // Babylon.js refs & states
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [scene, setScene] = useState<Scene | null>(null);
    const [camera, setCamera] = useState<ArcRotateCamera | null>(null);

    const activeMeshesRef = useRef<Mesh[]>([]);
    const skeletonRef = useRef<Skeleton | null>(null);
    const skeletonViewerRef = useRef<SkeletonViewer | null>(null);
    const gridMeshRef = useRef<any>(null);
    const floorMeshRef = useRef<any>(null);

    // Animation player refs
    const animationPlayerRef = useRef<AnimationPlayer | null>(null);
    const lastTimeRef = useRef<number>(0);
    const lastReactTimeRef = useRef<number>(0);

    const builtSklRef = useRef<{
        boneIndexByHash: Map<number, number>;
        bones: Bone[];
        joints: BoneData[];
    } | null>(null);

    // Initialize engine & scene when canvas is available
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const engine = createEngine(canvas);
        const activeScene = new Scene(engine);
        setScene(activeScene);

        // Default scene clearColor matching the app background
        activeScene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0); // #1b1b1b

        // Set up orbital camera
        const activeCamera = new ArcRotateCamera(
            "camera",
            Math.PI / 2 + Math.PI / 8, // Face front of model (tilted slightly like Jade)
            Math.PI / 3,
            5,
            Vector3.Zero(),
            activeScene
        );
        activeCamera.panningSensibility = 100; // Sensibility of panning (lower value is faster)
        activeCamera.attachControl(canvas, true);
        activeCamera.wheelDeltaPercentage = 0.05; // smooth percentage zoom
        setCamera(activeCamera);

        // Prevent default browser context menu to allow panning via right click drag
        const handleContextMenu = (e: MouseEvent) => {
            e.preventDefault();
        };
        canvas.addEventListener('contextmenu', handleContextMenu);

        // Set up lighting (Jade-style soft/unlit default, customizable if checked)
        const ambientLight = new HemisphericLight("ambient", new Vector3(0, 1, 0), activeScene);
        ambientLight.intensity = customizeLighting ? ambientIntensity : 1.2;
        ambientLight.specular = new Color3(0, 0, 0);

        const dirLight1 = new DirectionalLight("dirLight1", new Vector3(-1, -1, -1), activeScene);
        dirLight1.intensity = customizeLighting ? directionalIntensity : 0.0;

        const dirLight2 = new DirectionalLight("dirLight2", new Vector3(1, 1, 1), activeScene);
        dirLight2.intensity = customizeLighting ? directionalIntensity * 0.4 : 0.0;

        const dirLight3 = new DirectionalLight("dirLight3", new Vector3(0, 1, 0), activeScene);
        dirLight3.intensity = customizeLighting ? directionalIntensity * 0.3 : 0.0;

        // Render loop
        engine.runRenderLoop(() => {
            if (animationPlayerRef.current) {
                const now = performance.now();
                if (lastTimeRef.current !== 0) {
                    const dt = (now - lastTimeRef.current) / 1000;
                    animationPlayerRef.current.tick(dt);

                    // Throttle state update so the React timeline slider moves smoothly without lagging the UI
                    const curTime = animationPlayerRef.current.time;
                    const rounded = Math.round(curTime * 100) / 100;
                    if (Math.abs(rounded - lastReactTimeRef.current) >= 0.05) {
                        lastReactTimeRef.current = rounded;
                        setCurrentTime(curTime);
                    }
                }
                lastTimeRef.current = now;
            }
            activeScene.render();
        });

        // Resize handler
        const handleResize = () => {
            engine.resize();
        };
        window.addEventListener('resize', handleResize);

        // Store cleanup on canvas ref to matches old contract
        (canvas as any)._flintCleanup = () => {
            window.removeEventListener('resize', handleResize);
            canvas.removeEventListener('contextmenu', handleContextMenu);

            if (skeletonViewerRef.current) {
                skeletonViewerRef.current.dispose();
                skeletonViewerRef.current = null;
            }

            activeMeshesRef.current.forEach(m => {
                if (m.material) {
                    const mat = m.material as PBRMaterial;
                    if (mat.albedoTexture) mat.albedoTexture.dispose();
                    mat.dispose();
                }
                m.dispose();
            });
            activeMeshesRef.current = [];

            if (skeletonRef.current) {
                skeletonRef.current.dispose();
                skeletonRef.current = null;
            }

            if (gridMeshRef.current) {
                gridMeshRef.current.dispose();
                gridMeshRef.current = null;
            }

            if (floorMeshRef.current) {
                if (floorMeshRef.current.material) {
                    floorMeshRef.current.material.dispose();
                }
                floorMeshRef.current.dispose();
                floorMeshRef.current = null;
            }

            engine.dispose();
        };

        return () => {
            const cleanup = canvas && (canvas as any)._flintCleanup;
            if (cleanup) {
                delete (canvas as any)._flintCleanup;
                // Defer GPU teardown so closing a project that had a 3D
                // preview open returns the UI immediately. The engine +
                // meshes + textures get disposed on the next idle slot.
                deferCleanup(cleanup);
            }
            setScene(null);
            setCamera(null);
        };
        // Engine + scene + camera set up once per component mount. Reloading
        // a new file path mutates the existing scene instead of tearing down
        // and recreating the WebGL context.
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Load mesh data
    useEffect(() => {
        let cancelled = false;

        const loadMesh = async () => {
            setLoading(true);
            setError(null);
            setAnimations([]);
            setSkeletonData(null);
            // Reset per-file state — previously handled by remounting via
            // key={filePath} on the parent, which also tore down the engine.
            setSelectedAnimation('');
            setActivePopup(null);
            setMeshData(null);

            try {
                let data: MeshData;

                if (meshType === 'static') {
                    data = await api.readScbMesh(filePath);
                } else {
                    const sklPath = filePath.replace(/\.skn$/i, '.skl');

                    const [meshResult, animResult, sklResult] = await Promise.allSettled([
                        api.readSknMesh(filePath),
                        api.readAnimationList(filePath),
                        api.readSklSkeleton(sklPath)
                    ]);

                    if (meshResult.status === 'fulfilled') {
                        data = meshResult.value;
                    } else {
                        throw meshResult.reason;
                    }

                    if (cancelled) return;

                    if (animResult.status === 'fulfilled') {
                        const animList = animResult.value;
                        if (animList.clips && animList.clips.length > 0) {
                            setAnimations(animList.clips);
                        }
                    }

                    if (sklResult.status === 'fulfilled') {
                        setSkeletonData(sklResult.value);
                    }
                }

                if (cancelled) return;

                setMeshData(data);

                if (data.kind === 'skn') {
                    setVisibleMaterials(new Set((data as SknMeshData).materials.map(m => m.name)));
                } else {
                    setVisibleMaterials(new Set((data as ScbMeshData).materials));
                }
            } catch (err) {
                if (cancelled) return;
                setError((err as Error).message || 'Failed to load mesh');
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        loadMesh();
        return () => { cancelled = true; };
    }, [filePath, meshType, fileVersion]);

    // Build/Rebuild mesh, skeleton & materials in the scene
    useEffect(() => {
        if (!scene || !camera || !meshData) return;

        // Tear down previous mesh assets
        if (skeletonViewerRef.current) {
            skeletonViewerRef.current.dispose();
            skeletonViewerRef.current = null;
        }

        activeMeshesRef.current.forEach(m => {
            if (m.material) {
                const mat = m.material as PBRMaterial;
                if (mat.albedoTexture) mat.albedoTexture.dispose();
                mat.dispose();
            }
            m.dispose();
        });
        activeMeshesRef.current = [];

        if (skeletonRef.current) {
            skeletonRef.current.dispose();
            skeletonRef.current = null;
        }
        builtSklRef.current = null;
        animationPlayerRef.current = null;

        // 1. Build Babylon Skeleton if rigged
        let babylonSkeleton: Skeleton | undefined;
        if (skeletonData) {
            const built = buildBabylonSkeleton(skeletonData, scene, "skeleton");
            babylonSkeleton = built.skeleton;
            skeletonRef.current = babylonSkeleton;
            builtSklRef.current = {
                boneIndexByHash: built.boneIndexByHash,
                bones: built.bones,
                joints: built.joints
            };
        }

        // 2. Map mesh fields to MeshDTO
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
                    index_count: m.index_count
                }))
                : (meshData as ScbMeshData).materials.map(matName => {
                    const scb = meshData as ScbMeshData;
                    const range = scb.material_ranges?.[matName] || [0, scb.indices.length];
                    return {
                        name: matName,
                        start_vertex: 0,
                        vertex_count: scb.positions.length / 3,
                        start_index: range[0],
                        index_count: range[1]
                    };
                }),
            bbox: meshData.bounding_box
        };

        // 3. Build meshes
        const influences = skeletonData?.influences;

        // ── DIAGNOSTIC: dump the exact payload handed to Babylon so a broken
        // render is visible in the app log (console.* is forwarded to the store).
        console.log(
            `[MeshPreview] build ${meshData.kind}: ` +
            `pos=${meshData.positions?.length}(${(meshData.positions?.length ?? 0) / 3}v) ` +
            `idx=${meshData.indices?.length} uv=${meshData.uvs?.length} nrm=${meshData.normals?.length} ` +
            `bbox=${JSON.stringify(meshData.bounding_box)} skel=${!!babylonSkeleton} ` +
            `submeshes=${meshDto.submeshes.length}[${meshDto.submeshes.map(s => `${s.name}:v${s.start_vertex}+${s.vertex_count}/i${s.start_index}+${s.index_count}`).join('; ')}]`
        );

        // Guard the geometry build: a throw here used to bubble up and crash the
        // whole React render → engine teardown → blank canvas. Now it's logged and
        // contained (old meshes already disposed → scene keeps the floor + error).
        let meshes: ReturnType<typeof buildSknMeshes>['meshes'];
        try {
            meshes = buildSknMeshes(meshDto, scene, babylonSkeleton, influences).meshes;
            console.log(`[MeshPreview] buildSknMeshes OK → ${meshes.length} mesh(es)`);
        } catch (err) {
            console.error(`[MeshPreview] buildSknMeshes THREW (${meshData.kind}):`, err);
            setError(`Mesh build failed: ${(err as Error)?.message ?? String(err)}`);
            return;
        }
        activeMeshesRef.current = meshes;

        // 4. Create base64 texture maps
        const textureCache = new Map<string, Texture>();
        const matData = meshData.material_data;
        if (matData && Object.keys(matData).length > 0) {
            for (const [matName, data] of Object.entries(matData)) {
                try {
                    const dataUrl = "data:image/png;base64," + data.texture;
                    // Load texture with invertY = true to match V-flipped UV coordinates
                    const texture = new Texture(dataUrl, scene, false, true);
                    texture.wrapU = Texture.WRAP_ADDRESSMODE;
                    texture.wrapV = Texture.WRAP_ADDRESSMODE;
                    texture.hasAlpha = false; // Force texture to be opaque

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
                    console.error("Failed to decode base64 texture for:", matName, e);
                }
            }
        } else if (isSkn && (meshData as SknMeshData).textures) {
            const textures = (meshData as SknMeshData).textures!;
            for (const [matName, base64Data] of Object.entries(textures)) {
                try {
                    const dataUrl = "data:image/png;base64," + base64Data;
                    // Load texture with invertY = true to match V-flipped UV coordinates
                    const texture = new Texture(dataUrl, scene, false, true);
                    texture.wrapU = Texture.WRAP_ADDRESSMODE;
                    texture.wrapV = Texture.WRAP_ADDRESSMODE;
                    texture.hasAlpha = false; // Force texture to be opaque
                    textureCache.set(matName, texture);
                } catch (e) {
                    console.error("Failed to decode base64 texture fallback for:", matName, e);
                }
            }
        }

        // 5. Apply materials with fuzzy matching
        console.log(
            `[MeshPreview] visibleMaterials(${visibleMaterials.size})=[${[...visibleMaterials].map(x => `'${x}'`).join(', ')}] ` +
            `textureCacheKeys=[${[...textureCache.keys()].map(x => `'${x}'`).join(', ')}] ` +
            `meshNames=[${meshes.map(m => `'${m.name}'`).join(', ')}]`
        );
        meshes.forEach(m => {
            const matName = m.name;

            let texture = textureCache.get(matName);
            if (!texture && matName.startsWith("mesh_")) {
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

            // ─────────────────────────────────────────────────────────────
            // IMPORTANT: Use PBRMaterial with unlit=true — this is the ONLY
            // correct way to render League SKN models in Babylon.js.
            //
            // WHY unlit=true MUST NEVER BE REMOVED:
            //   Jade (the reference viewer) sets mat.unlit = true by default.
            //   League models are authored for a flat / toon-shaded look. Any
            //   lighting calculation applied on top of the albedo texture makes
            //   the model look washed-out, darkened, or otherwise wrong.
            //
            //   PBR without unlit=true also uses normals for shading — and even
            //   after ComputeNormals the per-vertex smoothed normals of a League
            //   mesh don't look right under a PBR lighting model.
            //
            //   The "Customize Lighting" checkbox in the Environment panel only
            //   controls the scene lights' intensities — it does NOT, and SHOULD
            //   NOT, change unlit on these materials. DO NOT add shadingEnabled
            //   or similar logic here. If you want a lit mode, gate it behind an
            //   explicit user setting and keep unlit=true as the hard default.
            // ─────────────────────────────────────────────────────────────
            const mat = new PBRMaterial(matName + "_material", scene);
            mat.unlit = true;              // ← MUST stay true. See warning above.
            mat.twoSidedLighting = true;
            mat.metallic = 0;
            mat.roughness = 1;
            mat.environmentIntensity = 0;  // kill env irradiance, not needed for unlit
            mat.needDepthPrePass = false;
            mat.wireframe = wireframe;

            if (!isSkn) {
                // SCB/SCO static meshes are simple geometry whose base texture is
                // often one-sided / transparent — a texture that fails to load or
                // covers only one winding leaves whole faces invisible. By design,
                // ignore the texture entirely and render an OPAQUE, DOUBLE-SIDED
                // solid red so the full shape is always visible regardless of
                // winding or alpha. (User choice: red over a texture gamble.)
                mat.albedoColor = new Color3(0.6, 0, 0);
                mat.albedoTexture = null;
                mat.backFaceCulling = false;
                mat.useAlphaFromAlbedoTexture = false;
                mat.transparencyMode = Material.MATERIAL_OPAQUE;
                mat.alpha = 1;
            } else if (texture) {
                mat.backFaceCulling = true;
                texture.hasAlpha = false;
                mat.albedoTexture = texture;
                mat.albedoColor = new Color3(1, 1, 1);
                mat.useAlphaFromAlbedoTexture = false;
                mat.transparencyMode = Material.MATERIAL_OPAQUE;
            } else {
                mat.backFaceCulling = true;
                mat.albedoColor = new Color3(1, 0, 1); // magenta — no texture found
            }

            m.material = mat;
            const willEnable = visibleMaterials.has(matName);
            m.setEnabled(willEnable);
            console.log(
                `[MeshPreview] applyMat mesh='${matName}' textureFound=${!!texture} ` +
                `visibleMaterials.has('${matName}')=${willEnable} -> setEnabled(${willEnable}) ` +
                `=> isEnabled=${m.isEnabled()} albedo=${texture ? 'tex' : 'MAGENTA(no-tex)'}`
            );
        });

        // ── DIAGNOSTIC: dump the ACTUAL runtime state of every built mesh AFTER
        // material + enable. This is the ground truth — if a mesh is invisible,
        // exactly one of these fields explains why (disabled, 0 verts, off-screen,
        // alpha 0, scaled to 0, or culled).
        meshes.forEach((m, i) => {
            const bi = m.getBoundingInfo();
            const bb = bi.boundingBox;
            const mat = m.material as PBRMaterial | null;
            console.log(
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

        // 6. Camera centering using bounding box.
        //
        // Guard against a degenerate/empty/inverted box. A mesh the parser returns
        // with zero vertices (common for tiny particle assets) yields an INVERTED
        // box on the Rust side — `min = f32::MAX, max = f32::MIN` — so `max - min`
        // is negative/NaN. Unguarded, that drives `camera.radius` to 0/negative/NaN,
        // which collapses the ArcRotateCamera and renders nothing but the background
        // ("only the skybox, floor gone"). Jade's MeshPreview guards the same framing
        // with `Math.max(...) || 5` and derives the box from the built mesh (never
        // inverted); we reject a non-finite or inverted box, then clamp.
        let [[minX, minY, minZ], [maxX, maxY, maxZ]] = meshData.bounding_box;
        const boxValid =
            [minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite) &&
            maxX >= minX && maxY >= minY && maxZ >= minZ;
        if (!boxValid) {
            minX = minY = minZ = -1;
            maxX = maxY = maxZ = 1;
        }
        const center = new Vector3(
            (minX + maxX) / 2,
            (minY + maxY) / 2,
            (minZ + maxZ) / 2
        );
        // Clamp to a positive minimum so tiny/zero-size meshes keep a usable radius
        // (mirrors Jade's `|| 5` fallback).
        const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.01) || 5;

        camera.target = center;
        camera.radius = size * 2;
        camera.lowerRadiusLimit = size * 0.1;
        camera.upperRadiusLimit = size * 10.0;
        camera.panningSensibility = 8000 / Math.max(camera.radius, 0.001); // guard divide-by-zero
        camera.alpha = Math.PI / 2 + Math.PI / 8; // Face front of model (tilted slightly like Jade)
        camera.beta = Math.PI / 3;
        console.log(
            `[MeshPreview] camera: boxValid=${boxValid} size=${size.toFixed(3)} ` +
            `radius=${camera.radius.toFixed(3)} target=(${center.x.toFixed(2)},${center.y.toFixed(2)},${center.z.toFixed(2)})`
        );

        // 7. Setup SkeletonViewer if active
        if (showSkeleton && babylonSkeleton && meshes.length > 0) {
            try {
                const viewer = new SkeletonViewer(
                    babylonSkeleton,
                    meshes[0],
                    scene,
                    true,
                    3,
                    {
                        displayMode: SkeletonViewer.DISPLAY_LINES,
                    }
                );
                viewer.isEnabled = true;
                skeletonViewerRef.current = viewer;
            } catch (e) {
                console.error("Failed to build skeleton viewer:", e);
            }
        }

        return () => {
            textureCache.forEach(tex => tex.dispose());
        };
    }, [scene, camera, meshData, skeletonData]);

    // Load animation when selection changes
    useEffect(() => {
        if (!selectedAnimation) {
            setAnimationData(null);
            setCurrentTime(0);
            animationPlayerRef.current = null;
            return;
        }

        const loadAnimation = async () => {
            try {
                const animData = await api.readAnimation(selectedAnimation, filePath);
                setAnimationData(animData as any);
                setCurrentTime(0);

                if (skeletonRef.current && builtSklRef.current) {
                    const { boneIndexByHash, bones, joints } = builtSklRef.current;
                    const player = new AnimationPlayer(
                        animData as any,
                        boneIndexByHash,
                        bones,
                        joints
                    );
                    player.paused = !isPlaying;
                    animationPlayerRef.current = player;
                    lastTimeRef.current = performance.now();
                }
            } catch (err) {
                console.error("Failed to load animation:", err);
                setAnimationData(null);
                animationPlayerRef.current = null;
            }
        };

        loadAnimation();
    }, [selectedAnimation, filePath]);

    // Playback state synchronization
    useEffect(() => {
        if (animationPlayerRef.current) {
            animationPlayerRef.current.paused = !isPlaying;
            if (isPlaying) {
                lastTimeRef.current = performance.now();
            }
        }
    }, [isPlaying]);

    // Slider manual updates
    const handleSliderChange = (val: number) => {
        setCurrentTime(val);
        if (animationPlayerRef.current) {
            animationPlayerRef.current.time = val;
            animationPlayerRef.current.tick(0); // force update pose on frame
        }
    };

    // Floor mode toggles
    useEffect(() => {
        if (!scene) return;

        if (gridMeshRef.current) {
            gridMeshRef.current.dispose();
            gridMeshRef.current = null;
        }
        if (floorMeshRef.current) {
            if (floorMeshRef.current.material) {
                floorMeshRef.current.material.dispose();
            }
            floorMeshRef.current.dispose();
            floorMeshRef.current = null;
        }

        if (floorMode === 'grid') {
            const gridLines: Vector3[][] = [];
            const gridColors: Color4[][] = [];
            const size = 1000;
            const step = 20;
            const color = new Color4(0.29, 0.29, 0.29, 1.0); // #4a4a4a
            for (let i = -size; i <= size; i += step) {
                gridLines.push([new Vector3(i, 0, -size), new Vector3(i, 0, size)]);
                gridLines.push([new Vector3(-size, 0, i), new Vector3(size, 0, i)]);
                gridColors.push([color, color], [color, color]);
            }
            gridMeshRef.current = CreateLineSystem("grid", { lines: gridLines, colors: gridColors, useVertexAlpha: false }, scene);
            gridMeshRef.current.isPickable = false;
        } else if (floorMode === 'textured') {
            let isMounted = true;

            const loadFloor = async () => {
                try {
                    const pngBytes = await api.getBundledFloorPng();
                    // Bail if this effect was torn down OR the scene was disposed
                    // (fast file switches remount the whole component + scene).
                    if (!isMounted || scene.isDisposed) return;

                    const blob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' });
                    const objectUrl = URL.createObjectURL(blob);

                    const ground = CreateGround("ground", { width: 1500, height: 1500 }, scene);
                    ground.isPickable = false;
                    // Sit a hair below y=0 so flat particle SCBs (bbox y=[0,0])
                    // that lie exactly on the floor plane can't occlude/z-fight it.
                    ground.position.y = -2;
                    const mat = new StandardMaterial("ground-mat", scene);
                    mat.backFaceCulling = false; // visible from any orbit angle

                    // CRITICAL: revoke the blob URL only AFTER the image has been
                    // pulled into the GPU texture — NEVER in the effect cleanup.
                    // Revoking while the <img> is still fetching the blob aborts the
                    // load and the floor renders blank until a manual reload. The
                    // old code revoked in cleanup, which fires mid-load on fast SCB
                    // switches / StrictMode remounts → intermittent missing floor.
                    const tex = new Texture(
                        objectUrl, scene, undefined, undefined, undefined,
                        () => {
                            URL.revokeObjectURL(objectUrl);
                            console.log('[floor] ground texture loaded (url revoked)');
                        },
                        (msg, ex) => {
                            URL.revokeObjectURL(objectUrl);
                            console.error('[floor] ground texture FAILED to load:', msg, ex);
                        },
                    );
                    mat.diffuseTexture = tex;
                    mat.specularColor = new Color3(0, 0, 0);
                    ground.material = mat;

                    floorMeshRef.current = ground;
                    console.log(`[floor] ground created (scene meshes=${scene.meshes.length})`);

                    // ── DECISIVE DIAGNOSTIC: dump EVERY mesh actually in the scene
                    // on the next rendered frame. If the floor is "loaded but
                    // invisible", this says whether 'ground' is present+enabled+
                    // visible (→ occlusion/material) or missing (→ disposed).
                    scene.onAfterRenderObservable.addOnce(() => {
                        const dump = scene.meshes.map(mm => {
                            const mm2 = mm as any;
                            return `${mm.name}{en=${mm.isEnabled()},vis=${mm.isVisible},a=${mm.visibility},y=${mm.position.y.toFixed(1)},` +
                                `verts=${mm.getTotalVertices()},mat=${mm2.material?.getClassName?.() ?? mm2.material?.name ?? 'none'}}`;
                        });
                        const cam = scene.activeCamera as any;
                        console.log(
                            `[floor] AFTER-RENDER scene.meshes(${scene.meshes.length})=[${dump.join(', ')}] ` +
                            `cam.radius=${cam?.radius?.toFixed?.(1)} cam.minZ=${cam?.minZ} cam.maxZ=${cam?.maxZ} ` +
                            `clearColor=(${scene.clearColor.r.toFixed(2)},${scene.clearColor.g.toFixed(2)},${scene.clearColor.b.toFixed(2)})`
                        );
                    });
                } catch (e) {
                    console.error("Failed to load textured floor:", e);
                }
            };
            loadFloor();
            return () => { isMounted = false; };
        }
    }, [scene, floorMode]);

    // Ambient light controls
    useEffect(() => {
        if (!scene) return;

        const ambient = scene.getLightByName("ambient");
        if (ambient) {
            ambient.intensity = customizeLighting ? ambientIntensity : 1.2;
        }
    }, [scene, ambientIntensity, customizeLighting]);

    // Directional lights controls
    useEffect(() => {
        if (!scene) return;

        const dir1 = scene.getLightByName("dirLight1");
        const dir2 = scene.getLightByName("dirLight2");
        const dir3 = scene.getLightByName("dirLight3");
        if (dir1) dir1.intensity = customizeLighting ? directionalIntensity : 0.0;
        if (dir2) dir2.intensity = customizeLighting ? directionalIntensity * 0.4 : 0.0;
        if (dir3) dir3.intensity = customizeLighting ? directionalIntensity * 0.3 : 0.0;
    }, [scene, directionalIntensity, customizeLighting]);

    // Skybox / clearColor toggles
    useEffect(() => {
        if (!scene) return;

        if (showSkybox) {
            scene.clearColor = new Color4(0.53, 0.81, 0.92, 1.0); // Sky blue
        } else {
            scene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0); // Dark grey
        }
    }, [scene, showSkybox]);

    // Wireframe updates
    useEffect(() => {
        activeMeshesRef.current.forEach(m => {
            if (m.material) {
                m.material.wireframe = wireframe;
            }
        });
    }, [wireframe]);

    // Visibility of meshes
    useEffect(() => {
        activeMeshesRef.current.forEach(m => {
            m.setEnabled(visibleMaterials.has(m.name));
        });
    }, [visibleMaterials]);

    // SkeletonViewer visibility toggle
    useEffect(() => {
        if (!scene) return;

        if (skeletonViewerRef.current) {
            skeletonViewerRef.current.dispose();
            skeletonViewerRef.current = null;
        }

        if (showSkeleton && skeletonRef.current && activeMeshesRef.current.length > 0) {
            try {
                const viewer = new SkeletonViewer(
                    skeletonRef.current,
                    activeMeshesRef.current[0],
                    scene,
                    true,
                    3,
                    {
                        displayMode: SkeletonViewer.DISPLAY_LINES,
                    }
                );
                viewer.isEnabled = true;
                skeletonViewerRef.current = viewer;
            } catch (e) {
                console.error("Failed to update skeleton viewer state:", e);
            }
        }
    }, [scene, showSkeleton]);

    // Close popup when clicking outside
    useEffect(() => {
        if (!activePopup) return;

        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target.closest('.model-preview__popup') && !target.closest('.model-preview__control-btn')) {
                setActivePopup(null);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [activePopup]);

    // Persist settings to localStorage
    useEffect(() => {
        const settings = {
            wireframe,
            showSkybox,
            floorMode,
            ambientIntensity,
            directionalIntensity,
            showSkeleton,
            customizeLighting,
        };
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }, [wireframe, showSkybox, floorMode, ambientIntensity, directionalIntensity, showSkeleton, customizeLighting]);

    const toggleMaterial = (name: string) => {
        setVisibleMaterials(prev => {
            const next = new Set(prev);
            if (next.has(name)) {
                next.delete(name);
            } else {
                next.add(name);
            }
            return next;
        });
    };

    const toggleAllMaterials = (visible: boolean) => {
        if (visible && meshData) {
            if (meshData.kind === 'skn') {
                setVisibleMaterials(new Set((meshData as SknMeshData).materials.map(m => m.name)));
            } else {
                setVisibleMaterials(new Set((meshData as ScbMeshData).materials));
            }
        } else {
            setVisibleMaterials(new Set());
        }
    };

    // The Babylon engine effect is mounted by the <canvas> below. Returning
    // a different tree for loading/error/empty would unmount the canvas and
    // tear down the WebGL context — expensive (~50–200ms) every time the
    // preview file changes. Instead, render the status as an overlay and
    // keep the canvas in the tree at all times.
    const statusOverlay = loading
        ? (
            <div className="model-preview__overlay model-preview__overlay--loading">
                <div className="spinner" />
                <span>Loading 3D model...</span>
            </div>
        )
        : error
            ? (
                <div className="model-preview__overlay model-preview__overlay--error">
                    <span className="error-icon">⚠️</span>
                    <span>{error}</span>
                </div>
            )
            : !meshData
                ? (
                    <div className="model-preview__overlay model-preview__overlay--empty">
                        <span>No mesh data available</span>
                    </div>
                )
                : null;

    return (
        <div className="model-preview">
            {meshData && (
                <>
                    {/* Environment Button - Top Left Corner */}
                    <div className="model-preview__controls-bar model-preview__controls-bar--left">
                        <button
                            className={`model-preview__control-btn ${activePopup === 'environment' ? 'model-preview__control-btn--active' : ''}`}
                            onClick={() => setActivePopup(activePopup === 'environment' ? null : 'environment')}
                            title="Environment Settings"
                        >
                            <span dangerouslySetInnerHTML={{ __html: getIcon('settings') }} />
                        </button>
                    </div>

                    {/* Other Control Buttons - Top Right */}
                    <div className="model-preview__controls-bar">
                        <button
                            className={`model-preview__control-btn ${activePopup === 'display' ? 'model-preview__control-btn--active' : ''}`}
                            onClick={() => setActivePopup(activePopup === 'display' ? null : 'display')}
                            title="Display & Skeleton"
                        >
                            <span dangerouslySetInnerHTML={{ __html: getIcon('image') }} />
                        </button>
                        <button
                            className={`model-preview__control-btn ${activePopup === 'materials' ? 'model-preview__control-btn--active' : ''}`}
                            onClick={() => setActivePopup(activePopup === 'materials' ? null : 'materials')}
                            title="Materials"
                        >
                            <span dangerouslySetInnerHTML={{ __html: getIcon('picture') }} />
                        </button>
                        {animations.length > 0 && (
                            <button
                                className={`model-preview__control-btn ${activePopup === 'animations' ? 'model-preview__control-btn--active' : ''}`}
                                onClick={() => setActivePopup(activePopup === 'animations' ? null : 'animations')}
                                title="Animations"
                            >
                                <span dangerouslySetInnerHTML={{ __html: getIcon('video') }} />
                            </button>
                        )}
                    </div>
                </>
            )}

            {/* 3D Canvas — stays mounted across loading/error/empty states so
                the Babylon engine isn't torn down and recreated. */}
            <div className="model-preview__canvas">
                <canvas
                    ref={canvasRef}
                    style={{ width: '100%', height: '100%', display: 'block', outline: 'none' }}
                />
            </div>
            {statusOverlay}

            {/* Popup Panels */}
            {activePopup === 'display' && (
                <div className="model-preview__popup model-preview__popup--top-right">
                    <div className="model-preview__popup-header">
                        <h4>Display & Skeleton</h4>
                        <button onClick={() => setActivePopup(null)}>×</button>
                    </div>
                    <div className="model-preview__popup-body">
                        <label className="model-preview__toggle">
                            <input
                                type="checkbox"
                                checked={wireframe}
                                onChange={(e) => setWireframe(e.target.checked)}
                            />
                            <span>Wireframe</span>
                        </label>
                        {skeletonData && (
                            <label className="model-preview__toggle">
                                <input
                                    type="checkbox"
                                    checked={showSkeleton}
                                    onChange={(e) => setShowSkeleton(e.target.checked)}
                                />
                                <span>Show Skeleton ({skeletonData.bones.length} bones)</span>
                            </label>
                        )}
                    </div>
                </div>
            )}

            {activePopup === 'environment' && (
                <div className="model-preview__popup model-preview__popup--top-left">
                    <div className="model-preview__popup-header">
                        <h4>Environment</h4>
                        <button onClick={() => setActivePopup(null)}>×</button>
                    </div>
                    <div className="model-preview__popup-body">
                        <label className="model-preview__toggle">
                            <input
                                type="checkbox"
                                checked={showSkybox}
                                onChange={(e) => setShowSkybox(e.target.checked)}
                            />
                            <span>Skybox</span>
                        </label>

                        <div className="model-preview__select-group">
                            <label className="model-preview__select-label">Floor</label>
                            <select
                                value={floorMode}
                                onChange={(e) => setFloorMode(e.target.value as 'grid' | 'textured' | 'none')}
                                className="model-preview__select"
                            >
                                <option value="grid">Grid</option>
                                <option value="textured">Textured</option>
                                <option value="none">None</option>
                            </select>
                        </div>

                        <label className="model-preview__toggle" style={{ marginTop: '12px', marginBottom: '8px' }}>
                            <input
                                type="checkbox"
                                checked={customizeLighting}
                                onChange={(e) => setCustomizeLighting(e.target.checked)}
                            />
                            <span>Customize Lighting</span>
                        </label>

                        {customizeLighting && (
                            <>
                                <div className="model-preview__slider">
                                    <label className="model-preview__slider-label">
                                        <span>Ambient Light</span>
                                        <span className="model-preview__slider-value">{ambientIntensity.toFixed(1)}</span>
                                    </label>
                                    <input
                                        type="range"
                                        min="0"
                                        max="2"
                                        step="0.1"
                                        value={ambientIntensity}
                                        onChange={(e) => setAmbientIntensity(parseFloat(e.target.value))}
                                        className="model-preview__slider-input"
                                    />
                                </div>

                                <div className="model-preview__slider">
                                    <label className="model-preview__slider-label">
                                        <span>Directional Light</span>
                                        <span className="model-preview__slider-value">{directionalIntensity.toFixed(1)}</span>
                                    </label>
                                    <input
                                        type="range"
                                        min="0"
                                        max="3"
                                        step="0.1"
                                        value={directionalIntensity}
                                        onChange={(e) => setDirectionalIntensity(parseFloat(e.target.value))}
                                        className="model-preview__slider-input"
                                    />
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {meshData && activePopup === 'materials' && (
                <div className="model-preview__popup model-preview__popup--top-right model-preview__popup--wide">
                    <div className="model-preview__popup-header">
                        <h4>Materials ({meshData.materials.length})</h4>
                        <div className="model-preview__header-actions">
                            <button className="model-preview__toggle-btn model-preview__toggle-btn--all" onClick={() => toggleAllMaterials(true)} title="Show all materials">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                </svg>
                            </button>
                            <button className="model-preview__toggle-btn model-preview__toggle-btn--none" onClick={() => toggleAllMaterials(false)} title="Hide all materials">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                    <line x1="1" y1="1" x2="23" y2="23" />
                                </svg>
                            </button>
                            <button onClick={() => setActivePopup(null)}>×</button>
                        </div>
                    </div>
                    <div className="model-preview__popup-body model-preview__popup-body--scrollable">
                        {meshData.texture_warning && (
                            <div className="model-preview__warning" style={{
                                background: 'rgba(251, 191, 36, 0.1)',
                                border: '1px solid rgba(251, 191, 36, 0.3)',
                                borderRadius: '4px',
                                padding: '8px',
                                marginBottom: '12px',
                                fontSize: '12px',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                                    <span style={{ fontSize: '14px' }}>⚠️</span>
                                    <span style={{ color: 'var(--text-secondary)' }}>{meshData.texture_warning}</span>
                                </div>
                            </div>
                        )}
                        <div className="model-preview__materials-list">
                            {meshData.materials.map((mat, index) => {
                                const matName = typeof mat === 'string' ? mat : mat.name;
                                const hasTexture =
                                    (meshData.kind === 'skn' && (
                                        (meshData as SknMeshData).material_data?.[matName] ||
                                        (meshData as SknMeshData).textures?.[matName]
                                    )) ||
                                    (meshData.kind !== 'skn' && (meshData as ScbMeshData).material_data?.[matName]);
                                const isVisible = visibleMaterials.has(matName);
                                return (
                                    <label
                                        key={matName || index}
                                        className={`material-toggle ${isVisible ? 'material-toggle--visible' : ''} ${hasTexture ? 'material-toggle--has-texture' : 'material-toggle--no-texture'}`}
                                        onMouseEnter={(e) => {
                                            setHoveredMaterial(matName);
                                            setPreviewPosition({ x: e.clientX, y: e.clientY });
                                        }}
                                        onMouseLeave={() => setHoveredMaterial(null)}
                                        onMouseMove={(e) => {
                                            setPreviewPosition({ x: e.clientX, y: e.clientY });
                                        }}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={isVisible}
                                            onChange={() => toggleMaterial(matName)}
                                        />
                                        <div className="material-toggle__info">
                                            <span className="material-toggle__name" title={matName}>
                                                {matName || `Material ${index}`}
                                            </span>
                                            <span className={`material-toggle__status ${hasTexture ? 'material-toggle__status--loaded' : 'material-toggle__status--missing'}`}>
                                                {hasTexture ? (
                                                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                                                        <path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z" />
                                                    </svg>
                                                ) : (
                                                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                                                        <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                                                    </svg>
                                                )}
                                                {hasTexture ? 'Texture loaded' : 'No texture'}
                                            </span>
                                        </div>
                                    </label>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {activePopup === 'animations' && animations.length > 0 && (
                <div className="model-preview__popup model-preview__popup--top-right">
                    <div className="model-preview__popup-header">
                        <h4>Animations ({animations.length})</h4>
                        <button onClick={() => setActivePopup(null)}>×</button>
                    </div>
                    <div className="model-preview__popup-body">
                        <div className="model-preview__select-group">
                            <select
                                className="model-preview__select"
                                value={selectedAnimation}
                                onChange={(e) => setSelectedAnimation(e.target.value)}
                            >
                                <option value="">-- Select Animation --</option>
                                {animations.map((anim, index) => (
                                    <option key={index} value={anim.animation_path}>
                                        {anim.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {selectedAnimation && (
                            <>
                                <div className="model-preview__playback-controls">
                                    <button
                                        className={`model-preview__playback-btn ${isPlaying ? 'model-preview__playback-btn--active' : ''}`}
                                        onClick={() => setIsPlaying(!isPlaying)}
                                        title={isPlaying ? 'Pause' : 'Play'}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            {isPlaying ? (
                                                <>
                                                    <rect x="6" y="4" width="4" height="16" />
                                                    <rect x="14" y="4" width="4" height="16" />
                                                </>
                                            ) : (
                                                <polygon points="5 3 19 12 5 21 5 3" />
                                            )}
                                        </svg>
                                        <span>{isPlaying ? 'Pause' : 'Play'}</span>
                                    </button>
                                    <button
                                        className="model-preview__playback-btn"
                                        onClick={() => { setIsPlaying(false); handleSliderChange(0); }}
                                        title="Stop"
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="6" y="6" width="12" height="12" />
                                        </svg>
                                        <span>Stop</span>
                                    </button>
                                </div>
                                {animationData && (
                                    <div className="model-preview__timeline">
                                        <input
                                            type="range"
                                            min={0}
                                            max={animationData.duration}
                                            step={0.001}
                                            value={currentTime}
                                            onChange={(e) => handleSliderChange(parseFloat(e.target.value))}
                                            className="model-preview__timeline-slider"
                                        />
                                        <div className="model-preview__timeline-info">
                                            <span>{currentTime.toFixed(2)}s / {animationData.duration.toFixed(2)}s</span>
                                            <span className="model-preview__timeline-fps">
                                                {animationData.fps.toFixed(0)} FPS · {animationData.joint_count} joints
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Texture Preview Tooltip */}
            {hoveredMaterial && meshData && (
                <div
                    className="asset-preview-tooltip"
                    style={{
                        position: 'fixed',
                        left: previewPosition.x - 240,
                        top: previewPosition.y - 100,
                        zIndex: 9999,
                        pointerEvents: 'none'
                    }}
                >
                    <div className="asset-preview-tooltip__header">
                        {hoveredMaterial}
                    </div>
                    <div className="asset-preview-tooltip__content">
                        {(() => {
                            const sknData = meshData as SknMeshData;
                            const scbData = meshData as ScbMeshData;
                            const textureData = (meshData.kind === 'skn'
                                ? sknData.material_data?.[hoveredMaterial]?.texture || sknData.textures?.[hoveredMaterial]
                                : scbData.material_data?.[hoveredMaterial]?.texture);
                            if (textureData) {
                                return (
                                    <div className="asset-preview-tooltip__texture">
                                        <img
                                            src={`data:image/png;base64,${textureData}`}
                                            alt={hoveredMaterial}
                                            style={{
                                                maxWidth: '180px',
                                                maxHeight: '160px',
                                                objectFit: 'contain',
                                                borderRadius: '4px',
                                                background: 'repeating-conic-gradient(var(--bg-tertiary) 0% 25%, var(--bg-primary) 0% 50%) 50% / 10px 10px'
                                            }}
                                        />
                                    </div>
                                );
                            } else {
                                return (
                                    <div className="asset-preview-tooltip__error">
                                        <span className="asset-preview-tooltip__error-icon">🎨</span>
                                        <span>No texture loaded</span>
                                    </div>
                                );
                            }
                        })()}
                    </div>
                </div>
            )}
        </div>
    );
};
