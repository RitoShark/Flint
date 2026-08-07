import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { createSknScene, type SknSceneHandle, type SknSkeletonMetadata } from '../../lib/babylon/sknScene';
import * as api from '../../lib/api';
import { decodeMeshPayload } from '../../lib/api/mesh';
import type { AnimationData, AnimationList, SknMeshData, SubmeshVisEvent } from '../../lib/api/mesh';
import { AnimationPlayer, resetSkeletonToRestPose, type BakedAnimationDTO } from '../../lib/babylon/animationPlayer';
import { SubmeshVisibilityTimeline } from '../../lib/babylon/submeshVisibility';
import { baselineHiddenLower, namesHiddenBy } from '../../lib/editor3d/submeshBaseline';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { useModelEditorStore } from '../../lib/stores/modelEditorStore';

export interface EditorViewportProps {
    sknPath: string;
    reloadToken: number;
    onPick: (name: string | null) => void;
    handleRef: React.MutableRefObject<SknSceneHandle | null>;
}

interface StashedMaterials {
    textures?: SknMeshData['textures'];
    material_data?: SknMeshData['material_data'];
}

function applyHiddenToScene(handle: SknSceneHandle, hidden: Set<string>): void {
    handle.getActiveMeshes().forEach((m) => handle.setSubmeshVisible(m.name, !hidden.has(m.name)));
}

export const EditorViewport: React.FC<EditorViewportProps> = ({ sknPath, reloadToken, onPick, handleRef }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const materialsRef = useRef<StashedMaterials | null>(null);
    const meshNamesRef = useRef<string[]>([]);
    const skeleton = useModelEditorStore((s) => s.skeleton);
    const skeletonRef = useRef(skeleton);
    skeletonRef.current = skeleton;
    // 0 is the sentinel "nothing staged yet" value reloadGeometry never produces.
    const isInitialReloadToken = useRef(true);

    const animationList = useModelEditorStore((s) => s.animationList);
    const activeForm = useModelEditorStore((s) => s.activeForm);
    const hiddenNames = useModelEditorStore((s) => s.hiddenNames);

    const [selectedClip, setSelectedClip] = useState<string | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [animationData, setAnimationData] = useState<AnimationData | null>(null);
    const [showAnimPopup, setShowAnimPopup] = useState(false);

    const isPlayingRef = useRef(isPlaying);
    isPlayingRef.current = isPlaying;

    const animationPlayerRef = useRef<AnimationPlayer | null>(null);
    const lastTimeRef = useRef(0);
    const lastReactTimeRef = useRef(0);
    const submeshTimelineRef = useRef<SubmeshVisibilityTimeline | null>(null);
    const timelineInitRef = useRef<{ submeshNames: string[]; events: SubmeshVisEvent[]; fps: number } | null>(null);
    const lastVisSigRef = useRef('');

    const applyTimelineTick = useCallback((tSeconds: number) => {
        const timeline = submeshTimelineRef.current;
        if (!timeline) return;
        const hidden = timeline.hiddenAt(tSeconds);
        const sig = [...hidden].sort().join('|');
        if (sig === lastVisSigRef.current) return;
        lastVisSigRef.current = sig;
        useModelEditorStore.getState().setHiddenNames(hidden);
    }, []);
    const applyTimelineTickRef = useRef(applyTimelineTick);
    applyTimelineTickRef.current = applyTimelineTick;

    const applyStaticBaseline = useCallback(() => {
        const names = meshNamesRef.current;
        if (names.length === 0) return;
        const list = useModelEditorStore.getState().animationList;
        const form = useModelEditorStore.getState().activeForm;
        const baseline = baselineHiddenLower(list?.initial_hide, list?.forms, form, names);
        useModelEditorStore.getState().setHiddenNames(namesHiddenBy(baseline, names));
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const handle = createSknScene(canvas);
        handleRef.current = handle;

        const observer = handle.scene.onBeforeRenderObservable.add(() => {
            const player = animationPlayerRef.current;
            if (!player) return;
            const now = performance.now();
            if (lastTimeRef.current !== 0) {
                const dt = (now - lastTimeRef.current) / 1000;
                player.tick(dt);

                const curTime = player.time;
                const rounded = Math.round(curTime * 100) / 100;
                if (Math.abs(rounded - lastReactTimeRef.current) >= 0.05) {
                    lastReactTimeRef.current = rounded;
                    setCurrentTime(curTime);
                }
                applyTimelineTickRef.current(curTime);
            }
            lastTimeRef.current = now;
        });

        return () => {
            handle.scene.onBeforeRenderObservable.remove(observer);
            handleRef.current = null;
            handle.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [meshResult, animResult] = await Promise.allSettled([
                api.readSknMesh(sknPath),
                api.readAnimationList(sknPath),
            ]);
            if (cancelled) return;

            if (meshResult.status !== 'fulfilled') {
                console.debug('[EditorViewport] readSknMesh failed', sknPath, meshResult.reason);
                return;
            }
            const mesh = meshResult.value;
            materialsRef.current = { textures: mesh.textures, material_data: mesh.material_data };
            meshNamesRef.current = mesh.materials.map((m) => m.name);

            let animationListResult: AnimationList | null = null;
            if (animResult.status === 'fulfilled') {
                animationListResult = animResult.value;
            } else {
                console.debug('[EditorViewport] readAnimationList failed (non-fatal)', sknPath, animResult.reason);
            }

            setSelectedClip(null);
            setIsPlaying(false);
            setAnimationData(null);
            setCurrentTime(0);
            animationPlayerRef.current = null;
            submeshTimelineRef.current = null;
            timelineInitRef.current = null;
            lastVisSigRef.current = '';
            useModelEditorStore.getState().setAnimationList(animationListResult);

            const handle = handleRef.current;
            if (!handle) return;
            await handle.loadMesh(mesh, skeletonRef.current);
            applyHiddenToScene(handle, useModelEditorStore.getState().hiddenNames);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sknPath]);

    useEffect(() => {
        if (isInitialReloadToken.current) {
            isInitialReloadToken.current = false;
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const sessionId = useModelEditorStore.getState().sessionId;
                const handle = handleRef.current;
                if (!sessionId || !handle) return;
                const buf = await api.deriveModelMesh(sessionId);
                if (cancelled) return;
                const mesh = decodeMeshPayload(buf);
                if (mesh.kind === 'skn' && materialsRef.current) {
                    mesh.textures = materialsRef.current.textures;
                    mesh.material_data = materialsRef.current.material_data;
                }
                if (mesh.kind === 'skn') meshNamesRef.current = mesh.materials.map((m) => m.name);

                // loadMesh always reframes from the new bbox, so the camera view is saved/restored around this call or a duplicate/delete yanks it.
                const camera = handle.scene.activeCamera as ArcRotateCamera | null;
                const priorView = camera
                    ? { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() }
                    : null;

                await handle.loadMesh(mesh, skeletonRef.current);

                if (camera && priorView) {
                    camera.alpha = priorView.alpha;
                    camera.beta = priorView.beta;
                    camera.radius = priorView.radius;
                    camera.target = priorView.target;
                }

                // The scene resets its own hidden-set bookkeeping on every rebuild — reapply whatever's currently in the store.
                applyHiddenToScene(handle, useModelEditorStore.getState().hiddenNames);
            } catch (err) {
                console.debug('[EditorViewport] deriveModelMesh reload failed', err);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reloadToken]);

    useEffect(() => {
        const handle = handleRef.current;
        if (!handle) return;
        applyHiddenToScene(handle, hiddenNames);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hiddenNames]);

    useEffect(() => {
        const names = meshNamesRef.current;
        if (names.length === 0) return;
        const list = useModelEditorStore.getState().animationList;
        const baseline = baselineHiddenLower(list?.initial_hide, list?.forms, activeForm, names);

        if (timelineInitRef.current && submeshTimelineRef.current) {
            submeshTimelineRef.current = new SubmeshVisibilityTimeline({
                ...timelineInitRef.current,
                initialHide: [...baseline],
            });
            lastVisSigRef.current = '';
            applyTimelineTick(animationPlayerRef.current?.time ?? 0);
        } else {
            useModelEditorStore.getState().setHiddenNames(namesHiddenBy(baseline, names));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeForm]);

    // Clip switching must never re-run loadMesh (it would reset the mesh/camera), so this effect is kept separate and keyed only on clip + file.
    useEffect(() => {
        if (!selectedClip) {
            setAnimationData(null);
            setCurrentTime(0);
            animationPlayerRef.current = null;
            submeshTimelineRef.current = null;
            timelineInitRef.current = null;
            lastVisSigRef.current = '';

            const skeleton2 = handleRef.current?.scene.skeletons[0];
            const meta = skeleton2?.metadata as SknSkeletonMetadata | undefined;
            if (skeleton2 && meta) resetSkeletonToRestPose(skeleton2.bones, meta.joints);

            applyStaticBaseline();
            return;
        }

        let cancelled = false;
        const clip = useModelEditorStore.getState().animationList?.clips?.find((c) => c.animation_path === selectedClip);
        const names = meshNamesRef.current;

        void (async () => {
            try {
                const animData = await api.readAnimation(selectedClip, sknPath);
                if (cancelled) return;
                setAnimationData(animData);
                setCurrentTime(0);

                timelineInitRef.current = {
                    submeshNames: names,
                    events: clip?.events ?? [],
                    fps: animData.fps ?? 30,
                };
                const list = useModelEditorStore.getState().animationList;
                const form = useModelEditorStore.getState().activeForm;
                const baseline = baselineHiddenLower(list?.initial_hide, list?.forms, form, names);
                submeshTimelineRef.current = new SubmeshVisibilityTimeline({
                    ...timelineInitRef.current,
                    initialHide: [...baseline],
                });
                lastVisSigRef.current = '';

                const skeleton2 = handleRef.current?.scene.skeletons[0];
                const meta = skeleton2?.metadata as SknSkeletonMetadata | undefined;
                if (skeleton2 && meta) {
                    // readAnimation's declared AnimationData type doesn't carry tracks/frame_count (ModelPreview.tsx casts the same way) — the runtime payload has them, only the TS surface is incomplete.
                    const player = new AnimationPlayer(animData as unknown as BakedAnimationDTO, meta.boneIndexByHash, skeleton2.bones, meta.joints);
                    player.paused = !isPlayingRef.current;
                    animationPlayerRef.current = player;
                    lastTimeRef.current = performance.now();
                }

                applyTimelineTickRef.current(animationPlayerRef.current?.time ?? 0);
            } catch (err) {
                console.debug('[EditorViewport] readAnimation failed', selectedClip, err);
                setAnimationData(null);
                animationPlayerRef.current = null;
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedClip, sknPath]);

    useEffect(() => {
        if (animationPlayerRef.current) {
            animationPlayerRef.current.paused = !isPlaying;
            if (isPlaying) lastTimeRef.current = performance.now();
        }
    }, [isPlaying]);

    const handleScrub = useCallback((val: number) => {
        setCurrentTime(val);
        if (animationPlayerRef.current) {
            animationPlayerRef.current.time = val;
            animationPlayerRef.current.tick(0);
        }
        applyTimelineTickRef.current(val);
    }, []);

    const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const handle = handleRef.current;
        if (!handle) return;
        onPick(handle.pickAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY));
    };

    const clips = animationList?.clips ?? [];

    return (
        <>
            <canvas
                ref={canvasRef}
                className="m3d__canvas"
                style={{ width: '100%', height: '100%', display: 'block', outline: 'none' }}
                onClick={handleClick}
            />
            {clips.length > 0 && (
                <div className="m3d__viewport-controls">
                    <button
                        type="button"
                        className={`m3d__viewport-btn ${showAnimPopup ? 'm3d__viewport-btn--active' : ''}`}
                        onClick={() => setShowAnimPopup((v) => !v)}
                        title="Animations"
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('video') }} />
                    </button>
                </div>
            )}
            {showAnimPopup && clips.length > 0 && (
                <div className="m3d__anim-popup">
                    <div className="m3d__anim-popup-head">
                        <span>Animations</span>
                        <span className="m3d__anim-popup-count">{clips.length}</span>
                    </div>
                    <div className="m3d__anim-list">
                        <button
                            type="button"
                            className={`m3d__anim-row ${!selectedClip ? 'm3d__anim-row--active' : ''}`}
                            onClick={() => setSelectedClip(null)}
                        >
                            No animation (rest pose)
                        </button>
                        {clips.map((clip) => (
                            <button
                                type="button"
                                key={clip.animation_path}
                                className={`m3d__anim-row ${selectedClip === clip.animation_path ? 'm3d__anim-row--active' : ''}`}
                                onClick={() => setSelectedClip(clip.animation_path)}
                                title={clip.name}
                            >
                                {clip.name}
                            </button>
                        ))}
                    </div>
                    {selectedClip && (
                        <div className="m3d__anim-controls">
                            <div className="m3d__anim-buttons">
                                <button type="button" className="m3d__btn m3d__btn--sm" onClick={() => setIsPlaying((p) => !p)}>
                                    {isPlaying ? 'Pause' : 'Play'}
                                </button>
                                <button
                                    type="button"
                                    className="m3d__btn m3d__btn--sm"
                                    onClick={() => { setIsPlaying(false); handleScrub(0); }}
                                >
                                    Stop
                                </button>
                            </div>
                            {animationData && (
                                <div className="m3d__anim-timeline">
                                    <input
                                        type="range"
                                        min={0}
                                        max={animationData.duration}
                                        step={0.001}
                                        value={currentTime}
                                        onChange={(e) => handleScrub(parseFloat(e.target.value))}
                                    />
                                    <span className="m3d__anim-time">
                                        {currentTime.toFixed(2)}s / {animationData.duration.toFixed(2)}s
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </>
    );
};
