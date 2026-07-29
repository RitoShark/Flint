import React, { useEffect, useCallback, useRef, useState } from 'react';
import { useAppMetadataStore, useConfigStore, useProjectTabStore, useNavigationStore, useWadExtractStore, useWadExplorerStore, useModalStore, useNotificationStore } from '../../lib/stores';
import { navigationCoordinator } from '../../lib/stores/navigationCoordinator';
import { useShortcutEngine, useAction } from '../../lib/shortcuts/hooks';
import { useTabShortcuts } from '../../lib/shortcuts/useTabShortcuts';
import * as api from '../../lib/api';
import type { PendingFileOpen } from '../../lib/api/shell';
import { openWadInExtract, isWadPath } from '../../lib/openWad';
import { openOrImportFolder } from '../../lib/projectOpen';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { invalidateCachedImage } from '../../lib/ui-helpers/imageCache';
import { isSidecarFile } from '../../lib/editor/sidecarFiles';

import { TitleBar } from './TitleBar';
import { LeftPanel } from '../browser/FileTree';
import { WadExplorer } from '../browser/WadExplorer';
import { CenterPanel } from './CenterPanel';
import { StatusBar } from './StatusBar';
import { ContextMenu } from '../overlays/ContextMenu';
import { ColorPickerHost } from '../common/ColorPicker';
import { ConfirmDialog } from '../overlays/ConfirmDialog';
import { TransferModal } from '../overlays/TransferModal';
import { NewProjectModal } from '../modals/NewProjectModal';
import { SettingsModal } from '../modals/SettingsModal';
import { ExportModal } from '../modals/ExportModal';
import { FirstTimeSetupModal } from '../modals/FirstTimeSetupModal';
import { UpdateModal } from '../modals/UpdateModal';
import { RecolorModal } from '../modals/RecolorModal';
import { ProjectListModal } from '../modals/ProjectListModal';
import { ModConfigEditorModal } from '../modals/ModConfigEditorModal';
import { ImportModModal } from '../modals/ImportModModal';
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
import { LoadscreenBannerModal } from '../modals/LoadscreenBannerModal';
import { SkinFixerModal } from '../modals/SkinFixerModal';
import { LoadManifestModal } from '../modals/LoadManifestModal';
import { ManifestBrowser } from '../browser/ManifestBrowser';
import { ToastContainer } from '../overlays/Toast';
import { TutorialOverlay, isOnboardingDone, TUTORIAL_REPLAY_EVENT } from '../overlays/TutorialOverlay';
import { TooltipProvider } from '../overlays/TooltipProvider';
import { ShortcutCheatSheet } from '../overlays/ShortcutCheatSheet';
import { UpdateShowcase } from '../update/UpdateShowcase';

function getActiveTab(state: { activeTabId: string | null; openTabs: Array<{ id: string; project: any; projectPath: string; selectedFile: string | null }> }) {
    if (!state.activeTabId) return null;
    return state.openTabs.find(t => t.id === state.activeTabId) || null;
}

let startupRan = false;

const ActiveModal: React.FC<{ activeModal: string | null }> = React.memo(({ activeModal }) => {
    switch (activeModal) {
        case 'newProject':       return <NewProjectModal />;
        case 'settings':         return <SettingsModal />;
        case 'export':           return <ExportModal />;
        case 'firstTimeSetup':   return <FirstTimeSetupModal />;
        case 'updateAvailable':  return <UpdateModal />;
        case 'recolor':          return <RecolorModal />;
        case 'projectList':      return <ProjectListModal />;
        case 'modConfig':        return <ModConfigEditorModal />;
        case 'importMod':        return <ImportModModal />;
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
        case 'loadscreenBanner': return <LoadscreenBannerModal />;
        case 'loadManifest':     return <LoadManifestModal />;
        case 'skinFixer':        return <SkinFixerModal />;
        default:                 return null;
    }
});
ActiveModal.displayName = 'ActiveModal';

export const App: React.FC = () => {
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
    const [showCheatSheet, setShowCheatSheet] = useState(false);
    const resizerRef = useRef<HTMLDivElement>(null);
    const isResizingRef = useRef(false);

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

    useShortcutEngine();
    useTabShortcuts();

    useAction('app.newProject', () => openModal('newProject'));
    useAction('app.save', async () => {
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
    useAction('app.settings', () => openModal('settings'));
    useAction('app.export', () => {
        const activeTab = getActiveTab(stateRef.current);
        if (activeTab) {
            openModal('export');
        }
    });
    useAction('app.closeCurrent', () => {
        const s = stateRef.current;
        if (s.currentView === 'wad-explorer') {
            navigationCoordinator.closeWadExplorerWithFallback();
        } else if (s.currentView === 'extract' && s.activeExtractId) {
            navigationCoordinator.closeExtractSessionWithFallback(s.activeExtractId);
        } else if (s.currentView === 'preview' && s.activeTabId) {
            navigationCoordinator.removeTabWithFallback(s.activeTabId);
        }
    });
    // No `if (activeModal)` guard needed — 'modal.close' is declared in the `modal`
    // scope, so it can only resolve while a modal is actually open.
    useAction('modal.close', () => closeModal());
    useAction('help.cheatSheet', () => setShowCheatSheet((open) => !open));

    useEffect(() => {
        if (!startupRan) {
            startupRan = true;
            useConfigStore.getState().hydrate().then(() => {
                loadInitialData();
                setTimeout(cleanStaleProjects, 3000);
            });
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const currentProjectPath = React.useMemo(() => {
        const activeTab = getActiveTab({ activeTabId, openTabs });
        return activeTab?.projectPath || null;
    }, [activeTabId, openTabs]);

    // The hash overlay is a single backend slot for "the active project," not
    // one per tab (see HashOverlayState in state.rs). `currentProjectPath`
    // transitioning to null means the last open project tab just closed —
    // the only point at which "no project is active" is unambiguous in a
    // multi-tab UI. Clearing there, rather than on every tab close, avoids
    // wiping a still-open tab's overlay when a *different* tab closes.
    const lastProjectPathRef = React.useRef<string | null>(null);
    useEffect(() => {
        if (lastProjectPathRef.current && !currentProjectPath) {
            api.clearProjectHashOverlay().catch(() => { });
        }
        lastProjectPathRef.current = currentProjectPath;
    }, [currentProjectPath]);

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

    const isWatchingRef = React.useRef(false);

    const autoSyncTarget = React.useMemo<{ name: string; path: string; kind: 'ltk' | 'celestial' } | null>(() => {
        if (preferredLauncher === 'celestial' && celestialModPath) return { name: 'Celestial', path: celestialModPath, kind: 'celestial' };
        if (preferredLauncher === 'ltk' && ltkManagerModPath) return { name: 'LTK Manager', path: ltkManagerModPath, kind: 'ltk' };
        if (celestialModPath) return { name: 'Celestial', path: celestialModPath, kind: 'celestial' };
        if (ltkManagerModPath) return { name: 'LTK Manager', path: ltkManagerModPath, kind: 'ltk' };
        return null;
    }, [preferredLauncher, ltkManagerModPath, celestialModPath]);
    const autoSyncNameRef = React.useRef<string>(autoSyncTarget?.name ?? 'launcher');
    React.useEffect(() => { autoSyncNameRef.current = autoSyncTarget?.name ?? 'launcher'; }, [autoSyncTarget]);

    useEffect(() => {
        const shouldWatch = !!(autoSyncToLauncher && autoSyncTarget && currentProjectPath);

        if (shouldWatch) {
            isWatchingRef.current = true;
            console.log('[Auto-sync] Starting watcher for:', currentProjectPath);
            api.startProjectWatcher(currentProjectPath, autoSyncTarget!.path, autoSyncTarget!.kind)
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

    // Renamed from `handleFileOpenRequest` — this is the existing double-click
    // "open a file in the right editor" routing, byte-for-byte unchanged. It is
    // now one branch of `handleShellRequest` below, reached by the `open` action.
    const openPathInEditor = useCallback(async (filePath: string) => {
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

        // Mod packages (.fantome = ZIP of WADs, .modpkg = ModPkg archive) open in the
        // full archive editor: META + inner WADs, with live inner-WAD editing.
        if (lower.endsWith('.fantome') || lower.endsWith('.modpkg')) {
            useNavigationStore.getState().navigateToArchiveEditor(filePath);
            return;
        }

        let kind: 'raw' | 'binText' | 'luaBin64' | 'troybin' = 'raw';
        if (lower.endsWith('.troybin')) {
            // .troybin is a binary League config with a dedicated read-only viewer;
            // it is NOT ritobin text, so it must never reach the BinEditor.
            kind = 'troybin';
        } else if (lower.endsWith('.bin') || lower.endsWith('.ritobin') || lower.endsWith('.py')) {
            kind = 'binText';
        } else if (lower.endsWith('.luabin') || lower.endsWith('.luabin64')) {
            kind = 'luaBin64';
        }
        useNavigationStore.getState().navigateToFileEditor({ filePath, kind });
    }, [setWorking, setReady, showToast]);

    // Dispatches every way Explorer can launch Flint with a target: a plain
    // double-click open, or one of the four context-menu verbs. Each non-`open`
    // branch reuses the flow that already exists for that action rather than
    // duplicating it — see docs/superpowers/plans/2026-07-27-explorer-shell-verbs.md.
    const handleShellRequest = useCallback(async (pending: PendingFileOpen) => {
        switch (pending.action) {
            case 'open':
                return openPathInEditor(pending.path);

            case 'extractWad': {
                // Same prompt-then-extract-everything flow as the WAD Explorer's
                // own extract actions (e.g. ChunkPreview.tsx), but with no chunk
                // filter so the whole archive comes out.
                try {
                    const dest = await open({ title: 'Choose Extraction Folder', directory: true });
                    if (!dest) return;
                    setWorking('Extracting WAD...');
                    const res = await api.extractWad(pending.path, dest as string, null);
                    showToast('success', `Extracted ${res.extracted} files`);
                    setReady('Extracted');
                } catch (err) {
                    console.error('Failed to extract WAD:', err);
                    showToast('error', 'Failed to extract WAD');
                    setReady('Error');
                }
                return;
            }

            case 'packWad': {
                try {
                    setWorking('Packing WAD...');
                    const outPath = await api.packFolderToWad(pending.path);
                    showToast('success', `Packed to ${outPath}`);
                    setReady('Packed');
                } catch (err) {
                    console.error('Failed to pack folder to WAD:', err);
                    showToast('error', 'Failed to pack folder to WAD');
                    setReady('Error');
                }
                return;
            }

            case 'importMod':
                // Seeds the same import wizard modal the file-association-driven
                // import flow was built for; it runs api.analyzeFantome/analyzeModpkg
                // itself once given a filePath (see ImportModModal.tsx).
                openModal('importMod', { filePath: pending.path });
                return;

            case 'openProject': {
                // Identical to the folder drag-and-drop handler in WelcomeScreen.tsx
                // and ProjectListModal.tsx.
                try {
                    const outcome = await openOrImportFolder(pending.path);
                    if (outcome.kind === 'rejected') {
                        showToast('error', outcome.reason);
                    } else if (outcome.kind === 'imported') {
                        showToast('success', `Imported ${outcome.project.display_name || outcome.project.name}`);
                    }
                } catch (err) {
                    console.error('Failed to open project folder:', err);
                    showToast('error', 'Failed to open folder as a Flint project');
                }
                return;
            }
        }
    }, [openPathInEditor, setWorking, setReady, showToast, openModal]);

    useEffect(() => {
        const unlistenFileOpen = listen<PendingFileOpen>('file-open-request', (event) => {
            void handleShellRequest(event.payload);
        });
        // On a cold start the webview boots long after the backend emits its
        // fixed-delay `file-open-request`, so that event is lost. Now that the
        // listener is mounted, PULL any pending Explorer action from the
        // backend — race-free regardless of boot time. (This is why double-
        // clicking a file used to just open Flint; you had to double-click again.)
        api.takePendingFileOpen()
            .then((pending) => { if (pending) void handleShellRequest(pending); })
            .catch((err) => console.error('takePendingFileOpen failed:', err));
        return () => { unlistenFileOpen.then((unlisten) => unlisten()); };
    }, [handleShellRequest]);

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

    useEffect(() => {
        const TEXTURE_EXTS = ['.dds', '.tex', '.png', '.jpg', '.jpeg', '.tga', '.bmp'];
        const MODEL_EXTS = ['.skn', '.scb', '.sco'];

        const isTextureFile = (path: string) => {
            const lower = path.toLowerCase();
            return TEXTURE_EXTS.some(ext => lower.endsWith(ext));
        };

        const unlistenFileChanged = listen<{ path: string; kind: string }>('file-changed', (event) => {
            const { path: changedPath, kind } = event.payload;

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
        api.setLogLevel(stateRef.current.verboseLogging).catch(() => { });

        try {
            const hashStatus = await api.getHashStatus();
            useAppMetadataStore.getState().setHashInfo(
                hashStatus.loaded_count > 0,
                hashStatus.loaded_count
            );

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

        } catch (error) {
            console.error('[Flint] Failed to load initial data:', error);
        }
    };


    const cleanStaleProjects = async () => {
        try {
            const recent = stateRef.current.recentProjects;
            if (recent.length === 0) return;

            const validity = await api.projectsPathValid(recent.map((p) => p.path));
            const validProjects = recent.filter((_, i) => validity[i]);

            if (validProjects.length !== recent.length) {
                useConfigStore.getState().setRecentProjects(validProjects);
            }
        } catch (error) {
            console.error('[Flint] Failed to clean stale projects:', error);
        }
    };

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

    const isWadExplorer = currentView === 'wad-explorer';
    const isExtractMode = currentView === 'extract';
    const isFileEditor = currentView === 'file-editor';
    const isArchiveEditor = currentView === 'archive-editor';
    const isManifest = currentView === 'manifest';
    const hasProject = !isWadExplorer && !isManifest && currentView !== 'welcome';

    const [projectIntro, setProjectIntro] = useState(false);
    useEffect(() => {
        const onIntro = () => {
            setProjectIntro(true);
            window.setTimeout(() => setProjectIntro(false), 700);
        };
        window.addEventListener('flint:project-intro', onIntro);
        return () => window.removeEventListener('flint:project-intro', onIntro);
    }, []);

    const hydrated = useConfigStore((s) => s._hydrated);
    useEffect(() => {
        if (hydrated && !creatorName && !activeModal) {
            openModal('firstTimeSetup');
        }
    }, [hydrated, creatorName, activeModal, openModal]);

    useEffect(() => {
        if (hydrated && creatorName && !showTutorial && !activeModal && !isOnboardingDone()) {
            const timer = setTimeout(() => setShowTutorial(true), 350);
            return () => clearTimeout(timer);
        }
    }, [hydrated, creatorName, activeModal, showTutorial]);

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
                {wadExplorerOpen && (
                    <div style={{ display: isWadExplorer ? 'contents' : 'none' }}>
                        <WadExplorer />
                    </div>
                )}
                {isManifest && <ManifestBrowser />}
                {!isWadExplorer && !isManifest && (
                    <>
                        {hasProject && !isExtractMode && !isFileEditor && !isArchiveEditor && (
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

            <ActiveModal activeModal={activeModal} />

            <ToastContainer />

            <ContextMenu />

            <ColorPickerHost />

            <ConfirmDialog />

            <TransferModal />

            {showTutorial && <TutorialOverlay onDone={() => setShowTutorial(false)} />}

            {showCheatSheet && <ShortcutCheatSheet onClose={() => setShowCheatSheet(false)} />}

            <TooltipProvider />

            <UpdateShowcase />
        </>
    );
};
