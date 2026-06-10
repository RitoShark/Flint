/**
 * Flint - ProjectWindow
 * Top-level root for a torn-off PROJECT OS window. Mounted by main.tsx when the
 * location hash starts with `#project`. Re-derives everything from a single URL
 * param (the project path) + disk (mirrors EditorWindow / MapPreviewWindow) —
 * no zustand state is shared across windows.
 *
 * On mount it runs the same open-and-seed sequence the main window uses when a
 * project is opened (api.openProjectWithTree → addTab → setView('preview') →
 * setFileTree), into this window's OWN store instances, then renders the
 * standard project layout: the file tree on the left and the preview/center
 * panel on the right.
 *
 * The hosted tree + preview read useConfigStore (BIN engine) and the
 * notification / modal / tooltip stores, so we wrap in AppProvider, hydrate the
 * config store from disk on mount, and render the overlays those views drive
 * (toasts, context menu, confirm dialog, tooltips, and the preview-related
 * modals).
 */
import React, { useEffect, useRef, useState } from 'react';
import {
    AppProvider,
    useConfigStore,
    useProjectTabStore,
    useNavigationStore,
    useModalStore,
} from '../../lib/stores';
import * as api from '../../lib/api';
import { LeftPanel } from '../browser/FileTree';
import { CenterPanel } from '../layout/CenterPanel';
import { ToastContainer } from '../overlays/Toast';
import { ContextMenu } from '../overlays/ContextMenu';
import { ConfirmDialog } from '../overlays/ConfirmDialog';
import { TransferModal } from '../overlays/TransferModal';
import { TooltipProvider } from '../overlays/TooltipProvider';
import { RecolorModal } from '../modals/RecolorModal';
import { FullResImageModal } from '../modals/FullResImageModal';
import { ModConfigEditorModal } from '../modals/ModConfigEditorModal';
import { ThumbnailCropModal } from '../modals/ThumbnailCropModal';
import { BinSplitModal } from '../modals/BinSplitModal';
import { FileCompareModal } from '../modals/FileCompareModal';
import { ChromaPortModal } from '../modals/ChromaPortModal';
import { AddLayerModal } from '../modals/AddLayerModal';

/** Parse `?path=...` from the location hash (`#project?path=...`). */
function pathFromHash(): string {
    const hash = window.location.hash; // e.g. "#project?path=..."
    const q = hash.indexOf('?');
    const params = new URLSearchParams(q < 0 ? '' : hash.slice(q + 1));
    return params.get('path') || '';
}

/** Subset of modals reachable from the project tree + preview, mounted on the
 *  active-modal id (mirrors the main window's ActiveModal switch). */
const ProjectModals: React.FC = () => {
    const activeModal = useModalStore((s) => s.activeModal);
    switch (activeModal) {
        case 'recolor':      return <RecolorModal />;
        case 'fullResImage': return <FullResImageModal />;
        case 'modConfig':    return <ModConfigEditorModal />;
        case 'thumbnail':    return <ThumbnailCropModal />;
        case 'binSplit':     return <BinSplitModal />;
        case 'fileCompare':  return <FileCompareModal />;
        case 'chromaPort':   return <ChromaPortModal />;
        case 'addLayer':     return <AddLayerModal />;
        default:             return null;
    }
};

const ProjectWindowInner: React.FC<{ path: string }> = ({ path }) => {
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Guard against double-open (StrictMode is disabled for this root, but the
    // seed is still a one-shot side effect we never want to run twice).
    const seededRef = useRef(false);

    useEffect(() => {
        if (!path || seededRef.current) return;
        seededRef.current = true;

        let cancelled = false;
        (async () => {
            try {
                const { project, fileTree } = await api.openProjectWithTree(path);
                if (cancelled) return;
                useProjectTabStore.getState().addTab(project, path);
                useNavigationStore.getState().setView('preview');
                const tabId = useProjectTabStore.getState().activeTabId;
                if (tabId) useProjectTabStore.getState().setFileTree(tabId, fileTree);
                setReady(true);
            } catch (err) {
                if (cancelled) return;
                console.error('Failed to open project in window:', err);
                setError(String(err));
            }
        })();

        return () => { cancelled = true; };
    }, [path]);

    // Preview hot-reload watcher: same lifecycle the main window uses on project
    // open. Best-effort — failures don't block the window.
    useEffect(() => {
        if (!ready || !path) return;
        api.startPreviewWatcher(path).catch((err) => {
            console.error('Failed to start preview watcher in project window:', err);
        });
        return () => { api.stopPreviewWatcher().catch(() => { }); };
    }, [ready, path]);

    if (!path) {
        return (
            <div style={{ color: '#ddd', padding: 24, font: '14px system-ui' }}>
                No project specified for the project window.
            </div>
        );
    }

    if (error) {
        return (
            <div style={{ color: '#f88', padding: 24, font: '14px system-ui' }}>
                Failed to open project: {error}
            </div>
        );
    }

    if (!ready) {
        return (
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100vh',
                    color: 'var(--text-secondary, #aaa)',
                    backgroundColor: 'var(--bg-primary)',
                    font: '14px system-ui',
                }}
            >
                Opening…
            </div>
        );
    }

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100vh',
                minHeight: 0,
                backgroundColor: 'var(--bg-primary)',
            }}
        >
            <div className="main-content" id="main-content">
                <LeftPanel style={{ width: 300 }} />
                <CenterPanel />
            </div>

            {/* Overlays the tree + preview drive */}
            <ToastContainer />
            <ContextMenu />
            <ConfirmDialog />
            <TransferModal />
            <ProjectModals />
            <TooltipProvider />
        </div>
    );
};

export const ProjectWindow: React.FC = () => {
    const [path] = useState<string>(() => pathFromHash());

    // Hydrate config from disk so the BIN converter engine is correct, same as
    // the main app's startup sequence.
    useEffect(() => {
        useConfigStore.getState().hydrate().catch((err) => {
            console.error('Failed to hydrate config in project window:', err);
        });
    }, []);

    return (
        <AppProvider>
            <ProjectWindowInner path={path} />
        </AppProvider>
    );
};
