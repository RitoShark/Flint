import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save } from '@tauri-apps/plugin-dialog';
import * as api from '../../lib/api';
import type { ModelEdit, ModelSessionInfo } from '../../lib/api/modelEdit';
import { useModelEditorStore } from '../../lib/stores/modelEditorStore';
import { useNotificationStore } from '../../lib/stores';
import type { SknSceneHandle } from '../../lib/babylon/sknScene';
import { EditorViewport } from './EditorViewport';
import { Outliner } from './Outliner';
import { Inspector } from './Inspector';
import { ContextMenu } from '../overlays/ContextMenu';
import { ConfirmDialog } from '../overlays/ConfirmDialog';
import { ToastContainer } from '../overlays/Toast';
import '../../styles/modelEditor.css';

interface Target {
    project: string;
    skn: string;
}

/** Parse `?project=…&skn=…` out of `#model-editor?…`. */
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
    // Surfaces a rejected staged op (bad index, name collision, format limit)
    // without disturbing `session`/the store — the last good summary stays put.
    const [opError, setOpError] = useState<string | null>(null);
    // Bumped by reloadGeometry; EditorViewport reloads geometry (only, no
    // re-frame) via api.deriveModelMesh whenever this changes.
    const [reloadToken, setReloadToken] = useState(0);
    // Save/Discard/Cancel modal for the two guarded exits below.
    const [discardGuardOpen, setDiscardGuardOpen] = useState(false);

    const summary = useModelEditorStore((s) => s.summary);
    const selection = useModelEditorStore((s) => s.selection);
    const select = useModelEditorStore((s) => s.select);
    const saving = useModelEditorStore((s) => s.saving);
    const showToast = useNotificationStore((s) => s.showToast);

    // Mirrors whichever session is currently open. A ref (not state) so the
    // onCloseRequested handler below always reads the live id instead of one
    // captured at listener-registration time — it's written at the same
    // point as setSession/setSession(null), never via a follow-up effect.
    const sessionIdRef = useRef<string | null>(null);

    // The live Babylon scene controller for the viewport canvas. Populated by
    // EditorViewport on mount, cleared on unmount — never recreated on a
    // retarget, since EditorViewport itself stays mounted and just reloads
    // whatever `sknPath` it's given.
    const sknHandleRef = useRef<SknSceneHandle | null>(null);

    const discardResolveRef = useRef<((proceed: boolean) => void) | null>(null);

    // Resolves `true` once it's safe to discard whatever's currently open —
    // immediately when there's nothing unsaved, otherwise after the user
    // picks Save/Discard/Cancel in the modal rendered below.
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

    // The backend retargets an already-open window rather than spawning a second
    // WebView2, so the file can change under us.
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        listen<[string, string]>('model-editor-load', (ev) => {
            void (async () => {
                const [project, skn] = ev.payload;
                // The backend has already focused this window either way;
                // on Cancel we simply keep editing the current file.
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

    const applyEdit = useCallback(async (edit: ModelEdit) => {
        const id = useModelEditorStore.getState().sessionId;
        if (!id) return;
        // Renaming doesn't reload geometry (see below), so it's the one edit
        // where the live scene's mesh names and the hidden-set's keys would
        // otherwise silently go stale — capture the old name to fix both up.
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
            // Renames and reorder don't touch geometry.
            if (edit.kind !== 'renameSubmesh' && edit.kind !== 'reorderSubmesh' && edit.kind !== 'renameJoint') {
                await reloadGeometry();
            }
        } catch (err) {
            setOpError(String(err));
        }
    }, [reloadGeometry]);

    const handleIsolate = useCallback((name: string | null) => {
        sknHandleRef.current?.setIsolated(name);
    }, []);

    // Selection sync: viewport pick → store (via EditorViewport's onPick
    // below) and store → viewport tint (here), so either side driving a
    // selection keeps both in step without one owning the other.
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
            // Save failed — the session is unchanged (still dirty), so a retry is safe.
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

    // Ctrl/Cmd+S save, Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo — refs read the
    // latest handlers so a single mount-time listener stays correct, same
    // `saveRef` pattern as BinEditor.tsx / WadPreviewPanel.tsx.
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

    // Closing the WebviewWindow natively (OS close button / Alt+F4) destroys
    // this JS context outright — a component-unmount cleanup never runs, so
    // without this the backend ModelEditSession (parsed mesh + skeleton) is
    // orphaned in the app-wide state map for the rest of the process
    // lifetime. preventDefault() first and unconditionally: the async
    // closeModelSession call cannot be relied on to finish before the window
    // tears down. This is the single onCloseRequested handler for this
    // window — the unsaved-changes guard extends it in place rather than
    // registering a second listener.
    useEffect(() => {
        const win = getCurrentWindow();
        let unlisten: (() => void) | undefined;
        win.onCloseRequested(async (event) => {
            event.preventDefault();
            let proceed = true;
            try {
                proceed = await confirmDiscard();
            } catch {
                // A broken guard must not be able to trap the user.
                proceed = true;
            }
            if (!proceed) return;
            // Everything from here on is best-effort: once preventDefault has
            // fired, ANY throw before destroy() leaves the window permanently
            // unclosable. `destroy()` itself needs `core:window:allow-destroy`
            // in capabilities/default.json — without it the call rejects and
            // that is exactly the trap this try/finally exists to survive.
            try {
                const id = sessionIdRef.current;
                if (id) await api.closeModelSession(id);
            } catch {
                // Session cleanup is not worth blocking the close over.
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
                        handleRef={sknHandleRef}
                    />
                </main>
                <aside className="m3d__dock m3d__dock--right">
                    {session && <Inspector />}
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
