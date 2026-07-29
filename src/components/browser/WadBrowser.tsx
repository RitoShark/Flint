import React, { useMemo, useCallback, useState } from 'react';
import { useAppMetadataStore, useModalStore, useNotificationStore, useWadExtractStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { open } from '@tauri-apps/plugin-dialog';
import { getIcon, getFileIcon } from '../../lib/ui-helpers/fileIcons';
import { checkboxSvg } from './wad-explorer/helpers';
import type { WadChunk } from '../../lib/types';

// =============================================================================
// Virtual Tree Types (used for traversing internal folders)
// =============================================================================

interface WadTreeFolder {
    type: 'folder';
    name: string;
    fullPath: string;
    children: WadTreeNode[];
}

interface WadTreeFile {
    type: 'file';
    name: string;
    chunk: WadChunk;
}

type WadTreeNode = WadTreeFolder | WadTreeFile;

// =============================================================================
// Tree Construction and Navigation Helpers
// =============================================================================

function getAllChunkHashes(nodes: WadTreeNode[]): string[] {
    const hashes: string[] = [];
    for (const node of nodes) {
        if (node.type === 'file') {
            hashes.push(node.chunk.hash);
        } else {
            hashes.push(...getAllChunkHashes(node.children));
        }
    }
    return hashes;
}

function buildWadTree(chunks: WadChunk[], searchQuery: string): WadTreeNode[] {
    const query = searchQuery.toLowerCase().trim();

    const filtered = query
        ? chunks.filter(c =>
            (c.path?.toLowerCase().includes(query)) ||
            (!c.path && c.hash.toLowerCase().includes(query))
          )
        : chunks;

    const folderMap = new Map<string, WadTreeFolder>();
    const rootNodes: WadTreeNode[] = [];

    const getOrCreateFolder = (folderPath: string): WadTreeFolder => {
        if (folderMap.has(folderPath)) return folderMap.get(folderPath)!;

        const parts = folderPath.split('/');
        const name = parts[parts.length - 1];
        const parentPath = parts.slice(0, -1).join('/');

        const folder: WadTreeFolder = { type: 'folder', name, fullPath: folderPath, children: [] };
        folderMap.set(folderPath, folder);

        if (parentPath === '') {
            rootNodes.push(folder);
        } else {
            getOrCreateFolder(parentPath).children.push(folder);
        }

        return folder;
    };

    for (const chunk of filtered) {
        if (!chunk.path) continue;

        const normalizedPath = chunk.path.replace(/\\/g, '/');
        const parts = normalizedPath.split('/');
        const fileName = parts[parts.length - 1];
        const dirParts = parts.slice(0, -1);

        const fileNode: WadTreeFile = { type: 'file', name: fileName, chunk };

        if (dirParts.length === 0) {
            rootNodes.push(fileNode);
        } else {
            getOrCreateFolder(dirParts.join('/')).children.push(fileNode);
        }
    }

    const unresolved = filtered.filter(c => !c.path);
    if (unresolved.length > 0) {
        rootNodes.push({
            type: 'folder',
            name: '[Unknown Hashes]',
            fullPath: '[Unknown Hashes]',
            children: unresolved.map(c => ({ type: 'file' as const, name: c.hash, chunk: c })),
        });
    }

    const sort = (nodes: WadTreeNode[]) => {
        nodes.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        nodes.forEach(n => { if (n.type === 'folder') sort(n.children); });
    };
    sort(rootNodes);

    return rootNodes;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// =============================================================================
// WadBrowserPanel — main export
// =============================================================================

export const WadBrowserPanel: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
    const extractSessions = useWadExtractStore((s) => s.extractSessions);
    const activeExtractId = useWadExtractStore((s) => s.activeExtractId);
    const showToast = useNotificationStore((s) => s.showToast);
    const setStatus = useAppMetadataStore((s) => s.setStatus);
    const session = extractSessions.find(s => s.id === activeExtractId);

    const isSearching = !!session?.searchQuery?.trim();

    const openContextMenu = useModalStore((s) => s.openContextMenu);
    const [isExtracting, setIsExtracting] = useState(false);
    const [isUnhashing, setIsUnhashing] = useState(false);
    const [isSavingWad, setIsSavingWad] = useState(false);
    const [renamingHash, setRenamingHash] = useState<string | null>(null);
    // Inline expand/collapse tree state (mirrors WadExplorer's look): the set of
    // expanded folder paths. Local — search mode bypasses it entirely.
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

    const toggleFolder = useCallback((fullPath: string) => {
        setExpandedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(fullPath)) next.delete(fullPath); else next.add(fullPath);
            return next;
        });
    }, []);

    const unknownChunksCount = useMemo(() => {
        if (!session) return 0;
        return session.chunks.filter(c => !c.path).length;
    }, [session?.chunks]);

    const handleUnhashWad = useCallback(async () => {
        if (!session) return;
        try {
            setIsUnhashing(true);
            setStatus('working', 'Scanning WAD for asset paths...');

            const result = await api.extractHashesFromWad(session.wadPath);
            const totalAdded = result.game_hashes_added + result.bin_hashes_added;

            const refreshedChunks = await api.getWadChunks(session.wadPath);
            useWadExtractStore.getState().setChunks(session.id, refreshedChunks);

            const beforeUnknown = session.chunks.filter(c => !c.path).length;
            const afterUnknown = refreshedChunks.filter(c => !c.path).length;
            const newlyResolved = Math.max(0, beforeUnknown - afterUnknown);

            if (newlyResolved > 0) {
                showToast('success', `Successfully unhashed ${newlyResolved} file${newlyResolved === 1 ? '' : 's'}! (+${totalAdded} hashes scanned)`);
            } else if (totalAdded > 0) {
                showToast('info', `Scanned ${result.scanned} files. Added ${totalAdded} hashes to database, but none matched this WAD.`);
            } else {
                showToast('info', `Scanned ${result.scanned} files. No new hashes found.`);
            }
        } catch (err) {
            console.error('[WadBrowser] Unhashing failed:', err);
            showToast('error', `Unhashing failed: ${(err as Error).message || err}`);
        } finally {
            setIsUnhashing(false);
            setStatus('ready', '');
        }
    }, [session, showToast, setStatus]);

    const handleSaveWad = useCallback(async () => {
        if (!session || !session.editSessionId) return;
        try {
            setIsSavingWad(true);
            setStatus('working', 'Saving WAD...');
            
            await api.saveWadEditSession(session.editSessionId, session.wadPath);
            useWadExtractStore.getState().setSessionDirty(session.id, false);
            showToast('success', 'WAD saved successfully!');
        } catch (err) {
            console.error('[WadBrowser] Save WAD failed:', err);
            showToast('error', `Failed to save WAD: ${(err as Error).message || err}`);
        } finally {
            setIsSavingWad(false);
            setStatus('ready', '');
        }
    }, [session, showToast, setStatus]);

    const handleRenameCommit = useCallback(async (chunk: WadChunk, newPath: string) => {
        setRenamingHash(null);
        const trimmed = newPath.trim();
        if (!session || !trimmed || trimmed === chunk.path) return;
        // A mount handles archives that are not WADs; otherwise fall back to the
        // WAD edit session.
        const renamableMount = session.mount?.caps.rename ? session.mount : null;
        if (!session.editSessionId && !renamableMount) return;
        try {
            if (renamableMount) {
                const path = chunk.path ?? chunk.hash;
                await renamableMount.rename!({
                    path,
                    name: path.split('/').pop() ?? path,
                    isDirectory: false,
                    size: chunk.size,
                    key: renamableMount.keyedBy === 'path' ? path : chunk.hash,
                }, trimmed);
                // Path-keyed mounts re-key on the path itself.
                const newKey = renamableMount.keyedBy === 'path' ? trimmed : chunk.hash;
                useWadExtractStore.getState().stageChunkRename(session.id, chunk.hash, newKey, trimmed);
            } else {
                const newHash = await api.renameSessionChunk(session.editSessionId!, chunk.hash, trimmed);
                useWadExtractStore.getState().stageChunkRename(session.id, chunk.hash, newHash, trimmed);
            }
            showToast('success', 'Chunk renamed');
        } catch (e) {
            showToast('error', `Rename failed: ${(e as { message?: string })?.message ?? String(e)}`);
        }
    }, [session, showToast]);

    const nodes = useMemo(() => {
        if (!session) return [];
        return buildWadTree(session.chunks, '');
    }, [session?.chunks]);

    const filteredChunks = useMemo(() => {
        if (!session) return [];
        const q = session.searchQuery.toLowerCase().trim();
        const results = [];
        for (const c of session.chunks) {
            if ((c.path?.toLowerCase().includes(q)) || (!c.path && c.hash.toLowerCase().includes(q))) {
                results.push(c);
                if (results.length >= 500) break;
            }
        }
        return results;
    }, [session?.chunks, session?.searchQuery]);

    const onPreview = useCallback((hash: string) => {
        if (!session) return;
        useWadExtractStore.getState().setPreview(session.id, hash);
    }, [session?.id]);

    const onToggleChunk = useCallback((hash: string) => {
        if (!session) return;
        useWadExtractStore.getState().toggleChunk(session.id, hash);
    }, [session?.id]);

    const handleToggleFolderSelection = useCallback((node: WadTreeFolder) => {
        if (!session) return;
        const hashes = getAllChunkHashes([node]);
        const allSelected = hashes.every(h => session.selectedHashes.has(h));
        
        for (const hash of hashes) {
            const isCurrentlySelected = session.selectedHashes.has(hash);
            if (allSelected && isCurrentlySelected) {
                useWadExtractStore.getState().toggleChunk(session.id, hash);
            } else if (!allSelected && !isCurrentlySelected) {
                useWadExtractStore.getState().toggleChunk(session.id, hash);
            }
        }
    }, [session]);

    const handleExtractSelected = useCallback(async () => {
        if (!session || session.selectedHashes.size === 0) return;

        try {
            const destDir = await open({ title: 'Choose Extraction Folder', directory: true });
            if (!destDir) return;

            setIsExtracting(true);
            const hashes = [...session.selectedHashes];
            const result = await api.extractWad(session.wadPath, destDir as string, hashes);
            showToast('success', `Extracted ${result.extracted} file${result.extracted !== 1 ? 's' : ''}`);
        } catch (err) {
            console.error('[WadBrowser] Extract failed:', err);
            showToast('error', 'Extraction failed');
        } finally {
            setIsExtracting(false);
        }
    }, [session, showToast]);

    const onSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        if (!session) return;
        useWadExtractStore.getState().setSearch(session.id, e.target.value);
    }, [session?.id]);

    // =========================================================================
    // Right-Click Context Menus
    // =========================================================================
    const handleContextMenu = useCallback((e: React.MouseEvent, chunk: WadChunk) => {
        e.preventDefault();
        e.stopPropagation();

        if (!session) return;

        const options = [
            {
                label: 'Extract File...',
                icon: getIcon('export'),
                onClick: async () => {
                    try {
                        const dest = await open({ title: 'Choose Extraction Folder', directory: true });
                        if (!dest) return;
                        setStatus('working', 'Extracting...');
                        const res = await api.extractWad(session.wadPath, dest as string, [chunk.hash]);
                        showToast('success', `Extracted ${res.extracted} file`);
                    } catch {
                        showToast('error', 'Extraction failed');
                    } finally {
                        setStatus('ready', '');
                    }
                }
            },
            ...((session.editSessionId || session.mount?.caps.rename) ? [{
                label: 'Rename / Move…',
                icon: getIcon('wrench'),
                onClick: () => setRenamingHash(chunk.hash),
            }] : []),
            {
                label: 'Copy',
                icon: getIcon('copy'),
                submenu: [
                    ...(chunk.path ? [
                        {
                            label: 'Path',
                            onClick: () => {
                                navigator.clipboard.writeText(chunk.path!);
                                showToast('success', 'Path copied to clipboard');
                            }
                        },
                        {
                            label: 'File Name',
                            onClick: () => {
                                navigator.clipboard.writeText(chunk.path!.split('/').pop() ?? chunk.path!);
                                showToast('success', 'File name copied to clipboard');
                            }
                        }
                    ] : []),
                    {
                        label: 'Hash',
                        onClick: () => {
                            navigator.clipboard.writeText(chunk.hash);
                            showToast('success', 'Hash copied to clipboard');
                        }
                    },
                    {
                        label: 'WAD Name',
                        onClick: () => {
                            navigator.clipboard.writeText(session.wadName);
                            showToast('success', 'WAD name copied to clipboard');
                        }
                    }
                ]
            }
        ];

        openContextMenu(e.clientX, e.clientY, options);
    }, [session, showToast, openContextMenu, setStatus]);

    const handleFolderContextMenu = useCallback((e: React.MouseEvent, node: WadTreeFolder) => {
        e.preventDefault();
        e.stopPropagation();

        if (!session) return;

        const options = [
            {
                label: 'Extract Folder...',
                icon: getIcon('export'),
                onClick: async () => {
                    try {
                        const dest = await open({ title: 'Choose Extraction Folder', directory: true });
                        if (!dest) return;
                        setStatus('working', 'Extracting...');
                        const hashes = getAllChunkHashes([node]);
                        const res = await api.extractWad(session.wadPath, dest as string, hashes);
                        showToast('success', `Extracted ${res.extracted} files`);
                    } catch {
                        showToast('error', 'Extraction failed');
                    } finally {
                        setStatus('ready', '');
                    }
                }
            },
            {
                label: 'Copy',
                icon: getIcon('copy'),
                submenu: [
                    {
                        label: 'Folder Path',
                        onClick: () => {
                            navigator.clipboard.writeText(node.fullPath);
                            showToast('success', 'Folder path copied to clipboard');
                        }
                    }
                ]
            }
        ];

        openContextMenu(e.clientX, e.clientY, options);
    }, [session, showToast, openContextMenu, setStatus]);

    if (!session) {
        return (
            <div className="left-panel" style={style}>
                <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '13px' }}>
                    No WAD file open.
                </div>
            </div>
        );
    }

    const totalChunks = session.chunks.length;
    const selectedCount = session.selectedHashes.size;

    // Recursive inline tree render (same row anatomy as WadExplorer): chevron →
    // checkbox → icon → name, indented by depth. Folders expand/collapse in
    // place; files preview on click and keep rename + context menus.
    const renderNode = (node: WadTreeNode, depth: number): React.ReactNode => {
        const indent = 8 + depth * 14;
        if (node.type === 'folder') {
            const isExpanded = expandedFolders.has(node.fullPath);
            const childHashes = getAllChunkHashes(node.children);
            const allSelected = childHashes.length > 0 && childHashes.every(h => session.selectedHashes.has(h));
            const someSelected = !allSelected && childHashes.some(h => session.selectedHashes.has(h));
            const folderState = allSelected ? 'all' : someSelected ? 'some' : 'none';
            return (
                <div key={node.fullPath}>
                    <div
                        className="file-tree__item"
                        style={{ paddingLeft: `${indent}px` }}
                        onClick={() => toggleFolder(node.fullPath)}
                        onContextMenu={(e) => handleFolderContextMenu(e, node)}
                    >
                        <span className="file-tree__chevron" dangerouslySetInnerHTML={{ __html: getIcon(isExpanded ? 'chevronDown' : 'chevronRight') }} />
                        <span
                            className="file-tree__checkbox"
                            style={{ cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}
                            dangerouslySetInnerHTML={{ __html: checkboxSvg(folderState) }}
                            onClick={(e) => { e.stopPropagation(); handleToggleFolderSelection(node); }}
                        />
                        <span className="file-tree__icon" dangerouslySetInnerHTML={{ __html: getIcon(isExpanded ? 'folderOpen' : 'folder') }} />
                        <span className="file-tree__name">{node.name}</span>
                    </div>
                    {isExpanded && node.children.map(c => renderNode(c, depth + 1))}
                </div>
            );
        }
        const chunk = node.chunk;
        const isSelected = session.selectedHashes.has(chunk.hash);
        const isPreviewing = session.previewHash === chunk.hash;
        return (
            <div
                key={chunk.hash}
                className={`file-tree__item${isPreviewing ? ' file-tree__item--selected' : ''}`}
                style={{ paddingLeft: `${indent + 16}px` }}
                onClick={() => onPreview(chunk.hash)}
                onContextMenu={(e) => handleContextMenu(e, chunk)}
            >
                <span
                    className="file-tree__checkbox"
                    style={{ cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}
                    dangerouslySetInnerHTML={{ __html: checkboxSvg(isSelected ? 'all' : 'none') }}
                    onClick={(e) => { e.stopPropagation(); onToggleChunk(chunk.hash); }}
                />
                <span className="file-tree__icon" dangerouslySetInnerHTML={{ __html: getFileIcon(node.name, false) }} />
                {renamingHash === chunk.hash ? (
                    <input
                        className="dl-input"
                        autoFocus
                        defaultValue={chunk.path ?? ''}
                        style={{ flex: 1, minWidth: 0, height: '20px', fontSize: '12px' }}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameCommit(chunk, (e.target as HTMLInputElement).value);
                            else if (e.key === 'Escape') setRenamingHash(null);
                        }}
                        onBlur={(e) => handleRenameCommit(chunk, e.target.value)}
                    />
                ) : (
                    <span className="file-tree__name" style={{ flex: 1, minWidth: 0 }}>{node.name}</span>
                )}
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0, paddingLeft: '8px' }}>
                    {formatSize(chunk.size)}
                </span>
            </div>
        );
    };

    return (
        <div className="left-panel" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', ...style }}>
            <div className="left-panel__header" style={{ padding: '10px 12px', flexShrink: 0 }}>
                <div className="file-tree__search" style={{ position: 'relative' }}>
                    <span
                        style={{ position: 'absolute', left: '6px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.5 }}
                        dangerouslySetInnerHTML={{ __html: getIcon('search') }}
                    />
                    <input
                        type="text"
                        className="file-tree__search-input"
                        placeholder="Filter files..."
                        value={session.searchQuery}
                        onChange={onSearchChange}
                        style={{ paddingLeft: '26px', width: '100%' }}
                    />
                </div>
            </div>

            {(unknownChunksCount > 0 || session.readOnly) && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 12px',
                    background: 'var(--bg-secondary)',
                    borderBottom: '1px solid color-mix(in oklab, var(--border) 60%, transparent)',
                    flexShrink: 0
                }}>
                    <span style={{ flex: 1, fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {session.wadName}
                    </span>
                    {unknownChunksCount > 0 && (
                        <button
                            className="btn btn--sm"
                            onClick={handleUnhashWad}
                            disabled={isUnhashing}
                            title={`Scan WAD's BIN/SKN files for asset paths to unhash ${unknownChunksCount} unresolved files`}
                            style={{
                                padding: '2px 6px',
                                fontSize: '10px',
                                height: '22px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                background: 'color-mix(in oklab, var(--accent-primary) 12%, transparent)',
                                border: '1px solid color-mix(in oklab, var(--accent-primary) 35%, transparent)',
                                color: 'var(--accent-primary)',
                                cursor: 'pointer',
                                borderRadius: '4px',
                                flexShrink: 0
                            }}
                        >
                            <span dangerouslySetInnerHTML={{ __html: getIcon('wrench') }} />
                            <span>{isUnhashing ? 'Unhashing...' : 'Unhash'}</span>
                        </button>
                    )}
                    {session.readOnly && (
                        <span
                            title="This is a game WAD archive. It is read-only and cannot be modified."
                            style={{ display: 'inline-flex', color: 'var(--error)', cursor: 'help', width: '14px', height: '14px', flexShrink: 0 }}
                            dangerouslySetInnerHTML={{ __html: getIcon('warning') }}
                        />
                    )}
                </div>
            )}

            <div className="file-tree" style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                {session.loading ? (
                    <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
                        <div className="spinner" style={{ margin: '0 auto 8px' }} />
                        <div style={{ fontSize: '12px' }}>Reading WAD...</div>
                    </div>
                ) : isSearching ? (
                    filteredChunks.length === 0 ? (
                        <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '12px' }}>
                            No files match your filter.
                        </div>
                    ) : (
                        filteredChunks.map(chunk => {
                            const isSelected = session.selectedHashes.has(chunk.hash);
                            const isPreviewing = session.previewHash === chunk.hash;
                            const displayName = chunk.path || chunk.hash;
                            return (
                                <div
                                    key={chunk.hash}
                                    className={`file-tree__item${isPreviewing ? ' file-tree__item--selected' : ''}`}
                                    style={{ paddingLeft: '24px' }}
                                    onClick={() => onPreview(chunk.hash)}
                                    onContextMenu={(e) => handleContextMenu(e, chunk)}
                                >
                                    <span
                                        className="file-tree__checkbox"
                                        style={{ cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}
                                        dangerouslySetInnerHTML={{ __html: checkboxSvg(isSelected ? 'all' : 'none') }}
                                        onClick={(e) => { e.stopPropagation(); onToggleChunk(chunk.hash); }}
                                    />
                                    <span className="file-tree__icon" dangerouslySetInnerHTML={{ __html: getFileIcon(chunk.path || '', false) }} />
                                    {renamingHash === chunk.hash ? (
                                        <input
                                            className="dl-input"
                                            autoFocus
                                            defaultValue={chunk.path ?? ''}
                                            style={{ flex: 1, minWidth: 0, height: '20px', fontSize: '12px' }}
                                            onClick={(e) => e.stopPropagation()}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') handleRenameCommit(chunk, (e.target as HTMLInputElement).value);
                                                else if (e.key === 'Escape') setRenamingHash(null);
                                            }}
                                            onBlur={(e) => handleRenameCommit(chunk, e.target.value)}
                                        />
                                    ) : (
                                        <span className="file-tree__name" style={{ flex: 1, minWidth: 0 }}>
                                            {displayName}
                                        </span>
                                    )}
                                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0, paddingLeft: '8px' }}>
                                        {formatSize(chunk.size)}
                                    </span>
                                </div>
                            );
                        })
                    )
                ) : nodes.length === 0 ? (
                    <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '12px' }}>
                        WAD folder is empty.
                    </div>
                ) : (
                    nodes.map(node => renderNode(node, 0))
                )}
            </div>

            <div
                style={{
                    flexShrink: 0,
                    borderTop: '1px solid var(--border)',
                    padding: '8px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    height: '44px',
                    boxSizing: 'border-box'
                }}
            >
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', flex: 1 }}>
                    {totalChunks.toLocaleString()} files{selectedCount > 0 ? ` · ${selectedCount} selected` : ''}
                </span>
                {session.editSessionId && session.isDirty && !session.id.startsWith('archive-') && (
                    <button
                        className="btn btn--primary btn--sm"
                        onClick={handleSaveWad}
                        disabled={isSavingWad}
                        style={{
                            background: 'var(--success, #28a745)',
                            borderColor: 'var(--success, #28a745)',
                            color: '#fff',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px'
                        }}
                        title="Save modified WAD changes to disk"
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('save') || '💾' }} />
                        <span>{isSavingWad ? 'Saving...' : 'Save WAD'}</span>
                    </button>
                )}
                <button
                    className="btn btn--primary btn--sm"
                    onClick={handleExtractSelected}
                    disabled={selectedCount === 0 || isExtracting}
                    title={selectedCount === 0 ? 'Select files to extract' : `Extract ${selectedCount} selected file${selectedCount !== 1 ? 's' : ''}`}
                >
                    <span dangerouslySetInnerHTML={{ __html: getIcon('export') }} />
                    <span>{isExtracting ? 'Extracting...' : `Extract${selectedCount > 0 ? ` (${selectedCount})` : ''}`}</span>
                </button>
            </div>
        </div>
    );
};
