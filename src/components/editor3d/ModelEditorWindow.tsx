import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save } from '@tauri-apps/plugin-dialog';
import * as api from '../../lib/api';
import type { ModelEdit, ModelSessionInfo, WeightEntry } from '../../lib/api/modelEdit';
import { useModelEditorStore } from '../../lib/stores/modelEditorStore';
import { useNotificationStore } from '../../lib/stores';
import type { SknSceneHandle } from '../../lib/babylon/sknScene';
import { EditorViewport } from './EditorViewport';
import { Outliner } from './Outliner';
import { Inspector } from './Inspector';
import { WeightPanel } from './WeightPanel';
import { ContextMenu } from '../overlays/ContextMenu';
import { ConfirmDialog } from '../overlays/ConfirmDialog';
import { ToastContainer } from '../overlays/Toast';
import '../../styles/modelEditor.css';

interface Target {
    project: string;
    skn: string;
}

function targetFromHash(): Target | null {
    const hash = window.location.hash;
    const q = hash.indexOf('?');
    if (q < 0) return null;
    const params = new URLSearchParams(hash.slice(q + 1));
    const skn = params.get('skn');
    if (!skn) return null;
    return { project: params.get('project') || '', skn };
}

function basename(path: string): string {
    return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

export const ModelEditorWindow: React.FC = () => {
    const [target, setTarget] = useState<Target | null>(() => targetFromHash());
    const [session, setSession] = useState<ModelSessionInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [opError, setOpError] = useState<string | null>(null);
    const [reloadToken, setReloadToken] = useState(0);
    const [discardGuardOpen, setDiscardGuardOpen] = useState(false);

    const summary = useModelEditorStore((s) => s.summary);
    const selection = useModelEditorStore((s) => s.selection);
    const select = useModelEditorStore((s) => s.select);
    const saving = useModelEditorStore((s) => s.saving);
    const mode = useModelEditorStore((s) => s.mode);
    const setMode = useModelEditorStore((s) => s.setMode);
    const showToast = useNotificationStore((s) => s.showToast);

    const sessionIdRef = useRef<string | null>(null);

    const sknHandleRef = useRef<SknSceneHandle | null>(null);

    const discardResolveRef = useRef<((proceed: boolean) => void) | null>(null);

    const confirmDiscard = useCallback((): Promise<boolean> => {
        if (!useModelEditorStore.getState().summary?.dirty) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
            discardResolveRef.current = resolve;
            setDiscardGuardOpen(true);
        });
    }, []);

    const resolveDiscardGuard = useCallback((proceed: boolean) => {
        setDiscardGuardOpen(false);
        const resolve = discardResolveRef.current;
        discardResolveRef.current = null;
        resolve?.(proceed);
    }, []);

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        listen<[string, string]>('model-editor-load', (ev) => {
            void (async () => {
                const [project, skn] = ev.payload;
                if (!(await confirmDiscard())) return;
                setTarget({ project, skn });
            })();
        }).then((u) => { unlisten = u; });
        return () => unlisten?.();
    }, [confirmDiscard]);

    useEffect(() => {
        if (!target) return;
        let cancelled = false;
        let openedId: string | null = null;
        setSession(null);
        sessionIdRef.current = null;
        setError(null);
        setOpError(null);
        useModelEditorStore.getState().reset();

        void (async () => {
            try {
                const info = await api.openModelSession(target.skn);
                openedId = info.sessionId;
                if (cancelled) {
                    void api.closeModelSession(info.sessionId);
                    return;
                }
                const skeleton = info.skeletonPath ? await api.readSklSkeleton(info.skeletonPath) : null;
                if (cancelled) return;
                setSession(info);
                sessionIdRef.current = info.sessionId;
                useModelEditorStore.getState().setSession(info, skeleton);
            } catch (err) {
                if (!cancelled) setError(String(err));
            }
        })();

        return () => {
            cancelled = true;
            if (openedId) {
                void api.closeModelSession(openedId);
                if (sessionIdRef.current === openedId) sessionIdRef.current = null;
            }
        };
    }, [target]);

    const reloadGeometry = useCallback(async () => {
        setReloadToken((n) => n + 1);
    }, []);

    const applyEdit = useCallback(async (edit: ModelEdit): Promise<boolean> => {
        const id = useModelEditorStore.getState().sessionId;
        if (!id) return false;
        // renameSubmesh doesn't reload geometry, so the old name must be captured here to fix up the live scene's mesh name and hidden-set key, or they go stale silently.
        const oldName = edit.kind === 'renameSubmesh'
            ? useModelEditorStore.getState().summary?.submeshes[edit.index]?.name
            : undefined;
        try {
            const nextSummary = await api.stageModelEdit(id, edit);
            useModelEditorStore.getState().applySummary(nextSummary);
            if (edit.kind === 'renameSubmesh' && oldName && oldName !== edit.name) {
                sknHandleRef.current?.renameSubmesh(oldName, edit.name);
                useModelEditorStore.getState().renameHiddenName(oldName, edit.name);
            }
            if (edit.kind === 'renameJoint') {
                useModelEditorStore.getState().renameJointName(edit.index, edit.name);
            }
            setOpError(null);
            const geometryUnchanged =
                edit.kind === 'renameSubmesh' ||
                edit.kind === 'reorderSubmesh' ||
                edit.kind === 'renameJoint' ||
                // The viewport already holds the painted weights; reloading would rebuild the scene and throw the brush state away.
                edit.kind === 'paintWeights';
            if (!geometryUnchanged) await reloadGeometry();
            return true;
        } catch (err) {
            setOpError(String(err));
            return false;
        }
    }, [reloadGeometry]);

    // A rejected stroke leaves the viewport's own weight buffers ahead of the session, so the
    // geometry is re-derived to pull them back in sync with what is actually staged.
    const handlePaint = useCallback(async (entries: WeightEntry[]) => {
        if (entries.length === 0) return;
        const ok = await applyEdit({ kind: 'paintWeights', entries });
        if (!ok) await reloadGeometry();
    }, [applyEdit, reloadGeometry]);

    const handleIsolate = useCallback((name: string | null) => {
        sknHandleRef.current?.setIsolated(name);
    }, []);

    useEffect(() => {
        sknHandleRef.current?.setSelection(selection?.kind === 'submesh' ? selection.name : null);
    }, [selection]);

    const performSave = useCallback(async (dest?: string): Promise<boolean> => {
        const state = useModelEditorStore.getState();
        const id = state.sessionId;
        if (!id || state.saving) return false;
        useModelEditorStore.getState().setSaving(true);
        try {
            const result = await api.saveModelSession(id, dest);
            useModelEditorStore.getState().applySummary(result.summary);
            setOpError(null);
            const savedName = basename(result.sknPath);
            const propagated: string[] = [];
            if (result.anmFilesUpdated.length > 0) propagated.push(`${result.anmFilesUpdated.length} .anm`);
            if (result.binFilesUpdated.length > 0) propagated.push(`${result.binFilesUpdated.length} .bin`);
            const propagatedSuffix = propagated.length > 0 ? ` (${propagated.join(', ')} updated)` : '';
            showToast('success', `Saved ${savedName}${result.sklPath ? ' + .skl' : ''}${propagatedSuffix}`);
            return true;
        } catch (err) {
            setOpError(String(err));
            return false;
        } finally {
            useModelEditorStore.getState().setSaving(false);
        }
    }, [showToast]);

    const handleSave = useCallback(() => {
        if (!useModelEditorStore.getState().summary?.dirty) return;
        void performSave();
    }, [performSave]);

    const handleSaveAs = useCallback(() => {
        void (async () => {
            const id = useModelEditorStore.getState().sessionId;
            if (!id) return;
            const dest = await save({
                defaultPath: target?.skn ? basename(target.skn) : undefined,
                filters: [{ name: 'Simple Skin', extensions: ['skn'] }],
            });
            if (!dest) return;
            await performSave(dest);
        })();
    }, [performSave, target]);

    const handleUndo = useCallback(() => {
        void (async () => {
            const id = useModelEditorStore.getState().sessionId;
            if (!id || !useModelEditorStore.getState().summary?.canUndo) return;
            try {
                const nextSummary = await api.undoModelEdit(id);
                useModelEditorStore.getState().applySummary(nextSummary);
                setOpError(null);
                await reloadGeometry();
            } catch (err) {
                setOpError(String(err));
            }
        })();
    }, [reloadGeometry]);

    const handleRedo = useCallback(() => {
        void (async () => {
            const id = useModelEditorStore.getState().sessionId;
            if (!id || !useModelEditorStore.getState().summary?.canRedo) return;
            try {
                const nextSummary = await api.redoModelEdit(id);
                useModelEditorStore.getState().applySummary(nextSummary);
                setOpError(null);
                await reloadGeometry();
            } catch (err) {
                setOpError(String(err));
            }
        })();
    }, [reloadGeometry]);

    const handleDiscardGuardSave = useCallback(() => {
        void (async () => {
            const ok = await performSave();
            resolveDiscardGuard(ok);
        })();
    }, [performSave, resolveDiscardGuard]);

    const saveRef = useRef(handleSave);
    saveRef.current = handleSave;
    const undoRef = useRef(handleUndo);
    undoRef.current = handleUndo;
    const redoRef = useRef(handleRedo);
    redoRef.current = handleRedo;

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            const key = e.key.toLowerCase();
            if (key === 's') {
                e.preventDefault();
                saveRef.current();
            } else if (key === 'z' && e.shiftKey) {
                e.preventDefault();
                redoRef.current();
            } else if (key === 'z') {
                e.preventDefault();
                undoRef.current();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // Native OS close destroys this JS context without running unmount cleanup, so the backend session must be closed here or it leaks for the process lifetime.
    useEffect(() => {
        const win = getCurrentWindow();
        let unlisten: (() => void) | undefined;
        win.onCloseRequested(async (event) => {
            event.preventDefault();
            let proceed = true;
            try {
                proceed = await confirmDiscard();
            } catch {
                proceed = true;
            }
            if (!proceed) return;
            // win.destroy() needs core:window:allow-destroy in capabilities, and any throw after preventDefault() leaves the window unclosable.
            try {
                const id = sessionIdRef.current;
                if (id) await api.closeModelSession(id);
            } catch {
                // ignore
            } finally {
                void win.destroy().catch(() => win.close());
            }
        }).then((u) => { unlisten = u; });
        return () => unlisten?.();
    }, [confirmDiscard]);

    const fileName = useCallback(
        () => (target ? basename(target.skn) : ''),
        [target],
    )();

    if (!target) {
        return <div className="m3d__empty">No model specified.</div>;
    }
    if (error) {
        return (
            <div className="m3d__empty m3d__empty--error">
                <strong>Could not open this model</strong>
                <p>{error}</p>
                <code>{target.skn}</code>
            </div>
        );
    }

    return (
        <div className="m3d">
            <header className="m3d__topbar">
                <span className="m3d__filename">{fileName}</span>
                {summary?.dirty && <span className="m3d__dirty" aria-label="Unsaved changes">●</span>}
                <div className="m3d__seg m3d__seg--topbar">
                    <button
                        type="button"
                        className={`m3d__seg-btn ${mode === 'object' ? 'm3d__seg-btn--active' : ''}`}
                        onClick={() => setMode('object')}
                    >
                        Model
                    </button>
                    <button
                        type="button"
                        className={`m3d__seg-btn ${mode === 'weights' ? 'm3d__seg-btn--active' : ''}`}
                        onClick={() => setMode('weights')}
                    >
                        Weights
                    </button>
                </div>
                <div className="m3d__topbar-actions">
                    <button type="button" className="m3d__btn" onClick={handleUndo} disabled={!summary?.canUndo}>
                        Undo
                    </button>
                    <button type="button" className="m3d__btn" onClick={handleRedo} disabled={!summary?.canRedo}>
                        Redo
                    </button>
                    <button type="button" className="m3d__btn" onClick={handleSaveAs} disabled={saving}>
                        Save As…
                    </button>
                    <button
                        type="button"
                        className="m3d__btn m3d__btn--primary"
                        onClick={handleSave}
                        disabled={!summary?.dirty || saving}
                    >
                        Save
                    </button>
                </div>
            </header>
            {opError && (
                <div className="m3d__op-error" role="alert">
                    <span>{opError}</span>
                    <button type="button" className="m3d__op-error-dismiss" onClick={() => setOpError(null)} aria-label="Dismiss">
                        <span>×</span>
                    </button>
                </div>
            )}
            <div className="m3d__body">
                <aside className="m3d__dock m3d__dock--left">
                    {!session && <div className="m3d__loading">Loading…</div>}
                    {session && (
                        <Outliner
                            onEdit={applyEdit}
                            onIsolate={handleIsolate}
                        />
                    )}
                </aside>
                <main className="m3d__viewport">
                    <EditorViewport
                        sknPath={target.skn}
                        reloadToken={reloadToken}
                        onPick={(name) => select(name ? { kind: 'submesh', name } : null)}
                        onPaint={handlePaint}
                        handleRef={sknHandleRef}
                    />
                </main>
                <aside className="m3d__dock m3d__dock--right">
                    {session && (mode === 'weights' ? <WeightPanel onPaint={handlePaint} /> : <Inspector />)}
                </aside>
            </div>
            <footer className="m3d__status">
                {summary
                    ? `${summary.submeshes.length} submeshes · ${summary.vertexCount.toLocaleString()} verts`
                    : ''}
            </footer>
            {discardGuardOpen && (
                <div className="m3d__discard-overlay">
                    <div className="m3d__discard-dialog">
                        <h3 className="m3d__discard-title">Unsaved changes</h3>
                        <p className="m3d__discard-message">
                            This model has unsaved changes. Save them before continuing?
                        </p>
                        <div className="m3d__discard-actions">
                            <button type="button" className="m3d__btn" onClick={() => resolveDiscardGuard(false)}>
                                Cancel
                            </button>
                            <button type="button" className="m3d__btn m3d__btn--danger" onClick={() => resolveDiscardGuard(true)}>
                                Discard
                            </button>
                            <button type="button" className="m3d__btn m3d__btn--primary" onClick={handleDiscardGuardSave}>
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}
            <ContextMenu />
            <ConfirmDialog />
            <ToastContainer />
        </div>
    );
};
