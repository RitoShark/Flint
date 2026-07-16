import React, { useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import * as api from '../../lib/api';
import type { CdnTreeNode, CdnProgress } from '../../lib/api/cdn';
import type { WadChunk } from '../../lib/types';
import { useNavigationStore, useNotificationStore } from '../../lib/stores';
import { useCdnManifestStore } from '../../lib/stores/cdnManifestStore';
import { formatBytes, buildVFSSubtree, isNonDefaultLocaleWad } from './wad-explorer/helpers';
import type { VFSNode, VFSFolder } from './wad-explorer/helpers';
import { ChunkPreview } from './wad-explorer/ChunkPreview';
import { cdnWadSource } from './wad-explorer/dataSource';
import { getIcon } from '../../lib/ui-helpers/fileIcons';

function isWadPath(path: string): boolean {
    const p = path.toLowerCase();
    return p.endsWith('.wad') || p.endsWith('.wad.client');
}

/** Collect every file_index at or under a tree node (for whole-folder extract/select). */
function collectIndices(node: CdnTreeNode, out: number[]): void {
    if (!node.is_dir && node.file_index != null) out.push(node.file_index);
    for (const c of node.children) collectIndices(c, out);
}

/** Sum the uncompressed size of the given file indices via a precomputed map. */
function sumSizes(indices: Set<number>, sizeByIndex: Map<number, number>): number {
    let total = 0;
    for (const i of indices) total += sizeByIndex.get(i) ?? 0;
    return total;
}

type TriState = 'none' | 'some' | 'all';

/** Cascade check-state for a node given the set of checked file indices. */
function nodeCheckState(node: CdnTreeNode, checked: Set<number>): TriState {
    const idx: number[] = [];
    collectIndices(node, idx);
    if (idx.length === 0) return 'none';
    let on = 0;
    for (const i of idx) if (checked.has(i)) on++;
    if (on === 0) return 'none';
    if (on === idx.length) return 'all';
    return 'some';
}

const TICK = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>
);

const Checkbox: React.FC<{ state: TriState; onToggle: () => void }> = ({ state, onToggle }) => (
    <span
        className={`cdn-cb${state === 'all' ? ' cdn-cb--on' : state === 'some' ? ' cdn-cb--part' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
    >
        {state === 'all' && TICK}
    </span>
);

export const ManifestBrowser: React.FC = () => {
    const activeId = useNavigationStore((s) => s.activeManifestId);
    const session = useCdnManifestStore((s) => (activeId ? s.sessions[activeId] : null));
    const update = useCdnManifestStore((s) => s.update);
    const showToast = useNotificationStore((s) => s.showToast);

    const [selectedInner, setSelectedInner] = useState<{ wadFileIndex: number; chunk: WadChunk } | null>(null);
    const [extracting, setExtracting] = useState(false);
    const [extractStatus, setExtractStatus] = useState<string | null>(null);
    const [extractPct, setExtractPct] = useState<number | null>(null);
    const [hideLanguages, setHideLanguages] = useState(true);
    const [expandedInnerFolders, setExpandedInnerFolders] = useState<Set<string>>(new Set());
    /** Checked manifest file indices (whole-WAD / folder / file selection). */
    const [checked, setChecked] = useState<Set<number>>(new Set());

    const sessionId = session?.sessionId ?? '';

    const dataSource = useMemo(
        () => (selectedInner ? cdnWadSource(sessionId, selectedInner.wadFileIndex) : null),
        [sessionId, selectedInner],
    );

    /** file_index → uncompressed size, for the selection-size summary. */
    const sizeByIndex = useMemo(() => {
        const map = new Map<number, number>();
        if (!session) return map;
        const walk = (n: CdnTreeNode) => {
            if (!n.is_dir && n.file_index != null) map.set(n.file_index, n.size);
            n.children.forEach(walk);
        };
        walk(session.tree);
        return map;
    }, [session?.tree]);

    /** Memoised VFS trees for each loaded inner WAD, keyed by file_index. */
    const innerTrees = useMemo(() => {
        if (!session) return new Map<number, VFSNode[]>();
        const result = new Map<number, VFSNode[]>();
        for (const [fileIndex, chunks] of session.wadInner) {
            const wadChunks: WadChunk[] = chunks.map((c) => ({ hash: c.hash, path: c.path, size: c.size }));
            result.set(fileIndex, buildVFSSubtree(wadChunks, `cdn:${fileIndex}`));
        }
        return result;
    }, [session?.wadInner]);

    if (!session) {
        return <div className="wad-explorer__empty" style={{ padding: 24 }}>No manifest loaded.</div>;
    }

    /** A WAD leaf is hidden by the language filter (non-default locale). */
    const isHiddenLangWad = (node: CdnTreeNode) =>
        hideLanguages && isWadPath(node.path) && isNonDefaultLocaleWad(node.name);

    const checkedCount = checked.size;
    const checkedSize = sumSizes(checked, sizeByIndex);

    const toggleFolder = (path: string) => {
        const next = new Set(session.expandedFolders);
        if (next.has(path)) next.delete(path); else next.add(path);
        update(session.sessionId, { expandedFolders: next });
    };

    const toggleInnerFolder = (key: string) => {
        setExpandedInnerFolders((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    };

    /** Toggle a node's whole subtree in the checked set (skips hidden lang WADs). */
    const toggleChecked = (node: CdnTreeNode) => {
        const idx: number[] = [];
        // When toggling a folder, skip file indices under hidden language WADs.
        const walk = (n: CdnTreeNode) => {
            if (isHiddenLangWad(n)) return;
            if (!n.is_dir && n.file_index != null) idx.push(n.file_index);
            n.children.forEach(walk);
        };
        walk(node);
        if (idx.length === 0) return;
        const state = nodeCheckState(node, checked);
        setChecked((prev) => {
            const next = new Set(prev);
            if (state === 'all') { for (const i of idx) next.delete(i); }
            else { for (const i of idx) next.add(i); }
            return next;
        });
    };

    const clearSelection = () => setChecked(new Set());

    const expandWad = async (node: CdnTreeNode) => {
        if (node.file_index == null) return;
        const next = new Set(session.expandedWads);
        if (next.has(node.path)) {
            next.delete(node.path);
            update(session.sessionId, { expandedWads: next });
            return;
        }
        next.add(node.path);
        update(session.sessionId, { expandedWads: next });
        if (!session.wadInner.has(node.file_index)) {
            try {
                const inner = await api.cdnListWad(session.sessionId, node.file_index);
                const map = new Map(session.wadInner);
                map.set(node.file_index, inner);
                update(session.sessionId, { wadInner: map });
            } catch (e) {
                showToast('error', `Failed to list WAD: ${(e as Error).message ?? e}`);
            }
        }
    };

    /** Run an extract for a set of manifest file indices with live progress. */
    const runExtract = async (indices: number[]) => {
        if (indices.length === 0) return;
        const dest = await open({ title: 'Choose Extraction Folder', directory: true });
        if (!dest) return;
        setExtracting(true);
        setExtractPct(0);
        setExtractStatus(`Preparing ${indices.length} file(s)…`);
        let done = 0;
        const total = indices.length;
        const unlisten = await listen<CdnProgress>('cdn-extract-progress', (ev) => {
            const p = ev.payload;
            if (p.type === 'fileStart') {
                const name = p.path.split('/').pop() ?? p.path;
                setExtractStatus(`${done}/${total} · ${name}`);
            } else if (p.type === 'fileDone' || p.type === 'fileError') {
                done++;
                setExtractPct(Math.round((done / total) * 100));
            } else if (p.type === 'allDone') {
                setExtractPct(100);
                setExtractStatus(`Done: ${p.files - p.errors}/${p.files} files`);
            }
        });
        try {
            const res = await api.cdnExtract(session.sessionId, indices, dest as string);
            showToast(res.errors > 0 ? 'error' : 'success',
                `Extracted ${res.files - res.errors}/${res.files} files${res.errors ? ` (${res.errors} failed)` : ''}`);
        } catch (e) {
            showToast('error', `Extraction failed: ${(e as Error).message ?? e}`);
        } finally {
            unlisten();
            setExtracting(false);
            setExtractStatus(null);
            setExtractPct(null);
        }
    };

    const extractNode = (node: CdnTreeNode) => {
        const indices: number[] = [];
        collectIndices(node, indices);
        runExtract(indices);
    };

    const extractSelected = () => runExtract([...checked]);

    /** Render inner WAD entries (unchanged from before — extract-only, no checkboxes). */
    const renderInnerNode = (node: VFSNode, depth: number, wadFileIndex: number): React.ReactNode => {
        const pad = 8 + depth * 14;
        if (node.type === 'folder') {
            const folder = node as VFSFolder;
            const isExpanded = expandedInnerFolders.has(folder.key);
            return (
                <div key={folder.key}>
                    <div className="wad-explorer__row" style={{ paddingLeft: pad, display: 'flex', alignItems: 'center', gap: 6, height: 24, cursor: 'pointer' }}
                        onClick={() => toggleInnerFolder(folder.key)}>
                        <span style={{ opacity: 0.7 }}>{isExpanded ? '▾' : '▸'}</span>
                        <span dangerouslySetInnerHTML={{ __html: getIcon('folder') }} />
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{folder.name}</span>
                    </div>
                    {isExpanded && folder.children.map((c) => renderInnerNode(c, depth + 1, wadFileIndex))}
                </div>
            );
        }
        const chunk = node.chunk;
        const isSel = selectedInner?.chunk.hash === chunk.hash && selectedInner?.wadFileIndex === wadFileIndex;
        return (
            <div key={chunk.hash}
                className={`wad-explorer__row ${isSel ? 'wad-explorer__row--selected' : ''}`}
                style={{ paddingLeft: pad, display: 'flex', alignItems: 'center', gap: 6, height: 24, cursor: 'pointer' }}
                onClick={() => setSelectedInner({ wadFileIndex, chunk })}>
                <span style={{ width: 10 }} />
                <span dangerouslySetInnerHTML={{ __html: getIcon('document') }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }} title={chunk.path ?? chunk.hash}>{node.name}</span>
                <span style={{ opacity: 0.5, fontSize: 11 }}>{formatBytes(chunk.size)}</span>
            </div>
        );
    };

    // Render the manifest tree with cascade checkboxes + per-node Extract.
    const renderNode = (node: CdnTreeNode, depth: number): React.ReactNode => {
        if (isHiddenLangWad(node)) return null;
        const pad = 8 + depth * 14;

        if (node.is_dir) {
            const expanded = session.expandedFolders.has(node.path);
            return (
                <div key={node.path}>
                    <div className="wad-explorer__row" style={{ paddingLeft: pad, display: 'flex', alignItems: 'center', gap: 8, height: 26, cursor: 'pointer' }}
                        onClick={() => toggleFolder(node.path)}>
                        <Checkbox state={nodeCheckState(node, checked)} onToggle={() => toggleChecked(node)} />
                        <span style={{ opacity: 0.7 }}>{expanded ? '▾' : '▸'}</span>
                        <span dangerouslySetInnerHTML={{ __html: getIcon('folder') }} />
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                        <span style={{ opacity: 0.5, fontSize: 11 }}>{formatBytes(node.size)}</span>
                        <button className="btn btn--sm" title="Extract this folder"
                            onClick={(e) => { e.stopPropagation(); extractNode(node); }}>Extract</button>
                    </div>
                    {expanded && node.children.map((c) => renderNode(c, depth + 1))}
                </div>
            );
        }

        const isWad = isWadPath(node.path);
        const locale = isWad ? node.name.match(/\.([a-z]{2}_[A-Z]{2})\.wad(?:\.client)?$/)?.[1] : null;
        const wadExpanded = isWad && session.expandedWads.has(node.path);
        const inner = node.file_index != null ? session.wadInner.get(node.file_index) : undefined;
        const vfsTree = node.file_index != null ? innerTrees.get(node.file_index) : undefined;
        return (
            <div key={node.path}>
                <div className="wad-explorer__row" style={{ paddingLeft: pad, display: 'flex', alignItems: 'center', gap: 8, height: 26, cursor: isWad ? 'pointer' : 'default' }}
                    onClick={() => isWad && expandWad(node)}>
                    <Checkbox state={nodeCheckState(node, checked)} onToggle={() => toggleChecked(node)} />
                    {isWad ? <span style={{ opacity: 0.7 }}>{wadExpanded ? '▾' : '▸'}</span> : <span style={{ width: 10 }} />}
                    <span dangerouslySetInnerHTML={{ __html: getIcon(isWad ? 'package' : 'document') }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                    {locale && <span className="cdn-langtag">{locale}</span>}
                    <span style={{ opacity: 0.5, fontSize: 11 }}>{formatBytes(node.size)}</span>
                    <button className="btn btn--sm" title="Extract"
                        onClick={(e) => { e.stopPropagation(); extractNode(node); }}>Extract</button>
                </div>
                {wadExpanded && node.file_index != null && (
                    <div>
                        {inner === undefined && <div style={{ paddingLeft: pad + 24, height: 24, opacity: 0.6, fontSize: 12 }}>Listing…</div>}
                        {vfsTree && vfsTree.map((n) => renderInnerNode(n, depth + 1, node.file_index!))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="wad-explorer" style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden', minWidth: 0 }}>
            <div style={{ width: 480, minWidth: 340, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
                <div className="cdn-bx-toolbar">
                    <span className="cdn-bx-toolbar__label">{session.label}</span>
                    <span className="cdn-bx-toolbar__files">{session.fileCount.toLocaleString()} files</span>
                    <div
                        className={`cdn-langtoggle${hideLanguages ? ' cdn-langtoggle--on' : ''}`}
                        onClick={() => setHideLanguages((v) => !v)}
                        title="Hide non-default language WADs (keeps shared + en_US)"
                    >
                        <span className="cdn-langtoggle__tgl" />
                        <span>{hideLanguages ? 'Hide other languages' : 'Showing all languages'}</span>
                    </div>
                </div>

                <div style={{ flex: 1, overflowY: 'auto' }}>
                    {session.tree.children.map((c) => renderNode(c, 0))}
                </div>

                <div className="cdn-actionbar">
                    {extracting ? (
                        <>
                            <div className={`cdn-bx-progress${extractPct == null ? ' cdn-bx-progress--indet' : ''}`}>
                                <div className="cdn-bx-progress__fill" style={extractPct != null ? { width: `${extractPct}%` } : undefined} />
                            </div>
                            <span className="cdn-bx-status">{extractStatus}</span>
                            <span className="cdn-actionbar__grow" />
                        </>
                    ) : (
                        <>
                            <span className="cdn-actionbar__summary">
                                <b>{checkedCount.toLocaleString()}</b> file{checkedCount === 1 ? '' : 's'} <span className="muted">·</span> <b>{formatBytes(checkedSize)}</b> <span className="muted">selected</span>
                            </span>
                            <span className="cdn-actionbar__grow" />
                            <button className="btn btn--sm" disabled={checkedCount === 0} onClick={clearSelection}>Clear</button>
                            <button className="btn btn--sm btn--primary" disabled={checkedCount === 0} onClick={extractSelected}>Extract selected</button>
                        </>
                    )}
                </div>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                {selectedInner && dataSource ? (
                    <ChunkPreview
                        key={`${selectedInner.wadFileIndex}:${selectedInner.chunk.hash}`}
                        wadPath={`cdn:${session.sessionId}:${selectedInner.wadFileIndex}`}
                        chunk={selectedInner.chunk}
                        dataSource={dataSource}
                        onClose={() => setSelectedInner(null)}
                    />
                ) : (
                    <div className="wad-explorer__empty" style={{ padding: 24, opacity: 0.6 }}>
                        {extracting ? 'Extracting…' : 'Select an inner file to preview, or check items and Extract to disk.'}
                    </div>
                )}
            </div>
        </div>
    );
};
