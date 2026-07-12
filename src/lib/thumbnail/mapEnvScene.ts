// Map-environment layer for the Thumbnail Creator: loads a bundled GLB map
// chunk (Dexal) and renders it as a live 3D backdrop on its OWN Babylon
// engine/scene/canvas. A separate canvas (not the model scene) is required
// because the disc "circle" separator must composite BETWEEN the map and the
// models (z-order: map → disc → models), and the model scene canvas already
// sits above the disc in the DOM. The map is 5 static frozen meshes, so a
// second lightweight engine is cheap.
//
// Textures are EXTERNAL (the GLB carries geometry + material slots only): each
// material is bound to a WebP by name, and a "variation" is a saved {slot:
// image} map you can hot-swap (the map's own chroma system). Placement/rotation/
// scale come baked from the layer.
//
// See docs/superpowers/specs/2026-07-13-thumbnail-map-env-design.md.

import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3, Color4, Quaternion } from '@babylonjs/core/Maths/math';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Material } from '@babylonjs/core/Materials/material';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
// Side-effect: registers the glTF 2.0 loader plugin so LoadAssetContainerAsync
// can read a .glb. Without this Babylon has no loader for the extension.
import '@babylonjs/loaders/glTF/2.0';

import { loadThumbnailAsset, type ThumbnailAssetName } from '../api/thumbnail';
import type { EnvLayer } from './layers';

/** A bundled default texture ships as a ThumbnailAssetName; any other value is
 *  treated as an absolute/disk path resolved via convertFileSrc by the caller. */
const BUNDLED_TEX: ReadonlySet<string> = new Set<ThumbnailAssetName>([
    'Ground_B1_ChaosTop_A.webp',
    'Ground_C1_ChaosTop_A.webp',
    'Periph_Top_G_1bitalpha.webp',
    'Periph_Top_H_1bitalpha.webp',
    'Periph_Top_I_1bitalpha.webp',
]);

/** A material slot needs alpha masking when it's a 1-bit-alpha cutout — the
 *  periph foliage/edge pieces. Keyed off the material name or the image name. */
function isCutout(name: string): boolean {
    const n = name.toLowerCase();
    return n.includes('periph') || n.includes('1bitalpha');
}

export interface MapEnvScene {
    /** Material-slot names discovered from the loaded GLB (for the picker UI). */
    getSlots(): string[];
    /** Load / swap the GLB. Reloads geometry only when the glb name changes. */
    setLayer(layer: EnvLayer): Promise<void>;
    /** Swap the ≤5 textures for a variation's {slot: image} map. No reload. */
    applyVariation(textures: Record<string, string>): Promise<void>;
    /** Apply the baked world transform (position/rotation-radians/uniform scale). */
    setTransform(position: [number, number, number], rotationRad: [number, number, number], scale: number): void;
    setVisible(visible: boolean): void;
    resize(): void;
    /** True once a GLB is loaded and has renderable meshes. */
    isLoaded(): boolean;
    /** Render the map at the given output size and read it back as a Blob
     *  (transparent where the map doesn't cover). For the export compositor. */
    screenshot(w: number, h: number): Promise<Blob>;
    dispose(): void;
}

/** Resolve a texture reference (bundled asset name OR abs path) to an object
 *  URL Babylon's Texture can load. */
async function resolveTextureUrl(ref: string, convertFileSrc: (p: string) => string): Promise<string> {
    if (BUNDLED_TEX.has(ref)) {
        const bytes = await loadThumbnailAsset(ref as ThumbnailAssetName);
        return URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'image/webp' }));
    }
    return convertFileSrc(ref);
}

/**
 * Create the map-env scene on its own canvas. Nothing is loaded until
 * `setLayer` is called. Transparent clear so the disc DOM element painted
 * behind this canvas shows through everywhere the map doesn't cover.
 */
export function createMapEnvScene(
    canvas: HTMLCanvasElement,
    convertFileSrc: (p: string) => string,
): MapEnvScene {
    const engine = new Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: false,
        antialias: true,
        adaptToDeviceRatio: true,
        alpha: true,
        premultipliedAlpha: false,
    });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 0); // transparent → disc shows through

    const camera = new ArcRotateCamera(
        'mapenv-cam',
        Math.PI / 2 + Math.PI / 8,
        Math.PI / 3,
        10,
        Vector3.Zero(),
        scene,
    );

    let container: AssetContainer | null = null;
    let meshes: AbstractMesh[] = [];
    // The wrapper node the user transform is applied to. The GLB's own baked
    // transforms (the `group1` node's 90°-X rotation + 0.01 scale) live BELOW
    // this, so user position/rotation/scale compose on top as a delta. We
    // transform THIS, never the leaf meshes (they're all parented, so setting
    // their local transform would do nothing / fight the rig).
    let root: TransformNode | null = null;
    let slots: string[] = [];
    const slotMeshes = new Map<string, AbstractMesh[]>();
    const slotMat = new Map<string, StandardMaterial>();
    let liveTextures: Texture[] = [];
    let currentGlb: string | null = null;

    engine.runRenderLoop(() => {
        if (meshes.length > 0) scene.render();
    });

    function clearGeometry(): void {
        for (const t of liveTextures) t.dispose();
        liveTextures = [];
        for (const m of slotMat.values()) m.dispose();
        slotMat.clear();
        slotMeshes.clear();
        slots = [];
        meshes = [];
        if (container) { container.removeAllFromScene(); container.dispose(); container = null; }
        if (root) { root.dispose(); root = null; }
    }

    async function loadGlb(glb: string): Promise<void> {
        clearGeometry();
        const glbBytes = await loadThumbnailAsset(glb as ThumbnailAssetName);
        // Pass as a named File so the loader infers the .glb extension.
        const file = new File([glbBytes.slice().buffer], glb, { type: 'model/gltf-binary' });
        container = await LoadAssetContainerAsync(file, scene);
        container.addAllToScene();
        meshes = container.meshes.filter((m): m is AbstractMesh => !!m.getTotalVertices?.() && m.getTotalVertices() > 0);
        // Parent the GLB's TOP-LEVEL nodes under our own wrapper so the user
        // transform (setTransform) can move the whole map as one unit WITHOUT
        // disturbing the rig's baked transforms below (Blender export nests the
        // meshes under a `group1` node that already carries a 90°-X rotation +
        // 0.01 scale — the loader adds a `__root__` above that). We must NOT
        // write the leaf meshes' local transforms: they're all parented, so it
        // would either no-op or fight the rig.
        root = new TransformNode('mapenv-root', scene);
        root.rotationQuaternion = Quaternion.Identity();
        for (const node of container.rootNodes) {
            if (node === root) continue;
            node.parent = root;
        }
        for (const mesh of meshes) {
            mesh.alwaysSelectAsActiveMesh = true; // fills the view; skip culling
            const matName = mesh.material?.name ?? mesh.name;
            const arr = slotMeshes.get(matName) ?? [];
            arr.push(mesh);
            slotMeshes.set(matName, arr);
        }
        slots = [...slotMeshes.keys()];
        // Flat StandardMaterial per slot (Phase 1: no scene light → emissive +
        // disableLighting so textures read in-game-bright without a sun).
        for (const slot of slots) {
            const mat = new StandardMaterial(`mapmat-${slot}`, scene);
            mat.disableLighting = true;
            mat.emissiveColor = new Color3(1, 1, 1);
            mat.backFaceCulling = false;
            if (isCutout(slot)) {
                mat.transparencyMode = Material.MATERIAL_ALPHATEST;
                mat.useAlphaFromDiffuseTexture = true;
            }
            for (const mesh of slotMeshes.get(slot) ?? []) mesh.material = mat;
            slotMat.set(slot, mat);
        }
        currentGlb = glb;
        frameToBox(); // one-time starting framing; fixed thereafter
    }

    function setTransform(position: [number, number, number], rotationRad: [number, number, number], scale: number): void {
        if (!root) return;
        root.position.set(position[0], position[1], position[2]);
        // Compose all 3 axes via a quaternion (YawPitchRoll = Y, X, Z) so they
        // don't gimbal-fight; this is a DELTA applied above the rig's own baked
        // rotation, which lives on the child `group1` node.
        root.rotationQuaternion = Quaternion.RotationYawPitchRoll(rotationRad[1], rotationRad[0], rotationRad[2]);
        root.scaling.setAll(scale);
        // Do NOT reframe here — the camera is framed ONCE at load so that
        // position/rotation/scale visibly MOVE the map (an auto-reframe would
        // re-center the map every edit and cancel the tuning).
    }

    /** Fit the camera so the whole map bbox is centered in the canvas. Called
     *  ONCE at load for a sensible starting view; distance is locked so the
     *  map's on-screen size comes from its own scale afterward. */
    function frameToBox(): void {
        if (meshes.length === 0) return;
        root?.computeWorldMatrix(true); // flush wrapper before reading children
        let min = new Vector3(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
        let max = new Vector3(-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE);
        for (const mesh of meshes) {
            mesh.computeWorldMatrix(true);
            const bb = mesh.getBoundingInfo().boundingBox;
            min = Vector3.Minimize(min, bb.minimumWorld);
            max = Vector3.Maximize(max, bb.maximumWorld);
        }
        if (min.x > max.x) { min = new Vector3(-1, -1, -1); max = new Vector3(1, 1, 1); }
        const center = min.add(max).scale(0.5);
        const sizeX = max.x - min.x, sizeY = max.y - min.y, sizeZ = max.z - min.z;
        const halfH = Math.max(sizeY, 0.01) / 2;
        const halfW = Math.max(sizeX, sizeZ, 0.01) / 2;
        const fovY = camera.fov || 0.8;
        const cw = engine.getRenderWidth() || 1;
        const ch = engine.getRenderHeight() || 1;
        const aspect = ch > 0 ? cw / ch : 1;
        const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
        // 1.6× margin (not tight) so the map sits with headroom in the frame —
        // gives room to reposition/scale it during tuning instead of filling
        // the whole view at scale 1.
        const radius = Math.max(halfH / Math.tan(fovY / 2), halfW / Math.tan(fovX / 2), 0.01) * 1.6;
        camera.target = center;
        camera.radius = radius;
        camera.lowerRadiusLimit = radius;
        camera.upperRadiusLimit = radius;
    }

    async function applyVariation(textures: Record<string, string>): Promise<void> {
        for (const [slot, ref] of Object.entries(textures)) {
            const mat = slotMat.get(slot);
            if (!mat || !ref) continue;
            const url = await resolveTextureUrl(ref, convertFileSrc);
            const tex = new Texture(url, scene, false, false);
            tex.hasAlpha = isCutout(slot);
            const prev = mat.diffuseTexture as Texture | null;
            mat.diffuseTexture = tex;
            mat.emissiveTexture = tex;
            liveTextures.push(tex);
            if (prev) { const i = liveTextures.indexOf(prev); if (i >= 0) liveTextures.splice(i, 1); prev.dispose(); }
        }
    }

    async function setLayer(layer: EnvLayer): Promise<void> {
        if (currentGlb !== layer.glb) await loadGlb(layer.glb);
        setTransform(layer.position, layer.rotation, layer.mapScale);
        const v = layer.variations.find(x => x.name === layer.activeVariation) ?? layer.variations[0];
        if (v) await applyVariation(v.textures);
    }

    async function screenshot(w: number, h: number): Promise<Blob> {
        // Render once at the current canvas resolution and scale-blit into an
        // output canvas (the export always requests the composed WxH). The
        // scene's own transparent clear means only map pixels are opaque.
        scene.render();
        const src = engine.getRenderingCanvas();
        if (!src) throw new Error('map screenshot: no rendering canvas');
        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        const ctx = out.getContext('2d');
        if (!ctx) throw new Error('map screenshot: no 2D context');
        ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
        return new Promise<Blob>((resolve, reject) => {
            out.toBlob(b => (b ? resolve(b) : reject(new Error('map screenshot: toBlob null'))), 'image/png');
        });
    }

    return {
        getSlots: () => slots.slice(),
        setLayer,
        applyVariation,
        setTransform,
        setVisible: (visible: boolean) => { for (const mesh of meshes) mesh.setEnabled(visible); },
        resize: () => { engine.resize(); frameToBox(); },
        isLoaded: () => meshes.length > 0,
        screenshot,
        dispose: () => {
            engine.stopRenderLoop();
            clearGeometry();
            scene.dispose();
            engine.dispose();
        },
    };
}
