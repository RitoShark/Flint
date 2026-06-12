/**
 * Flint - Main Application Component
 */

import React, { useEffect, useCallback, useRef, useState } from 'react';
import { useAppMetadataStore, useConfigStore, useProjectTabStore, useNavigationStore, useWadExtractStore, useWadExplorerStore, useModalStore, useNotificationStore } from '../../lib/stores';
import { navigationCoordinator } from '../../lib/stores/navigationCoordinator';
import { initShortcuts, registerShortcut } from '../../lib/util/utils';
import * as api from '../../lib/api';
import { openWadInExtract, isWadPath } from '../../lib/openWad';
import * as updater from '../../lib/util/updater';
import { getVersion } from '@tauri-apps/api/app';
import { CHANGELOG } from '../../lib/data/changelog';
import { listen } from '@tauri-apps/api/event';
import { invalidateCachedImage } from '../../lib/ui-helpers/imageCache';
import { isSidecarFile } from '../../lib/editor/sidecarFiles';

import { TitleBar } from './TitleBar';
import { LeftPanel } from '../browser/FileTree';
import { WadExplorer } from '../browser/WadExplorer';
import { CenterPanel } from './CenterPanel';
import { StatusBar } from './StatusBar';
import { ContextMenu } from '../overlays/ContextMenu';
import { ConfirmDialog } from '../overlays/ConfirmDialog';
import { TransferModal } from '../overlays/TransferModal';
import { NewProjectModal } from '../modals/NewProjectModal';
import { SettingsModal } from '../modals/SettingsModal';
import { ExportModal } from '../modals/ExportModal';
import { FirstTimeSetupModal } from '../modals/FirstTimeSetupModal';
import { UpdateModal } from '../modals/UpdateModal';
import { RecolorModal } from '../modals/RecolorModal';
import { FixerModal } from '../modals/FixerModal';
import { ProjectListModal } from '../modals/ProjectListModal';
import { ModConfigEditorModal } from '../modals/ModConfigEditorModal';
import { ThumbnailCropModal } from '../modals/ThumbnailCropModal';
import { CheckpointModal } from '../modals/CheckpointModal';
import { MapTexturesModal } from '../modals/MapTexturesModal';
import { BinSplitModal } from '../modals/BinSplitModal';
import { FullResImageModal } from '../modals/FullResImageModal';
import { BrowseWadModal } from '../modals/BrowseWadModal';
import { FileCompareModal } from '../modals/FileCompareModal';
import { AddLayerModal } from '../modals/AddLayerModal';
import { RenameProjectModal } from '../modals/RenameProjectModal';
import { ChromaPortModal } from '../modals/ChromaPortModal';
import { WhatsNewModal } from '../modals/WhatsNewModal';
import { ToastContainer } from '../overlays/Toast';
import { TutorialOverlay, isOnboardingDone, TUTORIAL_REPLAY_EVENT } from '../overlays/TutorialOverlay';
import { TooltipProvider } from '../overlays/TooltipProvider';

// Helper to get active tab from state
function getActiveTab(state: { activeTabId: string | null; openTabs: Array<{ id: string; project: any; projectPath: string; selectedFile: string | null }> }) {
    if (!state.activeTabId) return null;
    return state.openTabs.find(t => t.id === state.activeTabId) || null;
}

// Module-level guard: React.StrictMode double-mounts in dev, which would run
// startup effects (hydrate, league detection, update check) twice. This flag
// ensures the one-shot startup sequence runs exactly once per process.
let startupRan = false;

// Single-mount modal dispatcher. Each modal still does its own `isVisible`
// gate internally (so it gets to control its own enter/exit transitions),
// but only the matching component is even mounted at any time — the other
// 14 don't subscribe to stores or render anything when nothing is open.
const ActiveModal: React.FC<{ activeModal: string | null }> = React.memo(({ activeModal }) => {
    switch (activeModal) {
        case 'newProject':       return <NewProjectModal />;
        case 'settings':         return <SettingsModal />;
        case 'export':           return <ExportModal />;
        case 'firstTimeSetup':   return <FirstTimeSetupModal />;
        case 'updateAvailable':  return <UpdateModal />;
        case 'recolor':          return <RecolorModal />;
        case 'fixer':            return <FixerModal />;
        case 'projectList':      return <ProjectListModal />;
        case 'modConfig':        return <ModConfigEditorModal />;
        case 'renameProject':    return <RenameProjectModal />;
        case 'thumbnail':        return <ThumbnailCropModal />;
        case 'checkpoint':       return <CheckpointModal />;
        case 'binSplit':         return <BinSplitModal />;
        case 'fullResImage':     return <FullResImageModal />;
        case 'browseWad':        return <BrowseWadModal />;
        case 'fileCompare':      return <FileCompareModal />;
        case 'addLayer':         return <AddLayerModal />;
        case 'chromaPort':       return <ChromaPortModal />;
        case 'whatsNew':         return <WhatsNewModal />;
        case 'map-textures':     return <MapTexturesModal />;
        default:                 return null;
    }
});
ActiveModal.displayName = 'ActiveModal';

export const App: React.FC = () => {
    // Narrow store subscriptions — App used to call useAppState() which
    // subscribed to 9 stores at once, so any unrelated dispatch re-rendered
    // the whole tree. Each hook here picks the single field actually used
    // in render or memo deps.
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const currentView = useNavigationStore((s) => s.currentView);
    const activeModal = useModalStore((s) => s.activeModal);
    const wadExplorerOpen = useWadExplorerStore((s) => s.isOpen);
    const autoSyncToLauncher = useConfigStore((s) => s.autoSyncToLauncher);
    const ltkManagerModPath = useConfigStore((s) => s.ltkManagerModPath);
    const celestialModPath = useConfigStore((s) => s.celestialModPath);
    const preferredLauncher = useConfigStore((s) => s.preferredLauncher);
    const creatorName = useConfigStore((s) => s.creatorName);

    const openModal = useModalStore((s) => s.openModal);
    const closeModal = useModalStore((s) => s.closeModal);
    const setWorking = useAppMetadataStore((s) => s.setWorking);
    const setReady = useAppMetadataStore((s) => s.setReady);
    const showToast = useNotificationStore((s) => s.showToast);

    const [leftPanelWidth, setLeftPanelWidth] = useState(280);
    const [showTutorial, setShowTutorial] = useState(false);
    const resizerRef = useRef<HTMLDivElement>(null);
    const isResizingRef = useRef(false);

    // stateRef holds the snapshot fields shortcut handlers + event listeners
    // need. They previously read from a `state` literal that re-rebuilt on
    // every render; now we mirror only what they actually use.
    const stateRef = useRef({
        activeTabId,
        openTabs,
        currentView,
        activeModal,
        recentProjects: useConfigStore.getState().recentProjects,
        verboseLogging: useAppMetadataStore.getState().verboseLogging,
        autoUpdateEnabled: useConfigStore.getState().autoUpdateEnabled,
        skippedUpdateVersion: useConfigStore.getState().skippedUpdateVersion,
        activeExtractId: useWadExtractStore.getState().activeExtractId,
    });
    useEffect(() => {
        stateRef.current = {
            activeTabId,
            openTabs,
            currentView,
            activeModal,
            recentProjects: useConfigStore.getState().recentProjects,
            verboseLogging: useAppMetadataStore.getState().verboseLogging,
            autoUpdateEnabled: useConfigStore.getState().autoUpdateEnabled,
            skippedUpdateVersion: useConfigStore.getState().skippedUpdateVersion,
            activeExtractId: useWadExtractStore.getState().activeExtractId,
        };
    });

    // Initialize shortcuts and load data on mount
    useEffect(() => {
        initShortcuts();

        // Register shortcuts — use stateRef.current so handlers always see latest state
        registerShortcut('ctrl+n', () => openModal('newProject'));
        registerShortcut('ctrl+s', async () => {
            const activeTab = getActiveTab(stateRef.current);
            if (activeTab) {
                try {
                    setWorking('Saving...');
                    await api.saveProject(activeTab.project);
                    setReady('Saved');
                } catch (error) {
                    console.error('Failed to save:', error);
                    showToast('error', 'Save failed');
                }
            }
        });
        registerShortcut('ctrl+,', () => openModal('settings'));
        registerShortcut('ctrl+e', () => {
            const activeTab = getActiveTab(stateRef.current);
            if (activeTab) {
                openModal('export');
            }
        });
        registerShortcut('ctrl+w', () => {
            const s = stateRef.current;
            if (s.currentView === 'wad-explorer') {
                navigationCoordinator.closeWadExplorerWithFallback();
            } else if (s.currentView === 'extract' && s.activeExtractId) {
                navigationCoordinator.closeExtractSessionWithFallback(s.activeExtractId);
            } else if (s.currentView === 'preview' && s.activeTabId) {
                navigationCoordinator.removeTabWithFallback(s.activeTabId);
            }
        });
        registerShortcut('escape', () => {
            if (stateRef.current.activeModal) {
                closeModal();
            }
        });

        // Hydrate settings from disk (migrates localStorage if needed), then load data.
        // Guarded against StrictMode double-invoke — the second mount must not re-fire
        // detect_league, hash checks, or update pings if they already ran.
        if (!startupRan) {
            startupRan = true;
            useConfigStore.getState().hydrate().then(() => {
                loadInitialData();
                // Defer recent-project validation by 3s. It fires N parallel
                // `list_project_files` calls (one per recent project) that
                // saturate Tauri's spawn_blocking pool — running it during
                // the cold-start window would block whatever the user
                // actually wanted to do first.
                setTimeout(cleanStaleProjects, 3000);
            });
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Manage file watcher for auto-sync
    // Compute the current project path (useMemo to avoid triggering effect on every state change)
    const currentProjectPath = React.useMemo(() => {
        const activeTab = getActiveTab({ activeTabId, openTabs });
        return activeTab?.projectPath || null;
    }, [activeTabId, openTabs]);

    // Block the browser's native right-click menu globally. Flint's own
    // hierarchical ContextMenu component handles right-click — the system
    // menu (Print, Translate, Inspect Element, etc.) is just noise inside
    // a packaged Tauri app. Still allowed: text inputs, textareas, and
    // contenteditable surfaces (so users keep Cut/Paste in text fields)
    // and anything marked `data-allow-native-context` on the closest
    // ancestor.
    useEffect(() => {
        const onContextMenu = (e: MouseEvent) => {
            const t = e.target as HTMLElement | null;
            if (!t) return;
            const tag = t.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (t.closest('[contenteditable="true"]')) return;
            if (t.closest('[data-allow-native-context]')) return;
            e.preventDefault();
        };
        document.addEventListener('contextmenu', onContextMenu);
        return () => document.removeEventListener('contextmenu', onContextMenu);
    }, []);

    // Track whether the watcher is currently running to avoid redundant stop calls
    const isWatchingRef = React.useRef(false);

    // Resolve which launcher auto-sync should target. Mirrors the same
    // preference→fallback logic used by the manual Sync button in TitleBar.
    const autoSyncTarget = React.useMemo<{ name: string; path: string } | null>(() => {
        if (preferredLauncher === 'celestial' && celestialModPath) return { name: 'Celestial', path: celestialModPath };
        if (preferredLauncher === 'ltk' && ltkManagerModPath) return { name: 'LTK Manager', path: ltkManagerModPath };
        if (celestialModPath) return { name: 'Celestial', path: celestialModPath };
        if (ltkManagerModPath) return { name: 'LTK Manager', path: ltkManagerModPath };
        return null;
    }, [preferredLauncher, ltkManagerModPath, celestialModPath]);
    const autoSyncNameRef = React.useRef<string>(autoSyncTarget?.name ?? 'launcher');
    React.useEffect(() => { autoSyncNameRef.current = autoSyncTarget?.name ?? 'launcher'; }, [autoSyncTarget]);

    useEffect(() => {
        const shouldWatch = !!(autoSyncToLauncher && autoSyncTarget && currentProjectPath);

        if (shouldWatch) {
            isWatchingRef.current = true;
            console.log('[Auto-sync] Starting watcher for:', currentProjectPath);
            api.startProjectWatcher(currentProjectPath, autoSyncTarget!.path)
                .catch(err => {
                    isWatchingRef.current = false;
                    console.error('[Auto-sync] Failed to start watcher:', err);
                    showToast('error', 'Failed to start auto-sync watcher');
                });
        } else if (isWatchingRef.current) {
            isWatchingRef.current = false;
            console.log('[Auto-sync] Stopping watcher');
            api.stopProjectWatcher().catch(err => {
                console.error('[Auto-sync] Failed to stop watcher:', err);
            });
        }

        return () => {
            if (isWatchingRef.current) {
                isWatchingRef.current = false;
                api.stopProjectWatcher().catch(() => { });
            }
        };
    }, [currentProjectPath, autoSyncToLauncher, autoSyncTarget]);

    // Listen for auto-sync events from Rust
    useEffect(() => {
        const unlistenComplete = listen('auto-sync-complete', (event) => {
            showToast('success', `Auto-synced to ${autoSyncNameRef.current}! Mod ID: ${event.payload}`);
        });

        const unlistenError = listen('auto-sync-error', (event) => {
            showToast('error', `Auto-sync failed: ${event.payload}`);
        });

        return () => {
            unlistenComplete.then((unlisten) => unlisten());
            unlistenError.then((unlisten) => unlisten());
        };
    }, [showToast]);

    // Hash readiness — Rust emits this once after `LmdbCacheState::prime` runs.
    // Replaces the old 30-attempt 1s polling loop. We re-query get_hash_status
    // for the entry-count number (the event payload is just a bool).
    useEffect(() => {
        const unlistenReady = listen<boolean>('hashes-ready', async (event) => {
            if (!event.payload) return;
            try {
                const status = await api.getHashStatus();
                useAppMetadataStore.getState().setHashInfo(
                    status.loaded_count > 0,
                    status.loaded_count,
                );
                console.log(`[Flint] Hashes loaded: ${status.loaded_count.toLocaleString()}`);
            } catch (err) {
                console.error('[Flint] Failed to read hash status after ready event:', err);
            }
        });

        return () => {
            unlistenReady.then((unlisten) => unlisten());
        };
    }, []);

    // Handle files opened via Windows "Open with" / double-click.
    // Rust reads argv[1] and emits this event 250ms after the webview loads.
    useEffect(() => {
        const unlistenFileOpen = listen<string>('file-open-request', async (event) => {
            const filePath = event.payload;
            if (!filePath) return;
            const lower = filePath.toLowerCase();

            if (isWadPath(lower)) {
                try {
                    setWorking('Opening WAD...');
                    await openWadInExtract(filePath);
                    setReady('WAD opened');
                } catch (err) {
                    console.error('Failed to open WAD:', err);
                    showToast('error', 'Failed to open WAD archive');
                    setReady('Error');
                }
                return;
            }

            let kind: 'raw' | 'binText' | 'luaBin64' = 'raw';
            if (lower.endsWith('.bin') || lower.endsWith('.ritobin') || lower.endsWith('.py') || lower.endsWith('.troybin')) {
                kind = 'binText';
            } else if (lower.endsWith('.luabin') || lower.endsWith('.luabin64')) {
                kind = 'luaBin64';
            }
            useNavigationStore.getState().navigateToFileEditor({ filePath, kind });
        });
        return () => { unlistenFileOpen.then((unlisten) => unlisten()); };
    }, [setWorking, setReady, showToast]);

    // Manage preview file watcher for hot reload.
    //
    // Track whether a watcher is actually running so we don't fire the IPC
    // for nothing. Without this guard, app startup sends 3× redundant
    // `stop_preview_watcher` calls (mount with no project, StrictMode remount,
    // cleanup) — each ~180ms and contending for the spawn_blocking pool.
    const previewWatcherRunningRef = React.useRef(false);
    useEffect(() => {
        if (currentProjectPath) {
            console.log('[Preview Hot Reload] Starting watcher for:', currentProjectPath);
            previewWatcherRunningRef.current = true;
            api.startPreviewWatcher(currentProjectPath)
                .catch(err => {
                    previewWatcherRunningRef.current = false;
                    console.error('[Preview Hot Reload] Failed to start watcher:', err);
                });
        } else if (previewWatcherRunningRef.current) {
            previewWatcherRunningRef.current = false;
            api.stopPreviewWatcher().catch(() => { });
        }

        return () => {
            if (previewWatcherRunningRef.current) {
                previewWatcherRunningRef.current = false;
                api.stopPreviewWatcher().catch(() => { });
            }
        };
    }, [currentProjectPath]);

    // Listen for file-changed events from Rust (hot reload)
    useEffect(() => {
        const TEXTURE_EXTS = ['.dds', '.tex', '.png', '.jpg', '.jpeg', '.tga', '.bmp'];
        const MODEL_EXTS = ['.skn', '.scb', '.sco'];

        const isTextureFile = (path: string) => {
            const lower = path.toLowerCase();
            return TEXTURE_EXTS.some(ext => lower.endsWith(ext));
        };

        const unlistenFileChanged = listen<{ path: string; kind: string }>('file-changed', (event) => {
            const { path: changedPath, kind } = event.payload;

            // Invalidate image cache (no store update, pure cache op)
            invalidateCachedImage(changedPath);

            const key = changedPath.replaceAll('\\', '/');
            const showStatus = !isSidecarFile(changedPath);
            const store = useAppMetadataStore.getState();

            const versionBumps = [key];
            const statusSets: Array<{ key: string; status: 'new' | 'modified' }> = [];
            const statusDeletes: string[] = [];

            if (kind === 'create' && showStatus) {
                statusSets.push({ key, status: 'new' });
            } else if (kind === 'modify' && showStatus) {
                if (store.getFileStatus(key) !== 'new') {
                    statusSets.push({ key, status: 'modified' });
                }
            } else if (kind === 'remove') {
                statusDeletes.push(key);
            }

            // Cascading reload: if a texture changed, also bump the model version
            if (isTextureFile(changedPath)) {
                const activeTab = getActiveTab(stateRef.current);
                if (activeTab?.selectedFile) {
                    const selectedFilePath = `${activeTab.projectPath}/${activeTab.selectedFile}`.replaceAll('\\', '/');
                    if (MODEL_EXTS.some(ext => selectedFilePath.toLowerCase().endsWith(ext))) {
                        versionBumps.push(selectedFilePath);
                    }
                }
            }

            store.applyFileEvent({
                versionBumps,
                statusSets,
                statusDeletes,
                bumpFileTree: kind === 'create' || kind === 'remove',
            });
        });

        return () => {
            unlistenFileChanged.then((unlisten) => unlisten());
        };
    }, []);

    const loadInitialData = async () => {
        // Sync log level setting to Rust backend
        api.setLogLevel(stateRef.current.verboseLogging).catch(() => { });

        try {
            const hashStatus = await api.getHashStatus();
            useAppMetadataStore.getState().setHashInfo(
                hashStatus.loaded_count > 0,
                hashStatus.loaded_count
            );

            // No fallback poll: backend emits a `hashes-ready` event once the
            // LMDBs are primed (see the listener in the dedicated effect below).
            // Polling get_hash_status every 1s for up to 30s was burning ~30 IPC
            // round-trips per cold start.

            // Read from the store's live state — the React `state` closure was
            // captured at render time (before `hydrate()` populated leaguePath),
            // so we'd always detect again. The store has the fresh value.
            if (!useConfigStore.getState().leaguePath) {
                try {
                    const leagueResult = await api.detectLeague();
                    if (leagueResult.path) {
                        useConfigStore.getState().setLeaguePath(leagueResult.path);
                        console.log('[Flint] Auto-detected League path:', leagueResult.path);
                    }
                } catch {
                    console.log('[Flint] League auto-detection failed');
                }
            }

            // Check for updates after a short delay (don't block startup)
            setTimeout(checkForUpdates, 3000);
            // Show "What's New" popup once per version, after update check
            setTimeout(showWhatsNew, 5000);
        } catch (error) {
            console.error('[Flint] Failed to load initial data:', error);
        }
    };


    const checkForUpdates = async () => {
        // Check if auto-updates are enabled
        if (!stateRef.current.autoUpdateEnabled) {
            console.log('[Flint] Auto-updates disabled, skipping update check');
            return;
        }

        try {
            console.log('[Flint] Checking for updates...');
            const result = await updater.checkForUpdates();

            if (result.available && result.newVersion) {
                // Skip if user already skipped this version
                if (stateRef.current.skippedUpdateVersion === result.newVersion) {
                    console.log(`[Flint] Update ${result.newVersion} was skipped by user`);
                    return;
                }

                console.log(`[Flint] Update available: ${result.currentVersion} → ${result.newVersion}`);

                // Convert to the format expected by UpdateModal
                const updateInfo = {
                    available: true,
                    current_version: result.currentVersion,
                    latest_version: result.newVersion,
                    release_notes: result.body || 'No release notes available',
                    published_at: result.date || new Date().toISOString(),
                    download_url: '', // Not needed with Tauri updater plugin
                };

                openModal('updateAvailable', updateInfo as unknown as Record<string, unknown>);
            } else {
                console.log('[Flint] Application is up to date');
            }
        } catch (error) {
            // Silently fail - don't bother user if update check fails
            console.log('[Flint] Update check failed:', error);
        }
    };

    const showWhatsNew = async () => {
        // Don't show if the user is still in first-time setup
        const config = useConfigStore.getState();
        if (!config.creatorName) return;

        // Don't show if another modal is already open
        const modal = useModalStore.getState();
        if (modal.activeModal) return;

        try {
            const currentVersion = await getVersion();
            const seenKey = 'flint_whats_new_seen_v';
            const seenVersion = localStorage.getItem(seenKey);

            if (seenVersion !== currentVersion) {
                // Mark as seen regardless — don't re-show even if no entry
                try { localStorage.setItem(seenKey, currentVersion); } catch { /* non-fatal */ }

                const entry = CHANGELOG.find((c) => c.version === currentVersion);
                if (entry) {
                    openModal('whatsNew');
                }
            }
        } catch (err) {
            console.log('[Flint] What\'s New check failed:', err);
        }
    };

    const cleanStaleProjects = async () => {
        try {
            const recent = stateRef.current.recentProjects;
            if (recent.length === 0) return;

            // One batched IPC call instead of N — Rust parallelizes the disk
            // checks via rayon.
            const validity = await api.projectsPathValid(recent.map((p) => p.path));
            const validProjects = recent.filter((_, i) => validity[i]);

            if (validProjects.length !== recent.length) {
                useConfigStore.getState().setRecentProjects(validProjects);
            }
        } catch (error) {
            console.error('[Flint] Failed to clean stale projects:', error);
        }
    };

    // Resizer handling
    const handleMouseDown = useCallback(() => {
        isResizingRef.current = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, []);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizingRef.current) return;
            const newWidth = Math.min(400, Math.max(200, e.clientX));
            setLeftPanelWidth(newWidth);
        };

        const handleMouseUp = () => {
            if (isResizingRef.current) {
                isResizingRef.current = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, []);

    const handleResizerDoubleClick = useCallback(() => {
        setLeftPanelWidth(prev => (prev === 48 ? 280 : 48));
    }, []);

    // Use currentView as the single source of truth for what's displayed
    const isWadExplorer = currentView === 'wad-explorer';
    const isExtractMode = currentView === 'extract';
    // The standalone file editor (desktop "open with", Edit Project Info) is
    // full-page — no project file tree alongside it.
    const isFileEditor = currentView === 'file-editor';
    // Show a left panel for any view that isn't the welcome screen or WAD Explorer
    const hasProject = !isWadExplorer && currentView !== 'welcome';

    // Workspace intro animation: the NewProjectModal dispatches
    // `flint:project-intro` right before it starts its zoom-out, and we
    // apply a matching subtle scale-up + fade on `.main-content` so the
    // hand-off reads as one continuous motion instead of two animations
    // happening in parallel. Class is removed after the keyframe finishes.
    const [projectIntro, setProjectIntro] = useState(false);
    useEffect(() => {
        const onIntro = () => {
            setProjectIntro(true);
            window.setTimeout(() => setProjectIntro(false), 700);
        };
        window.addEventListener('flint:project-intro', onIntro);
        return () => window.removeEventListener('flint:project-intro', onIntro);
    }, []);

    // Check if first-time setup is needed (wait for settings to load from disk first)
    const hydrated = useConfigStore((s) => s._hydrated);
    useEffect(() => {
        if (hydrated && !creatorName && !activeModal) {
            openModal('firstTimeSetup');
        }
    }, [hydrated, creatorName, activeModal, openModal]);

    // Show tutorial once after first-time setup. Guard with !showTutorial so
    // opening modals from within the tutorial doesn't re-trigger this effect.
    useEffect(() => {
        if (hydrated && creatorName && !showTutorial && !activeModal && !isOnboardingDone()) {
            const timer = setTimeout(() => setShowTutorial(true), 350);
            return () => clearTimeout(timer);
        }
    }, [hydrated, creatorName, activeModal, showTutorial]);

    // External replay trigger — Settings → Dev → "Replay Tutorial" fires
    // a window event so we can re-enter the overlay without round-tripping
    // through localStorage hydration.
    useEffect(() => {
        const onReplay = () => setShowTutorial(true);
        window.addEventListener(TUTORIAL_REPLAY_EVENT, onReplay);
        return () => window.removeEventListener(TUTORIAL_REPLAY_EVENT, onReplay);
    }, []);

    return (
        <>
            <TitleBar />
            <div
                className={`main-content${projectIntro ? ' app-content--project-intro' : ''}`}
                id="main-content"
            >
                {/* Keep WadExplorer mounted when open — toggling display avoids the ~10s rescan on every switch */}
                {wadExplorerOpen && (
                    <div style={{ display: isWadExplorer ? 'contents' : 'none' }}>
                        <WadExplorer />
                    </div>
                )}
                {!isWadExplorer && (
                    <>
                        {hasProject && !isExtractMode && !isFileEditor && (
                            <>
                                <LeftPanel style={{ width: leftPanelWidth }} />
                                <div
                                    ref={resizerRef}
                                    className="panel-resizer"
                                    id="panel-resizer"
                                    onMouseDown={handleMouseDown}
                                    onDoubleClick={handleResizerDoubleClick}
                                />
                            </>
                        )}
                        <CenterPanel />
                    </>
                )}
            </div>
            <StatusBar />

            {/* Modals — only the active one is mounted. Mounting all 15
                meant every modal called useAppState() (9-store fan-out)
                and re-ran on every dispatch, even with nothing open. */}
            <ActiveModal activeModal={activeModal} />

            {/* Toast notifications */}
            <ToastContainer />

            {/* Context Menu */}
            <ContextMenu />

            {/* Confirm Dialog */}
            <ConfirmDialog />

            {/* Cross-project file copy/move */}
            <TransferModal />

            {/* First-run tutorial */}
            {showTutorial && <TutorialOverlay onDone={() => setShowTutorial(false)} />}

            {/* Global custom-styled tooltip (hijacks native [title] attrs) */}
            <TooltipProvider />
        </>
    );
};
