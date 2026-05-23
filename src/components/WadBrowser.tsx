/**
 * Flint - WAD Browser Panel
 * Redesigned flat list sidebar for browsing WAD files with breadcrumbs,
 * double-click folder navigation, search, and context menu actions.
 */

import React, { useMemo, useCallback, useState } from 'react';
import { useAppState, useModalStore, useWadExtractStore } from '../lib/stores';
import * as api from '../lib/api';
import { open } from '@tauri-apps/plugin-dialog';
import { getIcon, getFileIcon } from '../lib/fileIcons';
import type { WadChunk } from '../lib/types';

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

    // Unresolved hashes → grouped at the bottom
    const unresolved = filtered.filter(c => !c.path);
    if (unresolved.length > 0) {
        rootNodes.push({
            type: 'folder',
            name: '[Unknown Hashes]',
            fullPath: '[Unknown Hashes]',
            children: unresolved.map(c => ({ type: 'file' as const, name: c.hash, chunk: c })),
        });
    }

    // Sort: folders first, then alphabetically
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

function getNodesAtDir(roots: WadTreeNode[], dirPath: string): WadTreeNode[] {
    if (!dirPath) return roots;
    const parts = dirPath.split('/').filter(Boolean);
    let currentNodes = roots;
    for (const part of parts) {
        const found = currentNodes.find(n => n.type === 'folder' && n.name === part) as WadTreeFolder | undefined;
        if (!found) return [];
        currentNodes = found.children;
    }
    return currentNodes;
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
    const { state, dispatch, showToast } = useAppState();
    const session = state.extractSessions.find(s => s.id === state.activeExtractId);

    const setCurrentDir = useWadExtractStore((s) => s.setCurrentDir);
    const navigateHistory = useWadExtractStore((s) => s.navigateHistory);

    const currentDir = session?.currentDir ?? '';
    const history = session?.history ?? [''];
    const historyIndex = session?.historyIndex ?? 0;

    const isSearching = !!session?.searchQuery?.trim();

    const openContextMenu = useModalStore((s) => s.openContextMenu);
    const [isExtracting, setIsExtracting] = useState(false);
    const [isUnhashing, setIsUnhashing] = useState(false);
    const [isSavingWad, setIsSavingWad] = useState(false);

    const unknownChunksCount = useMemo(() => {
        if (!session) return 0;
        return session.chunks.filter(c => !c.path).length;
    }, [session?.chunks]);

    const handleUnhashWad = useCallback(async () => {
        if (!session) return;
        try {
            setIsUnhashing(true);
            dispatch({ type: 'SET_STATUS', payload: { status: 'working', message: 'Scanning WAD for asset paths...' } });

            // 1. Run the hash scanner
            const result = await api.extractHashesFromWad(session.wadPath);
            const totalAdded = result.game_hashes_added + result.bin_hashes_added;

            // 2. Refresh chunks and update store
            const refreshedChunks = await api.getWadChunks(session.wadPath);
            dispatch({ type: 'SET_EXTRACT_CHUNKS', payload: { sessionId: session.id, chunks: refreshedChunks } });

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
            dispatch({ type: 'SET_STATUS', payload: { status: 'ready', message: '' } });
        }
    }, [session, dispatch, showToast]);

    const handleSaveWad = useCallback(async () => {
        if (!session || !session.editSessionId) return;
        try {
            setIsSavingWad(true);
            dispatch({ type: 'SET_STATUS', payload: { status: 'working', message: 'Saving WAD...' } });
            
            await api.saveWadEditSession(session.editSessionId, session.wadPath);
            dispatch({
                type: 'SET_EXTRACT_SESSION_DIRTY',
                payload: { sessionId: session.id, isDirty: false }
            });
            showToast('success', 'WAD saved successfully!');
        } catch (err) {
            console.error('[WadBrowser] Save WAD failed:', err);
            showToast('error', `Failed to save WAD: ${(err as Error).message || err}`);
        } finally {
            setIsSavingWad(false);
            dispatch({ type: 'SET_STATUS', payload: { status: 'ready', message: '' } });
        }
    }, [session, dispatch, showToast]);

    // Directory contents at active path
    const nodes = useMemo(() => {
        if (!session) return [];
        const roots = buildWadTree(session.chunks, ''); // build base tree of all chunks
        return getNodesAtDir(roots, currentDir);
    }, [session?.chunks, currentDir]);

    // Flat search results
    const filteredChunks = useMemo(() => {
        if (!session) return [];
        const q = session.searchQuery.toLowerCase().trim();
        const results = [];
        for (const c of session.chunks) {
            if ((c.path?.toLowerCase().includes(q)) || (!c.path && c.hash.toLowerCase().includes(q))) {
                results.push(c);
                if (results.length >= 500) break; // Limit to 500 results for fluid UI performance
            }
        }
        return results;
    }, [session?.chunks, session?.searchQuery]);

    const onPreview = useCallback((hash: string) => {
        if (!session) return;
        dispatch({ type: 'SET_EXTRACT_PREVIEW', payload: { sessionId: session.id, hash } });
    }, [dispatch, session?.id]);

    const onToggleChunk = useCallback((hash: string) => {
        if (!session) return;
        dispatch({ type: 'TOGGLE_EXTRACT_CHUNK', payload: { sessionId: session.id, hash } });
    }, [dispatch, session?.id]);

    // Toggles selection for all chunks under a tree node recursively
    const handleToggleFolderSelection = useCallback((node: WadTreeFolder) => {
        if (!session) return;
        const hashes = getAllChunkHashes([node]);
        const allSelected = hashes.every(h => session.selectedHashes.has(h));
        
        for (const hash of hashes) {
            const isCurrentlySelected = session.selectedHashes.has(hash);
            if (allSelected && isCurrentlySelected) {
                dispatch({ type: 'TOGGLE_EXTRACT_CHUNK', payload: { sessionId: session.id, hash } });
            } else if (!allSelected && !isCurrentlySelected) {
                dispatch({ type: 'TOGGLE_EXTRACT_CHUNK', payload: { sessionId: session.id, hash } });
            }
        }
    }, [dispatch, session]);

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
        dispatch({ type: 'SET_EXTRACT_SEARCH', payload: { sessionId: session.id, query: e.target.value } });
    }, [dispatch, session?.id]);

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
                        dispatch({ type: 'SET_STATUS', payload: { status: 'working', message: 'Extracting...' } });
                        const res = await api.extractWad(session.wadPath, dest as string, [chunk.hash]);
                        showToast('success', `Extracted ${res.extracted} file`);
                    } catch {
                        showToast('error', 'Extraction failed');
                    } finally {
                        dispatch({ type: 'SET_STATUS', payload: { status: 'ready', message: '' } });
                    }
                }
            },
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
    }, [session, dispatch, showToast, openContextMenu]);

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
                        dispatch({ type: 'SET_STATUS', payload: { status: 'working', message: 'Extracting...' } });
                        const hashes = getAllChunkHashes([node]);
                        const res = await api.extractWad(session.wadPath, dest as string, hashes);
                        showToast('success', `Extracted ${res.extracted} files`);
                    } catch {
                        showToast('error', 'Extraction failed');
                    } finally {
                        dispatch({ type: 'SET_STATUS', payload: { status: 'ready', message: '' } });
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
    }, [session, dispatch, showToast, openContextMenu]);

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

    return (
        <div className="left-panel" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', ...style }}>
            {/* Header */}
            <div className="left-panel__header" style={{ padding: '10px 12px', flexShrink: 0 }}>
                {/* Search */}
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

            {/* Breadcrumbs Row (Folder traversal inside WAD) */}
            {!isSearching && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '6px 12px',
                    background: 'var(--bg-secondary)',
                    borderBottom: '1px solid color-mix(in oklab, var(--border) 60%, transparent)',
                    flexShrink: 0
                }}>
                    <button
                        className="btn btn--sm"
                        disabled={historyIndex <= 0}
                        onClick={() => {
                            if (session) navigateHistory(session.id, 'back');
                        }}
                        title="Back"
                        style={{ padding: '2px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 'unset', height: '22px' }}
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('chevronLeft') || '←' }} />
                    </button>
                    <button
                        className="btn btn--sm"
                        disabled={historyIndex >= history.length - 1}
                        onClick={() => {
                            if (session) navigateHistory(session.id, 'forward');
                        }}
                        title="Forward"
                        style={{ padding: '2px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 'unset', height: '22px' }}
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('chevronRight') || '→' }} />
                    </button>
                    <button
                        className="btn btn--sm"
                        disabled={!currentDir}
                        onClick={() => {
                            if (session) navigateHistory(session.id, 'up');
                        }}
                        title="Up one folder"
                        style={{ padding: '2px 4px', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 'unset', height: '22px' }}
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('chevronUp') || '↑' }} />
                    </button>
                    <div style={{ width: '1px', height: '14px', background: 'var(--border)', margin: '0 2px' }} />
                    <div className="welcome-breadcrumb" style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        fontSize: '11px',
                        color: 'var(--text-muted)',
                        overflowX: 'auto',
                        whiteSpace: 'nowrap',
                        flex: 1,
                        scrollbarWidth: 'none'
                    }}>
                        <button
                            type="button"
                            onClick={() => {
                                if (session) setCurrentDir(session.id, '');
                            }}
                            style={{ background: 'transparent', border: 'none', padding: '2px 4px', borderRadius: '4px', fontSize: '11px', color: currentDir ? 'var(--text-secondary)' : 'var(--text-primary)', fontWeight: currentDir ? 'normal' : '600', cursor: 'pointer', fontFamily: 'inherit' }}
                        >
                            {session.wadName}
                        </button>
                        {currentDir.split('/').filter(Boolean).map((part, idx, arr) => {
                            const subPath = arr.slice(0, idx + 1).join('/');
                            const isLast = idx === arr.length - 1;
                            return (
                                <React.Fragment key={subPath}>
                                    <span style={{ opacity: 0.5 }}>/</span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (session && !isLast) {
                                                setCurrentDir(session.id, subPath);
                                            }
                                        }}
                                        style={{ background: 'transparent', border: 'none', padding: '2px 4px', borderRadius: '4px', fontSize: '11px', color: isLast ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: isLast ? '600' : 'normal', cursor: isLast ? 'default' : 'pointer', fontFamily: 'inherit' }}
                                        disabled={isLast}
                                    >
                                        {part}
                                    </button>
                                </React.Fragment>
                            );
                        })}
                    </div>
                    {/* Unhash and read-only indicators */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        flexShrink: 0,
                        marginLeft: '8px'
                    }}>
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
                </div>
            )}

            {/* Table Column Headers */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                padding: '6px 12px 6px 52px',
                borderBottom: '1px solid color-mix(in oklab, var(--border) 60%, transparent)',
                fontSize: '10px',
                fontWeight: 600,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                background: 'var(--bg-secondary)',
                flexShrink: 0
            }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Name</span>
                <span style={{ width: '60px', flexShrink: 0, paddingLeft: '8px' }}>Type</span>
                <span style={{ width: '65px', flexShrink: 0, textAlign: 'right' }}>Size</span>
            </div>

            {/* Flat Directory List */}
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
                            const ext = displayName.split('.').pop()?.toUpperCase() || 'FILE';
                            return (
                                <div
                                    key={chunk.hash}
                                    className={`file-tree__item ${isPreviewing ? 'file-tree__item--selected' : ''}`}
                                    style={{ paddingLeft: '8px', display: 'flex', alignItems: 'center', height: '28px', cursor: 'pointer' }}
                                    onClick={() => onPreview(chunk.hash)}
                                    onContextMenu={(e) => handleContextMenu(e, chunk)}
                                    title={displayName}
                                >
                                    <input
                                        type="checkbox"
                                        className="wad-browser__checkbox"
                                        checked={isSelected}
                                        onChange={() => onToggleChunk(chunk.hash)}
                                        onClick={e => e.stopPropagation()}
                                        style={{ marginRight: '6px' }}
                                    />
                                    <span
                                        className="file-tree__icon"
                                        style={{ marginRight: '6px', display: 'inline-flex', alignItems: 'center' }}
                                        dangerouslySetInnerHTML={{ __html: getFileIcon(chunk.path || '', false) }}
                                    />
                                    <span className="file-tree__name" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: '12px' }}>
                                        {displayName}
                                    </span>
                                    <span style={{ width: '60px', fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0, paddingLeft: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {ext}
                                    </span>
                                    <span style={{ width: '65px', fontSize: '10px', color: 'var(--text-muted)', textAlign: 'right', paddingRight: '6px', flexShrink: 0 }}>
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
                    nodes.map(node => {
                        if (node.type === 'folder') {
                            const childHashes = getAllChunkHashes(node.children);
                            const allSelected = childHashes.length > 0 && childHashes.every(h => session.selectedHashes.has(h));
                            const someSelected = !allSelected && childHashes.some(h => session.selectedHashes.has(h));

                            return (
                                <div
                                    key={node.fullPath}
                                    className="file-tree__item"
                                    style={{ paddingLeft: '8px', display: 'flex', alignItems: 'center', height: '28px', cursor: 'pointer' }}
                                    onClick={() => {}}
                                    onDoubleClick={() => {
                                        if (session) setCurrentDir(session.id, node.fullPath);
                                    }}
                                    onContextMenu={(e) => handleFolderContextMenu(e, node)}
                                    title={node.fullPath}
                                >
                                    <input
                                        type="checkbox"
                                        className="wad-browser__checkbox"
                                        checked={allSelected}
                                        ref={el => { if (el) el.indeterminate = someSelected; }}
                                        onChange={() => handleToggleFolderSelection(node)}
                                        onClick={e => e.stopPropagation()}
                                        style={{ marginRight: '6px' }}
                                    />
                                    <span
                                        className="file-tree__icon"
                                        style={{ marginRight: '6px', display: 'inline-flex', alignItems: 'center', color: 'var(--accent-primary)' }}
                                        dangerouslySetInnerHTML={{ __html: getIcon('folder') }}
                                    />
                                    <span className="file-tree__name" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: '500', paddingRight: '12px' }}>
                                        {node.name}
                                    </span>
                                    <span style={{ width: '60px', fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0, paddingLeft: '8px', textTransform: 'capitalize' }}>
                                        Folder
                                    </span>
                                    <span style={{ width: '65px', fontSize: '10.5px', color: 'var(--text-muted)', textAlign: 'right', paddingRight: '6px', flexShrink: 0 }}>
                                        {childHashes.length} files
                                    </span>
                                </div>
                            );
                        } else {
                            const isSelected = session.selectedHashes.has(node.chunk.hash);
                            const isPreviewing = session.previewHash === node.chunk.hash;
                            const ext = node.name.split('.').pop()?.toUpperCase() || 'FILE';

                            return (
                                <div
                                    key={node.chunk.hash}
                                    className={`file-tree__item ${isPreviewing ? 'file-tree__item--selected' : ''}`}
                                    style={{ paddingLeft: '8px', display: 'flex', alignItems: 'center', height: '28px', cursor: 'pointer' }}
                                    onClick={() => onPreview(node.chunk.hash)}
                                    onContextMenu={(e) => handleContextMenu(e, node.chunk)}
                                    title={node.chunk.path || node.chunk.hash}
                                >
                                    <input
                                        type="checkbox"
                                        className="wad-browser__checkbox"
                                        checked={isSelected}
                                        onChange={() => onToggleChunk(node.chunk.hash)}
                                        onClick={e => e.stopPropagation()}
                                        style={{ marginRight: '6px' }}
                                    />
                                    <span
                                        className="file-tree__icon"
                                        style={{ marginRight: '6px', display: 'inline-flex', alignItems: 'center' }}
                                        dangerouslySetInnerHTML={{ __html: getFileIcon(node.name, false) }}
                                    />
                                    <span className="file-tree__name" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: '12px' }}>
                                        {node.name}
                                    </span>
                                    <span style={{ width: '60px', fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0, paddingLeft: '8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {ext}
                                    </span>
                                    <span style={{ width: '65px', fontSize: '10px', color: 'var(--text-muted)', textAlign: 'right', paddingRight: '6px', flexShrink: 0 }}>
                                        {formatSize(node.chunk.size)}
                                    </span>
                                </div>
                            );
                        }
                    })
                )}
            </div>

            {/* Footer */}
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
                {session.editSessionId && session.isDirty && (
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
