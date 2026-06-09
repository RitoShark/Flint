/**
 * Flint - MapPreview
 * 3D preview of a map project's mapgeo, with textures auto-connected from the
 * materials bin and live reload. Rendered inside the separate map-preview window.
 *
 * Adapted from ModelPreview.tsx: engine created once + scene mutated on reload
 * (never recreate the WebGL context), render loop wrapped in try/catch, unlit
 * PBRMaterial (the correct League look), camera framing with a degenerate-box
 * guard, per-submesh meshes via the meshBuilder contract, lazy RawTexture
 * loading + cache, and live reload off the existing `file-changed` watcher event.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
// Side-effect import: scene.pick() silently no-ops ("Ray needs to be imported
// before…") unless the Ray module is registered. Required for hover/click picking.
import '@babylonjs/core/Culling/ray';
// Side-effect import: scene.pick() needs the Ray module registered or it no-ops
// ("Ray needs to be imported before…"). Required for hover/click picking.
import '@babylonjs/core/Culling/ray';

import * as api from '../../lib/api';
import { createEngine } from '../../lib/babylon/engine';
import {
    buildMapMeshes,
    MAP_VARIANTS,
    BARON_STAGES,
    layerVisibleForVariant,
    resolveFace,
    type BuiltMapMesh,
    type MapVariant,
    type BaronStage,
    type SubmeshSpan,
} from '../../lib/babylon/mapMeshBuilder';
import * as paint from '../../lib/babylon/paintEngine';

interface MapPreviewProps {
    projectPath: string;
}

/** What hover/click resolves a piece of geometry to. */
interface IdentifyInfo {
    meshName: string;           // the merged-mesh name (key for show/hide)
    materialName: string;
    textureFile: string;        // basename for the status bar
    texturePath: string | null; // full bin path
    variants: MapVariant[];
    baronStage: BaronStage | null;
    layer: number;
}

const overlay: React.CSSProperties = {
    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
    color: '#ddd', font: '14px system-ui', pointerEvents: 'none', textAlign: 'center',
};
const badge: React.CSSProperties = {
    position: 'absolute', top: 8, left: 8, color: '#aaa', font: '12px system-ui',
    background: 'rgba(0,0,0,0.4)', padding: '2px 8px', borderRadius: 4, pointerEvents: 'none',
};

export const MapPreview: React.FC<MapPreviewProps> = ({ projectPath }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const engineRef = useRef<Engine | null>(null);
    const sceneRef = useRef<Scene | null>(null);
    const cameraRef = useRef<ArcRotateCamera | null>(null);
    const meshesRef = useRef<Mesh[]>([]);
    const builtRef = useRef<BuiltMapMesh[]>([]);
    const texCacheRef = useRef<Map<string, RawTexture>>(new Map());
    // Mutable paint buffers per texture path: the live RGBA backing each
    // RawTexture, so the paint brush can mutate pixels and update() in place.
    const paintBufRef = useRef<Map<string, { tex: RawTexture; rgba: Uint8Array; w: number; h: number }>>(new Map());
    const dataRef = useRef<api.MapPreviewData | null>(null);
    const meshByBabylonRef = useRef<Map<Mesh, BuiltMapMesh>>(new Map());
    // The mesh currently shown with a hover tint, and its original emissive so we
    // can restore it. (Emissive tint avoids HighlightLayer's bloom on the huge map.)
    const hoverTintRef = useRef<{ mesh: Mesh; prev: Color3 } | null>(null);
    // Build serialization: a monotonically increasing generation. Each buildScene
    // bumps it; any async step that finds the generation changed bails out. This
    // prevents two concurrent builds (StrictMode double-mount, rapid project
    // switch) from racing and corrupting the engine (the "no buffer bound" /
    // "bindSamplers null" errors that left the window blank ~half the time).
    const buildGenRef = useRef(0);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState('');
    const [hoverInfo, setHoverInfo] = useState<IdentifyInfo | null>(null);
    const [pinnedInfo, setPinnedInfo] = useState<IdentifyInfo | null>(null);
    const [pinnedTexPath, setPinnedTexPath] = useState<string | null>(null);
    const [showUv, setShowUv] = useState(false);
    const [uvTris, setUvTris] = useState<Float32Array | null>(null);
    const [highlightOn, setHighlightOn] = useState(true);
    // Mirror highlightOn into a ref so the render-loop pick handler reads the
    // current value without being re-created.
    const highlightOnRef = useRef(true);

    // ── Paint mode ────────────────────────────────────────────────────────────
    const [paintMode, setPaintMode] = useState(false);
    const [brush, setBrush] = useState<paint.Brush>({
        mode: 'Dodge', color: [255, 240, 200], opacity: 0.8, flow: 0.5, hardness: 0.3,
    });
    const [brushSize, setBrushSize] = useState(64); // radius in texels
    const [eyedrop, setEyedrop] = useState(false);
    const [painting, setPainting] = useState(false);
    // Refs so the pointer handler (added once) reads live values.
    const paintModeRef = useRef(false);
    const brushRef = useRef(brush);
    const brushSizeRef = useRef(brushSize);
    const eyedropRef = useRef(false);
    const dirtyTexRef = useRef<Set<string>>(new Set());
    const lastTexelRef = useRef<{ texPath: string; x: number; y: number } | null>(null);
    // Undo: per-stroke "before" snapshots (texPath -> rgba copy). strokeSnapRef
    // collects the before-state of each texture touched in the current stroke.
    const strokeSnapRef = useRef<Map<string, Uint8Array>>(new Map());
    const undoStackRef = useRef<Array<Map<string, Uint8Array>>>([]);
    const redoStackRef = useRef<Array<Map<string, Uint8Array>>>([]);
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);
    useEffect(() => { paintModeRef.current = paintMode; }, [paintMode]);
    useEffect(() => { brushRef.current = brush; }, [brush]);
    useEffect(() => { brushSizeRef.current = brushSize; }, [brushSize]);
    useEffect(() => { eyedropRef.current = eyedrop; }, [eyedrop]);

    // span -> IdentifyInfo
    const spanToInfo = useCallback((built: BuiltMapMesh, span: SubmeshSpan): IdentifyInfo => {
        const file = (span.texturePath ?? span.name).split(/[\\/]/).pop() ?? span.name;
        return {
            meshName: built.mesh.name,
            materialName: span.name,
            textureFile: file,
            texturePath: span.texturePath,
            variants: built.variants,
            baronStage: built.baronStage,
            layer: built.layer,
        };
    }, []);

    // Visibility UI. Exactly ONE elemental theme is active at a time (like the
    // live game): 'Base' shows the static map; an element swaps in its pieces and
    // hides the Base pieces they replace. `hiddenMeshes` is per-mesh manual hide.
    const [built, setBuilt] = useState<BuiltMapMesh[]>([]);
    const [activeVariant, setActiveVariant] = useState<MapVariant>('Base');
    const [baronStage, setBaronStage] = useState<BaronStage>('Default');
    const [hiddenMeshes, setHiddenMeshes] = useState<Set<string>>(new Set()); // by mesh.name
    const [showPanel, setShowPanel] = useState(false);
    const [meshSearch, setMeshSearch] = useState('');

    // ── Apply (or reuse cached) texture to a material ────────────────────────
    // Load ONE unique texture (decode in Rust → RawTexture) and apply it to all
    // materials waiting on that path. Called by the throttled loader below.
    const loadAndApply = useCallback(async (texPath: string, mats: PBRMaterial[]) => {
        const scene = sceneRef.current;
        if (!scene) return;
        try {
            let tex = texCacheRef.current.get(texPath);
            if (!tex) {
                const { width, height, rgba } = await api.loadMapTexture(projectPath, texPath);
                // Re-validate AFTER the await: the engine/scene must still be
                // alive and not disposed, or RawTexture upload hits a null GL
                // program ("bindSamplers reading 'program'") and can blank the
                // whole window. This is the boot-validation guard.
                const sc = sceneRef.current;
                const eng = engineRef.current;
                if (!sc || sc.isDisposed || !eng || eng.isDisposed) return;
                // invertY=true matches the V-flip meshBuilder applies to UVs.
                tex = RawTexture.CreateRGBATexture(rgba, width, height, sc, false, true);
                tex.wrapU = Texture.WRAP_ADDRESSMODE;
                tex.wrapV = Texture.WRAP_ADDRESSMODE;
                tex.hasAlpha = true; // sample alpha for cutouts (see below)
                texCacheRef.current.set(texPath, tex);
                // Keep a mutable copy of the pixels for in-app painting.
                paintBufRef.current.set(texPath, {
                    tex,
                    rgba: new Uint8Array(rgba),
                    w: width,
                    h: height,
                });
            }
            for (const mat of mats) {
                mat.albedoTexture = tex;
                mat.albedoColor = new Color3(1, 1, 1);
                // Alpha-test ALL materials. Verified safe: no map texture is
                // uniformly zero-alpha, so opaque surfaces (alpha=255) pass the
                // cutoff and render normally, while real cutouts (decals, brush,
                // water lily) get clipped. cutoff=0.5 is a hard 1-bit cutout.
                mat.useAlphaFromAlbedoTexture = true;
                mat.transparencyMode = Material.MATERIAL_ALPHATEST;
                mat.alphaCutOff = 0.5;
                mat.backFaceCulling = false;
            }
        } catch (e) {
            console.error('[map-tex] failed', texPath, e);
            for (const mat of mats) mat.albedoColor = new Color3(1, 0, 1); // magenta: missing
        }
    }, [projectPath]);

    // Re-apply a single already-known texture path (used by live reload).
    const applyTexture = useCallback(async (mat: PBRMaterial, texPath: string) => {
        await loadAndApply(texPath, [mat]);
    }, [loadAndApply]);

    // ── Visibility model ─────────────────────────────────────────────────────
    // One elemental theme active at a time. layerVisibleForVariant shows shared
    // (0xff) + default (0x01) + the active element's pieces. Then a REPLACEMENT
    // pass hides the default (0x01) pieces that the active element overrides at
    // the same spot (default dragon pit hides when the elemental pit shows),
    // matched by replacement key (name minus element token).
    const applyVisibility = useCallback(
        (active: MapVariant, stage: BaronStage, hiddenM: Set<string>) => {
            const VARIANT_BIT: Record<string, number> = {
                Infernal: 0x02, Mountain: 0x04, Ocean: 0x08,
                Cloud: 0x10, Hextech: 0x20, Chemtech: 0x40,
            };
            // Replacement keys owned by the ACTIVE element's pieces.
            const replacedKeys = new Set<string>();
            if (active !== 'Base') {
                const bit = VARIANT_BIT[active];
                for (const b of builtRef.current) {
                    // An element-specific piece for the active theme (its bit set,
                    // and NOT plain default/shared) defines a spot it replaces.
                    if (b.layer !== 0xff && (b.layer & 0x01) === 0 && (b.layer & bit) !== 0) {
                        for (const k of b.replaceKeys) replacedKeys.add(k);
                    }
                }
            }
            for (const b of builtRef.current) {
                let visible = layerVisibleForVariant(b.layer, active);
                // Hide a default (0x01) piece if the active element replaces its spot.
                if (visible && active !== 'Base' && b.layer !== 0xff && (b.layer & 0x01) !== 0) {
                    if (b.replaceKeys.some(k => replacedKeys.has(k))) visible = false;
                }
                // Baron stage axis: a staged Baron piece shows only for its stage.
                if (b.baronStage && b.baronStage !== stage) visible = false;
                if (hiddenM.has(b.mesh.name)) visible = false;
                b.mesh.setEnabled(visible);
            }
        },
        [],
    );

    // ── Build / rebuild geometry + materials ─────────────────────────────────
    const buildScene = useCallback(async () => {
        const scene = sceneRef.current, camera = cameraRef.current;
        if (!scene || !camera) return;
        // New build generation; supersedes any in-flight build.
        const gen = ++buildGenRef.current;
        setLoading(true); setError(null);
        try {
            const data = await api.loadMapPreview(projectPath);
            // Bail if a newer build started or the scene was torn down meanwhile.
            if (gen !== buildGenRef.current || !sceneRef.current) return;
            dataRef.current = data;

            // Tear down old meshes + materials (texture cache survives; keyed by path).
            // Drop the hover-tint ref so it can't touch a disposed mesh.
            hoverTintRef.current = null;
            setHoverInfo(null);
            meshesRef.current.forEach(m => { m.material?.dispose(); m.dispose(); });
            meshesRef.current = [];

            // Build MERGED meshes — one per (variant, texture) (~180), not one
            // per submesh (~600). Building 600 meshes spiked memory to multiple
            // GB and froze the window; merging fixes that at the source.
            const builtMeshes = buildMapMeshes(
                {
                    positions: data.positions,
                    uvs: data.uvs,
                    indices: data.indices,
                    submeshes: data.submeshes,
                    materials: data.materials,
                },
                scene,
            );
            meshesRef.current = builtMeshes.map(b => b.mesh);
            builtRef.current = builtMeshes;
            meshByBabylonRef.current = new Map(builtMeshes.map(b => [b.mesh, b]));
            setBuilt(builtMeshes);

            // Default to the Base theme + Default Baron stage, via the single
            // visibility path (so the base map = shared + default geometry).
            setActiveVariant('Base');
            setBaronStage('Default');
            setHiddenMeshes(new Set());
            applyVisibility('Base', 'Default', new Set());

            // Camera framing with degenerate-box guard (mirrors ModelPreview).
            let [[minX, minY, minZ], [maxX, maxY, maxZ]] = data.bounding_box;
            const ok = [minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)
                && maxX >= minX && maxY >= minY && maxZ >= minZ;
            if (!ok) { minX = minY = minZ = -1; maxX = maxY = maxZ = 1; }
            const center = new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
            const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.01) || 5;
            camera.target = center;
            camera.radius = size * 1.5;
            camera.lowerRadiusLimit = size * 0.05;
            camera.upperRadiusLimit = size * 10;
            camera.panningSensibility = 8000 / Math.max(camera.radius, 0.001);
            // Extend ONLY the far plane so the whole map fits in the frustum at
            // radius = size*1.5. Keep the near plane SMALL (a large minZ clips the
            // whole view to black — that was the regression). Default minZ is 1.
            camera.minZ = 1;
            camera.maxZ = Math.max(size * 8, 10000);

            // One material per merged mesh. Each mesh maps 1:1 to a texture path
            // (or null = no material entry). Group materials by texture so each
            // texture is decoded once and applied to its mesh(es).
            const byTexture = new Map<string, PBRMaterial[]>();
            for (const { mesh, texturePath } of builtMeshes) {
                const mat = new PBRMaterial(mesh.name + '_mat', scene);
                mat.unlit = true;
                mat.metallic = 0;
                mat.roughness = 1;
                mat.environmentIntensity = 0;
                mat.backFaceCulling = false;
                // Neutral grey by default. Submeshes whose material has no
                // resolvable diffuse texture (e.g. effect/prototype materials
                // like FaeLights) stay grey — that's expected, not an error.
                // Magenta is reserved for a texture that WAS found but failed to
                // decode (set in loadAndApply's catch).
                mat.albedoColor = new Color3(0.5, 0.5, 0.5);
                mesh.material = mat;
                if (texturePath) {
                    const list = byTexture.get(texturePath);
                    if (list) list.push(mat);
                    else byTexture.set(texturePath, [mat]);
                }
            }

            const uniqueTextures = [...byTexture.entries()];
            setStatus(
                `${data.variant} · ${builtMeshes.length} meshes · loading 0/${uniqueTextures.length} textures`,
            );
            setLoading(false); // geometry is up; textures stream in below

            // Throttled texture loading: at most CONCURRENCY decodes in flight.
            // This is the fix for the 6 GB / freeze — previously every submesh
            // fired a load_map_texture IPC call at once, decoding hundreds of
            // multi-MB textures to raw RGBA simultaneously.
            const CONCURRENCY = 4;
            let next = 0;
            let done = 0;
            const worker = async () => {
                while (true) {
                    const i = next++;
                    if (i >= uniqueTextures.length) break;
                    // Stop uploading if this build was superseded or scene gone.
                    if (gen !== buildGenRef.current || !sceneRef.current) break;
                    const [texPath, mats] = uniqueTextures[i];
                    await loadAndApply(texPath, mats);
                    done++;
                    if (done % 8 === 0 || done === uniqueTextures.length) {
                        setStatus(
                            `${data.variant} · ${builtMeshes.length} meshes · loading ${done}/${uniqueTextures.length} textures`,
                        );
                    }
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(CONCURRENCY, uniqueTextures.length) }, worker),
            );
            if (sceneRef.current) {
                setStatus(`${data.variant} · ${builtMeshes.length} meshes · ${uniqueTextures.length} textures`);
            }
        } catch (e) {
            setError((e as Error).message || 'Failed to load map');
            setLoading(false);
        }
    }, [projectPath, loadAndApply, applyVisibility]);

    // ── Reload a single changed texture by filename match ────────────────────
    const reloadChangedTexture = useCallback(async (changedLowerPath: string) => {
        const base = changedLowerPath.split(/[\\/]/).pop() || '';
        if (!base) return;
        for (const b of builtRef.current) {
            const texPath = b.texturePath;
            if (!texPath) continue;
            if (!texPath.toLowerCase().endsWith(base)) continue;
            texCacheRef.current.get(texPath)?.dispose();
            texCacheRef.current.delete(texPath);
            if (b.mesh.material) await applyTexture(b.mesh.material as PBRMaterial, texPath);
        }
    }, [applyTexture]);

    const selectVariant = useCallback((v: MapVariant) => {
        setActiveVariant(v);
        applyVisibility(v, baronStage, hiddenMeshes);
    }, [applyVisibility, baronStage, hiddenMeshes]);

    const selectBaronStage = useCallback((s: BaronStage) => {
        setBaronStage(s);
        applyVisibility(activeVariant, s, hiddenMeshes);
    }, [applyVisibility, activeVariant, hiddenMeshes]);

    const toggleMesh = useCallback((meshName: string) => {
        setHiddenMeshes(prev => {
            const next = new Set(prev);
            if (next.has(meshName)) next.delete(meshName);
            else next.add(meshName);
            applyVisibility(activeVariant, baronStage, next);
            return next;
        });
    }, [applyVisibility, activeVariant, baronStage]);

    // ── Engine once ──────────────────────────────────────────────────────────
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const engine = createEngine(canvas);
        engineRef.current = engine;
        const scene = new Scene(engine);
        sceneRef.current = scene;
        scene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0);

        const camera = new ArcRotateCamera('cam', Math.PI / 2, Math.PI / 3, 1000, Vector3.Zero(), scene);
        camera.attachControl(canvas, true);
        camera.wheelDeltaPercentage = 0.05;
        camera.panningSensibility = 20;
        cameraRef.current = camera;

        const light = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
        light.intensity = 1.2;
        light.specular = new Color3(0, 0, 0);

        const handleContextMenu = (e: MouseEvent) => e.preventDefault();
        canvas.addEventListener('contextmenu', handleContextMenu);

        // Hover/click identify. IMPORTANT for perf: pointer-move fires far more
        // often than frames; running scene.pick() per move (a ray-cast vs ~180
        // meshes) floods and lags on fast movement. Instead, POINTERMOVE only
        // marks "dirty" + records the cursor; the render loop does at most ONE
        // pick per frame. Click resolves immediately (rare).
        let hoverDirty = false;
        let lastHoverMesh: Mesh | null = null;
        let lastHoverKey = '';
        let paintDown = false;

        // Resolve the texture path + buffer entry for a pick.
        const texEntryForPick = (pick: ReturnType<typeof scene.pick>) => {
            const mesh = (pick?.hit && pick.pickedMesh) ? (pick.pickedMesh as Mesh) : null;
            const built = mesh ? meshByBabylonRef.current.get(mesh) : undefined;
            if (!built || !pick || pick.faceId < 0) return null;
            const span = resolveFace(built, pick.faceId);
            const texPath = span?.texturePath ?? built.texturePath;
            if (!texPath) return null;
            const entry = paintBufRef.current.get(texPath);
            return entry ? { texPath, entry, pick } : null;
        };

        // Paint (or eyedrop) at the current cursor; interpolate from last texel.
        const paintAtCursor = () => {
            const pick = scene.pick(scene.pointerX, scene.pointerY);
            if (!pick) return;
            const uv = pick.getTextureCoordinates?.();
            const res = texEntryForPick(pick);
            if (!res || !uv) return;
            const { texPath, entry } = res;
            const [tx, ty] = paint.uvToTexel(uv.x, uv.y, entry.w, entry.h);

            // Eyedropper: sample the texel color, exit eyedrop mode, don't paint.
            if (eyedropRef.current) {
                const i = (Math.min(entry.h - 1, Math.max(0, Math.floor(ty))) * entry.w
                    + Math.min(entry.w - 1, Math.max(0, Math.floor(tx)))) * 4;
                setBrush(b => ({ ...b, color: [entry.rgba[i], entry.rgba[i + 1], entry.rgba[i + 2]] }));
                setEyedrop(false);
                return;
            }

            // Snapshot this texture's BEFORE state the first time the stroke
            // touches it (for undo).
            if (!strokeSnapRef.current.has(texPath)) {
                strokeSnapRef.current.set(texPath, new Uint8Array(entry.rgba));
            }

            const radius = brushSizeRef.current;
            const b = brushRef.current;
            // Stamp spaced dabs from the last texel on this texture to the new one.
            const last = lastTexelRef.current;
            const from: [number, number] = (last && last.texPath === texPath) ? [last.x, last.y] : [tx, ty];
            for (const [dx, dy] of paint.strokeDabs(from, [tx, ty], radius)) {
                paint.stampDab(entry.rgba, entry.w, entry.h, dx, dy, radius, b);
            }
            lastTexelRef.current = { texPath, x: tx, y: ty };
            dirtyTexRef.current.add(texPath);
            entry.tex.update(entry.rgba); // live
        };

        scene.onPointerObservable.add((pi) => {
            // Paint mode owns the pointer: brush on down + drag, no hover/identify.
            if (paintModeRef.current) {
                if (pi.type === PointerEventTypes.POINTERDOWN) {
                    paintDown = true;
                    lastTexelRef.current = null;
                    strokeSnapRef.current = new Map();
                    setPainting(true);
                    paintAtCursor();
                } else if (pi.type === PointerEventTypes.POINTERMOVE) {
                    if (paintDown) paintAtCursor();
                } else if (pi.type === PointerEventTypes.POINTERUP) {
                    paintDown = false;
                    lastTexelRef.current = null;
                    setPainting(false);
                    // Commit the stroke's before-snapshot to the undo stack.
                    if (strokeSnapRef.current.size) {
                        undoStackRef.current.push(strokeSnapRef.current);
                        if (undoStackRef.current.length > 30) undoStackRef.current.shift();
                        redoStackRef.current = [];
                        strokeSnapRef.current = new Map();
                        setCanUndo(true);
                        setCanRedo(false);
                    }
                }
                return;
            }
            if (pi.type === PointerEventTypes.POINTERMOVE) {
                hoverDirty = true;
            } else if (pi.type === PointerEventTypes.POINTERPICK) {
                const pick = pi.pickInfo;
                const built = pick?.pickedMesh
                    ? meshByBabylonRef.current.get(pick.pickedMesh as Mesh)
                    : undefined;
                if (!built || !pick || pick.faceId < 0) { setPinnedInfo(null); return; }
                const span = resolveFace(built, pick.faceId);
                setPinnedInfo(span ? spanToInfo(built, span) : null);
            }
        });

        // One hover-pick per frame, only when the pointer moved since last frame.
        const pickHover = () => {
            if (paintModeRef.current) return; // paint mode owns the pointer
            if (!hoverDirty) return;
            hoverDirty = false;
            const pick = scene.pick(scene.pointerX, scene.pointerY);
            const mesh = (pick?.hit && pick.pickedMesh) ? (pick.pickedMesh as Mesh) : null;
            const built = mesh ? meshByBabylonRef.current.get(mesh) : undefined;

            // Subtle emissive tint on the hovered mesh; toggle only on change.
            if (mesh !== lastHoverMesh) {
                // Restore the previously-tinted mesh.
                const prev = hoverTintRef.current;
                if (prev && !prev.mesh.isDisposed()) {
                    const m = prev.mesh.material as PBRMaterial | null;
                    if (m) m.emissiveColor = prev.prev;
                }
                hoverTintRef.current = null;
                // Tint the new one (unless the user disabled the highlight).
                if (mesh && built && highlightOnRef.current) {
                    const m = mesh.material as PBRMaterial | null;
                    if (m) {
                        hoverTintRef.current = { mesh, prev: m.emissiveColor.clone() };
                        m.emissiveColor = new Color3(0.35, 0.28, 0.05); // soft gold
                    }
                }
                lastHoverMesh = mesh && built ? mesh : null;
            }

            if (!built || !pick || pick.faceId < 0) {
                if (lastHoverKey !== '') { lastHoverKey = ''; setHoverInfo(null); }
                return;
            }
            const span = resolveFace(built, pick.faceId);
            const key = `${built.mesh.name}#${span?.startFace ?? -1}`;
            if (key === lastHoverKey) return;
            lastHoverKey = key;
            setHoverInfo(span ? spanToInfo(built, span) : null);
        };

        let errs = 0;
        engine.runRenderLoop(() => {
            try { pickHover(); scene.render(); }
            catch (e) { if (++errs <= 5) console.error('[map-render] frame threw:', e); }
        });
        const onResize = () => engine.resize();
        window.addEventListener('resize', onResize);

        // First-open black-screen fix: when this window is freshly created the
        // WebView lays out the canvas AFTER React mounts, so the engine's first
        // backbuffer can be 0×0 and renders nothing until a manual reload (Ctrl+R).
        // A ResizeObserver re-sizes the engine the moment the canvas gets real
        // dimensions; the rAF calls cover the initial layout before the observer
        // attaches.
        const ro = new ResizeObserver(() => engine.resize());
        ro.observe(canvas);
        requestAnimationFrame(() => {
            engine.resize();
            requestAnimationFrame(() => engine.resize());
        });

        return () => {
            ro.disconnect();
            window.removeEventListener('resize', onResize);
            canvas.removeEventListener('contextmenu', handleContextMenu);
            hoverTintRef.current = null;
            texCacheRef.current.forEach(t => t.dispose());
            texCacheRef.current.clear();
            paintBufRef.current.clear();
            meshesRef.current.forEach(m => { m.material?.dispose(); m.dispose(); });
            meshesRef.current = [];
            engine.dispose();
            engineRef.current = null;
            sceneRef.current = null;
            cameraRef.current = null;
        };
    }, []);

    // Paint mode owns the pointer: detach camera control so left-drag paints
    // instead of rotating. Re-attach when leaving paint mode.
    useEffect(() => {
        const cam = cameraRef.current;
        const canvas = canvasRef.current;
        if (!cam || !canvas) return;
        if (paintMode) cam.detachControl();
        else cam.attachControl(canvas, true);
    }, [paintMode]);

    // Swap current buffers with a snapshot map, returning the REPLACED state (for
    // the opposite stack). Updates the live RawTextures + dirty set.
    const swapSnapshot = useCallback((snap: Map<string, Uint8Array>): Map<string, Uint8Array> => {
        const replaced = new Map<string, Uint8Array>();
        for (const [texPath, before] of snap) {
            const entry = paintBufRef.current.get(texPath);
            if (!entry) continue;
            replaced.set(texPath, new Uint8Array(entry.rgba)); // current -> opposite stack
            entry.rgba.set(before);
            entry.tex.update(entry.rgba);
            dirtyTexRef.current.add(texPath);
        }
        return replaced;
    }, []);

    const handleUndo = useCallback(() => {
        const snap = undoStackRef.current.pop();
        if (!snap) return;
        redoStackRef.current.push(swapSnapshot(snap));
        setCanUndo(undoStackRef.current.length > 0);
        setCanRedo(true);
    }, [swapSnapshot]);

    const handleRedo = useCallback(() => {
        const snap = redoStackRef.current.pop();
        if (!snap) return;
        undoStackRef.current.push(swapSnapshot(snap));
        setCanRedo(redoStackRef.current.length > 0);
        setCanUndo(true);
    }, [swapSnapshot]);

    // Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) while in paint mode.
    useEffect(() => {
        if (!paintMode) return;
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            const k = e.key.toLowerCase();
            if (k === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); }
            else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); handleRedo(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [paintMode, handleUndo, handleRedo]);

    // Save all painted textures: edge-dilate then write each dirty .tex.
    const handleSavePaint = useCallback(async () => {
        const dirty = Array.from(dirtyTexRef.current);
        if (!dirty.length) return;
        let written = 0; const errors: string[] = [];
        for (const texPath of dirty) {
            const entry = paintBufRef.current.get(texPath);
            if (!entry) continue;
            paint.edgeDilate(entry.rgba, entry.w, entry.h, 4);
            entry.tex.update(entry.rgba);
            try {
                await api.savePaintedTexture(projectPath, texPath, entry.rgba, entry.w, entry.h);
                written++;
            } catch (e) {
                errors.push(`${texPath.split(/[\\/]/).pop()}: ${(e as Error).message || e}`);
            }
        }
        dirtyTexRef.current.clear();
        if (errors.length) console.error('[paint] save errors', errors);
        setStatus(`Saved ${written} painted texture${written === 1 ? '' : 's'}` +
            (errors.length ? `, ${errors.length} error(s)` : ''));
    }, [projectPath]);

    // Initial build + rebuild whenever the project changes.
    useEffect(() => { void buildScene(); }, [buildScene]);

    // Resolve the pinned texture's real on-disk path (for Copy / Open in editor).
    useEffect(() => {
        let cancelled = false;
        setPinnedTexPath(null);
        setShowUv(false); // collapse UV view when switching meshes
        if (pinnedInfo?.texturePath) {
            api.resolveMapTexturePath(projectPath, pinnedInfo.texturePath)
                .then(p => { if (!cancelled) setPinnedTexPath(p); })
                .catch(() => { if (!cancelled) setPinnedTexPath(null); });
        }
        return () => { cancelled = true; };
    }, [pinnedInfo, projectPath]);

    // Compute the clicked mesh's triangle UVs (flat u0,v0,u1,v1,u2,v2 …) when the
    // UV view is opened. Reads the mesh's source-submesh index ranges from the
    // builder spans and looks up each vertex's UV in the global pool.
    useEffect(() => {
        if (!showUv || !pinnedInfo) { setUvTris(null); return; }
        const data = dataRef.current;
        const built = builtRef.current.find(b => b.mesh.name === pinnedInfo.meshName);
        if (!data || !built) { setUvTris(null); return; }
        const uvs = data.uvs;
        const idx = data.indices;
        const out: number[] = [];
        for (const span of built.spans) {
            const start = span.globalStartIndex;
            const end = start + span.globalIndexCount;
            for (let i = start; i + 2 < end; i += 3) {
                for (let k = 0; k < 3; k++) {
                    const vi = idx[i + k];
                    out.push(uvs[vi * 2], uvs[vi * 2 + 1]);
                }
            }
        }
        setUvTris(new Float32Array(out));
    }, [showUv, pinnedInfo]);

    // Keep the render-loop ref in sync; when turned off, clear the active tint.
    useEffect(() => {
        highlightOnRef.current = highlightOn;
        if (!highlightOn) {
            const prev = hoverTintRef.current;
            if (prev && !prev.mesh.isDisposed()) {
                const m = prev.mesh.material as PBRMaterial | null;
                if (m) m.emissiveColor = prev.prev;
            }
            hoverTintRef.current = null;
        }
    }, [highlightOn]);

    // ── Live reload via the existing `file-changed` event ────────────────────
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let debounce: ReturnType<typeof setTimeout> | undefined;
        // The Rust preview watcher emits "file-changed" for anything under content/.
        void api.startPreviewWatcher(projectPath).catch(() => {});
        listen<{ path: string; kind: string }>('file-changed', (ev) => {
            const p = ev.payload.path.toLowerCase();
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
                if (p.endsWith('.mapgeo') || p.endsWith('.materials.bin')) {
                    void buildScene();
                } else if (p.endsWith('.tex') || p.endsWith('.dds')) {
                    void reloadChangedTexture(p);
                }
            }, 150);
        }).then(u => { unlisten = u; });
        return () => { if (debounce) clearTimeout(debounce); unlisten?.(); };
    }, [projectPath, buildScene, reloadChangedTexture]);

    // Variants actually present in this map, in canonical order. A variant is
    // "present" if any mesh participates in it (excluding shared-only, which is
    // always Base).
    const presentVariants = MAP_VARIANTS.filter(
        v => v === 'Base' || built.some(b => b.variants.includes(v)),
    );
    // Show the Baron-stage selector only if this map has staged Baron geometry.
    const hasBaronStages = built.some(b => b.baronStage !== null);
    // Meshes for the flat list, with a friendly label and a primary variant tag
    // (the most specific variant the mesh belongs to, for display).
    const meshRows = [...built]
        .map(b => {
            const tex = b.texturePath ?? '';
            const label = tex
                ? tex.split(/[\\/]/).pop()!.replace(/\.(tex|dds)$/i, '')
                : b.mesh.name.replace(/^[^:]+::__notex__/, '');
            // Primary tag: the elemental variant if any, else Base.
            const primary = b.variants.find(v => v !== 'Base') ?? 'Base';
            return { name: b.mesh.name, layer: b.layer, variants: b.variants, primary, label, hasTex: !!b.texturePath };
        })
        .sort((a, b) =>
            a.primary === b.primary ? a.label.localeCompare(b.label) : a.primary.localeCompare(b.primary),
        );

    return (
        <div style={{ position: 'absolute', inset: 0, background: '#1b1b1b' }}>
            <canvas
                ref={canvasRef}
                style={{ width: '100%', height: '100%', display: 'block', outline: 'none' }}
            />

            {/* Layers button (top-right) */}
            {!loading && !error && (
                <button
                    style={{ ...iconBtn, ...(showPanel ? iconBtnActive : {}) }}
                    onClick={() => setShowPanel(p => !p)}
                    title="Layers & variants"
                >☰</button>
            )}

            {/* Paint button (below Layers) */}
            {!loading && !error && (
                <button
                    style={{ ...iconBtn, top: 50, ...(paintMode ? iconBtnActive : {}) }}
                    onClick={() => setPaintMode(p => !p)}
                    title="Paint on the map (brush)"
                >🖌</button>
            )}

            {/* Paint toolbar */}
            {paintMode && !loading && !error && (
                <div style={{ ...panel, top: undefined, bottom: 12, left: 12, right: 'auto', width: 230 }}>
                    <div style={panelHeader}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>Paint{painting ? ' …' : ''}</span>
                        <button style={{ ...textBtn, padding: '2px 8px' }} onClick={() => setPaintMode(false)}>×</button>
                    </div>
                    <div style={panelBody}>
                        <div style={sectionLabel}>Blend</div>
                        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                            {(['Normal', 'Dodge', 'Multiply'] as paint.BlendMode[]).map(m => (
                                <button key={m}
                                    style={{ ...textBtn, flex: 1, padding: '3px 0', background: brush.mode === m ? '#3a5' : undefined }}
                                    onClick={() => setBrush(b => ({ ...b, mode: m }))}
                                >{m}</button>
                            ))}
                        </div>
                        <div style={sectionLabel}>Color</div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                            <input type="color"
                                value={'#' + brush.color.map(c => c.toString(16).padStart(2, '0')).join('')}
                                onChange={e => {
                                    const h = e.target.value;
                                    setBrush(b => ({ ...b, color: [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] }));
                                }} />
                            <button style={{ ...textBtn, flex: 1, background: eyedrop ? '#3a5' : undefined }}
                                onClick={() => setEyedrop(v => !v)}
                                title="Click the map to sample a color"
                            >{eyedrop ? 'Click to pick…' : 'Eyedropper'}</button>
                        </div>
                        {([
                            ['Size', brushSize, 1, 256, (v: number) => setBrushSize(v)],
                            ['Hardness', Math.round(brush.hardness * 100), 0, 100, (v: number) => setBrush(b => ({ ...b, hardness: v / 100 }))],
                            ['Opacity', Math.round(brush.opacity * 100), 0, 100, (v: number) => setBrush(b => ({ ...b, opacity: v / 100 }))],
                            ['Flow', Math.round(brush.flow * 100), 0, 100, (v: number) => setBrush(b => ({ ...b, flow: v / 100 }))],
                        ] as [string, number, number, number, (v: number) => void][]).map(([label, val, min, max, set]) => (
                            <div key={label} style={{ marginBottom: 6 }}>
                                <div style={{ fontSize: 11, color: '#aaa', display: 'flex', justifyContent: 'space-between' }}>
                                    <span>{label}</span><span>{val}</span>
                                </div>
                                <input type="range" min={min} max={max} value={val} style={{ width: '100%' }}
                                    onChange={e => set(Number(e.target.value))} />
                            </div>
                        ))}
                        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                            <button style={{ ...textBtn, flex: 1, padding: '4px 0', opacity: canUndo ? 1 : 0.4 }}
                                disabled={!canUndo} onClick={handleUndo} title="Undo (Ctrl+Z)">↶ Undo</button>
                            <button style={{ ...textBtn, flex: 1, padding: '4px 0', opacity: canRedo ? 1 : 0.4 }}
                                disabled={!canRedo} onClick={handleRedo} title="Redo (Ctrl+Y)">↷ Redo</button>
                        </div>
                        <button style={{ ...textBtn, width: '100%', marginTop: 6, padding: '6px 0', background: '#2a6' }}
                            onClick={handleSavePaint}
                        >Save painted textures</button>
                        <div style={{ fontSize: 10, color: '#888', marginTop: 6 }}>
                            Left-drag to paint. Camera is locked while painting. Ctrl+Z undo.
                        </div>
                    </div>
                </div>
            )}

            {/* Layers panel — fully self-contained inline styles (the standalone
                preview window doesn't reliably inherit the app's component CSS). */}
            {showPanel && (
                <div style={panel}>
                    <div style={panelHeader}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>Layers</span>
                        <button style={{ ...textBtn, padding: '2px 8px' }} onClick={() => setShowPanel(false)}>×</button>
                    </div>

                    <div style={panelBody}>

                        {/* Elemental theme — single active (radio). Base + any
                            elemental variants actually present in this map. */}
                        <div style={sectionLabel}>Elemental theme</div>
                        {(['Base', ...presentVariants.filter(v => v !== 'Base')] as MapVariant[]).map(v => (
                            <label key={v} style={row}>
                                <input
                                    type="radio"
                                    name="map-variant"
                                    checked={activeVariant === v}
                                    onChange={() => selectVariant(v)}
                                />
                                <span style={{ fontWeight: activeVariant === v ? 700 : 400 }}>{v}</span>
                            </label>
                        ))}

                        {/* Baron pit stage — independent axis, only if present. */}
                        {hasBaronStages && (
                            <div style={{ ...row, marginTop: 8, justifyContent: 'space-between' }}>
                                <span style={{ fontSize: 12 }}>Baron pit</span>
                                <select
                                    value={baronStage}
                                    onChange={e => selectBaronStage(e.target.value as BaronStage)}
                                    style={{ background: '#2a2a2a', color: '#ddd', border: '1px solid #444', borderRadius: 4, padding: '2px 6px', fontSize: 12 }}
                                >
                                    {BARON_STAGES.map(s => (
                                        <option key={s} value={s}>{s}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Hover highlight toggle */}
                        <label style={{ ...row, marginTop: 8 }}>
                            <input
                                type="checkbox"
                                checked={highlightOn}
                                onChange={e => setHighlightOn(e.target.checked)}
                            />
                            <span style={{ fontSize: 12 }}>Highlight on hover</span>
                        </label>

                        {/* Per-mesh hide within the current theme. Only meshes
                            actually visible under the active theme are listed. */}
                        {(() => {
                            // List meshes visible under the active theme, filtered by search.
                            const q = meshSearch.trim().toLowerCase();
                            const visibleRows = meshRows.filter(
                                r => layerVisibleForVariant(r.layer, activeVariant)
                                    && (q === '' || r.label.toLowerCase().includes(q)),
                            );
                            return (
                                <>
                                    <div style={{ ...sectionLabel, marginTop: 12 }}>
                                        Meshes ({visibleRows.length})
                                    </div>
                                    <input
                                        type="text"
                                        value={meshSearch}
                                        onChange={(e) => setMeshSearch(e.target.value)}
                                        placeholder="Filter meshes…"
                                        style={{
                                            width: '100%', boxSizing: 'border-box', margin: '0 0 6px',
                                            padding: '4px 8px', fontSize: 12, borderRadius: 4,
                                            border: '1px solid #444', background: '#1e1e1e', color: '#ddd',
                                        }}
                                    />
                                    {visibleRows.map(rowItem => {
                                        const meshHidden = hiddenMeshes.has(rowItem.name);
                                        return (
                                            <label
                                                key={rowItem.name}
                                                style={{ ...row, opacity: meshHidden ? 0.4 : 1 }}
                                                title={rowItem.label}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={!meshHidden}
                                                    onChange={() => toggleMesh(rowItem.name)}
                                                />
                                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                                                    {rowItem.label}
                                                </span>
                                                {rowItem.primary !== 'Base' && (
                                                    <span style={{ fontSize: 10, color: '#888', flexShrink: 0 }}>{rowItem.primary}</span>
                                                )}
                                            </label>
                                        );
                                    })}
                                </>
                            );
                        })()}
                    </div>
                </div>
            )}

            {/* Hover status bar — live identity of the geometry under the cursor */}
            {hoverInfo && (
                <div style={hoverBar}>
                    <span style={{ color: '#fff' }}>{hoverInfo.materialName}</span>
                    <span style={{ color: '#888' }}>{'  ·  '}{hoverInfo.textureFile}</span>
                    <span style={{ color: '#6cf' }}>
                        {'  ·  '}
                        {hoverInfo.baronStage
                            ? `Baron ${hoverInfo.baronStage}`
                            : hoverInfo.variants.filter(v => v !== 'Base')[0] ?? 'Base'}
                    </span>
                </div>
            )}

            {/* Click info card — thumbnail, path, copy, open in editor */}
            {pinnedInfo && (
                <div style={infoCard}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontWeight: 600, fontSize: 12 }}>Texture</span>
                        <button style={{ ...textBtn, padding: '2px 8px' }} onClick={() => setPinnedInfo(null)}>×</button>
                    </div>
                    {pinnedInfo.texturePath && (
                        <TextureThumb projectPath={projectPath} texturePath={pinnedInfo.texturePath} />
                    )}
                    <div style={{ fontSize: 12, color: '#ddd', wordBreak: 'break-all', margin: '6px 0' }}>
                        {pinnedInfo.materialName}
                    </div>
                    <div style={{ fontSize: 11, color: '#9af', wordBreak: 'break-all', marginBottom: 8 }}>
                        {pinnedInfo.texturePath ?? '(no texture)'}
                    </div>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
                        {pinnedInfo.baronStage ? `Baron ${pinnedInfo.baronStage} · ` : ''}
                        {pinnedInfo.variants.join(', ')} · layer 0x{pinnedInfo.layer.toString(16)}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                            style={textBtn}
                            disabled={!pinnedTexPath}
                            onClick={() => { if (pinnedTexPath) void navigator.clipboard.writeText(pinnedTexPath); }}
                        >Copy path</button>
                        <button
                            style={textBtn}
                            disabled={!pinnedTexPath}
                            onClick={() => { if (pinnedTexPath) void api.openWithDefaultApp(pinnedTexPath.replace(/\//g, '\\')); }}
                        >Open in editor</button>
                        <button
                            style={textBtn}
                            onClick={() => toggleMesh(pinnedInfo.meshName)}
                        >{hiddenMeshes.has(pinnedInfo.meshName) ? 'Show mesh' : 'Hide mesh'}</button>
                        <button
                            style={textBtn}
                            onClick={() => setShowUv(v => !v)}
                        >{showUv ? 'Hide UV' : 'Show UV'}</button>
                    </div>
                    {showUv && (
                        <div style={{ marginTop: 8 }}>
                            <UvOverlay
                                projectPath={projectPath}
                                texturePath={pinnedInfo.texturePath}
                                triUVs={uvTris ?? new Float32Array(0)}
                            />
                            <div style={{ fontSize: 10, color: '#888', textAlign: 'center' }}>
                                UV layout · {(uvTris?.length ?? 0) / 6} triangles
                            </div>
                        </div>
                    )}
                </div>
            )}

            {loading && <div style={overlay}>Loading map…</div>}
            {error && <div style={{ ...overlay, color: '#f88' }}>⚠️ {error}</div>}
            {!loading && !error && <div style={badge}>{status}</div>}
        </div>
    );
};

/** Small decoded thumbnail of a map texture, drawn from RGBA into a canvas. */
const TextureThumb: React.FC<{ projectPath: string; texturePath: string }> = ({ projectPath, texturePath }) => {
    const ref = useRef<HTMLCanvasElement | null>(null);
    useEffect(() => {
        let cancelled = false;
        api.loadMapTexture(projectPath, texturePath).then(({ width, height, rgba }) => {
            if (cancelled || !ref.current) return;
            const cv = ref.current;
            cv.width = width; cv.height = height;
            const ctx = cv.getContext('2d');
            if (!ctx) return;
            ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [projectPath, texturePath]);
    return (
        <canvas
            ref={ref}
            style={{ width: '100%', maxHeight: 160, objectFit: 'contain', borderRadius: 4,
                     background: 'repeating-conic-gradient(#2a2a2a 0% 25%, #1b1b1b 0% 50%) 50% / 16px 16px' }}
        />
    );
};

/** Texture with the mesh's UV wireframe drawn over it. `triUVs` is a flat list
 *  of triangle UV coords: u0,v0,u1,v1,u2,v2 per triangle. */
const UvOverlay: React.FC<{ projectPath: string; texturePath: string | null; triUVs: Float32Array }>
    = ({ projectPath, texturePath, triUVs }) => {
    const SIZE = 280; // display canvas size (square)
    const texRef = useRef<HTMLCanvasElement | null>(null);
    const uvRef = useRef<HTMLCanvasElement | null>(null);

    // Draw the texture (or a checkerboard if none) at SIZE×SIZE.
    useEffect(() => {
        let cancelled = false;
        const cv = texRef.current;
        if (!cv) return;
        cv.width = SIZE; cv.height = SIZE;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        // checkerboard base
        ctx.clearRect(0, 0, SIZE, SIZE);
        if (!texturePath) return;
        api.loadMapTexture(projectPath, texturePath).then(({ width, height, rgba }) => {
            if (cancelled || !texRef.current) return;
            // Put the decoded image on an offscreen canvas, then draw scaled to SIZE.
            const off = document.createElement('canvas');
            off.width = width; off.height = height;
            off.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
            const c = texRef.current.getContext('2d');
            c?.drawImage(off, 0, 0, SIZE, SIZE);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [projectPath, texturePath]);

    // Draw the UV wireframe (V flipped so it aligns with the texture as shown).
    useEffect(() => {
        const cv = uvRef.current;
        if (!cv) return;
        cv.width = SIZE; cv.height = SIZE;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.strokeStyle = 'rgba(80, 255, 120, 0.85)';
        ctx.lineWidth = 0.7;
        for (let i = 0; i + 5 < triUVs.length; i += 6) {
            const pts = [
                [triUVs[i] * SIZE, (1 - triUVs[i + 1]) * SIZE],
                [triUVs[i + 2] * SIZE, (1 - triUVs[i + 3]) * SIZE],
                [triUVs[i + 4] * SIZE, (1 - triUVs[i + 5]) * SIZE],
            ];
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            ctx.lineTo(pts[1][0], pts[1][1]);
            ctx.lineTo(pts[2][0], pts[2][1]);
            ctx.closePath();
            ctx.stroke();
        }
    }, [triUVs]);

    return (
        <div style={{ position: 'relative', width: SIZE, maxWidth: '100%', aspectRatio: '1 / 1', margin: '0 auto 6px' }}>
            <canvas ref={texRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', borderRadius: 4,
                background: 'repeating-conic-gradient(#2a2a2a 0% 25%, #1b1b1b 0% 50%) 50% / 16px 16px' }} />
            <canvas ref={uvRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        </div>
    );
};

// ── Self-contained panel styles ─────────────────────────────────────────────
const iconBtn: React.CSSProperties = {
    position: 'absolute', top: 8, right: 8, width: 34, height: 34,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(30,30,30,0.9)', color: '#ddd', border: '1px solid #444',
    borderRadius: 6, cursor: 'pointer', fontSize: 16,
};
const iconBtnActive: React.CSSProperties = { background: '#3a3a3a', color: '#fff', borderColor: '#666' };
const panel: React.CSSProperties = {
    position: 'absolute', top: 50, right: 8, width: 300, maxHeight: 'calc(100% - 60px)',
    display: 'flex', flexDirection: 'column',
    background: 'rgba(24,24,24,0.97)', border: '1px solid #444', borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)', color: '#ddd', font: '13px system-ui',
    overflow: 'hidden',
};
const panelHeader: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 12px', borderBottom: '1px solid #3a3a3a', flexShrink: 0,
};
const panelBody: React.CSSProperties = { padding: '8px 10px', overflowY: 'auto' };
const sectionLabel: React.CSSProperties = {
    fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.6,
    margin: '4px 2px 6px',
};
const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px',
    borderRadius: 4, cursor: 'pointer',
};
const textBtn: React.CSSProperties = {
    background: '#2a2a2a', color: '#ddd', border: '1px solid #444',
    borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 12,
};
const hoverBar: React.CSSProperties = {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    padding: '4px 10px', background: 'rgba(20,20,20,0.92)',
    borderTop: '1px solid #333', color: '#ddd', font: '12px system-ui',
    pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden',
    textOverflow: 'ellipsis',
};
const infoCard: React.CSSProperties = {
    position: 'absolute', bottom: 36, left: 8, width: 300,
    background: 'rgba(24,24,24,0.97)', border: '1px solid #444', borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)', padding: 10, color: '#ddd',
    font: '13px system-ui',
};
