import React, { useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import * as api from '../../lib/api';
import type { CdnTreeNode, CdnWadChunk, CdnProgress } from '../../lib/api/cdn';
import type { WadChunk } from '../../lib/types';
import { useNavigationStore, useNotificationStore } from '../../lib/stores';
import { useCdnManifestStore } from '../../lib/stores/cdnManifestStore';
import { formatBytes } from './wad-explorer/helpers';
import { ChunkPreview } from './wad-explorer/ChunkPreview';
import { cdnWadSource } from './wad-explorer/dataSource';
import { getIcon } from '../../lib/ui-helpers/fileIcons';

function isWadPath(path: string): boolean {
    const p = path.toLowerCase();
    return p.endsWith('.wad') || p.endsWith('.wad.client');
}

/** Collect every file_index at or under a tree node (for whole-folder extract). */
function collectIndices(node: CdnTreeNode, out: number[]): void {
    if (!node.is_dir && node.file_index != null) {
        out.push(node.file_index);
    }
    for (const c of node.children) collectIndices(c, out);
}

export const ManifestBrowser: React.FC = () => {
    const activeId = useNavigationStore((s) => s.activeManifestId);
    const session = useCdnManifestStore((s) => (activeId ? s.sessions[activeId] : null));
    const update = useCdnManifestStore((s) => s.update);
    const showToast = useNotificationStore((s) => s.showToast);

    const [selectedInner, setSelectedInner] = useState<{ wadFileIndex: number; chunk: WadChunk } | null>(null);
    const [extracting, setExtracting] = useState(false);
    const [extractStatus, setExtractStatus] = useState<string | null>(null);

    const sessionId = session?.sessionId ?? '';

    const dataSource = useMemo(
        () => (selectedInner ? cdnWadSource(sessionId, selectedInner.wadFileIndex) : null),
        [sessionId, selectedInner],
    );

    if (!session) {
        return <div className="wad-explorer__empty" style={{ padding: 24 }}>No manifest loaded.</div>;
    }

    const toggleFolder = (path: string) => {
        const next = new Set(session.expandedFolders);
        if (next.has(path)) next.delete(path); else next.add(path);
        update(session.sessionId, { expandedFolders: next });
    };

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
        // Lazy-list inner entries once.
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

    const extractNode = async (node: CdnTreeNode) => {
        const indices: number[] = [];
        collectIndices(node, indices);
        if (indices.length === 0) return;
        const dest = await open({ title: 'Choose Extraction Folder', directory: true });
        if (!dest) return;
        setExtracting(true);
        setExtractStatus(`Extracting ${indices.length} file(s)…`);
        const unlisten = await listen<CdnProgress>('cdn-extract-progress', (ev) => {
            const p = ev.payload;
            if (p.type === 'fileStart') setExtractStatus(`Downloading ${p.path}`);
            else if (p.type === 'allDone') setExtractStatus(`Done: ${p.files - p.errors}/${p.files} files`);
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
        }
    };

    // Render the manifest tree recursively. Folders expand inline; WAD leaves expand
    // to their range-fetched inner entries (each a previewable ChunkPreview target).
    const renderNode = (node: CdnTreeNode, depth: number): React.ReactNode => {
        const pad = 8 + depth * 14;
        if (node.is_dir) {
            const expanded = session.expandedFolders.has(node.path);
            return (
                <div key={node.path}>
                    <div className="wad-explorer__row" style={{ paddingLeft: pad, display: 'flex', alignItems: 'center', gap: 6, height: 26, cursor: 'pointer' }}
                        onClick={() => toggleFolder(node.path)}>
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

        // File leaf. WADs expand into inner entries; non-WAD files are extract-only.
        const isWad = isWadPath(node.path);
        const wadExpanded = isWad && session.expandedWads.has(node.path);
        const inner = node.file_index != null ? session.wadInner.get(node.file_index) : undefined;
        return (
            <div key={node.path}>
                <div className="wad-explorer__row" style={{ paddingLeft: pad, display: 'flex', alignItems: 'center', gap: 6, height: 26, cursor: isWad ? 'pointer' : 'default' }}
                    onClick={() => isWad && expandWad(node)}>
                    {isWad ? <span style={{ opacity: 0.7 }}>{wadExpanded ? '▾' : '▸'}</span> : <span style={{ width: 10 }} />}
                    <span dangerouslySetInnerHTML={{ __html: getIcon(isWad ? 'package' : 'document') }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                    <span style={{ opacity: 0.5, fontSize: 11 }}>{formatBytes(node.size)}</span>
                    <button className="btn btn--sm" title="Extract"
                        onClick={(e) => { e.stopPropagation(); extractNode(node); }}>Extract</button>
                </div>
                {wadExpanded && node.file_index != null && (
                    <div>
                        {inner === undefined && <div style={{ paddingLeft: pad + 24, height: 24, opacity: 0.6, fontSize: 12 }}>Listing…</div>}
                        {inner?.map((c: CdnWadChunk) => {
                            const chunk: WadChunk = { hash: c.hash, path: c.path, size: c.size };
                            const label = c.path ? (c.path.split('/').pop() ?? c.path) : c.hash;
                            const isSel = selectedInner?.chunk.hash === c.hash && selectedInner?.wadFileIndex === node.file_index;
                            return (
                                <div key={c.hash}
                                    className={`wad-explorer__row ${isSel ? 'wad-explorer__row--selected' : ''}`}
                                    style={{ paddingLeft: pad + 24, display: 'flex', alignItems: 'center', gap: 6, height: 24, cursor: 'pointer' }}
                                    onClick={() => setSelectedInner({ wadFileIndex: node.file_index!, chunk })}>
                                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }} title={c.path ?? c.hash}>{label}</span>
                                    <span style={{ opacity: 0.5, fontSize: 11 }}>{formatBytes(c.size)}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="wad-explorer" style={{ display: 'flex', height: '100%' }}>
            <div style={{ width: 460, minWidth: 320, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>{session.label}</span>
                    <span style={{ opacity: 0.6, fontSize: 12 }}>{session.fileCount.toLocaleString()} files</span>
                    {extractStatus && <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.8 }}>{extractStatus}</span>}
                </div>
                <div style={{ flex: 1, overflowY: 'auto' }}>
                    {session.tree.children.map((c) => renderNode(c, 0))}
                </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
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
                        {extracting ? 'Extracting…' : 'Select an inner file to preview, or Extract a folder/WAD to disk.'}
                    </div>
                )}
            </div>
        </div>
    );
};
