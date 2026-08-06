import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Material } from '@babylonjs/core/Materials/material';
import { Vector3 } from '@babylonjs/core/Maths/math';

import * as api from '../../lib/api';
import { useAction, useScope } from '../../lib/shortcuts/hooks';
import { useAppMetadataStore } from '../../lib/stores';
import { getIcon } from '../../lib/ui-helpers/fileIcons';

import { createSknScene, type SknSceneHandle, type SknSkeletonMetadata } from '../../lib/babylon/sknScene';
import { AnimationPlayer } from '../../lib/babylon/animationPlayer';
import { SubmeshVisibilityTimeline, fnv1a32Lower } from '../../lib/babylon/submeshVisibility';
import type { AnimationClipInfo, SkinForm, SubmeshVisEvent } from '../../lib/api/mesh';
import { modelPreviewSessionStore, type ModelPreviewSession } from '../../lib/stores/modelPreviewSessionStore';
import { shaderForgeAvailable, loadShaderForge } from '@shaderforge';

// ============================================================================
// Types
// ============================================================================

type SknMeshData = api.SknMeshData;
type ScbMeshData = api.ScbMeshData;
type MeshData = SknMeshData | ScbMeshData;

interface ModelPreviewProps {
    filePath: string;
    meshType?: 'skinned' | 'static';  // skinned = SKN, static = SCB/SCO
    /** Pre-select this animation_path on load (standalone .anm open). */
    initialAnimation?: string;
    /** Start playing the initial animation immediately. */
    autoPlay?: boolean;
}

// ============================================================================
// Main Component
// ============================================================================

const SETTINGS_KEY = 'flint-model-preview-settings';

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

/**
 * Find the clip an animation path refers to. A standalone `.anm` open gives an asset path
 * (`ASSETS/…/idle1.anm`) while clips carry whatever the animation BIN stored, so match
 * case-insensitively from either end.
 */
function matchClip<T extends { animation_path: string }>(clips: T[], target: string): T | undefined {
    return clips.find(c =>
        c.animation_path === target ||
        c.animation_path.toLowerCase() === target.toLowerCase() ||
        c.animation_path.toLowerCase().endsWith(target.toLowerCase()) ||
        target.toLowerCase().endsWith(c.animation_path.toLowerCase()),
    );
}

/**
 * Decide which animation to pre-select on load. `initialAnimation` (a standalone
 * .anm open) wins; otherwise a cached session is restored if its clip still exists.
 * Returns `{ path, play }` or null.
 */
function pickInitialAnimation(
    clips: { name: string; animation_path: string }[],
    initialAnimation: string | undefined,
    autoPlay: boolean,
    restore: { selectedAnimation: string; isPlaying: boolean } | null,
): { path: string; play: boolean } | null {
    if (initialAnimation) {
        const c = matchClip(clips, initialAnimation);
        if (c) return { path: c.animation_path, play: autoPlay };
    }
    if (restore?.selectedAnimation) {
        const c = matchClip(clips, restore.selectedAnimation);
        if (c) return { path: c.animation_path, play: restore.isPlaying };
    }
    return null;
}

// ── Shared design-lab popup building blocks (used by the Display / Environment /
//    Animations popups so they all read like the reworked Materials panel). ──

/** Popup shell: floating panel + a design-lab header with title + × close. */
const MpPopup: React.FC<{
    title: string;
    side?: 'left' | 'right';
    onClose: () => void;
    headExtra?: React.ReactNode;
    children: React.ReactNode;
}> = ({ title, side = 'right', onClose, headExtra, children }) => (
    <div className={`model-preview__popup mp-panel ${side === 'left' ? 'model-preview__popup--top-left' : 'model-preview__popup--top-right'}`}>
        <div className="mp-panel__head">
            <span className="mp-panel__title">{title}</span>
            <div className="mp-panel__head-actions">
                {headExtra}
                <button className="mp-panel__close" onClick={onClose} title="Close" aria-label="Close">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
            </div>
        </div>
        <div className="mp-panel__body">{children}</div>
    </div>
);

/** A labelled row with a design-lab toggle switch on the right. */
const MpToggleRow: React.FC<{
    label: React.ReactNode;
    desc?: React.ReactNode;
    checked: boolean;
    onChange: (v: boolean) => void;
}> = ({ label, desc, checked, onChange }) => (
    <div className="mp-field mp-field--row" onClick={() => onChange(!checked)}>
        <div className="mp-field__text">
            <span className="mp-field__label">{label}</span>
            {desc && <span className="mp-field__desc">{desc}</span>}
        </div>
        <label className="dl-toggle" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span className="dl-toggle__track" />
            <span className="dl-toggle__thumb" />
        </label>
    </div>
);

/** A labelled design-lab slider field with a live value bubble. */
const MpSliderField: React.FC<{
    label: React.ReactNode;
    value: number;
    min: number;
    max: number;
    step?: number;
    format?: (v: number) => string;
    onChange: (v: number) => void;
}> = ({ label, value, min, max, step = 1, format, onChange }) => (
    <div className="mp-field">
        <div className="mp-field__head">
            <span className="mp-field__label">{label}</span>
            <span className="mp-field__value">{format ? format(value) : value}</span>
        </div>
        <div className="dl-slider" style={{ ['--_value' as never]: `${((value - min) / (max - min)) * 100}%` }}>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(parseFloat(e.target.value))}
            />
            <span className="dl-slider__bubble">{format ? format(value) : value}</span>
        </div>
    </div>
);

export const ModelPreview: React.FC<ModelPreviewProps> = ({ filePath, meshType = 'skinned', initialAnimation, autoPlay = true }) => {
    const [meshData, setMeshData] = useState<MeshData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const savedSettings = useMemo(() => loadSettings(), []);
    const [wireframe, setWireframe] = useState(savedSettings.wireframe);
    const [visibleMaterials, setVisibleMaterials] = useState<Set<string>>(new Set());
    // Gear forms (GearSkinUpgrade, e.g. Kayn's Assassin/Slayer) from the skin BIN.
    const [forms, setForms] = useState<SkinForm[]>([]);
    // Index into `forms` of the active form, or -1 for the base look.
    const [activeForm, setActiveForm] = useState(-1);

    const [showSkybox, setShowSkybox] = useState(savedSettings.showSkybox);
    const [floorMode, setFloorMode] = useState<'grid' | 'textured' | 'none'>(savedSettings.floorMode);
    const [ambientIntensity, setAmbientIntensity] = useState(savedSettings.ambientIntensity);
    const [directionalIntensity, setDirectionalIntensity] = useState(savedSettings.directionalIntensity);
    const [customizeLighting, setCustomizeLighting] = useState(savedSettings.customizeLighting ?? false);

    const [activePopup, setActivePopup] = useState<'display' | 'environment' | 'materials' | 'animations' | null>(null);

    const fileVersion = useAppMetadataStore((state) => {
        void state.fileVersionsRev;
        return state.getFileVersion(filePath);
    });

    const [animations, setAnimations] = useState<{ name: string; animation_path: string }[]>([]);
    const [selectedAnimation, setSelectedAnimation] = useState<string>('');
    const [isPlaying, setIsPlaying] = useState(false);

    const [animationData, setAnimationData] = useState<{ duration: number; fps: number; joint_count: number; joint_hashes: number[] } | null>(null);
    const [currentTime, setCurrentTime] = useState(0);

    const [skeletonData, setSkeletonData] = useState<any | null>(null);
    const [showSkeleton, setShowSkeleton] = useState(savedSettings.showSkeleton);

    const [hoveredMaterial, setHoveredMaterial] = useState<string | null>(null);
    const [previewPosition, setPreviewPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [scene, setScene] = useState<Scene | null>(null);
    const [camera, setCamera] = useState<ArcRotateCamera | null>(null);
    // The headless controller (engine/camera/lights/skybox/grid/materials/skeleton
    // overlay — see sknScene.ts). `scene`/`camera` above are mirrors of
    // `handle.scene`/`handle.scene.activeCamera`, kept as state so the effects
    // below can keep depending on them exactly as they did before this existed.
    const sknSceneRef = useRef<SknSceneHandle | null>(null);

    // ── Viewport shortcuts ───────────────────────────────────────────────────
    // Scoped to the preview being mounted with a live camera rather than to canvas
    // focus: orbiting doesn't require a focus click, so a focus-gated scope would
    // leave 'F' dead in the common case. Re-framing is idempotent, so falling
    // through from another surface is harmless.
    useScope('model-preview', !!camera);

    useAction('view.frameCamera', () => {
        sknSceneRef.current?.frameCamera();
    });

    /** Multiplicative zoom, clamped to the scale-aware limits framing installed. */
    const zoomByFactor = React.useCallback((factor: number) => {
        if (!camera) return;
        const lower = camera.lowerRadiusLimit ?? 0.01;
        const upper = camera.upperRadiusLimit ?? Number.POSITIVE_INFINITY;
        camera.radius = Math.min(upper, Math.max(lower, camera.radius * factor));
    }, [camera]);

    useAction('view.zoomIn', () => zoomByFactor(1 / 1.2));
    useAction('view.zoomOut', () => zoomByFactor(1.2));

    // ── Game shaders (private shader-preview module) ─────────────────
    // Opt-in per user preference: translation is expensive, so nothing
    // runs until the toggle is on. Previous materials are snapshotted so
    // toggling off restores the fast PBR look instantly.
    const [gameShaders, setGameShaders] = useState(() => {
        try {
            return localStorage.getItem('flint.gameShaders') === '1';
        } catch {
            return false;
        }
    });
    const gameShadersRef = useRef(gameShaders);
    gameShadersRef.current = gameShaders;
    const prevMaterialsRef = useRef<Map<Mesh, { mat: Material | null; alphaIndex: number }>>(new Map());
    const passTokenRef = useRef(0);

    const applyGameShadersPass = async () => {
        const s = scene;
        const passMeshes = sknSceneRef.current?.getActiveMeshes() ?? [];
        if (!shaderForgeAvailable || !s || s.isDisposed || passMeshes.length === 0) return;
        const token = ++passTokenRef.current;
        const aborted = () =>
            s.isDisposed || token !== passTokenRef.current || !gameShadersRef.current;
        try {
            const res = await api.readSknGenericMaterials(filePath);
            const matCount =
                (res as { materials?: unknown[] } | null)?.materials?.length ?? 0;
            console.info(`[shaderforge] materials resolved: ${matCount}`);
            if (matCount === 0) {
                console.warn(
                    '[shaderforge] no materials resolved for', filePath,
                    '- skin BIN not found from this path; preview keeps the PBR look',
                );
                return;
            }
            // Loose view of the pass: the precise DTO types live in the
            // private module and aren't visible to stub builds.
            const sf = (await loadShaderForge()) as null | {
                translatedMaterial: {
                    applyTranslatedPass: (
                        scene: unknown,
                        res: unknown,
                        targets: unknown,
                        opts?: unknown,
                    ) => Promise<unknown>;
                };
            };
            if (!sf || aborted()) return;
            for (const m of passMeshes) {
                if (!prevMaterialsRef.current.has(m)) {
                    prevMaterialsRef.current.set(m, { mat: m.material, alphaIndex: m.alphaIndex });
                }
            }
            await sf.translatedMaterial.applyTranslatedPass(
                s,
                res,
                passMeshes.map(m => ({ submeshName: m.name, mesh: m })),
                { cacheHint: filePath, shouldAbort: aborted },
            );
        } catch (e) {
            console.warn('[shaderforge] translated pass skipped:', e);
        }
    };

    const removeGameShadersPass = () => {
        passTokenRef.current++; // abort any in-flight apply
        for (const [m, prev] of prevMaterialsRef.current) {
            if (m.isDisposed()) continue;
            const cur = m.material;
            if (cur && cur !== prev.mat) {
                m.material = prev.mat;
                m.alphaIndex = prev.alphaIndex;
                // Textures stay owned by the module's caches / the scene —
                // only the ShaderMaterial wrapper goes.
                cur.dispose();
            }
        }
        prevMaterialsRef.current.clear();
    };

    useEffect(() => {
        try {
            localStorage.setItem('flint.gameShaders', gameShaders ? '1' : '0');
        } catch { /* private mode etc. — session-only */ }
        if (gameShaders) {
            void applyGameShadersPass();
        } else {
            removeGameShadersPass();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gameShaders]);

    const animationPlayerRef = useRef<AnimationPlayer | null>(null);
    const lastTimeRef = useRef<number>(0);
    const lastReactTimeRef = useRef<number>(0);

    // Submesh-visibility: full clip list (carries per-clip events), the static load-time
    // baseline (initialSubmeshToHide), and the timeline for the currently-playing clip.
    const clipsRef = useRef<AnimationClipInfo[]>([]);
    const initialHideRef = useRef<string[]>([]);
    const submeshTimelineRef = useRef<SubmeshVisibilityTimeline | null>(null);
    // Mirrors of the forms state for callbacks that run outside the render (render loop,
    // async loads).
    const formsRef = useRef<SkinForm[]>([]);
    const activeFormRef = useRef(-1);
    // Params of the current clip's timeline, so a form change can rebuild it in place with
    // the new baseline (without re-fetching the .anm).
    const timelineInitRef = useRef<{ submeshNames: string[]; events: SubmeshVisEvent[]; fps: number } | null>(null);
    // Signature of the last visibility set pushed to React, to avoid per-frame state churn.
    const lastVisSigRef = useRef<string>('');
    // True once the user manually toggles a submesh (Materials popup). Gates session restore.
    const materialsOverriddenRef = useRef<boolean>(false);

    // Session snapshot consumed once by the mesh-load + camera-frame effects.
    const restoreRef = useRef<ModelPreviewSession | null>(null);
    // Latest live state, read by the engine-cleanup to persist a final snapshot.
    const latestRef = useRef<{
        visibleMaterials: Set<string>;
        selectedAnimation: string;
        isPlaying: boolean;
        currentTime: number;
        getCamera: () => ModelPreviewSession['camera'] | undefined;
    }>({
        visibleMaterials: new Set(),
        selectedAnimation: '',
        isPlaying: false,
        currentTime: 0,
        getCamera: () => undefined,
    });
    // Engine effect has an empty dep array, so it can't close over live props.
    const filePathRef = useRef(filePath);
    const fileVersionRef = useRef(fileVersion);
    // The mesh-load effect reads these but must NOT depend on them — see the clip-switch
    // effect below.
    const initialAnimationRef = useRef(initialAnimation);
    const autoPlayRef = useRef(autoPlay);

    initialAnimationRef.current = initialAnimation;
    autoPlayRef.current = autoPlay;
    formsRef.current = forms;
    activeFormRef.current = activeForm;
    latestRef.current.visibleMaterials = visibleMaterials;
    latestRef.current.selectedAnimation = selectedAnimation;
    latestRef.current.isPlaying = isPlaying;
    latestRef.current.currentTime = currentTime;
    latestRef.current.getCamera = () => {
        const cam = camera;
        if (!cam) return undefined;
        return {
            alpha: cam.alpha,
            beta: cam.beta,
            radius: cam.radius,
            target: [cam.target.x, cam.target.y, cam.target.z],
        };
    };
    filePathRef.current = filePath;
    fileVersionRef.current = fileVersion;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        // Environment starts blank (no default grid/skybox) — the dedicated
        // floor-mode/skybox effects below apply the persisted settings right
        // after mount, exactly like the standalone effects they replace did.
        const handle = createSknScene(canvas, { grid: false, skybox: false });
        sknSceneRef.current = handle;
        setScene(handle.scene);
        setCamera(handle.scene.activeCamera as ArcRotateCamera);

        (canvas as any)._flintCleanup = () => {
            // Persist a final snapshot so the last camera/playhead survive remount.
            const lr = latestRef.current;
            modelPreviewSessionStore.save(filePathRef.current, {
                fileVersion: fileVersionRef.current,
                visibleMaterials: [...lr.visibleMaterials],
                selectedAnimation: lr.selectedAnimation,
                isPlaying: lr.isPlaying,
                currentTime: lr.currentTime,
                camera: lr.getCamera(),
            });

            sknSceneRef.current = null;
            handle.dispose();
        };

        return () => {
            const cleanup = canvas && (canvas as any)._flintCleanup;
            if (cleanup) {
                delete (canvas as any)._flintCleanup;
                cleanup();
            }
            setScene(null);
            setCamera(null);
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        let cancelled = false;

        const loadMesh = async () => {
            setLoading(true);
            setError(null);
            setAnimations([]);
            setSkeletonData(null);
            setSelectedAnimation('');
            setActivePopup(null);
            setMeshData(null);

            const cached = modelPreviewSessionStore.get(filePath);
            const restore = cached && cached.fileVersion === fileVersion ? cached : null;
            restoreRef.current = restore;

            try {
                let data: MeshData;

                // New model → back to the base form; SKN loads repopulate below.
                setForms([]);
                setActiveForm(-1);

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
                        // Carry the static submesh baseline + full clips (with events) for the
                        // visibility timeline. `initial_shadow_hide` is intentionally NOT applied:
                        // it only affects the shadow pass, which this preview doesn't render.
                        initialHideRef.current = animList.initial_hide ?? [];
                        clipsRef.current = animList.clips ?? [];
                        setForms(animList.forms ?? []);
                        if (animList.clips && animList.clips.length > 0) {
                            setAnimations(animList.clips);
                            // Prop-driven open (standalone .anm) takes priority, then cache.
                            const wantAnim = pickInitialAnimation(animList.clips, initialAnimationRef.current, autoPlayRef.current, restore);
                            if (wantAnim) {
                                setSelectedAnimation(wantAnim.path);
                                setIsPlaying(wantAnim.play);
                            }
                        }
                    } else {
                        initialHideRef.current = [];
                        clipsRef.current = [];
                    }

                    if (sklResult.status === 'fulfilled') {
                        setSkeletonData(sklResult.value);
                    }
                }

                if (cancelled) return;

                setMeshData(data);

                // Start with all submeshes visible, minus the static initialSubmeshToHide
                // baseline (matched case-insensitively). Animation events layer on top later.
                const allNames = data.kind === 'skn'
                    ? (data as SknMeshData).materials.map(m => m.name)
                    : (data as ScbMeshData).materials;
                const hiddenLower = new Set(initialHideRef.current.map(n => n.toLowerCase()));
                const baseVisible = new Set(allNames.filter(n => !hiddenLower.has(n.toLowerCase())));
                // Only a session where the user EXPLICITLY toggled submeshes overrides the
                // baseline; otherwise the initialSubmeshToHide baseline always wins on open.
                if (restore?.materialsOverridden && restore.visibleMaterials.length > 0) {
                    materialsOverriddenRef.current = true;
                    setVisibleMaterials(new Set(restore.visibleMaterials));
                } else {
                    materialsOverriddenRef.current = false;
                    setVisibleMaterials(baseVisible);
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
        // initialAnimation/autoPlay are read through refs on purpose: a new .anm clicked while
        // this viewer is open must not re-fetch the mesh (which re-frames the camera) — the
        // clip-switch effect below handles it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filePath, meshType, fileVersion]);

    // Another .anm clicked while the viewer is already showing its skin: just select that
    // clip. Setting `selectedAnimation` is enough — the clip-load effect fetches the .anm and
    // rebuilds the visibility timeline, leaving the engine, meshes and camera untouched.
    useEffect(() => {
        if (!initialAnimation || animations.length === 0) return;
        const clip = matchClip(animations, initialAnimation);
        if (!clip) return;
        setSelectedAnimation(clip.animation_path);
        setIsPlaying(autoPlay);
    }, [initialAnimation, autoPlay, animations]);

    useEffect(() => {
        if (!scene || !camera || !meshData) return;
        const handle = sknSceneRef.current;
        if (!handle) return;

        try {
            // `loadMesh` is synchronous under the hood (see its doc-comment in
            // sknScene.ts) — a build failure throws here, synchronously, exactly
            // like the old inline `buildSknMeshes` call did.
            void handle.loadMesh(meshData, skeletonData);
        } catch (err) {
            setError(`Mesh build failed: ${(err as Error)?.message ?? String(err)}`);
            return;
        }

        const camRestore = restoreRef.current?.camera;
        if (camRestore) {
            const cam = handle.scene.activeCamera as ArcRotateCamera;
            cam.alpha = camRestore.alpha;
            cam.beta = camRestore.beta;
            cam.radius = camRestore.radius;
            cam.target = new Vector3(camRestore.target[0], camRestore.target[1], camRestore.target[2]);
        }

        // Skeleton overlay for the freshly-loaded mesh — mirrors the original
        // build effect's one-shot viewer creation (the dedicated `showSkeleton`
        // toggle effect below only fires again on an explicit user toggle).
        handle.setSkeletonOverlay(showSkeleton ? 'lines' : 'off');

        // Game-shaders pass (private module): opt-in via the Display
        // popup toggle — translation work only happens when it's on.
        // The snapshot map from any previous model is stale now.
        prevMaterialsRef.current.clear();
        if (meshData.kind === 'skn' && shaderForgeAvailable && gameShadersRef.current) {
            void applyGameShadersPass();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scene, camera, meshData, skeletonData]);

    // The load-time hidden set: initialSubmeshToHide plus the active gear form's
    // mCharacterSubmeshesToHide/Show delta (hide first, show wins). Forms are DELTAS over the
    // baseline, not full states — the base BIN already hides every form's meshes at load,
    // which is why the gears don't hide each other. Returns lowercased names.
    const effectiveInitialHide = React.useCallback((): string[] => {
        const hidden = new Set(initialHideRef.current.map(n => n.toLowerCase()));
        const form = formsRef.current[activeFormRef.current];
        if (!form || !meshData) return [...hidden];
        const allNames = meshData.kind === 'skn'
            ? (meshData as SknMeshData).materials.map(m => m.name)
            : (meshData as ScbMeshData).materials;
        const lowerByHash = new Map<number, string>();
        for (const n of allNames) lowerByHash.set(fnv1a32Lower(n), n.toLowerCase());
        for (const h of form.hide_hashes) {
            const n = lowerByHash.get(h >>> 0);
            if (n) hidden.add(n);
        }
        for (const h of form.show_hashes) {
            const n = lowerByHash.get(h >>> 0);
            if (n) hidden.delete(n);
        }
        return [...hidden];
    }, [meshData]);

    // Reset visibility to the static baseline (all shown minus the effective hidden set).
    const applyBaselineVisibility = React.useCallback(() => {
        if (!meshData) return;
        const allNames = meshData.kind === 'skn'
            ? (meshData as SknMeshData).materials.map(m => m.name)
            : (meshData as ScbMeshData).materials;
        const hiddenLower = new Set(effectiveInitialHide());
        setVisibleMaterials(new Set(allNames.filter(n => !hiddenLower.has(n.toLowerCase()))));
    }, [meshData, effectiveInitialHide]);

    // Push the timeline's visible set at `tSeconds` into `visibleMaterials`, but only when it
    // actually changed (the render loop calls this every frame). `hiddenAt`/`visibleAt` are
    // stateless folds from the baseline, so loop-wrap and scrubbing recompute correctly.
    const applyTimelineVisibility = React.useCallback((tSeconds: number) => {
        const timeline = submeshTimelineRef.current;
        if (!timeline) return;
        const visible = timeline.visibleAt(tSeconds);
        const sig = [...visible].sort().join('');
        if (sig === lastVisSigRef.current) return;
        lastVisSigRef.current = sig;
        setVisibleMaterials(visible);
    }, []);

    // The render loop reads this ref so it always calls the latest closure.
    const applyTimelineVisibilityRef = useRef(applyTimelineVisibility);
    applyTimelineVisibilityRef.current = applyTimelineVisibility;
    const applyBaselineVisibilityRef = useRef(applyBaselineVisibility);
    applyBaselineVisibilityRef.current = applyBaselineVisibility;

    // Form switch: recompute visibility from the new baseline. If a clip is up, rebuild its
    // timeline in place (events keep layering on top of the form); otherwise the static
    // baseline applies directly. Clears any manual submesh overrides — picking a form is an
    // explicit "show me this configuration".
    useEffect(() => {
        activeFormRef.current = activeForm;
        materialsOverriddenRef.current = false;
        lastVisSigRef.current = '';
        const init = timelineInitRef.current;
        if (init && submeshTimelineRef.current) {
            submeshTimelineRef.current = new SubmeshVisibilityTimeline({
                ...init,
                initialHide: effectiveInitialHide(),
            });
            applyTimelineVisibility(animationPlayerRef.current?.time ?? 0);
        } else {
            applyBaselineVisibility();
        }
        // Only react to the form itself; the helpers are kept fresh via refs/deps above.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeForm]);

    useEffect(() => {
        if (!selectedAnimation) {
            setAnimationData(null);
            setCurrentTime(0);
            animationPlayerRef.current = null;
            // Dropped the animation → fall back to the static baseline visibility.
            submeshTimelineRef.current = null;
            timelineInitRef.current = null;
            lastVisSigRef.current = '';
            applyBaselineVisibilityRef.current();
            return;
        }

        // Build the submesh-visibility timeline for this clip from its events + baseline.
        const clip = clipsRef.current.find(c => c.animation_path === selectedAnimation);
        const submeshNames = meshData
            ? (meshData.kind === 'skn'
                ? (meshData as SknMeshData).materials.map(m => m.name)
                : (meshData as ScbMeshData).materials)
            : [];

        const loadAnimation = async () => {
            try {
                const animData = await api.readAnimation(selectedAnimation, filePath);
                setAnimationData(animData as any);
                setCurrentTime(0);

                // fps comes from the baked .anm; needed to convert event frames → seconds.
                timelineInitRef.current = {
                    submeshNames,
                    events: clip?.events ?? [],
                    fps: (animData as any).fps ?? 30,
                };
                submeshTimelineRef.current = new SubmeshVisibilityTimeline({
                    ...timelineInitRef.current,
                    initialHide: effectiveInitialHide(),
                });
                lastVisSigRef.current = '';

                // Bone data for the AnimationPlayer comes off the Babylon Skeleton's
                // `metadata` slot, stamped there by sknScene.ts's loadMesh — see
                // SknSkeletonMetadata's doc-comment for why it lives there instead of
                // a controller method.
                const skeleton = scene?.skeletons[0];
                const meta = skeleton?.metadata as SknSkeletonMetadata | undefined;
                if (skeleton && meta) {
                    const player = new AnimationPlayer(
                        animData as any,
                        meta.boneIndexByHash,
                        skeleton.bones,
                        meta.joints
                    );
                    player.paused = !isPlaying;
                    const seekTo = latestRef.current.currentTime;
                    if (seekTo > 0) {
                        player.time = seekTo;
                        player.tick(0);
                    }
                    animationPlayerRef.current = player;
                    lastTimeRef.current = performance.now();
                }

                // Apply the clip's visibility at its starting time immediately, so a
                // paused/just-selected clip shows the correct submeshes without waiting for
                // the first tick.
                applyTimelineVisibility(animationPlayerRef.current?.time ?? 0);
            } catch (err) {
                console.error("Failed to load animation:", err);
                setAnimationData(null);
                animationPlayerRef.current = null;
            }
        };

        loadAnimation();
    }, [selectedAnimation, filePath]);

    useEffect(() => {
        if (animationPlayerRef.current) {
            animationPlayerRef.current.paused = !isPlaying;
            if (isPlaying) {
                lastTimeRef.current = performance.now();
            }
        }
    }, [isPlaying]);

    const handleSliderChange = (val: number) => {
        setCurrentTime(val);
        if (animationPlayerRef.current) {
            animationPlayerRef.current.time = val;
            animationPlayerRef.current.tick(0);
        }
        // Recompute submesh visibility at the scrubbed time (works while paused too).
        applyTimelineVisibility(val);
    };

    // Drives the AnimationPlayer + submesh-visibility timeline off the scene's own
    // render clock. The controller's render loop calls `scene.render()` inside a
    // try/catch every frame; `onBeforeRenderObservable` fires from inside that
    // call, so an exception here is still caught there exactly as it was when
    // this logic lived inline in the render loop itself.
    useEffect(() => {
        if (!scene) return;
        const observer = scene.onBeforeRenderObservable.add(() => {
            if (animationPlayerRef.current) {
                const now = performance.now();
                if (lastTimeRef.current !== 0) {
                    const dt = (now - lastTimeRef.current) / 1000;
                    animationPlayerRef.current.tick(dt);

                    const curTime = animationPlayerRef.current.time;
                    const rounded = Math.round(curTime * 100) / 100;
                    if (Math.abs(rounded - lastReactTimeRef.current) >= 0.05) {
                        lastReactTimeRef.current = rounded;
                        setCurrentTime(curTime);
                    }
                    // Drive submesh visibility from the current playhead (recomputes from
                    // baseline, so loop-wrap is handled without special-casing).
                    applyTimelineVisibilityRef.current(curTime);
                }
                lastTimeRef.current = now;
            }
        });
        return () => { scene.onBeforeRenderObservable.remove(observer); };
    }, [scene]);

    useEffect(() => {
        if (!scene) return;
        sknSceneRef.current?.setFloorMode(floorMode);
    }, [scene, floorMode]);

    useEffect(() => {
        if (!scene) return;

        const ambient = scene.getLightByName("ambient");
        if (ambient) {
            ambient.intensity = customizeLighting ? ambientIntensity : 1.2;
        }
    }, [scene, ambientIntensity, customizeLighting]);

    useEffect(() => {
        if (!scene) return;

        const dir1 = scene.getLightByName("dirLight1");
        const dir2 = scene.getLightByName("dirLight2");
        const dir3 = scene.getLightByName("dirLight3");
        if (dir1) dir1.intensity = customizeLighting ? directionalIntensity : 0.0;
        if (dir2) dir2.intensity = customizeLighting ? directionalIntensity * 0.4 : 0.0;
        if (dir3) dir3.intensity = customizeLighting ? directionalIntensity * 0.3 : 0.0;
    }, [scene, directionalIntensity, customizeLighting]);

    useEffect(() => {
        if (!scene) return;
        sknSceneRef.current?.setSkyboxVisible(showSkybox);
    }, [scene, showSkybox]);

    useEffect(() => {
        sknSceneRef.current?.setWireframe(wireframe);
    }, [wireframe]);

    useEffect(() => {
        const handle = sknSceneRef.current;
        if (!handle) return;
        handle.getActiveMeshes().forEach(m => handle.setSubmeshVisible(m.name, visibleMaterials.has(m.name)));
    }, [visibleMaterials]);

    useEffect(() => {
        if (!scene) return;
        sknSceneRef.current?.setSkeletonOverlay(showSkeleton ? 'lines' : 'off');
    }, [scene, showSkeleton]);

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

    useEffect(() => {
        if (!meshData) return;
        modelPreviewSessionStore.save(filePath, {
            fileVersion,
            visibleMaterials: [...visibleMaterials],
            materialsOverridden: materialsOverriddenRef.current,
            selectedAnimation,
            isPlaying,
            currentTime: latestRef.current.currentTime,
            camera: latestRef.current.getCamera(),
        });
    }, [filePath, fileVersion, meshData, visibleMaterials, selectedAnimation, isPlaying]);

    const toggleMaterial = (name: string) => {
        materialsOverriddenRef.current = true;
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
        materialsOverriddenRef.current = true;
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

    /** Base64 PNG of a material's texture (for the inline thumbnail), or null if
     *  the material has no loaded texture. Same lookup the hover tooltip uses. */
    const materialTextureSrc = (name: string): string | null => {
        if (!meshData) return null;
        const sknData = meshData as SknMeshData;
        const scbData = meshData as ScbMeshData;
        const data = meshData.kind === 'skn'
            ? sknData.material_data?.[name]?.texture || sknData.textures?.[name]
            : scbData.material_data?.[name]?.texture;
        return data ? `data:image/png;base64,${data}` : null;
    };

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
                    <div className="model-preview__controls-bar model-preview__controls-bar--left">
                        <button
                            className={`model-preview__control-btn ${activePopup === 'environment' ? 'model-preview__control-btn--active' : ''}`}
                            onClick={() => setActivePopup(activePopup === 'environment' ? null : 'environment')}
                            title="Environment Settings"
                        >
                            <span dangerouslySetInnerHTML={{ __html: getIcon('settings') }} />
                        </button>
                    </div>

                    <div className="model-preview__controls-bar">
                        <button
                            className={`model-preview__control-btn ${activePopup === 'display' ? 'model-preview__control-btn--active' : ''}`}
                            onClick={() => setActivePopup(activePopup === 'display' ? null : 'display')}
                            title="Display & Skeleton"
                        >
                            {/* Skeleton/rig glyph (currentColor so it themes) — distinct
                                from the Materials "picture" icon. */}
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="4.5" r="2" />
                                <path d="M12 6.5v6M6.5 9.5h11M9.5 12.5l-2 5M14.5 12.5l2 5" />
                            </svg>
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

            <div className="model-preview__canvas">
                <canvas
                    ref={canvasRef}
                    style={{ width: '100%', height: '100%', display: 'block', outline: 'none' }}
                />
            </div>
            {statusOverlay}

            {activePopup === 'display' && (
                <MpPopup title="Display & Skeleton" side="right" onClose={() => setActivePopup(null)}>
                    <MpToggleRow label="Wireframe" checked={wireframe} onChange={setWireframe} />
                    {shaderForgeAvailable && meshType === 'skinned' && (
                        <MpToggleRow
                            label="Game shaders"
                            desc="Game-accurate materials (slower)"
                            checked={gameShaders}
                            onChange={setGameShaders}
                        />
                    )}
                    {skeletonData && (
                        <MpToggleRow
                            label="Show skeleton"
                            desc={`${skeletonData.bones.length} bones`}
                            checked={showSkeleton}
                            onChange={setShowSkeleton}
                        />
                    )}
                </MpPopup>
            )}

            {activePopup === 'environment' && (
                <MpPopup title="Environment" side="left" onClose={() => setActivePopup(null)}>
                    <MpToggleRow
                        label="Skybox"
                        desc="Cubemap sky backdrop"
                        checked={showSkybox}
                        onChange={setShowSkybox}
                    />

                    <div className="mp-field">
                        <div className="mp-field__head">
                            <span className="mp-field__label">Floor</span>
                        </div>
                        <div className="mp-seg">
                            {(['grid', 'textured', 'none'] as const).map((mode) => (
                                <button
                                    key={mode}
                                    className={`mp-seg__btn ${floorMode === mode ? 'mp-seg__btn--active' : ''}`}
                                    onClick={() => setFloorMode(mode)}
                                >
                                    {mode === 'grid' ? 'Grid' : mode === 'textured' ? 'Textured' : 'None'}
                                </button>
                            ))}
                        </div>
                    </div>

                    <MpToggleRow
                        label="Customize lighting"
                        checked={customizeLighting}
                        onChange={setCustomizeLighting}
                    />

                    {customizeLighting && (
                        <>
                            <MpSliderField
                                label="Ambient light"
                                value={ambientIntensity}
                                min={0}
                                max={2}
                                step={0.1}
                                format={(v) => v.toFixed(1)}
                                onChange={setAmbientIntensity}
                            />
                            <MpSliderField
                                label="Directional light"
                                value={directionalIntensity}
                                min={0}
                                max={3}
                                step={0.1}
                                format={(v) => v.toFixed(1)}
                                onChange={setDirectionalIntensity}
                            />
                        </>
                    )}
                </MpPopup>
            )}

            {meshData && activePopup === 'materials' && (() => {
                const total = meshData.materials.length;
                const shownCount = meshData.materials.reduce((n, mat) => {
                    const nm = typeof mat === 'string' ? mat : mat.name;
                    return n + (visibleMaterials.has(nm) ? 1 : 0);
                }, 0);
                // Only offer forms that actually CHANGE this mesh's baseline visibility.
                // Filters both gears that only touch another SKN's parts (dead button) and
                // gears that mirror the base look — skins often list every form as a gear,
                // so a form identical to Base would be a redundant second button.
                const lowerByHash = new Map<number, string>();
                for (const mat of meshData.materials) {
                    const nm = typeof mat === 'string' ? mat : mat.name;
                    lowerByHash.set(fnv1a32Lower(nm), nm.toLowerCase());
                }
                const baseHidden = new Set(initialHideRef.current.map(n => n.toLowerCase()));
                const usableForms = forms
                    .map((form, index) => ({ form, index }))
                    .filter(({ form }) =>
                        form.hide_hashes.some(h => {
                            const n = lowerByHash.get(h >>> 0);
                            return !!n && !baseHidden.has(n);
                        }) ||
                        form.show_hashes.some(h => {
                            const n = lowerByHash.get(h >>> 0);
                            return !!n && baseHidden.has(n);
                        }));
                return (
                <div className="model-preview__popup model-preview__popup--top-right model-preview__popup--wide mp-materials">
                    <div className="mp-materials__head">
                        <div className="mp-materials__title">
                            <span>Materials</span>
                            <span className="mp-materials__count">{shownCount}/{total} shown</span>
                        </div>
                        <div className="mp-materials__head-actions">
                            <button className="dl-btn dl-btn--ghost dl-btn--sm" onClick={() => toggleAllMaterials(true)}>Show all</button>
                            <button className="dl-btn dl-btn--ghost dl-btn--sm" onClick={() => toggleAllMaterials(false)}>Hide all</button>
                            <button className="mp-materials__close" onClick={() => setActivePopup(null)} title="Close" aria-label="Close">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                            </button>
                        </div>
                    </div>
                    <div className="mp-materials__body">
                        {meshData.texture_warning && (
                            <div className="mp-materials__warning">
                                <span className="mp-materials__warning-icon" aria-hidden>!</span>
                                <span>{meshData.texture_warning}</span>
                            </div>
                        )}
                        {usableForms.length > 0 && (
                            <div className="mp-materials__forms">
                                <button
                                    className={`mp-form-btn ${activeForm === -1 ? 'mp-form-btn--active' : ''}`}
                                    onClick={() => setActiveForm(-1)}
                                >
                                    Base
                                </button>
                                {usableForms.map(({ form, index }) => (
                                    <button
                                        key={index}
                                        className={`mp-form-btn ${activeForm === index ? 'mp-form-btn--active' : ''}`}
                                        onClick={() => setActiveForm(index)}
                                    >
                                        {form.name}
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="mp-materials__list">
                            {meshData.materials.map((mat, index) => {
                                const matName = typeof mat === 'string' ? mat : mat.name;
                                const texSrc = materialTextureSrc(matName);
                                const hasTexture = !!texSrc;
                                const isVisible = visibleMaterials.has(matName);
                                return (
                                    <div
                                        key={matName || index}
                                        className={`mp-mat-row ${isVisible ? '' : 'mp-mat-row--off'}`}
                                        onClick={() => toggleMaterial(matName)}
                                        onMouseEnter={(e) => { setHoveredMaterial(matName); setPreviewPosition({ x: e.clientX, y: e.clientY }); }}
                                        onMouseLeave={() => setHoveredMaterial(null)}
                                        onMouseMove={(e) => setPreviewPosition({ x: e.clientX, y: e.clientY })}
                                    >
                                        <div className={`mp-mat-row__thumb ${hasTexture ? '' : 'mp-mat-row__thumb--empty'}`}>
                                            {hasTexture
                                                ? <img src={texSrc!} alt="" draggable={false} />
                                                : <span className="mp-mat-row__thumb-glyph" aria-hidden>▦</span>}
                                        </div>
                                        <div className="mp-mat-row__info">
                                            <span className="mp-mat-row__name" title={matName}>{matName || `Material ${index}`}</span>
                                            <span className={`mp-mat-row__status ${hasTexture ? 'mp-mat-row__status--ok' : 'mp-mat-row__status--missing'}`}>
                                                {hasTexture ? 'Texture loaded' : 'No texture'}
                                            </span>
                                        </div>
                                        <button
                                            className="mp-mat-row__eye"
                                            title={isVisible ? 'Hide this material' : 'Show this material'}
                                            aria-pressed={isVisible}
                                            onClick={(e) => { e.stopPropagation(); toggleMaterial(matName); }}
                                        >
                                            {isVisible ? (
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                                    <circle cx="12" cy="12" r="3" />
                                                </svg>
                                            ) : (
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                                    <line x1="1" y1="1" x2="23" y2="23" />
                                                </svg>
                                            )}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
                );
            })()}

            {activePopup === 'animations' && animations.length > 0 && (
                <MpPopup
                    title="Animations"
                    side="right"
                    onClose={() => setActivePopup(null)}
                    headExtra={<span className="mp-panel__count">{animations.length}</span>}
                >
                    <div className="mp-anim-list">
                        {animations.map((anim, index) => {
                            const active = selectedAnimation === anim.animation_path;
                            return (
                                <button
                                    key={index}
                                    className={`mp-anim-row ${active ? 'mp-anim-row--active' : ''}`}
                                    onClick={() => setSelectedAnimation(anim.animation_path)}
                                    title={anim.name}
                                >
                                    <span className="mp-anim-row__glyph" aria-hidden>
                                        {active && isPlaying ? (
                                            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                                        ) : (
                                            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
                                        )}
                                    </span>
                                    <span className="mp-anim-row__name">{anim.name}</span>
                                </button>
                            );
                        })}
                    </div>
                    {selectedAnimation && (
                        <div className="mp-anim-controls">
                            <div className="mp-anim-buttons">
                                <button
                                    className={`dl-btn dl-btn--sm ${isPlaying ? 'dl-btn--primary' : 'dl-btn--secondary'}`}
                                    onClick={() => setIsPlaying(!isPlaying)}
                                >
                                    {isPlaying ? (
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                                    ) : (
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                                    )}
                                    <span>{isPlaying ? 'Pause' : 'Play'}</span>
                                </button>
                                <button
                                    className="dl-btn dl-btn--sm dl-btn--ghost"
                                    onClick={() => { setIsPlaying(false); handleSliderChange(0); }}
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="6" width="12" height="12" /></svg>
                                    <span>Stop</span>
                                </button>
                            </div>
                            {animationData && (
                                <div className="mp-anim-timeline">
                                    <div
                                        className="dl-slider"
                                        style={{ ['--_value' as never]: `${animationData.duration > 0 ? (currentTime / animationData.duration) * 100 : 0}%` }}
                                    >
                                        <input
                                            type="range"
                                            min={0}
                                            max={animationData.duration}
                                            step={0.001}
                                            value={currentTime}
                                            onChange={(e) => handleSliderChange(parseFloat(e.target.value))}
                                        />
                                    </div>
                                    <div className="mp-anim-timeline__info">
                                        <span>{currentTime.toFixed(2)}s / {animationData.duration.toFixed(2)}s</span>
                                        <span className="mp-anim-timeline__meta">{animationData.fps.toFixed(0)} FPS · {animationData.joint_count} joints</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </MpPopup>
            )}

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
