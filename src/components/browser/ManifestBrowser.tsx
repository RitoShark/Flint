import React, { useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import * as api from '../../lib/api';
import type { CdnTreeNode, CdnProgress } from '../../lib/api/cdn';
import type { WadChunk } from '../../lib/types';
import { useNavigationStore, useNotificationStore } from '../../lib/stores';
import { useCdnManifestStore } from '../../lib/stores/cdnManifestStore';
import { formatBytes, buildVFSSubtree } from './wad-explorer/helpers';
import type { VFSNode, VFSFolder } from './wad-explorer/helpers';
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
    /** Tracks expanded inner-WAD folders by VFS key (e.g. `cdn:0::assets/characters`). */
    const [expandedInnerFolders, setExpandedInnerFolders] = useState<Set<string>>(new Set());

    const sessionId = session?.sessionId ?? '';

    const dataSource = useMemo(
        () => (selectedInner ? cdnWadSource(sessionId, selectedInner.wadFileIndex) : null),
        [sessionId, selectedInner],
    );

    /** Memoised VFS trees for each loaded inner WAD, keyed by file_index. */
    const innerTrees = useMemo(() => {
        if (!session) return new Map<number, VFSNode[]>();
        const result = new Map<number, VFSNode[]>();
        for (const [fileIndex, chunks] of session.wadInner) {
            const wadChunks: WadChunk[] = chunks.map((c) => ({ hash: c.hash, path: c.path, size: c.size }));
            // Use a synthetic wadPath key: `cdn:<fileIndex>` — keeps VFS folder keys unique per WAD.
            result.set(fileIndex, buildVFSSubtree(wadChunks, `cdn:${fileIndex}`));
        }
        return result;
    }, [session?.wadInner]);

    if (!session) {
        return <div className="wad-explorer__empty" style={{ padding: 24 }}>No manifest loaded.</div>;
    }

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

    /** Render the VFS tree of inner WAD entries with folders, matching the WAD explorer look. */
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
        // File node
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

    // Render the manifest tree recursively. Folders expand inline; WAD leaves expand
    // to their range-fetched inner entries rendered as a navigable folder tree.
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

        // File leaf. WADs expand into inner entries as a folder tree; non-WAD files are extract-only.
        const isWad = isWadPath(node.path);
        const wadExpanded = isWad && session.expandedWads.has(node.path);
        const inner = node.file_index != null ? session.wadInner.get(node.file_index) : undefined;
        const vfsTree = node.file_index != null ? innerTrees.get(node.file_index) : undefined;
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
                        {vfsTree && vfsTree.map((n) => renderInnerNode(n, depth + 1, node.file_index!))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="wad-explorer" style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden', minWidth: 0 }}>
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
                        {extracting ? 'Extracting…' : 'Select an inner file to preview, or Extract a folder/WAD to disk.'}
                    </div>
                )}
            </div>
        </div>
    );
};
