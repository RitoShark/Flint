import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';
import * as api from '../../lib/api';
import { useArchiveEditStore } from '../../lib/stores/archiveEditStore';
import { useWadExtractStore } from '../../lib/stores/wadExtractStore';
import { useNotificationStore } from '../../lib/stores';
import { WadBrowserPanel } from '../browser/WadBrowser';
import { WadPreviewPanel } from './WadPreviewPanel';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { mountModpkg } from '../../lib/vfs/modpkgMount';

function errMsg(e: unknown): string {
    return (e as { message?: string })?.message ?? String(e);
}

/** Editable Monaco JSON editor (mirrors ReadOnlyMonaco but writable + onChange). */
const JsonEditor: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
        if (!containerRef.current) return;
        const ed = monaco.editor.create(containerRef.current, {
            value,
            language: 'json',
            theme: 'vs-dark',
            automaticLayout: true,
            fontFamily: 'var(--font-mono), Consolas, monospace',
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
        });
        editorRef.current = ed;
        const sub = ed.onDidChangeModelContent(() => onChangeRef.current(ed.getValue()));
        return () => {
            sub.dispose();
            ed.dispose();
            editorRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const ed = editorRef.current;
        if (ed && ed.getValue() !== value) {
            ed.setValue(value);
        }
    }, [value]);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
};

type Selection = 'meta' | 'modpkg' | { wad: string } | null;

export const ArchiveEditor: React.FC<{ filePath: string }> = ({ filePath }) => {
    const showToast = useNotificationStore((s) => s.showToast);
    const { layout, metaJson, openWadName, setLayout, setMetaJson, openWad, closeWad, reset } = useArchiveEditStore();
    const [selected, setSelected] = useState<Selection>('meta');
    const [busy, setBusy] = useState(false);
    const metaDebounceRef = useRef<number | null>(null);
    // Track the seeded wadExtractStore session ids we created so we can close
    // them (and their backend WAD edit sessions) on unmount.
    const seededSessionIdsRef = useRef<Set<string>>(new Set());
    // Backend modpkg session, opened lazily when the user browses the contents.
    const modpkgSessionIdRef = useRef<string | null>(null);
    // The package's own metadata, kept so a chunk-only save can round-trip it
    // unchanged rather than re-reading the file.
    const modpkgMetaRef = useRef<api.ModpkgMetadataInput | null>(null);
    const [modpkgChunkCount, setModpkgChunkCount] = useState(0);
    // The extract-store session the embedded browser/preview panes render. Held
    // explicitly because those panes must not follow the global active session,
    // which belongs to the user's own WAD tabs.
    const [paneSessionId, setPaneSessionId] = useState<string | null>(null);

    // Open the archive session on mount; close + clean up on unmount.
    useEffect(() => {
        let sid: string | null = null;
        (async () => {
            try {
                const l = await api.openArchiveSession(filePath);
                sid = l.session_id;
                setLayout(l);
                setSelected('meta');
            } catch (e) {
                showToast('error', `Failed to open archive: ${errMsg(e)}`);
            }
        })();
        return () => {
            // Close any seeded extract sessions first (closeSession also closes
            // their backend WAD edit session). The backend close_archive_session
            // also removes them — double-remove is a harmless no-op.
            const store = useWadExtractStore.getState();
            seededSessionIdsRef.current.forEach((id) => {
                try { store.closeSession(id); } catch { /* ignore */ }
            });
            seededSessionIdsRef.current.clear();
            const modpkgSid = modpkgSessionIdRef.current;
            if (modpkgSid) {
                api.closeModpkgSession(modpkgSid).catch(() => {});
                modpkgSessionIdRef.current = null;
            }
            if (sid) api.closeArchiveSession(sid).catch(() => {});
            reset();
        };
    }, [filePath, setLayout, reset, showToast]);

    // Debounced meta write-through to the backend session.
    const handleMetaChange = useCallback((v: string) => {
        setMetaJson(v);
        if (!layout) return;
        if (metaDebounceRef.current) window.clearTimeout(metaDebounceRef.current);
        metaDebounceRef.current = window.setTimeout(() => {
            api.writeArchiveMeta(layout.session_id, v).catch((e) => {
                console.error('writeArchiveMeta failed', e);
            });
        }, 400);
    }, [layout, setMetaJson]);

    const handleOpenWad = useCallback(async (name: string) => {
        if (!layout) return;
        setBusy(true);
        try {
            const info = await api.openInnerWad(layout.session_id, name);
            const exId = `archive-${layout.session_id}-${name}`;
            // Seed (or re-activate) a wadExtractStore session pointing at the
            // already-open backend edit session for this inner WAD.
            const existing = useWadExtractStore.getState().extractSessions.find((s) => s.id === exId);
            if (!existing) {
                useWadExtractStore.getState().openSession(exId, info.source_path, info.session_id, { embedded: true });
                seededSessionIdsRef.current.add(exId);
                // Folder-backed WADs supply their REAL paths directly (no LMDB,
                // no hashed `data/`). Packed WADs use the normal resolve path.
                const chunks = info.is_folder && info.folder_chunks
                    ? info.folder_chunks.map((c) => ({ hash: c.hash, path: c.path, size: c.size }))
                    : await api.getWadChunks(info.source_path);
                useWadExtractStore.getState().setChunks(exId, chunks);
            }
            setPaneSessionId(exId);
            openWad(name, info.session_id);
            setSelected({ wad: name });
        } catch (e) {
            showToast('error', `Failed to open inner WAD: ${errMsg(e)}`);
        } finally {
            setBusy(false);
        }
    }, [layout, openWad, showToast]);

    const handleSelectMeta = useCallback(() => {
        setSelected('meta');
        closeWad();
    }, [closeWad]);

    /**
     * Browse a modpkg's chunks in the same tree a WAD uses.
     *
     * A modpkg has no inner WADs to open, so instead of an edit session it gets
     * a VFS mount, and the session carries that mount for the browser and
     * preview panel to read and write through.
     */
    const handleOpenModpkg = useCallback(async () => {
        if (!layout) return;
        // Already open — just show it. Opening a second backend session would
        // strand the first along with any edits staged in it.
        if (modpkgSessionIdRef.current) {
            setSelected('modpkg');
            closeWad();
            return;
        }
        setBusy(true);
        try {
            const session = await api.openModpkgSession(layout.source_path);
            modpkgSessionIdRef.current = session.session_id;
            modpkgMetaRef.current = {
                name: session.name,
                display_name: session.display_name,
                description: session.description,
                version: session.version,
                authors: session.authors,
            };

            const mount = await mountModpkg(session.session_id, layout.source_path.split(/[\\/]/).pop() ?? 'modpkg');
            const exId = `archive-modpkg-${session.session_id}`;

            const store = useWadExtractStore.getState();
            store.openSession(exId, layout.source_path, undefined, { mountBacked: true, embedded: true });
            seededSessionIdsRef.current.add(exId);
            store.setSessionMount(exId, mount);
            setPaneSessionId(exId);

            // The browser works in WadChunk shape; a modpkg is keyed by path, so
            // the hash column carries the path and stays a stable row identity.
            const chunks = await api.listModpkgChunks(session.session_id);
            store.setChunks(exId, chunks.map((c) => ({
                hash: c.path,
                path: c.path,
                size: c.size,
            })));
            setModpkgChunkCount(chunks.length);

            setSelected('modpkg');
            closeWad();
        } catch (e) {
            showToast('error', `Failed to open package contents: ${errMsg(e)}`);
        } finally {
            setBusy(false);
        }
    }, [layout, closeWad, showToast]);

    const handleSave = useCallback(async () => {
        if (!layout) return;
        setBusy(true);
        try {
            await api.writeArchiveMeta(layout.session_id, metaJson);
            // Staged chunk edits live in the modpkg session, and the archive save
            // path only rewrites metadata — so flush the chunks first, then let
            // the archive save apply the metadata on top.
            const modpkgSessionId = modpkgSessionIdRef.current;
            const modpkgMeta = modpkgMetaRef.current;
            if (modpkgSessionId && modpkgMeta) {
                const dirty = await api.modpkgDirtyChunks(modpkgSessionId);
                if (dirty.length > 0) {
                    await api.saveModpkgSession(modpkgSessionId, modpkgMeta, layout.source_path);
                }
            }
            await api.saveArchiveSession(layout.session_id, layout.source_path);
            showToast('success', 'Archive saved');
        } catch (e) {
            showToast('error', `Save failed: ${errMsg(e)}`);
        } finally {
            setBusy(false);
        }
    }, [layout, metaJson, showToast]);

    if (!layout) {
        return (
            <div className="dl-root" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                <span style={{ color: 'var(--text-muted)' }}>Opening archive…</span>
            </div>
        );
    }

    const archiveName = layout.source_path.split(/[\\/]/).pop() || layout.source_path;
    const wadSelected = typeof selected === 'object' && selected !== null && 'wad' in selected;

    return (
        <div
            className="dl-root archive-editor"
            style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', overflow: 'hidden' }}
        >
            {/* Toolbar. Doubles as a window drag handle — it is the full-width
                strip under the tab bar, so without it the window is only
                draggable by the tabs themselves. */}
            <div className="archive-toolbar" data-tauri-drag-region>
                <span className="archive-toolbar__name" data-tauri-drag-region>{archiveName}</span>
                <span className="archive-toolbar__kind">{layout.kind}</span>
                <div style={{ flex: 1 }} data-tauri-drag-region />
                <button
                    className="dl-btn dl-btn--primary dl-btn--sm"
                    onClick={handleSave}
                    disabled={busy}
                    data-tauri-drag-region="false"
                >
                    {busy ? 'Saving…' : 'Save Archive'}
                </button>
            </div>

            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                {/* Left: container tree */}
                <div className="archive-side">
                    <div className="archive-side__group">Meta</div>
                    <TreeItem
                        label="info.json"
                        icon="bin"
                        active={selected === 'meta'}
                        onClick={handleSelectMeta}
                    />
                    {layout.kind === 'fantome' && layout.wads.length > 0 && (
                        <>
                            <div className="archive-side__group">WAD</div>
                            {layout.wads.map((w) => (
                                <TreeItem
                                    key={w.name}
                                    label={w.name}
                                    icon="package"
                                    active={wadSelected && (selected as { wad: string }).wad === w.name}
                                    onClick={() => handleOpenWad(w.name)}
                                />
                            ))}
                        </>
                    )}
                    {layout.kind === 'modpkg' && (
                        <>
                            <div className="archive-side__group">Content</div>
                            <TreeItem
                                label={modpkgChunkCount > 0 ? `${modpkgChunkCount.toLocaleString()} file${modpkgChunkCount === 1 ? '' : 's'}` : 'Files'}
                                icon="package"
                                active={selected === 'modpkg'}
                                onClick={handleOpenModpkg}
                            />
                        </>
                    )}
                </div>

                {/* Right: editor / WAD panes */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                    {selected === 'modpkg' ? (
                        <>
                            <div className="archive-note">
                                <span className="archive-note__icon" dangerouslySetInnerHTML={{ __html: getIcon('package') }} />
                                Package contents — edits persist into the package only on “Save Archive”.
                            </div>
                            <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
                                <WadBrowserPanel sessionId={paneSessionId ?? undefined} style={{ flex: 1, height: '100%', minWidth: 0, maxWidth: 'none', borderRight: '1px solid var(--border)' }} />
                                <WadPreviewPanel sessionId={paneSessionId ?? undefined} style={{ width: '420px', height: '100%', minWidth: '380px' }} />
                            </div>
                        </>
                    ) : selected === 'meta' || !openWadName ? (
                        <>
                            <div className="archive-note">
                                Editing META/info.json — saved into the archive on “Save Archive”.
                            </div>
                            <div style={{ flex: 1, minHeight: 0 }}>
                                <JsonEditor value={metaJson} onChange={handleMetaChange} />
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="archive-note">
                                <span className="archive-note__icon" dangerouslySetInnerHTML={{ __html: getIcon('package') }} />
                                {openWadName} — edits persist into the archive only on “Save Archive”.
                            </div>
                            <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
                                <WadBrowserPanel sessionId={paneSessionId ?? undefined} style={{ flex: 1, height: '100%', minWidth: 0, maxWidth: 'none', borderRight: '1px solid var(--border)' }} />
                                <WadPreviewPanel sessionId={paneSessionId ?? undefined} style={{ width: '420px', height: '100%', minWidth: '380px' }} />
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

const TreeItem: React.FC<{ label: string; icon: string; active: boolean; onClick: () => void }> = ({ label, icon, active, onClick }) => (
    <div
        className={`archive-item${active ? ' archive-item--active' : ''}`}
        onClick={onClick}
        title={label}
    >
        <span className="archive-item__icon" dangerouslySetInnerHTML={{ __html: getIcon(icon as never) }} />
        <span className="archive-item__label">{label}</span>
    </div>
);
