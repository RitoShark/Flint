import { Button } from '../ui/Button';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
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
import {
    createMapTerrainMaterial,
    type MapEnv,
} from '../../lib/babylon/mapTerrainMaterial';
import * as paint from '../../lib/babylon/paintEngine';
import { createUvPass, type UvPass } from '../../lib/babylon/uvPaintPass';

/** Riot's AUTHORED texture address-mode enum -> Babylon.
 *
 *  0 = WRAP, 1 = CLAMP, 2 = MIRROR, 3 = BORDER. This is NOT the D3D enum: the
 *  game indexes [1, 3, 2, 4] into D3D11's 1-based TEXTURE_ADDRESS_MODE, so an
 *  authored 1 becomes D3D 3 (CLAMP) and an authored 2 becomes D3D 2 (MIRROR).
 *  Babylon has no border mode, so BORDER takes clamp-to-edge, the nearest thing.
 *
 *  Only observable where UVs leave [0,1], which is exactly what a tiling map
 *  surface does. 109 of League's 200 map materials bins author these. */
function addressMode(riot: number): number {
    switch (riot) {
        case 1: return Texture.CLAMP_ADDRESSMODE;
        case 2: return Texture.MIRROR_ADDRESSMODE;
        case 3: return Texture.CLAMP_ADDRESSMODE;
        default: return Texture.WRAP_ADDRESSMODE;
    }
}

/** Build a Babylon texture from one batch entry.
 *
 *  LANDMINE: `invertY` is FALSE on both arms, and `mapMeshBuilder` correspondingly
 *  passes UVs through unflipped. Compressed blocks cannot be flipped during upload,
 *  so the GPU-native path pins the D3D convention for the whole map pipeline. The
 *  two halves move together or every surface renders upside down. */
function createMapTexture(
    scene: Scene,
    entry: api.MapTextureEntry,
    addressU: number,
    addressV: number,
    name: string,
): BaseTexture | null {
    if (entry.kind === 'missing') return null;
    let tex: BaseTexture;
    if (entry.kind === 'dds') {
        // The blocks go to the GPU as they sit on disk. Mip levels the file already
        // carries come with them; `noMipmap` only says not to try generating more,
        // which is impossible for a compressed upload anyway.
        tex = new Texture(name, scene, {
            noMipmap: false,
            invertY: false,
            samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
            buffer: entry.dds,
            forcedExtension: '.dds',
        });
    } else {
        tex = RawTexture.CreateRGBATexture(
            entry.rgba, entry.width, entry.height, scene,
            /* generateMipMaps */ true,
            /* invertY */ false,
            Texture.TRILINEAR_SAMPLINGMODE,
        );
        tex.name = name;
    }
    tex.wrapU = addressMode(addressU);
    tex.wrapV = addressMode(addressV);
    // Only what the FILE carries. Forcing this on turned every BC1 surface into an
    // alpha-tested one, so any block the encoder wrote in punch-through mode cut a
    // hole in solid terrain.
    tex.hasAlpha = entry.hasAlpha;
    return tex;
}

/** The engine's albedo is `texture x TintColor x 2`, so an authored 0.5 is neutral
 *  and nearly every material authors exactly that. Foliage is where it matters: brush
 *  cards bind one shared neutral texture and take their whole colour from here.
 *
 *  Renormalising by the peak channel keeps the hue while stopping a material that
 *  authors [1,1,1] - because its real colour comes from a tint TEXTURE this pass does
 *  not bind - from rendering at 2x. */
function tintColor(tint: [number, number, number] | null): Color3 {
    if (!tint) return new Color3(1, 1, 1);
    const [r, g, b] = [tint[0] * 2, tint[1] * 2, tint[2] * 2];
    const peak = Math.max(r, g, b, 1);
    return new Color3(r / peak, g / peak, b / peak);
}

/** A texture's cache identity. The modes belong in it: the same file is used
 *  under two different ones in 182 places across League's maps, and Babylon
 *  addressing is a property of the texture, not of the material. */
function textureKey(path: string, addressU: number, addressV: number): string {
    return `${path}|${addressU}|${addressV}`;
}

interface MapPreviewProps {
    projectPath: string;
}

function loadPref<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(`flint.mappreview.${key}`);
        return raw == null ? fallback : (JSON.parse(raw) as T);
    } catch { return fallback; }
}
function savePref(key: string, value: unknown): void {
    try { localStorage.setItem(`flint.mappreview.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
}

/** Camera speed prefs (sensibilities are DIVISORS: higher = slower). */
interface CamSpeed { rotate: number; pan: number; zoom: number; }
const CAM_DEFAULTS: CamSpeed = { rotate: 1500, pan: 15, zoom: 0.04 };

interface BrushPreset { name: string; brush: paint.Brush; size: number; }

function rgbToHex(c: [number, number, number]): string {
    const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
function hexToRgb(hex: string): [number, number, number] {
    return [parseInt(hex.slice(1, 3), 16) || 0, parseInt(hex.slice(3, 5), 16) || 0, parseInt(hex.slice(5, 7), 16) || 0];
}

interface IdentifyInfo {
    meshName: string;
    materialName: string;
    textureFile: string;
    texturePath: string | null;
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

function useDraggable() {
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
    const drag = useRef<{ dx: number; dy: number } | null>(null);
    const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('button')) return;
        const panel = (e.currentTarget as HTMLElement).parentElement;
        if (!panel) return;
        const r = panel.getBoundingClientRect();
        drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        const onMove = (m: MouseEvent) => {
            if (!drag.current) return;
            setPos({ x: m.clientX - drag.current.dx, y: m.clientY - drag.current.dy });
        };
        const onUp = () => { drag.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        e.preventDefault();
    }, []);
    const dragStyle: React.CSSProperties = pos
        ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
        : {};
    return { dragStyle, onHeaderMouseDown };
}

export const MapPreview: React.FC<MapPreviewProps> = ({ projectPath }) => {
    const paintDrag = useDraggable();
    const cardDrag = useDraggable();
    const camDrag = useDraggable();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const engineRef = useRef<Engine | null>(null);
    const sceneRef = useRef<Scene | null>(null);
    const cameraRef = useRef<ArcRotateCamera | null>(null);
    const meshesRef = useRef<Mesh[]>([]);
    const builtRef = useRef<BuiltMapMesh[]>([]);
    const texCacheRef = useRef<Map<string, BaseTexture>>(new Map());
    const lightmapCacheRef = useRef<Map<string, BaseTexture | null>>(new Map());
    // Compressed upload needs the S3TC extension. Without it every entry comes
    // back as RGBA instead, which is slower but renders identically.
    const preferCompressedRef = useRef(true);
    const paintBufRef = useRef<Map<string, { texs: RawTexture[]; rgba: Uint8Array; orig: Uint8Array; w: number; h: number }>>(new Map());
    const dataRef = useRef<api.MapPreviewData | null>(null);
    const meshByBabylonRef = useRef<Map<Mesh, BuiltMapMesh>>(new Map());
    const hoverTintRef = useRef<{ mesh: Mesh; prev: Color3 } | null>(null);
    const buildGenRef = useRef(0);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState('');
    const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null);
    const [hoverInfo, setHoverInfo] = useState<IdentifyInfo | null>(null);
    const [pinnedInfo, setPinnedInfo] = useState<IdentifyInfo | null>(null);
    const [pinnedTexPath, setPinnedTexPath] = useState<string | null>(null);
    const [showUv, setShowUv] = useState(false);
    const [uvTris, setUvTris] = useState<Float32Array | null>(null);
    const [highlightOn, setHighlightOn] = useState(() => loadPref('highlightOn', true));
    const highlightOnRef = useRef(highlightOn);

    const [camSpeed, setCamSpeed] = useState<CamSpeed>(() => loadPref('camSpeed', CAM_DEFAULTS));
    const camSpeedRef = useRef(camSpeed);
    const [showCamPanel, setShowCamPanel] = useState(false);

    const [presets, setPresets] = useState<BrushPreset[]>(() => loadPref('brushPresets', [] as BrushPreset[]));
    useEffect(() => { savePref('brushPresets', presets); }, [presets]);

    // ── Paint mode ────────────────────────────────────────────────────────────
    const [paintMode, setPaintMode] = useState(false);
    const [brush, setBrush] = useState<paint.Brush>({
        mode: 'Dodge', color: [120, 110, 80], opacity: 0.7, flow: 0.4, hardness: 0.3,
    });
    const [brushSize, setBrushSize] = useState(40);
    const [eyedrop, setEyedrop] = useState(false);
    const [eraser, setEraser] = useState(false);
    const eraserRef = useRef(false);
    useEffect(() => { eraserRef.current = eraser; }, [eraser]);
    const [onlyThisMesh, setOnlyThisMesh] = useState(true);
    const onlyThisMeshRef = useRef(true);
    useEffect(() => { onlyThisMeshRef.current = onlyThisMesh; }, [onlyThisMesh]);
    const [painting, setPainting] = useState(false);
    const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
    const cursorPosRef = useRef<{ x: number; y: number } | null>(null);
    const paintModeRef = useRef(false);
    const brushRef = useRef(brush);
    const brushSizeRef = useRef(brushSize);
    const eyedropRef = useRef(false);
    const dirtyTexRef = useRef<Set<string>>(new Set());
    const uvPassRef = useRef<UvPass | null>(null);
    const strokeSnapRef = useRef<Map<string, Uint8Array>>(new Map());
    const strokeMaskRef = useRef<Map<string, Float32Array>>(new Map());
    const undoStackRef = useRef<Array<Map<string, Uint8Array>>>([]);
    const redoStackRef = useRef<Array<Map<string, Uint8Array>>>([]);
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);
    useEffect(() => { paintModeRef.current = paintMode; }, [paintMode]);
    useEffect(() => { brushRef.current = brush; }, [brush]);
    useEffect(() => { brushSizeRef.current = brushSize; }, [brushSize]);
    useEffect(() => { eyedropRef.current = eyedrop; }, [eyedrop]);

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

    const [built, setBuilt] = useState<BuiltMapMesh[]>([]);
    const [activeVariant, setActiveVariant] = useState<MapVariant>('Base');
    const [baronStage, setBaronStage] = useState<BaronStage>('Default');
    const [hiddenMeshes, setHiddenMeshes] = useState<Set<string>>(new Set());
    const [showPanel, setShowPanel] = useState(false);
    const [meshSearch, setMeshSearch] = useState('');

    // ── Apply (or reuse cached) texture to a material ────────────────────────
    /** Bind already-fetched entries to their materials, creating one texture per
     *  (path, address-mode) pair. The BYTES are shared: a file used under two modes
     *  is fetched once and uploaded twice. */
    const applyEntries = useCallback((
        slots: {
            path: string; u: number; v: number;
            mats: PBRMaterial[]; material: api.MapMaterial | null;
        }[],
        entries: Map<string, api.MapTextureEntry>,
    ) => {
        const sc = sceneRef.current;
        const eng = engineRef.current;
        if (!sc || sc.isDisposed || !eng || eng.isDisposed) return;
        for (const { path, u, v, mats, material } of slots) {
            const cacheKey = textureKey(path, u, v);
            let tex = texCacheRef.current.get(cacheKey);
            if (!tex) {
                const entry = entries.get(path);
                if (!entry) continue;
                const made = createMapTexture(sc, entry, u, v, cacheKey);
                if (!made) {
                    for (const mat of mats) mat.albedoColor = new Color3(1, 0, 1);
                    continue;
                }
                tex = made;
                texCacheRef.current.set(cacheKey, tex);
            }
            for (const mat of mats) {
                mat.albedoTexture = tex;
                mat.albedoColor = tintColor(material?.tint_color ?? null);
                mat.backFaceCulling = false;
                if (!tex.hasAlpha) {
                    mat.transparencyMode = Material.MATERIAL_OPAQUE;
                    continue;
                }
                mat.useAlphaFromAlbedoTexture = true;
                if (material?.translucent) {
                    // Authored alpha-BLEND (water, tarps, nets): composite instead of
                    // hard-cutting, and do not write depth so what is behind shows.
                    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
                    mat.forceDepthWrite = false;
                } else {
                    // ALPHATESTANDBLEND is what actually discards on an unlit PBR
                    // material; plain ALPHATEST renders the cutouts as black boxes.
                    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATESTANDBLEND;
                    mat.alphaCutOff = material?.alpha_test ?? 0.5;
                    mat.forceDepthWrite = true;
                }
            }
        }
    }, []);

    /** Swap every baked-lit mesh onto the game's terrain shader.
     *
     *  Babylon's PBR cannot express `albedo x (lightmap x scale + ndl . shadow . sun)`:
     *  binding the atlas as a `lightmapTexture` runs it through the diffuse BRDF and
     *  loses the shadow mask in alpha, which is why the preview washed out. A mesh
     *  missing its atlas, its diffuse, or its normals keeps the unlit fallback -
     *  that is flat, but flat beats wrong. */
    const applyTerrainLighting = useCallback((
        meshes: BuiltMapMesh[],
        entries: Map<string, api.MapTextureEntry>,
        env: MapEnv,
    ): number => {
        const sc = sceneRef.current;
        if (!sc || sc.isDisposed) return 0;
        const cache = new Map<string, ShaderMaterial>();
        let lit = 0;
        for (const bm of meshes) {
            if (!bm.lightmap || !bm.texturePath || bm.mesh.isDisposed()) continue;
            // Translucent surfaces stay on their blended PBR material; the terrain
            // shader is opaque and would smear the water back into a solid sheet.
            if (bm.material?.translucent) continue;
            const diffuse = texCacheRef.current.get(
                textureKey(bm.texturePath, bm.addressU, bm.addressV),
            );
            if (!diffuse) continue;
            let lm = lightmapCacheRef.current.get(bm.lightmap);
            if (lm === undefined) {
                const entry = entries.get(bm.lightmap);
                lm = entry ? createMapTexture(sc, entry, 1, 1, `lm:${bm.lightmap}`) : null;
                lightmapCacheRef.current.set(bm.lightmap, lm);
            }
            if (!lm) continue;
            const cutoff = diffuse.hasAlpha ? (bm.material?.alpha_test ?? 0.5) : 0;
            const key = `${bm.texturePath}|${bm.lightmap}|${cutoff}`;
            let mat = cache.get(key);
            if (!mat) {
                mat = createMapTerrainMaterial(
                    sc, diffuse, lm, env, bm.material?.tint_color ?? null, cutoff,
                );
                cache.set(key, mat);
            }
            bm.mesh.material?.dispose();
            bm.mesh.material = mat;
            lit++;
        }
        return lit;
    }, []);

    const loadAndApply = useCallback(async (
        texPath: string,
        addressU: number,
        addressV: number,
        mats: PBRMaterial[],
    ) => {
        try {
            const [entry] = await api.loadMapTextures(projectPath, [texPath], preferCompressedRef.current);
            if (!entry) return;
            applyEntries(
                [{ path: texPath, u: addressU, v: addressV, mats, material: null }],
                new Map([[texPath, entry]]),
            );
        } catch (e) {
            console.error('[map-tex] failed', texPath, e);
            for (const mat of mats) mat.albedoColor = new Color3(1, 0, 1);
        }
    }, [projectPath, applyEntries]);

    const applyTexture = useCallback(async (
        mat: PBRMaterial,
        texPath: string,
        addressU: number,
        addressV: number,
    ) => {
        await loadAndApply(texPath, addressU, addressV, [mat]);
    }, [loadAndApply]);

    // ── Visibility model ─────────────────────────────────────────────────────
    const applyVisibility = useCallback(
        (active: MapVariant, stage: BaronStage, hiddenM: Set<string>) => {
            const VARIANT_BIT: Record<string, number> = {
                Infernal: 0x02, Mountain: 0x04, Ocean: 0x08,
                Cloud: 0x10, Hextech: 0x20, Chemtech: 0x40,
            };
            const replacedKeys = new Set<string>();
            if (active !== 'Base') {
                const bit = VARIANT_BIT[active];
                for (const b of builtRef.current) {
                    if (b.layer !== 0xff && (b.layer & 0x01) === 0 && (b.layer & bit) !== 0) {
                        for (const k of b.replaceKeys) replacedKeys.add(k);
                    }
                }
            }
            for (const b of builtRef.current) {
                let visible = layerVisibleForVariant(b.layer, active);
                if (visible && active !== 'Base' && b.layer !== 0xff && (b.layer & 0x01) !== 0) {
                    if (b.replaceKeys.some(k => replacedKeys.has(k))) visible = false;
                }
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
        const gen = ++buildGenRef.current;
        setLoading(true); setError(null);
        try {
            const data = await api.loadMapPreview(projectPath);
            if (gen !== buildGenRef.current || !sceneRef.current) return;
            dataRef.current = data;

            hoverTintRef.current = null;
            setHoverInfo(null);
            meshesRef.current.forEach(m => { m.material?.dispose(); m.dispose(); });
            meshesRef.current = [];

            const builtMeshes = buildMapMeshes(
                {
                    positions: data.positions,
                    normals: data.normals,
                    uvs: data.uvs,
                    uvs2: data.uvs2,
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

            setActiveVariant('Base');
            setBaronStage('Default');
            setHiddenMeshes(new Set());
            applyVisibility('Base', 'Default', new Set());

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
            const cs = camSpeedRef.current;
            camera.panningSensibility = cs.pan;
            camera.angularSensibilityX = cs.rotate;
            camera.angularSensibilityY = cs.rotate;
            camera.wheelDeltaPercentage = cs.zoom;
            camera.inertia = 0.7;
            camera.minZ = 1;
            camera.maxZ = Math.max(size * 8, 10000);

            const byTexture = new Map<string, {
                path: string; u: number; v: number;
                mats: PBRMaterial[]; material: api.MapMaterial | null;
            }>();
            for (const { mesh, texturePath, addressU, addressV, material } of builtMeshes) {
                const mat = new PBRMaterial(mesh.name + '_mat', scene);
                mat.unlit = true;
                mat.metallic = 0;
                mat.roughness = 1;
                mat.environmentIntensity = 0;
                mat.backFaceCulling = false;
                mat.albedoColor = new Color3(0.5, 0.5, 0.5);
                mesh.material = mat;
                if (texturePath) {
                    const key = textureKey(texturePath, addressU, addressV);
                    const slot = byTexture.get(key);
                    if (slot) slot.mats.push(mat);
                    else {
                        byTexture.set(key, {
                            path: texturePath, u: addressU, v: addressV,
                            mats: [mat], material,
                        });
                    }
                }
            }

            const uniqueTextures = [...byTexture.values()];
            const uniquePaths = [...new Set(uniqueTextures.map(t => t.path))];
            setStatus(
                `${data.variant} · ${builtMeshes.length} meshes · loading ${uniquePaths.length} textures`,
            );
            setLoading(false);

            // Every model on a League map is baked-lit, and the atlas is named by the
            // GEOMETRY, not the materials bin. Without it a surface is flat albedo -
            // which on big terrain slabs reads as "untextured, just coloured".
            const lightmapPaths = [...new Set(
                builtMeshes.map(b => b.lightmap).filter((p): p is string => !!p),
            )];

            // ONE round trip for the whole variant. This used to be one IPC call per
            // texture at concurrency 4, each decoding to RGBA: 192 calls and 585 MB
            // on the wire for Bilgewater, against 105 MB of compressed blocks.
            void (async () => {
                try {
                    const wanted = [...uniquePaths, ...lightmapPaths];
                    const entries = await api.loadMapTextures(
                        projectPath, wanted, preferCompressedRef.current,
                    );
                    if (gen !== buildGenRef.current || !sceneRef.current) return;
                    const byPath = new Map<string, api.MapTextureEntry>();
                    wanted.forEach((path, i) => byPath.set(path, entries[i]));
                    applyEntries(uniqueTextures, byPath);
                    const lit = applyTerrainLighting(builtMeshes, byPath, data.env);
                    setStatus(
                        `${data.variant} · ${builtMeshes.length} meshes · ${uniquePaths.length} textures`
                        + (lightmapPaths.length ? ` · ${lit} baked-lit` : ''),
                    );
                } catch (e) {
                    console.error('[map-tex] batch failed', e);
                    setStatus(`${data.variant} · ${builtMeshes.length} meshes · textures failed`);
                }
            })();
        } catch (e) {
            setError((e as Error).message || 'Failed to load map');
            setLoading(false);
        }
    }, [projectPath, applyEntries, applyTerrainLighting, applyVisibility]);

    const reloadChangedTexture = useCallback(async (changedLowerPath: string) => {
        const base = changedLowerPath.split(/[\\/]/).pop() || '';
        if (!base) return;
        for (const b of builtRef.current) {
            const texPath = b.texturePath;
            if (!texPath) continue;
            if (!texPath.toLowerCase().endsWith(base)) continue;
            const key = textureKey(texPath, b.addressU, b.addressV);
            texCacheRef.current.get(key)?.dispose();
            texCacheRef.current.delete(key);
            paintBufRef.current.delete(texPath);
            if (b.mesh.material) {
                await applyTexture(b.mesh.material as PBRMaterial, texPath, b.addressU, b.addressV);
            }
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
        preferCompressedRef.current = !!engine.getCaps().s3tc;
        const scene = new Scene(engine);
        sceneRef.current = scene;
        scene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0);

        const camera = new ArcRotateCamera('cam', Math.PI / 2, Math.PI / 3, 1000, Vector3.Zero(), scene);
        camera.attachControl(canvas, true);
        {
            const cs = camSpeedRef.current;
            camera.angularSensibilityX = cs.rotate;
            camera.angularSensibilityY = cs.rotate;
            camera.panningSensibility = cs.pan;
            camera.wheelDeltaPercentage = cs.zoom;
        }
        camera.inertia = 0.7;
        cameraRef.current = camera;

        uvPassRef.current = createUvPass(scene);

        const light = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
        // Zero: a baked-lit mesh leaves `unlit`, so any real light here would ADD a
        // second diffuse term on top of the atlas and wash the baked shading out.
        // Meshes with no atlas stay unlit and never consult it either way.
        light.intensity = 0;
        light.specular = new Color3(0, 0, 0);

        const handleContextMenu = (e: MouseEvent) => e.preventDefault();
        canvas.addEventListener('contextmenu', handleContextMenu);

        let hoverDirty = false;
        let lastHoverMesh: Mesh | null = null;
        let lastHoverKey = '';
        let paintDown = false;

        const paintScreenAt = (px: number, py: number) => {
            const pick = scene.pick(px, py);
            if (!pick?.hit || !pick.pickedMesh) return;
            const pickedBuilt = meshByBabylonRef.current.get(pick.pickedMesh as Mesh);

            if (eyedropRef.current) {
                const uv = pick.getTextureCoordinates?.();
                const eEntry = pickedBuilt?.texturePath ? paintBufRef.current.get(pickedBuilt.texturePath) : undefined;
                if (uv && eEntry) {
                    const tx = uv.x * eEntry.w, ty = uv.y * eEntry.h;
                    const i = (Math.min(eEntry.h - 1, Math.max(0, Math.floor(ty))) * eEntry.w
                        + Math.min(eEntry.w - 1, Math.max(0, Math.floor(tx)))) * 4;
                    setBrush(b => ({ ...b, color: [eEntry.rgba[i], eEntry.rgba[i + 1], eEntry.rgba[i + 2]] }));
                    setEyedrop(false);
                }
                return;
            }

            const radiusPx = brushSizeRef.current;
            const b = brushRef.current;
            const hsl = engine.getHardwareScalingLevel();
            const rpx = px / hsl, rpy = py / hsl, rRad = radiusPx / hsl;

            let pass = uvPassRef.current;
            if (pass && (pass.width() !== engine.getRenderWidth() || pass.height() !== engine.getRenderHeight())) {
                pass.dispose();
                pass = uvPassRef.current = createUvPass(scene);
            }
            if (!pass) return;

            const onlyTex = onlyThisMeshRef.current ? pickedBuilt?.texturePath ?? null : null;
            const texPaths: string[] = [];
            const texIndex = new Map<string, number>();
            const groups: { texId: number; meshes: Mesh[] }[] = [];
            for (const bm of builtRef.current) {
                if (!bm.texturePath || bm.mesh.isDisposed() || !bm.mesh.isEnabled()) continue;
                if (!paintBufRef.current.has(bm.texturePath)) continue;
                if (onlyTex && bm.texturePath !== onlyTex) continue;
                let id = texIndex.get(bm.texturePath);
                if (id === undefined) {
                    id = texPaths.length; texPaths.push(bm.texturePath); texIndex.set(bm.texturePath, id);
                    groups.push({ texId: id, meshes: [] });
                }
                groups[id].meshes.push(bm.mesh);
            }
            if (!groups.length) return;
            pass.renderGroups(groups);

            const x0 = Math.max(0, Math.floor(rpx - rRad));
            const y0 = Math.max(0, Math.floor(rpy - rRad));
            const x1 = Math.min(pass.width() - 1, Math.ceil(rpx + rRad));
            const y1 = Math.min(pass.height() - 1, Math.ceil(rpy + rRad));
            const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
            if (rw <= 0 || rh <= 0) return;
            const region = pass.read(x0, y0, rw, rh);
            if (!region) return;

            const decode = (rx: number, ry: number) => {
                if (rx < 0 || rx >= rw || ry < 0 || ry >= rh) return null;
                const o = (ry * rw + rx) * 4;
                if (region[o + 3] <= 0) return null;
                const id = Math.round(region[o + 2]);
                const texPath = texPaths[id];
                if (!texPath) return null;
                const entry = paintBufRef.current.get(texPath);
                if (!entry) return null;
                return { texPath, entry, tx: region[o] * entry.w, ty: (1 - region[o + 1]) * entry.h };
            };

            const touched = new Set<string>();
            for (let ry = 0; ry < rh; ry++) {
                for (let rx = 0; rx < rw; rx++) {
                    const d = decode(rx, ry);
                    if (!d) continue;
                    const sx = x0 + rx, sy = y0 + ry;
                    const sd = Math.hypot(sx - rpx, sy - rpy);
                    if (sd > rRad) continue;
                    const f = paint.falloff(sd, rRad, b.hardness);
                    if (f <= 0) continue;
                    const { texPath, entry } = d;
                    if (!strokeSnapRef.current.has(texPath)) {
                        strokeSnapRef.current.set(texPath, new Uint8Array(entry.rgba));
                    }
                    let mask = strokeMaskRef.current.get(texPath);
                    if (!mask) { mask = new Float32Array(entry.w * entry.h); strokeMaskRef.current.set(texPath, mask); }
                    const SEAM = 24;
                    const right = decode(rx + 1, ry), down = decode(rx, ry + 1);
                    let span = 1.5;
                    if (right && right.texPath === texPath) {
                        const g = Math.hypot(right.tx - d.tx, right.ty - d.ty);
                        if (g <= SEAM) span = Math.max(span, g);
                    }
                    if (down && down.texPath === texPath) {
                        const g = Math.hypot(down.tx - d.tx, down.ty - d.ty);
                        if (g <= SEAM) span = Math.max(span, g);
                    }
                    const dabR = Math.min(span * 0.7, SEAM);
                    paint.stampMask(mask, entry.w, entry.h, d.tx, d.ty, dabR, 1, b.opacity, b.flow * f);
                    touched.add(texPath);
                }
            }
            for (const texPath of touched) {
                const entry = paintBufRef.current.get(texPath)!;
                const mask = strokeMaskRef.current.get(texPath)!;
                const base0 = strokeSnapRef.current.get(texPath)!;
                if (eraserRef.current) {
                    paint.compositeErase(entry.rgba, base0, entry.orig, mask, entry.w, entry.h);
                } else {
                    paint.compositeMask(entry.rgba, base0, mask, entry.w, entry.h, b.mode, b.color);
                }
                entry.texs.forEach(t => t.update(entry.rgba));
                dirtyTexRef.current.add(texPath);
            }
        };

        const lastScreenRef = { x: 0, y: 0, has: false };
        const paintAtCursor = () => {
            const px = scene.pointerX, py = scene.pointerY;
            if (eyedropRef.current) { paintScreenAt(px, py); return; }
            if (!lastScreenRef.has) { lastScreenRef.x = px; lastScreenRef.y = py; lastScreenRef.has = true; }
            const r = brushSizeRef.current;
            for (const [sx, sy] of paint.strokeDabs([lastScreenRef.x, lastScreenRef.y], [px, py], r)) {
                paintScreenAt(sx, sy);
            }
            lastScreenRef.x = px; lastScreenRef.y = py;
        };
        const resetStroke = () => { lastScreenRef.has = false; };

        scene.onPointerObservable.add((pi) => {
            if (paintModeRef.current) {
                cursorPosRef.current = { x: scene.pointerX, y: scene.pointerY };
                if (pi.type === PointerEventTypes.POINTERDOWN) {
                    paintDown = true;
                    resetStroke();
                    strokeSnapRef.current = new Map();
                    strokeMaskRef.current = new Map();
                    setPainting(true);
                    paintAtCursor();
                } else if (pi.type === PointerEventTypes.POINTERMOVE) {
                    if (paintDown) paintAtCursor();
                } else if (pi.type === PointerEventTypes.POINTERUP) {
                    paintDown = false;
                    resetStroke();
                    setPainting(false);
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

        const pickHover = () => {
            if (paintModeRef.current) return;
            if (!hoverDirty) return;
            hoverDirty = false;
            const pick = scene.pick(scene.pointerX, scene.pointerY);
            const mesh = (pick?.hit && pick.pickedMesh) ? (pick.pickedMesh as Mesh) : null;
            const built = mesh ? meshByBabylonRef.current.get(mesh) : undefined;

            if (mesh !== lastHoverMesh) {
                const prev = hoverTintRef.current;
                if (prev && !prev.mesh.isDisposed()) {
                    const m = prev.mesh.material as PBRMaterial | null;
                    if (m) m.emissiveColor = prev.prev;
                }
                hoverTintRef.current = null;
                if (mesh && built && highlightOnRef.current) {
                    const m = mesh.material as PBRMaterial | null;
                    if (m) {
                        hoverTintRef.current = { mesh, prev: m.emissiveColor.clone() };
                        m.emissiveColor = new Color3(0.35, 0.28, 0.05);
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
            uvPassRef.current?.dispose();
            uvPassRef.current = null;
            meshesRef.current.forEach(m => { m.material?.dispose(); m.dispose(); });
            meshesRef.current = [];
            engine.dispose();
            engineRef.current = null;
            sceneRef.current = null;
            cameraRef.current = null;
        };
    }, []);

    useEffect(() => {
        const cam = cameraRef.current;
        const canvas = canvasRef.current;
        if (!cam || !canvas) return;
        if (paintMode) cam.detachControl();
        else cam.attachControl(canvas, true);
    }, [paintMode]);

    // Painting needs CPU pixels, and a compressed texture has none. The buffers are
    // built only when paint mode is actually entered: the display path uploads ~105 MB
    // of blocks, while the RGBA these need is ~585 MB for one Bilgewater variant.
    useEffect(() => {
        if (!paintMode) return;
        let cancelled = false;
        void (async () => {
            const wanted = new Map<string, { path: string; u: number; v: number; mats: PBRMaterial[] }>();
            for (const bm of builtRef.current) {
                if (!bm.texturePath || bm.mesh.isDisposed() || !bm.mesh.isEnabled()) continue;
                if (paintBufRef.current.has(bm.texturePath)) continue;
                const key = textureKey(bm.texturePath, bm.addressU, bm.addressV);
                const mat = bm.mesh.material as PBRMaterial | null;
                if (!mat) continue;
                const slot = wanted.get(key);
                if (slot) slot.mats.push(mat);
                else wanted.set(key, { path: bm.texturePath, u: bm.addressU, v: bm.addressV, mats: [mat] });
            }
            const slots = [...wanted.values()];
            const paths = [...new Set(slots.map(sl => sl.path))];
            if (!paths.length) return;
            setStatus(`Preparing ${paths.length} textures for painting…`);
            try {
                // preferCompressed false: the stroke writes into these pixels.
                const entries = await api.loadMapTextures(projectPath, paths, false);
                if (cancelled || !sceneRef.current) return;
                const byPath = new Map<string, api.MapTextureEntry>();
                paths.forEach((path, i) => byPath.set(path, entries[i]));
                const sc = sceneRef.current;
                for (const { path, u, v, mats } of slots) {
                    const entry = byPath.get(path);
                    if (!entry || entry.kind !== 'rgba') continue;
                    const key = textureKey(path, u, v);
                    texCacheRef.current.get(key)?.dispose();
                    const tex = RawTexture.CreateRGBATexture(
                        entry.rgba, entry.width, entry.height, sc,
                        /* generateMipMaps */ true,
                        /* invertY */ false,
                        Texture.TRILINEAR_SAMPLINGMODE,
                    );
                    tex.wrapU = addressMode(u);
                    tex.wrapV = addressMode(v);
                    tex.hasAlpha = true;
                    tex.name = key;
                    texCacheRef.current.set(key, tex);
                    for (const mat of mats) mat.albedoTexture = tex;
                    const buf = paintBufRef.current.get(path);
                    if (buf) {
                        buf.texs.push(tex);
                    } else {
                        paintBufRef.current.set(path, {
                            texs: [tex],
                            rgba: new Uint8Array(entry.rgba),
                            orig: new Uint8Array(entry.rgba),
                            w: entry.width,
                            h: entry.height,
                        });
                    }
                }
                setStatus(`Ready to paint · ${paths.length} textures`);
            } catch (e) {
                console.error('[paint] could not prepare textures', e);
                setStatus('Could not prepare textures for painting');
            }
        })();
        return () => { cancelled = true; };
    }, [paintMode, projectPath]);

    useEffect(() => {
        if (!paintMode) { setCursorPos(null); return; }
        const id = setInterval(() => {
            const c = cursorPosRef.current;
            setCursorPos(c ? { x: c.x, y: c.y } : null);
        }, 16);
        return () => clearInterval(id);
    }, [paintMode]);

    const swapSnapshot = useCallback((snap: Map<string, Uint8Array>): Map<string, Uint8Array> => {
        const replaced = new Map<string, Uint8Array>();
        for (const [texPath, before] of snap) {
            const entry = paintBufRef.current.get(texPath);
            if (!entry) continue;
            replaced.set(texPath, new Uint8Array(entry.rgba));
            entry.rgba.set(before);
            entry.texs.forEach(t => t.update(entry.rgba));
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

    const handleSavePaint = useCallback(async () => {
        const dirty = Array.from(dirtyTexRef.current);
        if (!dirty.length || saveProgress) return;
        let written = 0; const errors: string[] = [];
        setSaveProgress({ done: 0, total: dirty.length });
        try {
            for (let i = 0; i < dirty.length; i++) {
                const texPath = dirty[i];
                const entry = paintBufRef.current.get(texPath);
                if (entry) {
                    paint.edgeDilate(entry.rgba, entry.w, entry.h, 4);
                    entry.texs.forEach(t => t.update(entry.rgba));
                    try {
                        await api.savePaintedTexture(projectPath, texPath, entry.rgba, entry.w, entry.h);
                        written++;
                    } catch (e) {
                        errors.push(`${texPath.split(/[\\/]/).pop()}: ${(e as Error).message || e}`);
                    }
                }
                setSaveProgress({ done: i + 1, total: dirty.length });
                await new Promise(r => requestAnimationFrame(() => r(null)));
            }
        } finally {
            setSaveProgress(null);
        }
        dirtyTexRef.current.clear();
        if (errors.length) console.error('[paint] save errors', errors);
        setStatus(`Saved ${written} painted texture${written === 1 ? '' : 's'}` +
            (errors.length ? `, ${errors.length} error(s)` : ''));
    }, [projectPath, saveProgress]);

    useEffect(() => { void buildScene(); }, [buildScene]);

    useEffect(() => {
        let cancelled = false;
        setPinnedTexPath(null);
        setShowUv(false);
        if (pinnedInfo?.texturePath) {
            api.resolveMapTexturePath(projectPath, pinnedInfo.texturePath)
                .then(p => { if (!cancelled) setPinnedTexPath(p); })
                .catch(() => { if (!cancelled) setPinnedTexPath(null); });
        }
        return () => { cancelled = true; };
    }, [pinnedInfo, projectPath]);

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

    useEffect(() => {
        highlightOnRef.current = highlightOn;
        savePref('highlightOn', highlightOn);
        if (!highlightOn) {
            const prev = hoverTintRef.current;
            if (prev && !prev.mesh.isDisposed()) {
                const m = prev.mesh.material as PBRMaterial | null;
                if (m) m.emissiveColor = prev.prev;
            }
            hoverTintRef.current = null;
        }
    }, [highlightOn]);

    useEffect(() => {
        camSpeedRef.current = camSpeed;
        savePref('camSpeed', camSpeed);
        const cam = cameraRef.current;
        if (cam) {
            cam.angularSensibilityX = camSpeed.rotate;
            cam.angularSensibilityY = camSpeed.rotate;
            cam.panningSensibility = camSpeed.pan;
            cam.wheelDeltaPercentage = camSpeed.zoom;
        }
    }, [camSpeed]);

    // ── Live reload via the existing `file-changed` event ────────────────────
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let debounce: ReturnType<typeof setTimeout> | undefined;
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

    const presentVariants = MAP_VARIANTS.filter(
        v => v === 'Base' || built.some(b => b.variants.includes(v)),
    );
    const hasBaronStages = built.some(b => b.baronStage !== null);
    const meshRows = [...built]
        .map(b => {
            const tex = b.texturePath ?? '';
            const label = tex
                ? tex.split(/[\\/]/).pop()!.replace(/\.(tex|dds)$/i, '')
                : b.mesh.name.replace(/^[^:]+::__notex__/, '');
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
                style={{ width: '100%', height: '100%', display: 'block', outline: 'none',
                         cursor: paintMode ? 'none' : 'default' }}
            />

            {paintMode && cursorPos && (() => {
                const ringColor = eyedrop ? '#5cf' : eraser ? '#f88'
                    : `rgb(${brush.color[0]},${brush.color[1]},${brush.color[2]})`;
                const fill = (eyedrop || eraser) ? 'transparent'
                    : `rgba(${brush.color[0]},${brush.color[1]},${brush.color[2]},0.28)`;
                return (
                    <div style={{
                        position: 'absolute',
                        left: cursorPos.x - brushSize,
                        top: cursorPos.y - brushSize,
                        width: brushSize * 2,
                        height: brushSize * 2,
                        borderRadius: '50%',
                        border: `2px solid ${ringColor}`,
                        background: fill,
                        boxShadow: '0 0 0 1px rgba(0,0,0,0.7) inset, 0 0 0 1px rgba(0,0,0,0.7)',
                        pointerEvents: 'none',
                        zIndex: 5,
                    }} />
                );
            })()}

            {!loading && !error && (
                <Button size="sm"
                    style={{ position: 'absolute', top: 8, right: 8 }} iconOnly active={showPanel}
                    onClick={() => setShowPanel(p => !p)}
                    title="Layers & variants"
                >☰</Button>
            )}

            {!loading && !error && (
                <Button size="sm"
                    style={{ position: 'absolute', right: 8, top: 50 }} iconOnly active={paintMode}
                    onClick={() => setPaintMode(p => !p)}
                    title="Paint on the map (brush)"
                >🖌</Button>
            )}

            {!loading && !error && (
                <Button size="sm"
                    style={{ position: 'absolute', right: 8, top: 90 }} iconOnly active={showCamPanel}
                    onClick={() => setShowCamPanel(p => !p)}
                    title="Camera speed settings"
                >⚙</Button>
            )}

            {showCamPanel && !loading && !error && (
                <div style={{ ...panel, top: 90, right: 50, width: 220, ...camDrag.dragStyle }}>
                    <div style={{ ...panelHeader, cursor: 'move' }} onMouseDown={camDrag.onHeaderMouseDown}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>Camera speed</span>
                        <Button size="sm"  onClick={() => setShowCamPanel(false)}>×</Button>
                    </div>
                    <div style={panelBody}>
                        {([
                            ['Rotate', Math.round(20000 / camSpeed.rotate), (v: number) => setCamSpeed(s => ({ ...s, rotate: Math.round(20000 / Math.max(1, v)) }))],
                            ['Pan', Math.round(300 / camSpeed.pan), (v: number) => setCamSpeed(s => ({ ...s, pan: Math.max(1, Math.round(300 / Math.max(1, v))) }))],
                            ['Zoom', Math.round(camSpeed.zoom * 1000), (v: number) => setCamSpeed(s => ({ ...s, zoom: Math.max(0.005, v / 1000) }))],
                        ] as [string, number, (v: number) => void][]).map(([label, val, set]) => (
                            <div key={label} style={{ marginBottom: 8 }}>
                                <div style={{ fontSize: 11, color: '#aaa', display: 'flex', justifyContent: 'space-between' }}>
                                    <span>{label}</span><span>{val}</span>
                                </div>
                                <input type="range" min={1} max={100} value={Math.max(1, Math.min(100, val))} style={{ width: '100%' }}
                                    onChange={e => set(Number(e.target.value))} />
                            </div>
                        ))}
                        <Button size="sm" style={{ width: '100%' }}
                            onClick={() => setCamSpeed(CAM_DEFAULTS)}>Reset to defaults</Button>
                        <div style={{ fontSize: 10, color: '#888', marginTop: 6 }}>
                            Left-drag = rotate · Right-drag = pan · Wheel = zoom. Saved automatically.
                        </div>
                    </div>
                </div>
            )}

            {paintMode && !loading && !error && (
                <div style={{ ...panel, top: undefined, bottom: 12, left: 12, right: 'auto', width: 230, ...paintDrag.dragStyle }}>
                    <div style={{ ...panelHeader, cursor: 'move' }} onMouseDown={paintDrag.onHeaderMouseDown}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>Paint{painting ? ' …' : ''}</span>
                        <Button size="sm"  onClick={() => setPaintMode(false)}>×</Button>
                    </div>
                    <div style={panelBody}>
                        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                            <Button size="sm"
                                style={{ flex: 1 }} active={!eraser}
                                onClick={() => setEraser(false)}
                            >🖌 Brush</Button>
                            <Button size="sm"
                                style={{ flex: 1 }} active={eraser}
                                onClick={() => setEraser(true)}
                                title="Erase painted pixels back to the original texture"
                            >🧽 Eraser</Button>
                        </div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 8, cursor: 'pointer' }}>
                            <input type="checkbox" checked={onlyThisMesh} onChange={e => setOnlyThisMesh(e.target.checked)} />
                            Only this mesh (don't paint others under the brush)
                        </label>
                        <div style={sectionLabel}>Blend</div>
                        <div style={{ display: 'flex', gap: 4, marginBottom: 8, opacity: eraser ? 0.4 : 1 }}>
                            {(['Normal', 'Dodge', 'Multiply'] as paint.BlendMode[]).map(m => (
                                <Button size="sm" key={m} disabled={eraser}
                                    style={{ flex: 1 }} active={brush.mode === m}
                                    onClick={() => setBrush(b => ({ ...b, mode: m }))}
                                >{m}</Button>
                            ))}
                        </div>
                        <div style={sectionLabel}>Color</div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                            <span style={{
                                width: 28, height: 28, borderRadius: 4, flexShrink: 0,
                                background: `rgb(${brush.color[0]},${brush.color[1]},${brush.color[2]})`,
                                border: '1px solid #666',
                            }} title={`rgb(${brush.color[0]}, ${brush.color[1]}, ${brush.color[2]})`} />
                            <input type="color"
                                style={{ width: 28, height: 28, padding: 0, border: '1px solid #666', borderRadius: 4, background: 'none', cursor: 'pointer' }}
                                value={rgbToHex(brush.color)}
                                onChange={e => setBrush(b => ({ ...b, color: hexToRgb(e.target.value) }))} />
                            <Button size="sm" style={{ flex: 1 }} active={eyedrop}
                                onClick={() => setEyedrop(v => !v)}
                                title="Click the map to sample a color"
                            >{eyedrop ? 'Click to pick…' : 'Eyedropper'}</Button>
                        </div>
                        {([
                            ['Size (px)', brushSize, 2, 300, (v: number) => setBrushSize(v)],
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
                        <div style={{ ...sectionLabel, marginTop: 10 }}>Presets</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 6 }}>
                            {presets.length === 0 && (
                                <div style={{ fontSize: 10, color: '#777' }}>No presets saved yet.</div>
                            )}
                            {presets.map((p, i) => (
                                <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                    <span style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                                        background: `rgb(${p.brush.color[0]},${p.brush.color[1]},${p.brush.color[2]})`, border: '1px solid #555' }} />
                                    <Button size="sm" style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                        title={`${p.brush.mode} · size ${p.size}`}
                                        onClick={() => { setBrush(p.brush); setBrushSize(p.size); setEraser(false); }}
                                    >{p.name}</Button>
                                    <Button size="sm"
                                        title="Delete preset"
                                        onClick={() => setPresets(ps => ps.filter((_, j) => j !== i))}
                                    >×</Button>
                                </div>
                            ))}
                        </div>
                        <Button size="sm" style={{ width: '100%', marginBottom: 6 }}
                            onClick={() => {
                                const name = window.prompt('Preset name:', `${brush.mode} ${brushSize}px`);
                                if (name) setPresets(ps => [...ps, { name, brush: { ...brush }, size: brushSize }]);
                            }}
                        >+ Save current as preset</Button>

                        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                            <Button size="sm" style={{ flex: 1 }}
                                disabled={!canUndo} onClick={handleUndo} title="Undo (Ctrl+Z)">↶ Undo</Button>
                            <Button size="sm" style={{ flex: 1 }}
                                disabled={!canRedo} onClick={handleRedo} title="Redo (Ctrl+Y)">↷ Redo</Button>
                        </div>
                        <Button size="sm" style={{ width: '100%', marginTop: 6 }} variant="success"
                            disabled={!!saveProgress}
                            onClick={handleSavePaint}
                        >{saveProgress ? `Saving ${saveProgress.done}/${saveProgress.total}…` : 'Save painted textures'}</Button>
                        {saveProgress && (
                            <div style={{ marginTop: 6 }}>
                                <div style={{ height: 6, borderRadius: 3, background: '#333', overflow: 'hidden' }}>
                                    <div style={{
                                        height: '100%', width: `${(saveProgress.done / Math.max(1, saveProgress.total)) * 100}%`,
                                        background: '#2a6', transition: 'width 120ms linear',
                                    }} />
                                </div>
                            </div>
                        )}
                        <div style={{ fontSize: 10, color: '#888', marginTop: 6 }}>
                            Left-drag to paint. Camera is locked while painting. Ctrl+Z undo.
                        </div>
                    </div>
                </div>
            )}

            {showPanel && (
                <div style={panel}>
                    <div style={panelHeader}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>Layers</span>
                        <Button size="sm"  onClick={() => setShowPanel(false)}>×</Button>
                    </div>

                    <div style={panelBody}>

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

                        <label style={{ ...row, marginTop: 8 }}>
                            <input
                                type="checkbox"
                                checked={highlightOn}
                                onChange={e => setHighlightOn(e.target.checked)}
                            />
                            <span style={{ fontSize: 12 }}>Highlight on hover</span>
                        </label>

                        {(() => {
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

            {pinnedInfo && (
                <div style={{ ...infoCard, ...cardDrag.dragStyle }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, cursor: 'move' }} onMouseDown={cardDrag.onHeaderMouseDown}>
                        <span style={{ fontWeight: 600, fontSize: 12 }}>Texture</span>
                        <Button size="sm"  onClick={() => setPinnedInfo(null)}>×</Button>
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
                        <Button size="sm"

                            disabled={!pinnedTexPath}
                            onClick={() => { if (pinnedTexPath) void navigator.clipboard.writeText(pinnedTexPath); }}
                        >Copy path</Button>
                        <Button size="sm"

                            disabled={!pinnedTexPath}
                            onClick={() => { if (pinnedTexPath) void api.openWithDefaultApp(pinnedTexPath.replace(/\//g, '\\')); }}
                        >Open in editor</Button>
                        <Button size="sm"

                            onClick={() => toggleMesh(pinnedInfo.meshName)}
                        >{hiddenMeshes.has(pinnedInfo.meshName) ? 'Show mesh' : 'Hide mesh'}</Button>
                        <Button size="sm"

                            onClick={() => setShowUv(v => !v)}
                        >{showUv ? 'Hide UV' : 'Show UV'}</Button>
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
    const SIZE = 280;
    const texRef = useRef<HTMLCanvasElement | null>(null);
    const uvRef = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        let cancelled = false;
        const cv = texRef.current;
        if (!cv) return;
        cv.width = SIZE; cv.height = SIZE;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, SIZE, SIZE);
        if (!texturePath) return;
        api.loadMapTexture(projectPath, texturePath).then(({ width, height, rgba }) => {
            if (cancelled || !texRef.current) return;
            const off = document.createElement('canvas');
            off.width = width; off.height = height;
            off.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
            const c = texRef.current.getContext('2d');
            c?.drawImage(off, 0, 0, SIZE, SIZE);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [projectPath, texturePath]);

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
