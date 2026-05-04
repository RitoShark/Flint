/**
 * Flint - New Project Modal Component
 *
 * Uses DataDragon/CommunityDragon API for champion/skin selection.
 * Supports Skin Projects and Animated Loading Screen projects.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useShallow } from 'zustand/react/shallow';
import { useAppState, useConfigStore } from '../../lib/stores';
import * as api from '../../lib/api';
import * as datadragon from '../../lib/datadragon';
import type { DDragonChampion, DDragonSkin } from '../../lib/datadragon';
import type { Project } from '../../lib/types';
import {
    calculateBudget,
    getVideoMetadata,
    generateSpritesheet,
    type VideoMeta,
    type BudgetResult,
} from '../../lib/spritesheet';
import { Button, Icon, Input, Picker } from '../ui';

// ─── Local helpers ───────────────────────────────────────────────────────────

/** Project name + folder location row, shared across all project types. */
const NameAndPathRow: React.FC<{
    namePlaceholder: string;
    name: string;
    onNameChange: (v: string) => void;
    path: string;
    onPathChange: (v: string) => void;
    onBrowse: () => void;
}> = ({ namePlaceholder, name, onNameChange, path, onPathChange, onBrowse }) => (
    <div className="np-fields-row">
        <div className="np-field np-field--grow">
            <label className="np-label">Project Name</label>
            <Input
                placeholder={namePlaceholder}
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
            />
        </div>
        <div className="np-field np-field--grow">
            <label className="np-label">Location</label>
            <Input
                placeholder="Select folder…"
                value={path}
                onChange={(e) => onPathChange(e.target.value)}
                buttonLabel="Browse"
                onButtonClick={onBrowse}
            />
        </div>
    </div>
);

type ProjectType = 'skin' | 'loading-screen' | 'map';

const SCALE_OPTIONS = [
    { label: '100%', value: 1.0 },
    { label: '75%', value: 0.75 },
    { label: '50%', value: 0.5 },
    { label: '25%', value: 0.25 },
];

const FPS_OPTIONS = [15, 24, 30, 60];

export const NewProjectModal: React.FC = () => {
    const { state, dispatch, closeModal, showToast, setWorking, setReady } = useAppState();
    // Subscribe to only the three config fields actually read in this file.
    // `useConfigStore()` (no selector) re-rendered the modal on every config
    // change anywhere — including unrelated fields like recentProjects that
    // fire automatically after project creation completes.
    const configStore = useConfigStore(
        useShallow((s) => ({
            leaguePathPbe: s.leaguePathPbe,
            binConverterEngine: s.binConverterEngine,
        })),
    );

    // ─── Shared state ────────────────────────────────────────────────────
    const [projectType, setProjectType] = useState<ProjectType>('skin');
    const [projectName, setProjectName] = useState('');
    const [projectPath, setProjectPath] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [progress, setProgress] = useState('');

    // Subscribe to Rust-side `project-create-progress` events. Without this
    // listener the modal sat on a single static "Creating project..." string
    // for the full 36+ seconds of work, which made the whole flow feel like
    // a frozen frontend even though Rust was busy. Now phase transitions
    // (init → create → extract → repath → complete) update the modal text
    // in real time.
    useEffect(() => {
        if (!isCreating) return;
        const unlistenP = listen<{ phase: string; message: string }>(
            'project-create-progress',
            (event) => {
                const m = event.payload?.message;
                if (typeof m === 'string' && m.length > 0) setProgress(m);
            },
        );
        return () => { unlistenP.then((fn) => fn()).catch(() => {}); };
    }, [isCreating]);

    // ─── Skin project state ─────────────────────────────────────────────
    const [selectedChampion, setSelectedChampion] = useState<DDragonChampion | null>(null);
    const [selectedSkin, setSelectedSkin] = useState<DDragonSkin | null>(null);
    const [champions, setChampions] = useState<DDragonChampion[]>([]);
    const [skins, setSkins] = useState<DDragonSkin[]>([]);
    const [championSearch, setChampionSearch] = useState('');
    const [skinSearch, setSkinSearch] = useState('');
    const [splashLoaded, setSplashLoaded] = useState(false);
    const [skinPickerOpen, setSkinPickerOpen] = useState(false);
    const [cacheReady, setCacheReady] = useState(0); // bumped when preload batches finish
    const [usePbe, setUsePbe] = useState(false);
    const cdragonBranch: 'pbe' | 'latest' = usePbe ? 'pbe' : 'latest';
    const effectiveLeaguePath = usePbe ? configStore.leaguePathPbe : state.leaguePath;

    // ─── Map project state ───────────────────────────────────────────────
    const [availableMaps, setAvailableMaps] = useState<api.MapEntry[]>([]);
    const [selectedMapId, setSelectedMapId] = useState<string>('');
    const [includeLevels, setIncludeLevels] = useState<boolean>(true);
    const [mapsLoading, setMapsLoading] = useState<boolean>(false);
    const [mapVariants, setMapVariants] = useState<api.MapVariant[]>([]);
    const [selectedVariant, setSelectedVariant] = useState<string>('');
    const [variantsLoading, setVariantsLoading] = useState<boolean>(false);
    /** 'variant' = only the chosen variant + referenced kit-pieces (default,
     *  matches what MapgeoAddon ships). 'full' = legacy whole-WAD dump. */
    const [mapExtractMode, setMapExtractMode] = useState<'variant' | 'full'>('variant');

    // ─── Loading screen state ────────────────────────────────────────────
    const [videoFile, setVideoFile] = useState<File | null>(null);
    const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
    const [trimStart, setTrimStart] = useState(0);
    const [trimEnd, setTrimEnd] = useState(0);
    const [scaleFactor, setScaleFactor] = useState(0.5);
    const [customFps, setCustomFps] = useState(30);
    const [budget, setBudget] = useState<BudgetResult | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
    const [videoEditorOpen, setVideoEditorOpen] = useState(false);
    const [editorPlaying, setEditorPlaying] = useState(false);
    const [editorCurrentTime, setEditorCurrentTime] = useState(0);
    const videoPreviewRef = useRef<HTMLVideoElement>(null);
    const videoInputRef = useRef<HTMLInputElement>(null);
    const previewVideoRef = useRef<HTMLVideoElement>(null);
    const videoEditorRef = useRef<HTMLVideoElement>(null);
    const timelineRef = useRef<HTMLDivElement>(null);
    const draggingHandle = useRef<'start' | 'end' | null>(null);
    const editorVideoUrlRef = useRef<string | null>(null);

    const isVisible = state.activeModal === 'newProject';

    // ─── Effects ─────────────────────────────────────────────────────────

    useEffect(() => {
        if (isVisible && !projectPath) {
            setDefaultProjectPath();
        }
    }, [isVisible]);

    useEffect(() => {
        if (isVisible) {
            loadChampions();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVisible, usePbe]);

    useEffect(() => {
        if (selectedChampion) {
            loadSkins(selectedChampion.id, selectedChampion.alias);
        } else {
            setSkins([]);
            setSelectedSkin(null);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedChampion, usePbe]);

    useEffect(() => {
        setSplashLoaded(false);
    }, [selectedSkin, selectedChampion]);

    useEffect(() => {
        if (!isVisible || projectType !== 'map' || !effectiveLeaguePath) {
            return;
        }
        let cancelled = false;
        (async () => {
            setMapsLoading(true);
            try {
                const maps = await api.listAvailableMaps(effectiveLeaguePath);
                if (cancelled) return;
                setAvailableMaps(maps);
                // Default to the first map (usually map11 / Summoner's Rift) if nothing selected
                if (maps.length > 0 && !selectedMapId) {
                    setSelectedMapId(maps[0].id);
                }
            } catch (err) {
                console.error('[NewProject] listAvailableMaps failed:', err);
                showToast('error', 'Failed to scan League maps folder — see log panel');
            } finally {
                if (!cancelled) setMapsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVisible, projectType, effectiveLeaguePath, usePbe]);

    // Fetch the variant list whenever the selected map changes. Variants
    // come from the WAD's resolved-paths scan (mapgeo + materials.bin pairs
    // grouped by base name), so this requires a hash db + ~1s WAD scan.
    useEffect(() => {
        if (!isVisible || projectType !== 'map' || !effectiveLeaguePath || !selectedMapId) {
            setMapVariants([]);
            setSelectedVariant('');
            return;
        }
        let cancelled = false;
        (async () => {
            setVariantsLoading(true);
            try {
                const variants = await api.listMapVariants(effectiveLeaguePath, selectedMapId);
                if (cancelled) return;
                setMapVariants(variants);
                // Pick the first variant by default — "room" on Summoner's Rift,
                // sorted alphabetically across all maps.
                setSelectedVariant(variants[0]?.name ?? '');
            } catch (err) {
                console.error('[NewProject] listMapVariants failed:', err);
                if (!cancelled) {
                    setMapVariants([]);
                    setSelectedVariant('');
                }
            } finally {
                if (!cancelled) setVariantsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [isVisible, projectType, effectiveLeaguePath, selectedMapId]);

    // Recalculate budget whenever video params change
    useEffect(() => {
        if (!videoMeta) {
            setBudget(null);
            return;
        }
        const result = calculateBudget({
            videoWidth: videoMeta.width,
            videoHeight: videoMeta.height,
            scaleFactor,
            fps: customFps,
            trimStart,
            trimEnd,
        });
        setBudget(result);
    }, [videoMeta, scaleFactor, customFps, trimStart, trimEnd]);

    // ─── Video editor effects & handlers ─────────────────────────────────

    useEffect(() => {
        if (!videoEditorOpen || !videoFile || !videoEditorRef.current) return;
        const url = URL.createObjectURL(videoFile);
        editorVideoUrlRef.current = url;
        const vid = videoEditorRef.current;
        vid.src = url;
        vid.currentTime = trimStart;
        return () => {
            URL.revokeObjectURL(url);
            editorVideoUrlRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoEditorOpen, videoFile]);

    const handleEditorMouseMove = (e: React.MouseEvent) => {
        if (!draggingHandle.current || !timelineRef.current || !videoMeta) return;
        const rect = timelineRef.current.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const time = parseFloat((ratio * videoMeta.duration).toFixed(2));
        if (draggingHandle.current === 'start') {
            setTrimStart(Math.min(time, trimEnd - 0.1));
        } else {
            setTrimEnd(Math.max(time, trimStart + 0.1));
        }
    };

    const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (draggingHandle.current || !timelineRef.current || !videoMeta) return;
        const rect = timelineRef.current.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const time = ratio * videoMeta.duration;
        const distStart = Math.abs(time - trimStart);
        const distEnd = Math.abs(time - trimEnd);
        if (distStart <= distEnd) {
            setTrimStart(parseFloat(Math.min(time, trimEnd - 0.1).toFixed(2)));
        } else {
            setTrimEnd(parseFloat(Math.max(time, trimStart + 0.1).toFixed(2)));
        }
        if (videoEditorRef.current) videoEditorRef.current.currentTime = time;
    };

    const formatEditorTime = (s: number) => {
        const m = Math.floor(s / 60);
        const sec = (s % 60).toFixed(1).padStart(4, '0');
        return `${m}:${sec}`;
    };

    // ─── Helpers ─────────────────────────────────────────────────────────

    const setDefaultProjectPath = async () => {
        try {
            const home = await api.getAppHome();
            setProjectPath(`${home.replace(/\\/g, '/')}/projects`);
        } catch {
            setProjectPath('C:/Users/Projects/Flint');
        }
    };

    const loadChampions = async () => {
        let result: datadragon.DDragonChampion[];
        try {
            setWorking(usePbe ? 'Loading PBE champions...' : 'Loading champions...');
            result = await datadragon.fetchChampions(cdragonBranch);
            setChampions(result);
            setReady();
            console.info(`[NewProject] Loaded ${result.length} champions from CDragon (${cdragonBranch})`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[NewProject] fetchChampions(${cdragonBranch}) failed: ${msg}`, err);
            showToast('error', `Failed to load ${usePbe ? 'PBE ' : ''}champions — see log panel`);
            setReady();
            return;
        }
        // Preload icons — outside try/catch so a preload error doesn't masquerade as a fetch error
        if (typeof datadragon.preloadChampionIcons !== 'function') {
            console.warn('[NewProject] datadragon.preloadChampionIcons is missing — likely a stale HMR module. Hard-reload (Ctrl+Shift+R) or restart the dev server.');
            return;
        }
        datadragon.preloadChampionIcons(result, cdragonBranch)
            .then(() => setCacheReady(v => v + 1))
            .catch((err) => console.warn(`[NewProject] Champion icon preload (${cdragonBranch}) failed:`, err));
    };

    const loadSkins = async (championId: number, alias: string) => {
        let result: datadragon.DDragonSkin[] | null = null;
        try {
            setWorking('Loading skins...');
            result = await datadragon.fetchChampionSkins(championId, alias, cdragonBranch);
            setSkins(result);
            const baseSkin = result.find(s => s.isBase) || result[0];
            setSelectedSkin(baseSkin);
            setReady();
            console.info(`[NewProject] Loaded ${result.length} skins for ${alias} (id=${championId}, branch=${cdragonBranch})`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[NewProject] fetchChampionSkins(${alias}, id=${championId}, branch=${cdragonBranch}) failed: ${msg}`, err);
            showToast('error', `Skin fetch failed for ${alias} — see log panel`);
            setSkins([{ id: championId * 1000, name: 'Base', num: 0, isBase: true }]);
            setSelectedSkin({ id: championId * 1000, name: 'Base', num: 0, isBase: true });
            setReady();
        }
        // Preload splashes — outside try/catch so failures don't reset skins
        if (result && result.length > 0) {
            if (typeof datadragon.preloadSkinSplashes !== 'function') {
                console.warn('[NewProject] datadragon.preloadSkinSplashes is missing — likely a stale HMR module. Hard-reload (Ctrl+Shift+R) or restart the dev server.');
                return;
            }
            datadragon.preloadSkinSplashes(championId, result, cdragonBranch).catch((err) => {
                console.warn(`[NewProject] Splash preload for ${alias} (branch=${cdragonBranch}) failed:`, err);
            });
        }
    };

    const handleBrowsePath = async () => {
        try {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const selected = await open({ title: 'Select Project Location', directory: true });
            if (selected) setProjectPath(selected as string);
        } catch { /* ignore */ }
    };

    // ─── Video file handling ─────────────────────────────────────────────

    const handleVideoSelect = () => {
        videoInputRef.current?.click();
    };

    const onVideoInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        try {
            await loadVideoFile(file);
        } catch (err) {
            showToast('error', 'Failed to load video file');
        }
    };

    const loadVideoFile = async (file: File) => {
        try {
            const meta = await getVideoMetadata(file);
            setVideoFile(file);
            setVideoMeta(meta);
            setTrimStart(0);
            setTrimEnd(meta.duration);
            setCustomFps(Math.min(30, Math.round(meta.fps)));

            if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }

            if (videoPreviewRef.current) {
                videoPreviewRef.current.src = URL.createObjectURL(file);
            }
        } catch (err) {
            showToast('error', 'Failed to read video metadata. Ensure it is a valid MP4 or WebM file.');
        }
    };

    const generatePreview = async () => {
        if (!videoFile || !videoMeta) return;
        setIsGeneratingPreview(true);
        if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }

        try {
            const outW = Math.floor(videoMeta.width * scaleFactor);
            const outH = Math.floor(videoMeta.height * scaleFactor);
            const duration = trimEnd - trimStart;
            const totalFrames = Math.ceil(duration * customFps);

            const video = document.createElement('video');
            video.preload = 'auto';
            video.muted = true;
            const srcUrl = URL.createObjectURL(videoFile);
            await new Promise<void>((resolve, reject) => {
                video.oncanplaythrough = () => resolve();
                video.onerror = () => reject(new Error('Failed to load video'));
                video.src = srcUrl;
            });

            const canvas = document.createElement('canvas');
            canvas.width = outW;
            canvas.height = outH;
            const ctx = canvas.getContext('2d')!;

            const stream = canvas.captureStream(0);
            const recorder = new MediaRecorder(stream, {
                mimeType: 'video/webm;codecs=vp9',
                videoBitsPerSecond: 2_000_000,
            });
            const chunks: Blob[] = [];
            recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

            const done = new Promise<Blob>((resolve) => {
                recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
            });
            recorder.start();

            const frameInterval = 1 / customFps;
            for (let i = 0; i < totalFrames; i++) {
                const time = Math.min(trimStart + i * frameInterval, video.duration - 0.001);

                await new Promise<void>((resolve, reject) => {
                    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
                    video.addEventListener('seeked', onSeeked);
                    video.addEventListener('error', () => reject(), { once: true });
                    video.currentTime = time;
                });

                ctx.drawImage(video, 0, 0, outW, outH);
                (stream.getVideoTracks()[0] as any).requestFrame?.();

                await new Promise(r => setTimeout(r, frameInterval * 1000));
            }

            recorder.stop();
            const blob = await done;
            URL.revokeObjectURL(srcUrl);

            const url = URL.createObjectURL(blob);
            setPreviewUrl(url);

            if (previewVideoRef.current) {
                previewVideoRef.current.src = url;
                previewVideoRef.current.play().catch(() => {});
            }
        } catch (err) {
            showToast('error', 'Failed to generate preview');
        } finally {
            setIsGeneratingPreview(false);
        }
    };

    const handleVideoDrop = useCallback(async (e: React.DragEvent) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('video/')) {
            await loadVideoFile(file);
        }
    }, []);

    // ─── Create handlers ─────────────────────────────────────────────────

    const handleCreateSkin = async () => {
        if (!projectName || !projectPath || !selectedChampion || !selectedSkin) {
            showToast('error', 'Please fill in all required fields');
            return;
        }
        if (!effectiveLeaguePath) {
            showToast('error', usePbe
                ? 'PBE League path is not configured. Open Settings (Ctrl+,) and set the LoL PBE folder.'
                : 'League path is not configured. Open Settings (Ctrl+,) and set the LoL folder.');
            return;
        }

        setIsCreating(true);
        setProgress(usePbe ? 'Creating project from PBE...' : 'Creating project...');

        // Log context up-front so the panel reads top-down: context → error.
        // The error itself is logged automatically by invokeCommand in api.ts.
        console.info(
            `[NewProject] Creating project: champion=${selectedChampion.alias}, skin=${selectedSkin.num}, pbe=${usePbe}, leaguePath=${effectiveLeaguePath}`
        );

        try {
            const project = await api.createProject({
                name: projectName,
                champion: selectedChampion.alias,
                skin: selectedSkin.num,
                projectPath,
                leaguePath: effectiveLeaguePath,
                creatorName: state.creatorName || undefined,
                useJade: configStore.binConverterEngine === 'jade',
                isPbe: usePbe,
            });

            await finishProjectCreation(project, selectedChampion.name, selectedSkin.num);
        } catch (err) {
            const flintError = err as api.FlintError;
            const userMsg = flintError.getUserMessage?.() || 'Failed to create project';
            showToast('error', `${userMsg} — see log panel for full error`);
        } finally {
            setIsCreating(false);
            setProgress('');
        }
    };

    const handleCreateLoadingScreen = async () => {
        if (!projectName || !projectPath || !videoFile || !budget?.fits || !budget.grid) {
            showToast('error', 'Please fill in all required fields and ensure spritesheet fits within 16k limit');
            return;
        }
        if (!effectiveLeaguePath) {
            showToast('error', usePbe
                ? 'PBE League path is not configured. Open Settings (Ctrl+,) and set the LoL PBE folder.'
                : 'League path is not configured. Open Settings (Ctrl+,) and set the LoL folder.');
            return;
        }

        setIsCreating(true);
        console.info(
            `[NewProject] Creating loading-screen project: pbe=${usePbe}, leaguePath=${effectiveLeaguePath}`
        );

        try {
            setProgress('Extracting video frames...');
            const blob = await generateSpritesheet({
                file: videoFile,
                trimStart,
                trimEnd,
                scaleFactor,
                fps: customFps,
                grid: budget.grid,
                frameW: budget.frameW,
                frameH: budget.frameH,
                onProgress: (cur, total) => setProgress(`Extracting frame ${cur}/${total}...`),
            });

            setProgress('Encoding spritesheet & injecting config...');
            const arrayBuf = await blob.arrayBuffer();
            const pngBytes = Array.from(new Uint8Array(arrayBuf));
            const project = await api.createLoadingScreenProject({
                name: projectName,
                projectPath,
                leaguePath: effectiveLeaguePath,
                creatorName: state.creatorName || 'SirDexal',
                spritesheetPngData: pngBytes,
                frameWidth: budget.frameW,
                frameHeight: budget.frameH,
                sheetWidth: budget.grid.sheetWidth,
                sheetHeight: budget.grid.sheetHeight,
                fps: customFps,
                totalFrames: budget.totalFrames,
                cols: budget.grid.cols,
                rows: budget.grid.rows,
            });

            await finishProjectCreation(project, 'Loading Screen', 0);
        } catch (err) {
            const flintError = err as api.FlintError;
            const userMsg = flintError.getUserMessage?.() || 'Failed to create loading screen project';
            showToast('error', `${userMsg} — see log panel for full error`);
        } finally {
            setIsCreating(false);
            setProgress('');
        }
    };

    const handleCreateMap = async () => {
        if (!projectName || !projectPath || !selectedMapId) {
            showToast('error', 'Please fill in all required fields');
            return;
        }
        if (!effectiveLeaguePath) {
            showToast('error', 'League path is not configured. Open Settings (Ctrl+,) and set the LoL folder.');
            return;
        }

        setIsCreating(true);
        setProgress('Creating map project...');
        console.info(
            `[NewProject] Creating map project: map=${selectedMapId}, levels=${includeLevels}, leaguePath=${effectiveLeaguePath}`
        );

        if (mapExtractMode === 'variant' && !selectedVariant) {
            showToast('error', 'No variant selected — pick one or switch to "Full WAD" mode.');
            return;
        }

        try {
            const project = await api.createMapProject({
                name: projectName,
                mapId: selectedMapId,
                includeLevels,
                projectPath,
                leaguePath: effectiveLeaguePath,
                creatorName: state.creatorName || undefined,
                extractMode: mapExtractMode,
                variantName: mapExtractMode === 'variant' ? selectedVariant : undefined,
            });
            const mapEntry = availableMaps.find(m => m.id === selectedMapId);
            await finishProjectCreation(project, mapEntry?.displayName || selectedMapId, 0);
        } catch (err) {
            const flintError = err as api.FlintError;
            const userMsg = flintError.getUserMessage?.() || 'Failed to create map project';
            showToast('error', `${userMsg} — see log panel for full error`);
        } finally {
            setIsCreating(false);
            setProgress('');
        }
    };

    const handleCreate = () => {
        if (projectType === 'skin') return handleCreateSkin();
        if (projectType === 'map') return handleCreateMap();
        return handleCreateLoadingScreen();
    };

    const finishProjectCreation = async (project: Project, championName: string, skinNum: number) => {
        setProgress('Opening project...');

        const projectDir = project.project_path || projectPath;
        dispatch({ type: 'SET_PROJECT', payload: { project, path: projectDir } });

        const files = await api.listProjectFiles(projectDir);
        dispatch({ type: 'SET_FILE_TREE', payload: files });

        const recent = state.recentProjects.filter(p => p.path !== projectDir);
        recent.unshift({
            name: project.display_name || project.name,
            champion: championName,
            skin: skinNum,
            path: projectDir,
            lastOpened: new Date().toISOString(),
        });
        dispatch({ type: 'SET_RECENT_PROJECTS', payload: recent.slice(0, 10) });

        closeModal();
        showToast('success', 'Project created successfully!');

        // No auto-checkpoint on project creation. The "initial state" of a
        // brand-new project IS the on-disk state — there's nothing to roll
        // back to that's different from the file tree the user sees. This
        // was costing ~2.8s of wall time after every create_project for a
        // checkpoint nobody asked for.
    };

    // ─── Computed values ─────────────────────────────────────────────────

    const filteredChampions = championSearch
        ? champions.filter(c => c.name.toLowerCase().includes(championSearch.toLowerCase()))
        : champions;

    const filteredSkins = skinSearch
        ? skins.filter(s => s.name.toLowerCase().includes(skinSearch.toLowerCase()))
        : skins;

    const canCreateSkin = projectType === 'skin'
        && !!projectName && !!projectPath && !!selectedChampion && !!selectedSkin && !isCreating;

    const canCreateLoadingScreen = projectType === 'loading-screen'
        && !!projectName && !!projectPath && !!videoFile && !!budget?.fits && !isCreating;

    const canCreateMap = projectType === 'map'
        && !!projectName && !!projectPath && !!selectedMapId && !!effectiveLeaguePath && !isCreating
        && (mapExtractMode === 'full' || !!selectedVariant);

    const canCreate = canCreateSkin || canCreateLoadingScreen || canCreateMap;

    const budgetMaxDim = budget ? Math.max(budget.grid?.sheetWidth ?? 0, budget.grid?.sheetHeight ?? 0) : 0;
    const budgetPercent = Math.min(100, (budgetMaxDim / 16384) * 100);

    // ─── Image URL helpers (use blob cache when available) ────────────────

    const cachedUrl = (url: string) => {
        void cacheReady; // dependency — re-renders when preload completes
        return datadragon.getCachedImageUrl?.(url) ?? url;
    };

    const getHeroSplashUrl = () => {
        if (!selectedChampion || !selectedSkin) return '';
        // Prefer the centered loading-screen splash from CDragon's per-champion JSON.
        // (Pattern from preyneyv/lol-skin-explorer — see Skin-Explorer/data/helpers.js `asset()`.)
        const centered = datadragon.getSkinCenteredSplashUrl(selectedSkin, cdragonBranch);
        if (centered) return cachedUrl(centered);
        // No splashPath in the JSON (rare) → uncentered CDragon art as a last resort.
        return cachedUrl(datadragon.getSkinSplashCDragonUrl(selectedChampion.id, selectedSkin.id, cdragonBranch));
    };

    const getHeroSplashFallback = () => {
        if (!selectedChampion || !selectedSkin) return '';
        // First fallback: uncentered CDragon splash (still on the selected branch).
        // Second fallback (DDragon, live only) handled below if both fail.
        return cachedUrl(datadragon.getSkinSplashCDragonUrl(selectedChampion.id, selectedSkin.id, cdragonBranch));
    };

    const getHeroSplashFinalFallback = () => {
        if (!selectedChampion || !selectedSkin) return '';
        // DDragon has no PBE branch — used only when both CDragon attempts fail.
        return cachedUrl(datadragon.getSkinSplashUrl(selectedChampion.alias, selectedSkin.num));
    };

    if (!isVisible) return null;

    return (
        // Custom modal shell — has nested np-skin-picker-overlay / np-video-editor-overlay
        // siblings that depend on .modal-overlay being the nearest positioned ancestor.
        // Don't migrate to <Modal> — it would change the containing block.
        <div className="modal-overlay modal-overlay--visible">
            <div className="modal modal--new-project">
                {/* Loading overlay — skeleton workspace preview */}
                {isCreating && (
                    <div className="np-loading-overlay">
                        <div className="np-skel">
                            <div className="np-skel__topbar">
                                <span className="np-skel__shimmer" style={{ width: 110 }} />
                                <span className="np-skel__shimmer np-skel__shimmer--soft" style={{ width: 70 }} />
                                <span className="np-skel__spacer" />
                                <span className="np-skel__dot" />
                                <span className="np-skel__dot" />
                                <span className="np-skel__dot" />
                            </div>
                            <div className="np-skel__body">
                                <aside className="np-skel__side">
                                    <span className="np-skel__shimmer" style={{ width: 90 }} />
                                    {Array.from({ length: 7 }).map((_, i) => (
                                        <span
                                            key={i}
                                            className="np-skel__shimmer np-skel__shimmer--row"
                                            style={{
                                                width: `${60 + ((i * 13) % 35)}%`,
                                                marginLeft: i % 3 === 0 ? 0 : 14,
                                                animationDelay: `${i * 80}ms`,
                                            }}
                                        />
                                    ))}
                                </aside>
                                <main className="np-skel__main">
                                    <div className="np-skel__hero">
                                        <span className="np-skel__shimmer" style={{ width: 200, height: 18 }} />
                                        <span className="np-skel__shimmer np-skel__shimmer--soft" style={{ width: 320, height: 12 }} />
                                    </div>
                                    <div className="np-skel__grid">
                                        {Array.from({ length: 6 }).map((_, i) => (
                                            <div key={i} className="np-skel__tile" style={{ animationDelay: `${i * 90}ms` }}>
                                                <span className="np-skel__shimmer np-skel__shimmer--block" />
                                                <span className="np-skel__shimmer np-skel__shimmer--row" style={{ width: '70%' }} />
                                            </div>
                                        ))}
                                    </div>
                                </main>
                            </div>
                            <div className="np-skel__statusline">
                                <span className="np-skel__pulse" />
                                <span className="np-skel__title">Creating Project</span>
                                <span className="np-skel__progress">{progress || 'Preparing workspace…'}</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Header — compact: title left, subtitle on the right */}
                <div className="np-header">
                    <h2 className="np-header__title">New Project</h2>
                    <span className="np-header__subtitle">Choose a project type and configure it</span>
                </div>

                {/* Body */}
                <div className="np-body">
                    {/* ─── Project Type Cards ─── */}
                    <div className="np-type-selector">
                        <button
                            className={`np-type-card${projectType === 'skin' ? ' np-type-card--active' : ''}`}
                            onClick={() => setProjectType('skin')}
                        >
                            <div className="np-type-card__glow" />
                            <div className="np-type-card__icon">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                                    <path d="M7 12.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM10 8.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM14 8.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM17 12.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" fill="currentColor"/>
                                    <path d="M16.36 14.64a3 3 0 01-2.83 2.36c-.55 0-1-.45-1-1v-1a1 1 0 00-1-1h-1a1 1 0 00-1 1v1c0 .55-.45 1-1 1a3 3 0 01-2.83-2.36" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
                                </svg>
                            </div>
                            <span className="np-type-card__label">Skin</span>
                        </button>

                        {import.meta.env.DEV && (
                            <button
                                className={`np-type-card${projectType === 'map' ? ' np-type-card--active' : ''}`}
                                onClick={() => setProjectType('map')}
                            >
                                <div className="np-type-card__glow" />
                                <div className="np-type-card__icon">
                                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                                        <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round"/>
                                        <path d="M9 4v14M15 6v14" stroke="currentColor" strokeWidth="1.5"/>
                                    </svg>
                                </div>
                                <span className="np-type-card__label">Map</span>
                            </button>
                        )}

                        <button
                            className={`np-type-card${projectType === 'loading-screen' ? ' np-type-card--active' : ''}`}
                            onClick={() => setProjectType('loading-screen')}
                        >
                            <div className="np-type-card__glow" />
                            <div className="np-type-card__icon">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                                    <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                                    <polygon points="10,9 10,15 15,12" fill="currentColor"/>
                                </svg>
                            </div>
                            <span className="np-type-card__label">Loading Screen</span>
                        </button>
                    </div>

                    {/* ════════════ Skin Project Form ════════════ */}
                    <div className={`np-form${projectType === 'skin' ? ' np-form--active' : ''}`}>
                        {/* Hero splash preview with splash-tinted glow behind it */}
                        {selectedChampion && selectedSkin && (
                            <div className="np-hero-wrap">
                                <div
                                    className="np-hero-glow"
                                    style={{ backgroundImage: `url(${JSON.stringify(getHeroSplashUrl()).slice(1, -1)})` }}
                                    aria-hidden="true"
                                />
                                <div className="np-hero-splash">
                                    <img
                                        key={`${selectedChampion.id}-${selectedSkin.id}-${cdragonBranch}`}
                                        src={getHeroSplashUrl()}
                                        alt={selectedSkin.name}
                                        className={`np-hero-splash__img${splashLoaded ? ' np-hero-splash__img--loaded' : ''}`}
                                        onLoad={() => setSplashLoaded(true)}
                                        onError={(e) => {
                                            const img = e.target as HTMLImageElement;
                                            const fb1 = getHeroSplashFallback();
                                            const fb2 = getHeroSplashFinalFallback();
                                            if (img.src !== fb1 && fb1) {
                                                img.src = fb1;
                                            } else if (img.src !== fb2 && fb2) {
                                                img.src = fb2;
                                            } else {
                                                setSplashLoaded(true);
                                            }
                                        }}
                                    />
                                    <div className="np-hero-splash__overlay" />
                                    <div className="np-hero-splash__info">
                                        <span className="np-hero-splash__champion">{selectedChampion.name}</span>
                                        <span className="np-hero-splash__skin">{selectedSkin.name}</span>
                                    </div>
                                    <button
                                        className="np-hero-splash__edit"
                                        onClick={() => { setSkinSearch(''); setSkinPickerOpen(true); }}
                                        title="Change skin"
                                    >
                                        <Icon name="file-edit" />
                                        <span>Change skin</span>
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Project details row */}
                        <NameAndPathRow
                            namePlaceholder="e.g., Ahri Base Rework"
                            name={projectName}
                            onNameChange={setProjectName}
                            path={projectPath}
                            onPathChange={setProjectPath}
                            onBrowse={handleBrowsePath}
                        />

                        {/* Champion Selection */}
                        <div className="np-section">
                            <div className="np-section__header">
                                <label className="np-label">Champion</label>
                                <div className="np-search-wrap">
                                    <span className="np-search-icon"><Icon name="search" /></span>
                                    <input
                                        type="text"
                                        className="np-search"
                                        placeholder="Search…"
                                        value={championSearch}
                                        onChange={(e) => setChampionSearch(e.target.value)}
                                    />
                                </div>
                            </div>
                            <div className="np-champion-grid">
                                {filteredChampions.map((champ, i) => (
                                    <button
                                        key={champ.id}
                                        className={`np-champ-card${selectedChampion?.id === champ.id ? ' np-champ-card--active' : ''}`}
                                        onClick={() => { setSelectedChampion(champ); setChampionSearch(''); }}
                                        title={champ.name}
                                        style={{ animationDelay: `${Math.min(i * 15, 300)}ms` }}
                                    >
                                        <img
                                            src={cachedUrl(datadragon.getChampionIconUrl(champ.id))}
                                            alt={champ.name}
                                            className="np-champ-card__icon"
                                            loading="lazy"
                                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                        />
                                        <span className="np-champ-card__name">{champ.name}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                    </div>

                    {/* ════════════ Loading Screen Form ════════════ */}
                    <div className={`np-form${projectType === 'loading-screen' ? ' np-form--active' : ''}`}>
                        <NameAndPathRow
                            namePlaceholder="e.g., My Animated Loadscreen"
                            name={projectName}
                            onNameChange={setProjectName}
                            path={projectPath}
                            onPathChange={setProjectPath}
                            onBrowse={handleBrowsePath}
                        />

                        {/* Video Selection */}
                        <input
                            ref={videoInputRef}
                            type="file"
                            accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.avi,.mkv"
                            style={{ display: 'none' }}
                            onChange={onVideoInputChange}
                        />
                        <div className="np-section">
                            <label className="np-label">Video File</label>
                            {!videoFile ? (
                                <div
                                    className="video-picker"
                                    onClick={handleVideoSelect}
                                    onDragOver={(e) => e.preventDefault()}
                                    onDrop={handleVideoDrop}
                                >
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                                        <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                                        <polygon points="10,9 10,15 15,12" fill="currentColor"/>
                                    </svg>
                                    <span className="video-picker__text">Click to select or drag & drop a video file</span>
                                    <span className="video-picker__hint">Supports MP4, WebM, MOV</span>
                                </div>
                            ) : (
                                <div className="video-info">
                                    <div className="video-info__preview">
                                        <video
                                            ref={videoPreviewRef}
                                            muted
                                            playsInline
                                            className="video-info__video"
                                        />
                                    </div>
                                    <div className="video-info__meta">
                                        <div className="video-info__name">{videoFile.name}</div>
                                        <div className="video-info__details">
                                            {videoMeta && (
                                                <>
                                                    <span>{videoMeta.width}&times;{videoMeta.height}</span>
                                                    <span className="video-info__tag">{(trimEnd - trimStart).toFixed(1)}s clip</span>
                                                    <span className="video-info__tag">{Math.floor(videoMeta.width * scaleFactor)}&times;{Math.floor(videoMeta.height * scaleFactor)}</span>
                                                    <span className="video-info__tag">{customFps} fps</span>
                                                </>
                                            )}
                                        </div>
                                        {budget && (
                                            <div className={`video-info__budget-badge${budget.fits ? ' video-info__budget-badge--ok' : ' video-info__budget-badge--exceeded'}`}>
                                                {budget.fits ? (
                                                    <>
                                                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                                        {budget.totalFrames} frames · {budget.grid?.sheetWidth}&times;{budget.grid?.sheetHeight}px
                                                    </>
                                                ) : (
                                                    <>
                                                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v5M6 9v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                                        Exceeds 16k limit — open editor to adjust
                                                    </>
                                                )}
                                            </div>
                                        )}
                                        <div className="video-info__actions">
                                            <Button
                                                size="sm"
                                                onClick={() => {
                                                    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }
                                                    setVideoFile(null); setVideoMeta(null); setBudget(null);
                                                }}
                                            >
                                                Change
                                            </Button>
                                            <Button
                                                variant="primary"
                                                size="sm"
                                                icon="file-edit"
                                                onClick={() => setVideoEditorOpen(true)}
                                            >
                                                Edit
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* ════════════ Map Project Form (Dev Only) ════════════ */}
                    {import.meta.env.DEV && (
                    <div className={`np-form${projectType === 'map' ? ' np-form--active' : ''}`}>
                        <NameAndPathRow
                            namePlaceholder="e.g., My Custom Map"
                            name={projectName}
                            onNameChange={setProjectName}
                            path={projectPath}
                            onPathChange={setProjectPath}
                            onBrowse={handleBrowsePath}
                        />

                        {/* Source — map + variant grouped in a card */}
                        <section className="np-map-section">
                            <header className="np-map-section__head">
                                <span className="np-map-section__step">1</span>
                                <div>
                                    <div className="np-map-section__title">Source map</div>
                                    <div className="np-map-section__sub">
                                        Pick a Riot map from <code>Game/DATA/FINAL/Maps/Shipping</code>
                                    </div>
                                </div>
                            </header>

                            <div className="np-map-row">
                                <div className="np-map-field">
                                    <label className="np-label">Map</label>
                                    <Picker
                                        fullWidth
                                        menuMaxHeight={210}
                                        value={selectedMapId}
                                        onChange={setSelectedMapId}
                                        disabled={mapsLoading || availableMaps.length === 0}
                                        placeholder={
                                            mapsLoading ? 'Scanning maps…'
                                            : availableMaps.length === 0 ? 'No maps found in League folder'
                                            : 'Select a map…'
                                        }
                                        options={availableMaps.map(m => ({
                                            value: m.id,
                                            label: m.displayName,
                                            hint: `${m.id}${m.hasLevels ? ' · +LEVELS' : ''}`,
                                        }))}
                                    />
                                </div>
                                <div className="np-map-field">
                                    <label className="np-label">
                                        Variant
                                        {mapVariants.length > 0 && (
                                            <span className="np-map-count">{mapVariants.length}</span>
                                        )}
                                    </label>
                                    <Picker
                                        fullWidth
                                        menuMaxHeight={210}
                                        value={selectedVariant}
                                        onChange={setSelectedVariant}
                                        disabled={
                                            mapExtractMode === 'full' ||
                                            variantsLoading ||
                                            mapVariants.length === 0
                                        }
                                        placeholder={
                                            mapExtractMode === 'full' ? 'Not used in Full WAD mode'
                                            : variantsLoading ? 'Scanning variants…'
                                            : mapVariants.length === 0 ? 'No variants found'
                                            : 'Select a variant…'
                                        }
                                        options={mapVariants.map(v => ({
                                            value: v.name,
                                            label: v.name,
                                        }))}
                                    />
                                </div>
                            </div>
                        </section>

                        {/* Extraction strategy — two big cards */}
                        <section className="np-map-section">
                            <header className="np-map-section__head">
                                <span className="np-map-section__step">2</span>
                                <div>
                                    <div className="np-map-section__title">Extraction strategy</div>
                                    <div className="np-map-section__sub">
                                        Variant only is fastest; Full WAD pulls every chunk
                                    </div>
                                </div>
                            </header>

                            <div className="np-map-mode-grid">
                                <button
                                    type="button"
                                    onClick={() => setMapExtractMode('variant')}
                                    className={`np-map-mode${mapExtractMode === 'variant' ? ' np-map-mode--active' : ''}`}
                                >
                                    <span className="np-map-mode__check">
                                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                            <path d="M3 8l4 4 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                        </svg>
                                    </span>
                                    <span className="np-map-mode__icon" aria-hidden>
                                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"/>
                                            <path d="M3.3 7.5L12 12.5l8.7-5"/>
                                            <path d="M12 12.5V21"/>
                                        </svg>
                                    </span>
                                    <span className="np-map-mode__body">
                                        <span className="np-map-mode__title">Variant only</span>
                                        <span className="np-map-mode__desc">
                                            mapgeo + materials.bin + the assets it references
                                        </span>
                                        <span className="np-map-mode__tag">Recommended · fast</span>
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setMapExtractMode('full')}
                                    className={`np-map-mode${mapExtractMode === 'full' ? ' np-map-mode--active' : ''}`}
                                >
                                    <span className="np-map-mode__check">
                                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                            <path d="M3 8l4 4 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                        </svg>
                                    </span>
                                    <span className="np-map-mode__icon" aria-hidden>
                                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="3" y="5" width="18" height="14" rx="2"/>
                                            <path d="M3 9h18M8 5V3m8 2V3"/>
                                        </svg>
                                    </span>
                                    <span className="np-map-mode__body">
                                        <span className="np-map-mode__title">Full WAD</span>
                                        <span className="np-map-mode__desc">
                                            Every chunk — heavy, gigabytes
                                        </span>
                                        <span className="np-map-mode__tag np-map-mode__tag--warn">Power users</span>
                                    </span>
                                </button>
                            </div>

                            <label className="np-map-toggle">
                                <input
                                    type="checkbox"
                                    checked={includeLevels}
                                    onChange={(e) => setIncludeLevels(e.target.checked)}
                                />
                                <span className="np-map-toggle__body">
                                    <span className="np-map-toggle__title">Include LEVELS WAD</span>
                                    <span className="np-map-toggle__desc">
                                        Pull lightmaps, lightgrid and grass-tint textures
                                    </span>
                                </span>
                            </label>
                        </section>

                        <div className="np-hint">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{marginRight: '8px', flexShrink: 0}}>
                                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                                <path d="M8 5v3M8 10v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                            </svg>
                            {mapExtractMode === 'variant'
                                ? 'Pulls only the variant’s mapgeo + materials.bin and the asset paths it references (kit-pieces, textures, lightmaps). Matches MapgeoAddon’s scoped flow.'
                                : 'Dumps the entire map WAD into your project. Use this if you need every chunk — most users want “Variant only”.'}
                        </div>
                    </div>
                    )}
                </div>

                {/* Footer */}
                <div className="np-footer">
                    {(projectType === 'skin' || projectType === 'loading-screen') && (
                        <label
                            className={`np-pbe-toggle${usePbe ? ' np-pbe-toggle--on' : ''}`}
                            title={configStore.leaguePathPbe
                                ? 'Pull champion list, skin metadata and WAD files from your PBE install instead of Live.'
                                : 'No PBE League path configured. Open Settings (Ctrl+,) to set one.'}
                        >
                            <input
                                type="checkbox"
                                className="np-pbe-toggle__input"
                                checked={usePbe}
                                onChange={(e) => {
                                    const next = e.target.checked;
                                    if (next && !configStore.leaguePathPbe) {
                                        console.error('[NewProject] PBE toggle blocked: leaguePathPbe is null. Set it in Settings.');
                                        showToast('error', 'No PBE League path configured. Open Settings (Ctrl+,) to set one.');
                                        return;
                                    }
                                    console.info(`[NewProject] PBE toggle → ${next ? 'PBE' : 'Live'} (path=${next ? configStore.leaguePathPbe : state.leaguePath})`);
                                    setUsePbe(next);
                                }}
                            />
                            <span className="np-pbe-toggle__track">
                                <span className="np-pbe-toggle__thumb" />
                            </span>
                            <span className="np-pbe-toggle__label">PBE</span>
                        </label>
                    )}
                    <div className="np-footer__spacer" />
                    <Button variant="ghost" onClick={closeModal}>
                        Cancel
                    </Button>
                    <Button
                        variant="success"
                        icon="success"
                        onClick={handleCreate}
                        disabled={!canCreate}
                    >
                        Create Project
                    </Button>
                </div>
            </div>

            {/* ─── Video Editor Panel ─── */}
            {videoEditorOpen && videoFile && videoMeta && (
                <div className="np-video-editor-overlay" onClick={() => setVideoEditorOpen(false)}>
                    <div
                        className="np-video-editor"
                        onClick={(e) => e.stopPropagation()}
                        onMouseMove={handleEditorMouseMove}
                        onMouseUp={() => { draggingHandle.current = null; }}
                        onMouseLeave={() => { draggingHandle.current = null; }}
                    >
                        {/* Header */}
                        <div className="np-ve-header">
                            <span className="np-ve-header__title">Edit Video</span>
                            <button className="modal__close" onClick={() => setVideoEditorOpen(false)} aria-label="Close">
                                <Icon name="close" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="np-ve-content">
                            {/* Left: Video player */}
                            <div className="np-ve-player">
                                <div className="np-ve-player__viewport">
                                    <video
                                        ref={videoEditorRef}
                                        muted
                                        playsInline
                                        className="np-ve-video"
                                        onTimeUpdate={(e) => setEditorCurrentTime(e.currentTarget.currentTime)}
                                        onPlay={() => setEditorPlaying(true)}
                                        onPause={() => setEditorPlaying(false)}
                                        onEnded={() => { setEditorPlaying(false); if (videoEditorRef.current) videoEditorRef.current.currentTime = trimStart; }}
                                    />
                                </div>
                                <div className="np-ve-player__controls">
                                    <button
                                        className="np-ve-play-btn"
                                        onClick={() => {
                                            const vid = videoEditorRef.current;
                                            if (!vid) return;
                                            if (editorPlaying) {
                                                vid.pause();
                                            } else {
                                                if (vid.currentTime < trimStart || vid.currentTime >= trimEnd) {
                                                    vid.currentTime = trimStart;
                                                }
                                                vid.play().catch(() => {});
                                            }
                                        }}
                                    >
                                        {editorPlaying ? (
                                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                                <rect x="2" y="2" width="3.5" height="10" rx="1" fill="currentColor"/>
                                                <rect x="8.5" y="2" width="3.5" height="10" rx="1" fill="currentColor"/>
                                            </svg>
                                        ) : (
                                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                                <polygon points="3,2 11,7 3,12" fill="currentColor"/>
                                            </svg>
                                        )}
                                    </button>
                                    <span className="np-ve-player__time">
                                        {formatEditorTime(editorCurrentTime)} / {formatEditorTime(videoMeta.duration)}
                                    </span>
                                    <span className="np-ve-player__dims">{videoMeta.width}&times;{videoMeta.height}</span>
                                </div>
                            </div>

                            {/* Right: Controls */}
                            <div className="np-ve-controls">
                                {/* Trim timeline */}
                                <div className="np-ve-section">
                                    <label className="np-label">Trim</label>
                                    <div
                                        ref={timelineRef}
                                        className="np-ve-timeline"
                                        onClick={handleTimelineClick}
                                    >
                                        {/* Dimmed regions outside trim */}
                                        <div className="np-ve-timeline__bg" />
                                        <div
                                            className="np-ve-timeline__range"
                                            style={{
                                                left: `${(trimStart / videoMeta.duration) * 100}%`,
                                                width: `${((trimEnd - trimStart) / videoMeta.duration) * 100}%`,
                                            }}
                                        />
                                        {/* Playhead */}
                                        <div
                                            className="np-ve-timeline__playhead"
                                            style={{ left: `${(editorCurrentTime / videoMeta.duration) * 100}%` }}
                                        />
                                        {/* Start handle */}
                                        <div
                                            className="np-ve-timeline__handle np-ve-timeline__handle--start"
                                            style={{ left: `${(trimStart / videoMeta.duration) * 100}%` }}
                                            onMouseDown={(e) => { e.stopPropagation(); draggingHandle.current = 'start'; }}
                                        />
                                        {/* End handle */}
                                        <div
                                            className="np-ve-timeline__handle np-ve-timeline__handle--end"
                                            style={{ left: `${(trimEnd / videoMeta.duration) * 100}%` }}
                                            onMouseDown={(e) => { e.stopPropagation(); draggingHandle.current = 'end'; }}
                                        />
                                    </div>
                                    <div className="np-ve-timeline__labels">
                                        <span>{trimStart.toFixed(1)}s</span>
                                        <span className="np-ve-timeline__duration">{(trimEnd - trimStart).toFixed(1)}s selected</span>
                                        <span>{trimEnd.toFixed(1)}s</span>
                                    </div>
                                </div>

                                {/* Resolution + FPS */}
                                <div className="np-ve-row">
                                    <div className="np-field np-field--grow">
                                        <label className="np-label">Resolution</label>
                                        <Picker<string>
                                            fullWidth
                                            value={String(scaleFactor)}
                                            onChange={(v) => setScaleFactor(parseFloat(v))}
                                            options={SCALE_OPTIONS.map((opt) => ({
                                                value: String(opt.value),
                                                label: opt.label,
                                                hint: `${Math.floor(videoMeta.width * opt.value)}×${Math.floor(videoMeta.height * opt.value)}`,
                                            }))}
                                        />
                                    </div>
                                    <div className="np-field np-field--grow">
                                        <label className="np-label">FPS</label>
                                        <Picker<string>
                                            fullWidth
                                            value={String(customFps)}
                                            onChange={(v) => setCustomFps(parseInt(v, 10))}
                                            options={FPS_OPTIONS.map((fps) => ({
                                                value: String(fps),
                                                label: `${fps} fps`,
                                            }))}
                                        />
                                    </div>
                                </div>

                                {/* Spritesheet budget */}
                                <div className="np-ve-section">
                                    <label className="np-label">Spritesheet Budget</label>
                                    <div className={`budget-indicator ${budget?.fits ? 'budget-indicator--ok' : 'budget-indicator--exceeded'}`}>
                                        {budget && (
                                            <>
                                                <div className="budget-indicator__summary">
                                                    <span>{budget.totalFrames} frames</span>
                                                    {budget.grid && (
                                                        <>
                                                            <span>{budget.grid.cols}&times;{budget.grid.rows} grid</span>
                                                            <span>{budget.grid.sheetWidth}&times;{budget.grid.sheetHeight} px</span>
                                                        </>
                                                    )}
                                                </div>
                                                <div className="budget-indicator__bar-container">
                                                    <div className="budget-indicator__bar">
                                                        <div
                                                            className="budget-indicator__fill"
                                                            style={{ width: `${Math.min(100, budgetPercent)}%` }}
                                                        />
                                                    </div>
                                                    <span className="budget-indicator__label">
                                                        {budgetMaxDim.toLocaleString()} / 16,384
                                                    </span>
                                                </div>
                                                {!budget.fits && (
                                                    <div className="budget-indicator__warning">
                                                        Exceeds 16,384 pixel limit.
                                                        {budget.suggestedFrameCounts.length > 0 && (
                                                            <> Try: lower resolution or shorter clip (fits at {budget.suggestedFrameCounts.slice(0, 3).join(', ')} frames)</>
                                                        )}
                                                    </div>
                                                )}
                                                {budget.fits && (
                                                    <div className="budget-indicator__ok">Fits within texture limit</div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Preview */}
                                {previewUrl && (
                                    <div className="video-preview-player">
                                        <video
                                            ref={previewVideoRef}
                                            src={previewUrl}
                                            muted loop autoPlay playsInline controls
                                            className="video-preview-player__video"
                                        />
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="np-ve-footer">
                            <Button
                                size="sm"
                                onClick={generatePreview}
                                disabled={isGeneratingPreview || !budget?.fits}
                                title="Generate a preview with current settings"
                            >
                                {isGeneratingPreview ? 'Generating…' : 'Preview'}
                            </Button>
                            <Button
                                variant="success"
                                icon="success"
                                onClick={() => setVideoEditorOpen(false)}
                            >
                                Done
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* ─── Skin Picker Modal ─── */}
            {skinPickerOpen && selectedChampion && (
                <div className="np-skin-picker-overlay" onClick={() => setSkinPickerOpen(false)}>
                    <div className="np-skin-picker" onClick={(e) => e.stopPropagation()}>
                        <div className="np-skin-picker__header">
                            <h3 className="np-skin-picker__title">Choose Skin</h3>
                            <div className="np-search-wrap np-search-wrap--picker">
                                <span className="np-search-icon"><Icon name="search" /></span>
                                <input
                                    type="text"
                                    className="np-search"
                                    placeholder="Search skins…"
                                    value={skinSearch}
                                    onChange={(e) => setSkinSearch(e.target.value)}
                                    autoFocus
                                />
                            </div>
                            <button className="modal__close" onClick={() => setSkinPickerOpen(false)} aria-label="Close">
                                <Icon name="close" />
                            </button>
                        </div>
                        <div className="np-skin-picker__grid">
                            {filteredSkins.map((skin, i) => (
                                <button
                                    key={skin.id}
                                    className={`np-skin-card${selectedSkin?.id === skin.id ? ' np-skin-card--active' : ''}`}
                                    onClick={() => { setSelectedSkin(skin); setSkinPickerOpen(false); }}
                                    style={{ animationDelay: `${Math.min(i * 25, 300)}ms` }}
                                >
                                    <div className="np-skin-card__img-wrap">
                                        <img
                                            src={cachedUrl(
                                                datadragon.getSkinCenteredSplashUrl(skin, cdragonBranch)
                                                    ?? datadragon.getSkinSplashCDragonUrl(selectedChampion.id, skin.id, cdragonBranch)
                                            )}
                                            alt={skin.name}
                                            className="np-skin-card__img"
                                            loading="lazy"
                                            onError={(e) => {
                                                const img = e.target as HTMLImageElement;
                                                const fallback = cachedUrl(datadragon.getSkinSplashCDragonUrl(selectedChampion.id, skin.id, cdragonBranch));
                                                if (img.src !== fallback) {
                                                    img.src = fallback;
                                                }
                                            }}
                                        />
                                        {selectedSkin?.id === skin.id && (
                                            <div className="np-skin-card__check">
                                                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                                    <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                                </svg>
                                            </div>
                                        )}
                                    </div>
                                    <span className="np-skin-card__name">{skin.name}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
