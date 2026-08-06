import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import * as api from '../../lib/api';
import type { ModelSessionInfo } from '../../lib/api/modelEdit';
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

export const ModelEditorWindow: React.FC = () => {
    const [target, setTarget] = useState<Target | null>(() => targetFromHash());
    const [session, setSession] = useState<ModelSessionInfo | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Mirrors whichever session is currently open. A ref (not state) so the
    // onCloseRequested handler below always reads the live id instead of one
    // captured at listener-registration time — it's written at the same
    // point as setSession/setSession(null), never via a follow-up effect.
    const sessionIdRef = useRef<string | null>(null);

    // The backend retargets an already-open window rather than spawning a second
    // WebView2, so the file can change under us.
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        listen<[string, string]>('model-editor-load', (ev) => {
            const [project, skn] = ev.payload;
            setTarget({ project, skn });
        }).then((u) => { unlisten = u; });
        return () => unlisten?.();
    }, []);

    useEffect(() => {
        if (!target) return;
        let cancelled = false;
        let openedId: string | null = null;
        setSession(null);
        sessionIdRef.current = null;
        setError(null);

        void (async () => {
            try {
                const info = await api.openModelSession(target.skn);
                openedId = info.sessionId;
                if (cancelled) {
                    void api.closeModelSession(info.sessionId);
                    return;
                }
                setSession(info);
                sessionIdRef.current = info.sessionId;
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

    // Closing the WebviewWindow natively (OS close button / Alt+F4) destroys
    // this JS context outright — a component-unmount cleanup never runs, so
    // without this the backend ModelEditSession (parsed mesh + skeleton) is
    // orphaned in the app-wide state map for the rest of the process
    // lifetime. preventDefault() first and unconditionally: the async
    // closeModelSession call cannot be relied on to finish before the window
    // tears down. Task 13's unsaved-changes guard extends this same handler
    // — do not add a second onCloseRequested listener for this window.
    useEffect(() => {
        const win = getCurrentWindow();
        let unlisten: (() => void) | undefined;
        win.onCloseRequested(async (event) => {
            event.preventDefault();
            const id = sessionIdRef.current;
            if (id) {
                try {
                    await api.closeModelSession(id);
                } catch {
                    // A failed close must never trap the user in an unclosable window.
                }
            }
            await win.destroy();
        }).then((u) => { unlisten = u; });
        return () => unlisten?.();
    }, []);

    const fileName = useCallback(
        () => (target ? target.skn.replace(/\\/g, '/').split('/').pop() ?? target.skn : ''),
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
                {session?.summary.dirty && <span className="m3d__dirty" aria-label="Unsaved changes">●</span>}
            </header>
            <div className="m3d__body">
                <aside className="m3d__dock m3d__dock--left">
                    {!session && <div className="m3d__loading">Loading…</div>}
                    {session && (
                        <ul className="m3d__list">
                            {session.summary.submeshes.map((s) => (
                                <li key={s.name} className="m3d__list-row">{s.name}</li>
                            ))}
                        </ul>
                    )}
                </aside>
                <main className="m3d__viewport" />
                <aside className="m3d__dock m3d__dock--right" />
            </div>
            <footer className="m3d__status">
                {session
                    ? `${session.summary.submeshes.length} submeshes · ${session.summary.vertexCount.toLocaleString()} verts`
                    : ''}
            </footer>
        </div>
    );
};
