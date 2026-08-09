import React, { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import { useModalStore, useNotificationStore, useAppMetadataStore, useProjectTabStore, useConfigStore, useNavigationStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { isSameProjectPath } from '../../lib/projectOpen';
import * as datadragon from '../../lib/data/datadragon';
import * as tftApi from '../../lib/data/tftApi';
import { getChromaImageUrl } from '../../lib/data/datadragon';
import type { DDragonChampion, DDragonSkin, DDragonChroma } from '../../lib/data/datadragon';
import type { Project } from '../../lib/types';
import {
    calculateBudget,
    getVideoMetadata,
    generateSpritesheet,
    computeDrawRect,
    LOADSCREEN_RESOLUTIONS,
    type VideoMeta,
    type BudgetResult,
    type FitMode,
} from '../../lib/data/spritesheet';
import { Button, Checkbox, Icon, Picker } from '../ui';

import { compressDeflate, type ProjectType, SCALE_OPTIONS, FPS_OPTIONS } from './new-project/helpers';
import { NameAndPathRow } from './new-project/NameAndPathRow';
import { ChromaPreviewPopup } from './new-project/ChromaPreviewPopup';

export const NewProjectModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const setWorking = useAppMetadataStore((s) => s.setWorking);
    const setReady = useAppMetadataStore((s) => s.setReady);
    const creatorName = useConfigStore((s) => s.creatorName);
    const leaguePath = useConfigStore((s) => s.leaguePath);
    const defaultProjectPath = useConfigStore((s) => s.defaultProjectPath);
    const recentProjects = useConfigStore((s) => s.recentProjects);
    const configStore = useConfigStore(
        useShallow((s) => ({
            leaguePathPbe: s.leaguePathPbe,
        })),
    );

    // ─── Shared state ────────────────────────────────────────────────────
    const [projectType, setProjectType] = useState<ProjectType>('skin');
    const [projectName, setProjectName] = useState('');
    const [projectPath, setProjectPath] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [progress, setProgress] = useState('');
    const [transitioning, setTransitioning] = useState(false);

    useEffect(() => {
        if (!isCreating) return;
        // Phases carry no count, so use the indeterminate marquee.
        api.setTaskbarProgress('indeterminate');
        const unlistenP = listen<{ phase: string; message: string }>(
            'project-create-progress',
            (event) => {
                const m = event.payload?.message;
                if (typeof m === 'string' && m.length > 0) setProgress(m);
            },
        );
        return () => {
            unlistenP.then((fn) => fn()).catch(() => {});
            api.setTaskbarProgress('no_progress');
        };
    }, [isCreating]);

    // ─── Skin project state ─────────────────────────────────────────────
    const [selectedChampion, setSelectedChampion] = useState<DDragonChampion | null>(null);
    const [selectedSkin, setSelectedSkin] = useState<DDragonSkin | null>(null);
    const [selectedChroma, setSelectedChroma] = useState<DDragonChroma | null>(null);
    // Tells the skin-change effect to skip its selectedChroma reset for one
    // render when a chroma dot sets skin + chroma together.
    const skipChromaResetRef = useRef(false);
    const [champions, setChampions] = useState<DDragonChampion[]>([]);
    const [skins, setSkins] = useState<DDragonSkin[]>([]);
    const [championSearch, setChampionSearch] = useState('');
    const [skinSearch, setSkinSearch] = useState('');
    const [splashLoaded, setSplashLoaded] = useState(false);
    const [skinPickerOpen, setSkinPickerOpen] = useState(false);
    const [cacheReady, setCacheReady] = useState(0);

    // ─── Chroma hover preview (1.5s delay → big popup) ──────────────────
    const [chromaPreview, setChromaPreview] = useState<{
        chromaId: number;
        url: string;
        name: string;
        c1: string;
        c2?: string;
        anchorX: number;
        anchorY: number;
    } | null>(null);
    const chromaPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const dismissChromaPreview = () => {
        if (chromaPreviewTimerRef.current) {
            clearTimeout(chromaPreviewTimerRef.current);
            chromaPreviewTimerRef.current = null;
        }
        setChromaPreview(null);
    };
    const scheduleChromaPreview = (chroma: DDragonChroma, anchor: DOMRect) => {
        if (!selectedChampion) return;
        if (chromaPreviewTimerRef.current) clearTimeout(chromaPreviewTimerRef.current);
        const championId = selectedChampion.id;
        const branch = cdragonBranch;
        chromaPreviewTimerRef.current = setTimeout(() => {
            setChromaPreview({
                chromaId: chroma.id,
                url: getChromaImageUrl(championId, chroma.id, branch),
                name: chroma.name ?? `Chroma ${chroma.id % 1000}`,
                c1: chroma.colors[0] ?? '#888',
                c2: chroma.colors[1],
                anchorX: anchor.left + anchor.width / 2,
                anchorY: anchor.top,
            });
        }, 1500);
    };
    useEffect(() => () => { if (chromaPreviewTimerRef.current) clearTimeout(chromaPreviewTimerRef.current); }, []);
    const [usePbe, setUsePbe] = useState(false);
    const [roster, setRoster] = useState<'live' | 'classic'>('live');
    const [classicScope, setClassicScope] = useState<'classic' | 'all'>('classic');
    const cdragonBranch: 'pbe' | 'latest' = usePbe ? 'pbe' : 'latest';
    const effectiveLeaguePath = usePbe ? configStore.leaguePathPbe : leaguePath;

    // ─── TFT project state ───────────────────────────────────────────────
    const [tftTacticians, setTftTacticians] = useState<tftApi.Tactician[]>([]);
    const [selectedTactician, setSelectedTactician] = useState<tftApi.Tactician | null>(null);
    const [tftSkins, setTftSkins] = useState<tftApi.TacticianSkin[]>([]);
    const [selectedTftSkin, setSelectedTftSkin] = useState<tftApi.TacticianSkin | null>(null);
    const [tftSearch, setTftSearch] = useState('');
    const [tftSkinSearch, setTftSkinSearch] = useState('');
    const [tftSkinPickerOpen, setTftSkinPickerOpen] = useState(false);

    // ─── Experimental warning ────────────────────────────────────────────
    const [experimentalWarning, setExperimentalWarning] = useState<'tft' | 'map' | null>(null);

    const handleSelectExperimentalType = (type: 'tft' | 'map') => {
        const key = `flint.seenExperimentalWarning.${type}`;
        if (localStorage.getItem(key) !== 'true') {
            setExperimentalWarning(type);
        } else {
            setProjectType(type);
        }
    };

    const confirmExperimental = () => {
        if (!experimentalWarning) return;
        localStorage.setItem(`flint.seenExperimentalWarning.${experimentalWarning}`, 'true');
        setProjectType(experimentalWarning);
        setExperimentalWarning(null);
    };

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
    const [videoDragOver, setVideoDragOver] = useState(false);
    const videoDropZoneRef = useRef<HTMLDivElement | null>(null);
    const loadVideoFromPathRef = useRef<(path: string) => Promise<void>>(() => Promise.resolve());
    const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
    const [trimStart, setTrimStart] = useState(0);
    const [trimEnd, setTrimEnd] = useState(0);
    const [scaleFactor, setScaleFactor] = useState(1.0);
    const [customFps, setCustomFps] = useState(30);
    // Loadscreens are authored 16:9. Force it by default (opt-out for source AR).
    const [force169, setForce169] = useState(true);
    const [loadscreenResIdx, setLoadscreenResIdx] = useState(0); // 0 = 1920×1080, 1 = 1280×720
    const [fitMode, setFitMode] = useState<FitMode>('cover');
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

    const isVisible = activeModal === 'newProject';

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
    }, [isVisible, usePbe, roster]);

    useEffect(() => {
        if (roster !== 'classic') return;
        const scoped = classicScope === 'classic' ? skins.filter(datadragon.isClassicSkin) : skins;
        if (scoped.some(s => s.id === selectedSkin?.id)) return;
        setSelectedSkin(scoped[0] ?? null);
        setSelectedChroma(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [classicScope, skins, roster]);

    const handleSelectRoster = (next: 'live' | 'classic') => {
        if (next === roster) return;
        setSelectedChampion(null);
        setChampions([]);
        setChampionSearch('');
        setClassicScope('classic');
        setRoster(next);
    };

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
        if (skipChromaResetRef.current) {
            skipChromaResetRef.current = false;
        } else {
            setSelectedChroma(null);
        }
    }, [selectedSkin, selectedChampion]);

    useEffect(() => {
        if (isVisible && projectType === 'tft') {
            loadTacticians();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVisible, projectType, usePbe]);

    useEffect(() => {
        if (selectedTactician) {
            loadTacticianSkins(selectedTactician.id);
        } else {
            setTftSkins([]);
            setSelectedTftSkin(null);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedTactician, usePbe]);

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
                // Don't auto-pick — the user chooses the variant, which reveals
                // the extraction-strategy step (progressive disclosure).
                setSelectedVariant('');
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

    useEffect(() => {
        if (!videoMeta) {
            setBudget(null);
            return;
        }
        const forced = force169 ? LOADSCREEN_RESOLUTIONS[loadscreenResIdx] : undefined;
        const result = calculateBudget({
            videoWidth: videoMeta.width,
            videoHeight: videoMeta.height,
            scaleFactor,
            fps: customFps,
            trimStart,
            trimEnd,
            forcedWidth: forced?.width,
            forcedHeight: forced?.height,
        });
        setBudget(result);
    }, [videoMeta, scaleFactor, customFps, trimStart, trimEnd, force169, loadscreenResIdx]);

    useEffect(() => {
        loadVideoFromPathRef.current = async (path: string) => {
            try {
                console.info(`[NewProject] loadVideoFromPath: starting for path="${path}"`);
                setWorking('Loading video file...');
                const assetUrl = convertFileSrc(path);
                console.info(`[NewProject] loadVideoFromPath: converted path to assetUrl="${assetUrl}"`);
                
                console.info(`[NewProject] loadVideoFromPath: fetching assetUrl...`);
                const res = await fetch(assetUrl);
                console.info(`[NewProject] loadVideoFromPath: fetch response status=${res.status}, ok=${res.ok}`);
                if (!res.ok) throw new Error(`Failed to fetch local file via asset protocol (status: ${res.status})`);
                
                const blob = await res.blob();
                console.info(`[NewProject] loadVideoFromPath: blob loaded successfully, size=${blob.size} bytes, type="${blob.type}"`);
                
                const filename = path.split(/[\\/]/).pop() || 'video.mp4';
                const file = new File([blob], filename, { type: blob.type || 'video/mp4' });
                console.info(`[NewProject] loadVideoFromPath: constructed File: name="${file.name}", size=${file.size}`);
                await loadVideoFile(file);
            } catch (err) {
                console.error('[NewProject] loadVideoFromPath failed:', err);
                showToast('error', `Failed to load video file: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                setReady();
            }
        };
    });

    useEffect(() => {
        if (!isVisible || projectType !== 'loading-screen') return;
        let unlisten: (() => void) | null = null;
        let cancelled = false;

        const checkInsideDropZone = (pos: { x: number; y: number }) => {
            const el = videoDropZoneRef.current;
            if (!el) {
                console.warn('[NewProject] checkInsideDropZone: drop zone element reference is null');
                return false;
            }
            const r = el.getBoundingClientRect();

            const insideLogical = pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom;

            const physicalX = pos.x / window.devicePixelRatio;
            const physicalY = pos.y / window.devicePixelRatio;
            const insidePhysical = physicalX >= r.left && physicalX <= r.right && physicalY >= r.top && physicalY <= r.bottom;
            
            console.info(
                `[NewProject] Drag/Drop hit test: ` +
                `rawPos=(${pos.x}, ${pos.y}), ` +
                `r={left:${r.left.toFixed(1)}, right:${r.right.toFixed(1)}, top:${r.top.toFixed(1)}, bottom:${r.bottom.toFixed(1)}}, ` +
                `devicePixelRatio=${window.devicePixelRatio}, ` +
                `insideLogical=${insideLogical}, ` +
                `insidePhysical=${insidePhysical}`
            );
            
            return insideLogical || insidePhysical;
        };

        getCurrentWebview()
            .onDragDropEvent((event) => {
                if (cancelled) return;
                const { type } = event.payload as { type: string };
                console.info(`[NewProject] onDragDropEvent: type="${type}"`, event.payload);

                if (type === 'over') {
                    const pos = (event.payload as any).position;
                    if (pos) {
                        setVideoDragOver(checkInsideDropZone(pos));
                    } else {
                        setVideoDragOver(false);
                    }
                } else if (type === 'drop') {
                    const payload = event.payload as { position?: { x: number; y: number }; paths?: string[] };
                    setVideoDragOver(false);
                    
                    const pos = payload.position;
                    if (!pos) {
                        console.warn('[NewProject] Drop failed: event payload missing position');
                        showToast('error', 'Drop failed: missing position data');
                        return;
                    }
                    
                    if (!checkInsideDropZone(pos)) {
                        console.warn('[NewProject] Drop ignored: pointer is not inside the drop zone');
                        return;
                    }
                    
                    if (!payload.paths?.length) {
                        console.warn('[NewProject] Drop ignored: empty paths list');
                        showToast('error', 'No file path in the drop');
                        return;
                    }
                    
                    const videoPath = payload.paths.find((p) => /\.(mp4|webm|mov|avi|mkv)$/i.test(p));
                    if (videoPath) {
                        console.info(`[NewProject] Video dropped. Path: "${videoPath}"`);
                        void loadVideoFromPathRef.current(videoPath);
                    } else {
                        console.warn('[NewProject] Drop ignored: no valid video file. Paths dropped:', payload.paths);
                        showToast('error', 'Not a valid video file (supports MP4, WebM, MOV, AVI, MKV)');
                    }
                } else {
                    setVideoDragOver(false);
                }
            })
            .then((fn) => {
                if (cancelled) fn();
                else unlisten = fn;
            })
            .catch((err) => console.error('[NewProject] drag listener setup failed:', err));

        return () => {
            cancelled = true;
            if (unlisten) unlisten();
        };
    }, [isVisible, projectType, showToast]);

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
        // Honor the user's configured Default Project Path (Settings → Paths)
        // when set; only fall back to the app-home /projects folder otherwise.
        const configured = defaultProjectPath?.trim();
        if (configured) {
            setProjectPath(configured.replace(/\\/g, '/'));
            return;
        }
        try {
            const home = await api.getAppHome();
            setProjectPath(`${home.replace(/\\/g, '/')}/projects`);
        } catch {
            setProjectPath('C:/Users/Projects/Flint');
        }
    };

    const loadChampions = async () => {
        let result: datadragon.DDragonChampion[];
        const rosterLabel = roster === 'classic' ? 'League Classic ' : usePbe ? 'PBE ' : '';
        try {
            setWorking(`Loading ${rosterLabel}champions...`);
            result = roster === 'classic'
                ? await datadragon.fetchJadeChampions(cdragonBranch)
                : await datadragon.fetchChampions(cdragonBranch);
            setChampions(result);
            setReady();
            console.info(`[NewProject] Loaded ${result.length} ${roster} champions from CDragon (${cdragonBranch})`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[NewProject] fetchChampions(roster=${roster}, ${cdragonBranch}) failed: ${msg}`, err);
            showToast('error', `Failed to load ${rosterLabel}champions — see log panel`);
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
            if (roster === 'classic') {
                result = [
                    ...result.filter(datadragon.isClassicSkin),
                    ...result.filter(s => !datadragon.isClassicSkin(s)),
                ];
            }
            setSkins(result);
            const preferred = roster === 'classic' ? result.find(datadragon.isClassicSkin) : undefined;
            setSelectedSkin(preferred || result.find(s => s.isBase) || result[0]);
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

    const loadTacticians = async () => {
        try {
            setWorking(usePbe ? 'Loading PBE tacticians...' : 'Loading tacticians...');
            const result = await tftApi.getTacticians(cdragonBranch);
            setTftTacticians(result);
            if (result.length > 0) {
                const found = result.find(c => c.id === selectedTactician?.id);
                setSelectedTactician(found || result[0]);
            }
            setReady();
            console.info(`[NewProject] Loaded ${result.length} tacticians from CDragon (${cdragonBranch})`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[NewProject] loadTacticians failed: ${msg}`, err);
            showToast('error', `Failed to load ${usePbe ? 'PBE ' : ''}tacticians — see log panel`);
            setReady();
        }
    };

    const loadTacticianSkins = async (tacticianId: string) => {
        try {
            setWorking('Loading tactician variants...');
            const result = await tftApi.getTacticianSkins(tacticianId, cdragonBranch);
            setTftSkins(result);
            if (result.length > 0) {
                const found = result.find(s => s.full_id === selectedTftSkin?.full_id);
                setSelectedTftSkin(found || result[0]);
            }
            setReady();
            console.info(`[NewProject] Loaded ${result.length} skins for tactician ${tacticianId} (${cdragonBranch})`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[NewProject] loadTacticianSkins failed: ${msg}`, err);
            showToast('error', `Tactician variants fetch failed — see log panel`);
            setReady();
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
            console.info(`[NewProject] loadVideoFile: name="${file.name}", size=${file.size} bytes, type="${file.type}"`);
            const meta = await getVideoMetadata(file);
            console.info(`[NewProject] loadVideoFile: metadata retrieved successfully:`, meta);
            
            setVideoFile(file);
            setVideoMeta(meta);
            setTrimStart(0);
            setTrimEnd(meta.duration);
            setCustomFps(Math.min(30, Math.round(meta.fps)));

            if (previewUrl) { 
                console.info('[NewProject] loadVideoFile: revoking old preview URL');
                URL.revokeObjectURL(previewUrl); 
                setPreviewUrl(null); 
            }

            if (videoPreviewRef.current) {
                const objectUrl = URL.createObjectURL(file);
                console.info(`[NewProject] loadVideoFile: setting video element src to objectUrl="${objectUrl}"`);
                videoPreviewRef.current.src = objectUrl;
            } else {
                console.warn('[NewProject] loadVideoFile: videoPreviewRef.current is null, cannot set preview src');
            }
        } catch (err) {
            console.error('[NewProject] loadVideoFile metadata/preview load failed:', err);
            showToast('error', `Failed to read video metadata: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    const generatePreview = async () => {
        if (!videoFile || !videoMeta) return;
        setIsGeneratingPreview(true);
        if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }

        try {
            const forced = force169 ? LOADSCREEN_RESOLUTIONS[loadscreenResIdx] : undefined;
            const outW = Math.floor((forced?.width ?? videoMeta.width) * scaleFactor);
            const outH = Math.floor((forced?.height ?? videoMeta.height) * scaleFactor);
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

                const rect = computeDrawRect(video.videoWidth, video.videoHeight, outW, outH, fitMode);
                ctx.clearRect(0, 0, outW, outH);
                ctx.drawImage(video, rect.dx, rect.dy, rect.dw, rect.dh);
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

        const effectiveSkinNum = selectedChroma?.skinNum ?? selectedSkin.num;

        console.info(
            `[NewProject] Creating project: champion=${selectedChampion.alias}, skin=${effectiveSkinNum}${selectedChroma ? ` (chroma of base ${selectedSkin.num})` : ''}, pbe=${usePbe}, leaguePath=${effectiveLeaguePath}`
        );

        try {
            const project = await api.createProject({
                name: projectName,
                champion: selectedChampion.alias,
                skin: effectiveSkinNum,
                projectPath,
                leaguePath: effectiveLeaguePath,
                creatorName: creatorName || undefined,
                isPbe: usePbe,
            });

            await finishProjectCreation(project, selectedChampion.name, effectiveSkinNum);
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
            const canvas = await generateSpritesheet({
                file: videoFile,
                trimStart,
                trimEnd,
                scaleFactor,
                fps: customFps,
                grid: budget.grid,
                frameW: budget.frameW,
                frameH: budget.frameH,
                fitMode,
                onProgress: (cur, total) => setProgress(`Extracting frame ${cur}/${total}...`),
            });

            setProgress('Encoding spritesheet & injecting config...');
            const ctx = canvas.getContext('2d')!;
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const rgbaBytes = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength);
            const deflatedBytes = await compressDeflate(rgbaBytes);

            const project = await api.createLoadingScreenProject({
                name: projectName,
                projectPath,
                leaguePath: effectiveLeaguePath,
                creatorName: creatorName || 'SirDexal',
                spritesheetRgbaDeflated: deflatedBytes,
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
                creatorName: creatorName || undefined,
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

    const handleCreateTft = async () => {
        if (!projectName || !projectPath || !selectedTactician || !selectedTftSkin) {
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
        setProgress(usePbe ? 'Creating TFT project from PBE...' : 'Creating TFT project...');

        console.info(
            `[NewProject] Creating TFT project: name=${projectName}, champion=${selectedTftSkin.wadAlias}, skin=${selectedTftSkin.wadSkinNum}, path=${projectPath}, pbe=${usePbe}`
        );

        try {
            const project = await api.createProject({
                name: projectName,
                champion: selectedTftSkin.wadAlias,
                skin: selectedTftSkin.wadSkinNum,
                projectPath,
                leaguePath: effectiveLeaguePath,
                creatorName: creatorName || undefined,
                isPbe: usePbe,
                isTft: true,
            });

            await finishProjectCreation(project, selectedTactician.name, selectedTftSkin.wadSkinNum);
        } catch (err) {
            const flintError = err as api.FlintError;
            const userMsg = flintError.getUserMessage?.() || 'Failed to create TFT project';
            showToast('error', `${userMsg} — see log panel for full error`);
        } finally {
            setIsCreating(false);
            setProgress('');
        }
    };

    const handleCreate = () => {
        if (projectType === 'skin') return handleCreateSkin();
        if (projectType === 'map') return handleCreateMap();
        if (projectType === 'tft') return handleCreateTft();
        return handleCreateLoadingScreen();
    };

    const finishProjectCreation = async (project: Project, championName: string, skinNum: number) => {
        setProgress('Opening project...');

        const projectDir = project.project_path || projectPath;
        useProjectTabStore.getState().addTab(project, projectDir);
        useNavigationStore.getState().setView('preview');
        const proj = project;
        useConfigStore.getState().addSavedProject({
            id: `proj-${Date.now()}`,
            name: proj.display_name || proj.name,
            kind: proj.kind ?? 'skin',
            champion: proj.champion,
            mapId: proj.map_id ?? null,
            path: projectDir,
            lastOpened: new Date().toISOString(),
        });

        const files = await api.listProjectFiles(projectDir);
        const tabId = useProjectTabStore.getState().activeTabId;
        if (tabId) useProjectTabStore.getState().setFileTree(tabId, files);

        const recent = recentProjects.filter(p => !isSameProjectPath(p.path, projectDir));
        recent.unshift({
            name: project.display_name || project.name,
            champion: championName,
            skin: skinNum,
            path: projectDir,
            lastOpened: new Date().toISOString(),
        });
        useConfigStore.getState().setRecentProjects(recent.slice(0, 10));

        // The DOM event lets App.tsx apply a matching scale-up + fade on
        // `.main-content` so the modal-to-workspace hand-off feels continuous.
        window.dispatchEvent(new CustomEvent('flint:project-intro'));
        setTransitioning(true);
        await new Promise((r) => setTimeout(r, 650));

        closeModal();
        showToast('success', 'Project created successfully!');
    };

    // ─── Computed values ─────────────────────────────────────────────────

    const filteredChampions = championSearch
        ? champions.filter(c => c.name.toLowerCase().includes(championSearch.toLowerCase()))
        : champions;

    const classicOnly = roster === 'classic' && classicScope === 'classic';
    const scopedSkins = classicOnly ? skins.filter(datadragon.isClassicSkin) : skins;
    const championHasNoClassicSkin = roster === 'classic' && !skins.some(datadragon.isClassicSkin);

    const filteredSkins = skinSearch
        ? scopedSkins.filter(s => s.name.toLowerCase().includes(skinSearch.toLowerCase()))
        : scopedSkins;

    const canCreateSkin = projectType === 'skin'
        && !!projectName && !!projectPath && !!selectedChampion && !!selectedSkin && !isCreating;

    const canCreateLoadingScreen = projectType === 'loading-screen'
        && !!projectName && !!projectPath && !!videoFile && !!budget?.fits && !isCreating;

    const canCreateMap = projectType === 'map'
        && !!projectName && !!projectPath && !!selectedMapId && !!effectiveLeaguePath && !isCreating
        && (mapExtractMode === 'full' || !!selectedVariant);

    const canCreateTft = projectType === 'tft'
        && !!projectName && !!projectPath && !!selectedTactician && !!selectedTftSkin && !isCreating;

    const canCreate = canCreateSkin || canCreateLoadingScreen || canCreateMap || canCreateTft;

    const budgetMaxDim = budget ? Math.max(budget.grid?.sheetWidth ?? 0, budget.grid?.sheetHeight ?? 0) : 0;
    const budgetPercent = Math.min(100, (budgetMaxDim / 16384) * 100);

    // ─── Image URL helpers (use blob cache when available) ────────────────

    const cachedUrl = (url: string) => {
        void cacheReady; // dependency — re-renders when preload completes
        return datadragon.getCachedImageUrl?.(url) ?? url;
    };

    const getHeroSplashUrl = () => {
        if (projectType === 'tft') {
            return selectedTftSkin?.centeredSplashPath || '';
        }
        if (!selectedChampion || !selectedSkin) return '';
        const centered = datadragon.getSkinCenteredSplashUrl(selectedSkin, cdragonBranch);
        if (centered) return cachedUrl(centered);
        // No splashPath in the JSON (rare) → uncentered CDragon art as a last resort.
        return cachedUrl(datadragon.getSkinSplashCDragonUrl(selectedChampion.id, selectedSkin.id, cdragonBranch));
    };

    const getHeroSplashFallback = () => {
        if (projectType === 'tft') return '';
        if (!selectedChampion || !selectedSkin) return '';
        return cachedUrl(datadragon.getSkinSplashCDragonUrl(selectedChampion.id, selectedSkin.id, cdragonBranch));
    };

    const getHeroSplashFinalFallback = () => {
        if (projectType === 'tft') return '';
        if (!selectedChampion || !selectedSkin) return '';
        // DDragon has no PBE branch — used only when both CDragon attempts fail.
        return cachedUrl(datadragon.getSkinSplashUrl(selectedChampion.alias, selectedSkin.num));
    };

    if (!isVisible) return null;

    return (
        // Nested np-skin-picker-overlay / np-video-editor-overlay siblings depend
        // on .modal-overlay being the nearest positioned ancestor — don't migrate
        // to <Modal> (it would change the containing block).
        <div className={`modal-overlay modal-overlay--visible${transitioning ? ' modal-overlay--zooming' : ''}`}>
            <div className={`modal modal--new-project${transitioning ? ' modal--zooming' : ''}`}>
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

                <div className="np-header">
                    <h2 className="np-header__title">New Project</h2>
                    <span className="np-header__subtitle">Choose a project type and configure it</span>
                </div>

                <div className="np-body">
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

                        <button
                            className={`np-type-card np-type-card--experimental${projectType === 'map' ? ' np-type-card--active' : ''}`}
                            onClick={() => handleSelectExperimentalType('map')}
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

                        <button
                            className={`np-type-card np-type-card--deprecated${projectType === 'tft' ? ' np-type-card--active' : ''}`}
                            onClick={() => handleSelectExperimentalType('tft')}
                        >
                            <div className="np-type-card__glow" />
                            <div className="np-type-card__icon">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none"/>
                                </svg>
                            </div>
                            <span className="np-type-card__label">TFT</span>
                            <span className="np-type-card__badge">Will be removed</span>
                        </button>
                    </div>

                    {/* ════════════ Skin Project Form ════════════ */}
                    <div className={`np-form${projectType === 'skin' ? ' np-form--active' : ''}`}>
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
                                        <span className="np-hero-splash__skin">
                                            {selectedSkin.name}
                                            {selectedChroma && (
                                                <span
                                                    className="np-hero-chroma-badge"
                                                    style={{ '--dot-color': selectedChroma.colors[0] ?? 'var(--accent-primary)' } as React.CSSProperties}
                                                >
                                                    <span className="np-hero-chroma-badge__dot" />
                                                    Chroma
                                                </span>
                                            )}
                                        </span>
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

                        <NameAndPathRow
                            namePlaceholder="e.g., Ahri Base Rework"
                            name={projectName}
                            onNameChange={setProjectName}
                            path={projectPath}
                            onPathChange={setProjectPath}
                            onBrowse={handleBrowsePath}
                        />

                        <div className="np-section">
                            <div className="np-section__header">
                                <label className="np-label">{roster === 'classic' ? 'Champion · League Classic' : 'Champion'}</label>
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

                    {/* ════════════ TFT Project Form ════════════ */}
                    <div className={`np-form${projectType === 'tft' ? ' np-form--active' : ''}`}>
                        <div className="np-tft-top-row">
                            <div className="np-tft-top-row__fields">
                                <NameAndPathRow
                                    namePlaceholder="e.g., Ahri Chibi Custom"
                                    name={projectName}
                                    onNameChange={setProjectName}
                                    path={projectPath}
                                    onPathChange={setProjectPath}
                                    onBrowse={handleBrowsePath}
                                />
                            </div>
                            {selectedTactician && selectedTftSkin && (
                                <div
                                    className={`np-tft-card np-tft-card--hero${splashLoaded ? ' np-tft-card--loaded' : ''}`}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => { setTftSkinSearch(''); setTftSkinPickerOpen(true); }}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTftSkinSearch(''); setTftSkinPickerOpen(true); } }}
                                    title="Change variant"
                                >
                                    <img
                                        key={`${selectedTactician.id}-${selectedTftSkin.id}-${cdragonBranch}`}
                                        src={selectedTftSkin.centeredSplashPath || ''}
                                        alt={selectedTftSkin.name}
                                        className="np-tft-card__img"
                                        onLoad={() => setSplashLoaded(true)}
                                        onError={() => setSplashLoaded(true)}
                                    />
                                    <div className="np-tft-card__footer">
                                        <span className="np-tft-card__species">{selectedTactician.name}</span>
                                        <span className="np-tft-card__variant">{selectedTftSkin.name}</span>
                                    </div>
                                    <div className="np-tft-card__change-hint">
                                        <Icon name="file-edit" />
                                        <span>Change variant</span>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="np-section">
                            <div className="np-section__header">
                                <label className="np-label">Tactician Species</label>
                                <div className="np-search-wrap">
                                    <span className="np-search-icon"><Icon name="search" /></span>
                                    <input
                                        type="text"
                                        className="np-search"
                                        placeholder="Search tacticians…"
                                        value={tftSearch}
                                        onChange={(e) => setTftSearch(e.target.value)}
                                    />
                                </div>
                            </div>
                            <div className="np-champion-grid">
                                {tftTacticians
                                    .filter(c => c.name.toLowerCase().includes(tftSearch.toLowerCase()))
                                    .map((tactician, i) => (
                                        <button
                                            key={tactician.id}
                                            className={`np-champ-card${selectedTactician?.id === tactician.id ? ' np-champ-card--active' : ''}`}
                                            onClick={() => { setSelectedTactician(tactician); setTftSearch(''); }}
                                            title={tactician.name}
                                            style={{ animationDelay: `${Math.min(i * 15, 300)}ms` }}
                                        >
                                            <img
                                                src={tactician.iconUrl}
                                                alt={tactician.name}
                                                className="np-champ-card__icon"
                                                loading="lazy"
                                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                            />
                                            <span className="np-champ-card__name">{tactician.name}</span>
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
                                    ref={videoDropZoneRef}
                                    className={`video-picker ${videoDragOver ? 'video-picker--over' : ''}`}
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

                    {/* ════════════ Map Project Form ════════════ */}
                    <div className={`np-form${projectType === 'map' ? ' np-form--active' : ''}`}>
                        <NameAndPathRow
                            namePlaceholder="e.g., My Custom Map"
                            name={projectName}
                            onNameChange={setProjectName}
                            path={projectPath}
                            onPathChange={setProjectPath}
                            onBrowse={handleBrowsePath}
                        />

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
                        </section>

                        {/* Step 2 — revealed once a map is picked. */}
                        {selectedMapId && (
                        <section className="np-map-section np-map-reveal">
                            <header className="np-map-section__head">
                                <span className="np-map-section__step">2</span>
                                <div>
                                    <div className="np-map-section__title">Variant</div>
                                    <div className="np-map-section__sub">
                                        Which shipped version of the map to base the project on
                                    </div>
                                </div>
                            </header>

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
                                    disabled={variantsLoading || mapVariants.length === 0}
                                    placeholder={
                                        variantsLoading ? 'Scanning variants…'
                                        : mapVariants.length === 0 ? 'No variants found'
                                        : 'Select a variant…'
                                    }
                                    options={mapVariants.map(v => ({
                                        value: v.name,
                                        label: v.name,
                                    }))}
                                />
                            </div>
                        </section>
                        )}

                        {/* Step 3 — revealed once a variant is chosen. */}
                        {selectedMapId && selectedVariant && (
                        <section className="np-map-section np-map-reveal">
                            <header className="np-map-section__head">
                                <span className="np-map-section__step">3</span>
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

                            <Checkbox
                                className="np-map-toggle"
                                checked={includeLevels}
                                onChange={(e) => setIncludeLevels(e.target.checked)}
                                label="Include LEVELS WAD"
                                description="Pull lightmaps, lightgrid and grass-tint textures"
                            />

                            <div className="np-hint">
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{marginRight: '8px', flexShrink: 0}}>
                                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                                    <path d="M8 5v3M8 10v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                                </svg>
                                {mapExtractMode === 'variant'
                                    ? 'Pulls only the variant’s mapgeo + materials.bin and the asset paths it references (kit-pieces, textures, lightmaps). Matches MapgeoAddon’s scoped flow.'
                                    : 'Dumps the entire map WAD into your project. Use this if you need every chunk — most users want “Variant only”.'}
                            </div>
                        </section>
                        )}
                    </div>
                </div>

                <div className="np-footer">
                    {(projectType === 'skin' || projectType === 'loading-screen' || projectType === 'tft') && (
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
                                    console.info(`[NewProject] PBE toggle → ${next ? 'PBE' : 'Live'} (path=${next ? configStore.leaguePathPbe : leaguePath})`);
                                    setUsePbe(next);
                                }}
                            />
                            <span className="np-pbe-toggle__track">
                                <span className="np-pbe-toggle__thumb" />
                            </span>
                            <span className="np-pbe-toggle__label">PBE</span>
                        </label>
                    )}
                    {projectType === 'skin' && (
                        <label
                            className={`np-pbe-toggle${roster === 'classic' ? ' np-pbe-toggle--on' : ''}`}
                            title="Use the League Classic roster. The Classic skin is Skin 301 — not every champion has one."
                        >
                            <input
                                type="checkbox"
                                className="np-pbe-toggle__input"
                                checked={roster === 'classic'}
                                onChange={(e) => handleSelectRoster(e.target.checked ? 'classic' : 'live')}
                            />
                            <span className="np-pbe-toggle__track">
                                <span className="np-pbe-toggle__thumb" />
                            </span>
                            <span className="np-pbe-toggle__label">Classic</span>
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
                        <div className="np-ve-header">
                            <span className="np-ve-header__title">Edit Video</span>
                            <button className="modal__close" onClick={() => setVideoEditorOpen(false)} aria-label="Close">
                                <Icon name="close" />
                            </button>
                        </div>

                        <div className="np-ve-content">
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

                            <div className="np-ve-controls">
                                <div className="np-ve-section">
                                    <label className="np-label">Trim</label>
                                    <div
                                        ref={timelineRef}
                                        className="np-ve-timeline"
                                        onClick={handleTimelineClick}
                                    >
                                        <div className="np-ve-timeline__bg" />
                                        <div
                                            className="np-ve-timeline__range"
                                            style={{
                                                left: `${(trimStart / videoMeta.duration) * 100}%`,
                                                width: `${((trimEnd - trimStart) / videoMeta.duration) * 100}%`,
                                            }}
                                        />
                                        <div
                                            className="np-ve-timeline__playhead"
                                            style={{ left: `${(editorCurrentTime / videoMeta.duration) * 100}%` }}
                                        />
                                        <div
                                            className="np-ve-timeline__handle np-ve-timeline__handle--start"
                                            style={{ left: `${(trimStart / videoMeta.duration) * 100}%` }}
                                            onMouseDown={(e) => { e.stopPropagation(); draggingHandle.current = 'start'; }}
                                        />
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

                                <div className="np-ve-section">
                                    <Checkbox
                                        toggle
                                        checked={force169}
                                        onChange={(e) => setForce169(e.target.checked)}
                                        label="Force 16:9 (recommended for loadscreens)"
                                    />
                                    {!force169 && (
                                        <div className="budget-indicator__warning" style={{ marginTop: 6 }}>
                                            Using the source video's aspect ratio. Non-16:9 loadscreens may look wrong in-game.
                                        </div>
                                    )}
                                </div>

                                {force169 && (
                                    <div className="np-ve-row">
                                        <div className="np-field np-field--grow">
                                            <label className="np-label">Aspect ratio</label>
                                            <Picker<string>
                                                fullWidth
                                                value={String(loadscreenResIdx)}
                                                onChange={(v) => setLoadscreenResIdx(parseInt(v, 10))}
                                                options={LOADSCREEN_RESOLUTIONS.map((r, i) => ({
                                                    value: String(i),
                                                    label: r.label,
                                                    hint: '16:9',
                                                }))}
                                            />
                                        </div>
                                        <div className="np-field np-field--grow">
                                            <label className="np-label">Fit</label>
                                            <Picker<FitMode>
                                                fullWidth
                                                value={fitMode}
                                                onChange={setFitMode}
                                                options={[
                                                    { value: 'cover', label: 'Fill', hint: 'Scale to cover, crop overflow' },
                                                    { value: 'contain', label: 'Fit', hint: 'Letterbox, no crop' },
                                                    { value: 'stretch', label: 'Stretch', hint: 'Distort to fill' },
                                                ]}
                                            />
                                        </div>
                                    </div>
                                )}

                                <div className="np-ve-row">
                                    <div className="np-field np-field--grow">
                                        <label className="np-label">Resolution</label>
                                        <Picker<string>
                                            fullWidth
                                            value={String(scaleFactor)}
                                            onChange={(v) => setScaleFactor(parseFloat(v))}
                                            options={SCALE_OPTIONS.map((opt) => {
                                                const baseW = force169 ? LOADSCREEN_RESOLUTIONS[loadscreenResIdx].width : videoMeta.width;
                                                const baseH = force169 ? LOADSCREEN_RESOLUTIONS[loadscreenResIdx].height : videoMeta.height;
                                                return {
                                                    value: String(opt.value),
                                                    label: opt.label,
                                                    hint: `${Math.floor(baseW * opt.value)}×${Math.floor(baseH * opt.value)}`,
                                                };
                                            })}
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

            {/* ─── Skin Picker Modal (DL redesign) ─── */}
            {skinPickerOpen && selectedChampion && (
                <div className="np-skin-picker-overlay" onClick={() => { dismissChromaPreview(); setSkinPickerOpen(false); }}>
                    <div className="np-skin-picker" onClick={(e) => e.stopPropagation()}>

                        <div className="np-skin-picker__header">
                            <h3 className="np-skin-picker__title">Choose Skin</h3>
                            {roster === 'classic' && (
                                <div className="np-scope" role="group" aria-label="Skin scope">
                                    <button
                                        type="button"
                                        className={`np-scope__btn${classicScope === 'classic' ? ' np-scope__btn--active' : ''}`}
                                        onClick={() => setClassicScope('classic')}
                                    >
                                        Classic only
                                    </button>
                                    <button
                                        type="button"
                                        className={`np-scope__btn${classicScope === 'all' ? ' np-scope__btn--active' : ''}`}
                                        onClick={() => setClassicScope('all')}
                                    >
                                        All variants
                                    </button>
                                </div>
                            )}
                            <div className="dl-search np-skin-picker__search">
                                <span className="dl-icon">
                                    <svg viewBox="0 0 16 16" fill="none">
                                        <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.4"/>
                                        <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                                    </svg>
                                </span>
                                <input
                                    type="text"
                                    className="dl-input"
                                    placeholder="Search skins…"
                                    value={skinSearch}
                                    onChange={(e) => setSkinSearch(e.target.value)}
                                    autoFocus
                                />
                            </div>
                            <button
                                className="dl-btn dl-btn--ghost dl-btn--icon dl-btn--sm"
                                onClick={() => setSkinPickerOpen(false)}
                                aria-label="Close"
                                style={{ flexShrink: 0 }}
                            >
                                <Icon name="close" />
                            </button>
                        </div>

                        {classicOnly && championHasNoClassicSkin && (
                            <p className="np-scope__note">
                                {selectedChampion.name} has no Classic skin — their current look is
                                already the original. Switch to All variants to mod a jade port.
                            </p>
                        )}

                        <div className="np-skin-picker__grid">
                            {filteredSkins.map((skin, i) => {
                                const isActiveSkin = selectedSkin?.id === skin.id;
                                const hasActiveChroma = isActiveSkin && selectedChroma !== null;
                                return (
                                    <div
                                        key={skin.id}
                                        role="button"
                                        tabIndex={0}
                                        className={`np-skin-card${isActiveSkin && !hasActiveChroma ? ' np-skin-card--active' : ''}`}
                                        onClick={() => { setSelectedSkin(skin); setSelectedChroma(null); setSkinPickerOpen(false); }}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedSkin(skin); setSelectedChroma(null); setSkinPickerOpen(false); } }}
                                        style={{ animationDelay: `${Math.min(i * 18, 280)}ms` }}
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
                                                    const fb = cachedUrl(datadragon.getSkinSplashCDragonUrl(selectedChampion.id, skin.id, cdragonBranch));
                                                    if (img.src !== fb) img.src = fb;
                                                }}
                                            />
                                            {isActiveSkin && !hasActiveChroma && (
                                                <div className="np-skin-card__check">
                                                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                                        <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                                    </svg>
                                                </div>
                                            )}
                                        </div>
                                        <span className="np-skin-card__name">{skin.name}</span>

                                        {skin.chromas && skin.chromas.length > 0 && (
                                            <div className="np-skin-card__chromas" onClick={(e) => e.stopPropagation()}>
                                                {skin.chromas.map(chroma => {
                                                    const c1 = chroma.colors[0] ?? '#888';
                                                    const c2 = chroma.colors[1];
                                                    const swatch = c2
                                                        ? `linear-gradient(135deg, ${c1} 50%, ${c2} 50%)`
                                                        : c1;
                                                    const isActiveChroma = hasActiveChroma && selectedChroma?.id === chroma.id;
                                                    return (
                                                        <button
                                                            key={chroma.id}
                                                            className={`np-chroma-dot${isActiveChroma ? ' np-chroma-dot--active' : ''}`}
                                                            style={{ '--dot-color': c1, background: swatch } as React.CSSProperties}
                                                            title={chroma.name ?? `Chroma ${chroma.id % 1000}`}
                                                            onMouseEnter={(e) => scheduleChromaPreview(chroma, e.currentTarget.getBoundingClientRect())}
                                                            onMouseLeave={dismissChromaPreview}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                dismissChromaPreview();
                                                                skipChromaResetRef.current = true;
                                                                setSelectedSkin(skin);
                                                                setSelectedChroma(isActiveChroma ? null : chroma);
                                                                setSkinPickerOpen(false);
                                                            }}
                                                        />
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {/* ─── Experimental feature warning ─── */}
            {experimentalWarning && (
                <div className="np-skin-picker-overlay" onClick={() => setExperimentalWarning(null)}>
                    <div className="np-experimental-dialog" onClick={(e) => e.stopPropagation()}>
                        <div className="np-experimental-dialog__icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                                <path d="M12 2L2 19h20L12 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none"/>
                                <path d="M12 9v5M12 16.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                            </svg>
                        </div>
                        <h3 className="np-experimental-dialog__title">
                            {experimentalWarning === 'tft' ? 'TFT support is going away' : 'Experimental Feature'}
                        </h3>
                        <p className="np-experimental-dialog__body">
                            {experimentalWarning === 'tft' ? (
                                <>
                                    TFT is moving to Unreal Engine, and I can't commit to maintaining support for it.
                                    As long as Riot keeps the existing companions on the current engine this will keep
                                    working — but it can break or be removed at any time.
                                </>
                            ) : (
                                <><strong>Map projects</strong> are experimental and may not work as intended. Proceed with caution.</>
                            )}
                        </p>
                        <div className="np-experimental-dialog__actions">
                            <button className="btn btn--secondary" onClick={() => setExperimentalWarning(null)}>Cancel</button>
                            <button className="btn btn--primary" onClick={confirmExperimental}>Continue anyway</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ─── TFT Variant Picker Modal ─── */}
            {tftSkinPickerOpen && selectedTactician && (
                <div className="np-skin-picker-overlay" onClick={() => setTftSkinPickerOpen(false)}>
                    <div className="np-skin-picker" onClick={(e) => e.stopPropagation()}>
                        <div className="np-skin-picker__header">
                            <h3 className="np-skin-picker__title">Choose Variant</h3>
                            <div className="dl-search np-skin-picker__search">
                                <span className="dl-icon">
                                    <svg viewBox="0 0 16 16" fill="none">
                                        <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.4"/>
                                        <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                                    </svg>
                                </span>
                                <input
                                    type="text"
                                    className="dl-input"
                                    placeholder="Search variants…"
                                    value={tftSkinSearch}
                                    onChange={(e) => setTftSkinSearch(e.target.value)}
                                    autoFocus
                                />
                            </div>
                            <button
                                className="dl-btn dl-btn--ghost dl-btn--icon dl-btn--sm"
                                onClick={() => setTftSkinPickerOpen(false)}
                                aria-label="Close"
                                style={{ flexShrink: 0 }}
                            >
                                <Icon name="close" />
                            </button>
                        </div>

                        <div className="np-skin-picker__grid">
                            {tftSkins
                                .filter(s => s.name.toLowerCase().includes(tftSkinSearch.toLowerCase()))
                                .map((skin, i) => {
                                    const isActiveSkin = selectedTftSkin?.full_id === skin.full_id;
                                    return (
                                        <div
                                            key={skin.full_id}
                                            role="button"
                                            tabIndex={0}
                                            className={`np-skin-card np-skin-card--tft${isActiveSkin ? ' np-skin-card--active' : ''}`}
                                            onClick={() => { setSelectedTftSkin(skin); setTftSkinPickerOpen(false); }}
                                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedTftSkin(skin); setTftSkinPickerOpen(false); } }}
                                            style={{ animationDelay: `${Math.min(i * 18, 280)}ms` }}
                                        >
                                            <div className="np-skin-card__img-wrap">
                                                <img
                                                    src={skin.tilePath || ''}
                                                    alt={skin.name}
                                                    className="np-skin-card__img"
                                                    loading="lazy"
                                                />
                                                {isActiveSkin && (
                                                    <div className="np-skin-card__check">
                                                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                                            <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                                        </svg>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="np-skin-card__label">
                                                <span className="np-skin-card__name">{skin.name}</span>
                                            </div>
                                        </div>
                                    );
                                })}
                        </div>
                    </div>
                </div>
            )}

            {/* ─── Chroma hover preview (positioned in viewport) ─── */}
            {chromaPreview && (
                <ChromaPreviewPopup data={chromaPreview} />
            )}
        </div>
    );
};

/* ──────────────────────────────────────────────────────────────────────────
 * Chroma preview popup — appears after hovering a chroma dot for 1.5s.
 * Renders a 160px chroma image, name, and two colour chips. Positioned
 * above the dot by default, flips below if there isn't room.
 * ────────────────────────────────────────────────────────────────────────── */
