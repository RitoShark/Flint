/**
 * Flint - EditorWindow
 * Top-level root for a torn-off file-editor OS window. Mounted by main.tsx
 * when the location hash starts with `#editor`. Re-derives everything from a
 * few URL params + disk (mirrors MapPreviewWindow) — no zustand state is
 * shared across windows.
 *
 * Rather than re-render individual editors, this seeds the (window-local)
 * `useFileEditorStore` with the torn-off target and renders the same
 * `FileEditorPage` the main window uses — so all four `FileEditorKind`s
 * (binText / luaBin64 / modConfig / raw) work identically. The store here is
 * this window's own instance (no cross-window sharing), so its close/dirty
 * calls stay local and harmless.
 *
 * The hosted editors read `useConfigStore` (BIN engine) and
 * `useNotificationStore` (toasts), so we wrap in AppProvider and hydrate the
 * config store from disk on mount, exactly like the main app does at startup.
 */
import React, { useEffect, useState } from 'react';
import { AppProvider, useConfigStore, useFileEditorStore } from '../../lib/stores';
import type { FileEditorKind } from '../../lib/types';
import { FileEditorPage } from './FileEditorPage';

interface EditorParams {
    path: string;
    kind: FileEditorKind;
    project: string;
}

/** Parse `?path=&kind=&project=` from the location hash (`#editor?...`). */
function paramsFromHash(): EditorParams {
    const hash = window.location.hash; // e.g. "#editor?path=...&kind=...&project=..."
    const q = hash.indexOf('?');
    const params = new URLSearchParams(q < 0 ? '' : hash.slice(q + 1));
    return {
        path: params.get('path') || '',
        kind: (params.get('kind') as FileEditorKind) || 'raw',
        project: params.get('project') || '',
    };
}

const EditorWindowInner: React.FC<EditorParams> = ({ path, kind, project }) => {
    // Seed this window's own file-editor store with the torn-off target so
    // FileEditorPage renders the right editor form.
    useEffect(() => {
        if (!path) return;
        useFileEditorStore.getState().openTarget({
            filePath: path,
            kind,
            projectPath: project || undefined,
        });
    }, [path, kind, project]);

    if (!path) {
        return (
            <div style={{ color: '#ddd', padding: 24, font: '14px system-ui' }}>
                No file specified for the editor window.
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
            <FileEditorPage />
        </div>
    );
};

export const EditorWindow: React.FC = () => {
    const [params] = useState<EditorParams>(() => paramsFromHash());

    // Hydrate config from disk so the BIN converter engine is correct, same as
    // the main app's startup sequence.
    useEffect(() => {
        useConfigStore.getState().hydrate().catch((err) => {
            console.error('Failed to hydrate config in editor window:', err);
        });
    }, []);

    return (
        <AppProvider>
            <EditorWindowInner {...params} />
        </AppProvider>
    );
};
