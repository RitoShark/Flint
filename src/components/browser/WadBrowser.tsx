import React, { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { useAppMetadataStore, useModalStore, useNotificationStore, useWadExtractStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { open } from '@tauri-apps/plugin-dialog';
import { getIcon, getFileIcon } from '../../lib/ui-helpers/fileIcons';
import { checkboxSvg } from './wad-explorer/helpers';
import { UNKNOWN_DIR, type Vfs } from '../../lib/vfs/types';
import type { WadChunk } from '../../lib/types';

// =============================================================================
// Virtual Tree Types (used for traversing internal folders)
// =============================================================================

interface WadTreeFolder {
    type: 'folder';
    name: string;
    fullPath: string;
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

/**
 * Every chunk at or below a folder.
 *
 * Derived from the flat chunk list by path prefix rather than by walking tree
 * nodes: folders load lazily now, so an unexpanded folder has no children to
 * walk, and "select this folder" must still cover what it contains.
 */
function chunkHashesUnder(chunks: WadChunk[], folderPath: string): string[] {
    if (folderPath === UNKNOWN_DIR) {
        return chunks.filter(c => !c.path).map(c => c.hash);
    }
    const prefix = `${folderPath}/`;
    return chunks.filter(c => c.path?.startsWith(prefix)).map(c => c.hash);
}

/**
 * Look chunks up by whatever key the mount addresses them with.
 *
 * A WAD keys by chunk hash and a package by path, so the lookup has to follow
 * `keyedBy` — using the wrong one silently finds a different file rather than
 * failing (see the note on `Vfs.keyedBy`).
 */
function chunkLookup(chunks: WadChunk[], keyedBy: 'hash' | 'path'): Map<string, WadChunk> {
    const out = new Map<string, WadChunk>();
    for (const c of chunks) {
        const key = keyedBy === 'path' ? (c.path ?? c.hash) : c.hash;
        if (!out.has(key)) out.set(key, c);
    }
    return out;
}

/**
 * One level of the mount, as rows this panel can render.
 *
 * Deliberately NOT recursive: `Vfs.list` answers a single directory, and folders
 * fill in only once expanded. Building the whole tree up front is what made a
 * 40k-chunk WAD slow to open.
 */
async function listLevel(
    mount: Vfs,
    dir: string,
    byKey: Map<string, WadChunk>,
): Promise<WadTreeNode[]> {
    const out: WadTreeNode[] = [];
    for (const entry of await mount.list(dir)) {
        if (entry.isDirectory) {
            out.push({ type: 'folder', name: entry.name, fullPath: entry.path });
            continue;
        }
        // Every key came from a chunk, so a miss means two chunks collapsed onto
        // one key. Skip rather than render a row with no chunk behind it, which
        // would crash on click.
        const chunk = byKey.get(entry.key);
        if (chunk) out.push({ type: 'file', name: entry.name, chunk });
    }
    return out;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// =============================================================================
// WadBrowserPanel — main export
// =============================================================================

/**
 * `sessionId` pins the panel to one session. The archive editor embeds this
 * alongside its own session and must NOT follow the globally active one — that
 * is shared with the user's WAD viewer tabs, so without pinning, opening a WAD
 * elsewhere would swap this panel's contents out from under it.
 */
export const WadBrowserPanel: React.FC<{
    style?: React.CSSProperties;
    sessionId?: string;
    /**
     * A folder grid sits beside this tree (the standalone WAD viewer), so
     * clicking a folder navigates that grid. The archive editor has a preview
     * panel there instead and leaves this off.
     */
    withGrid?: boolean;
}> = ({ style, sessionId, withGrid = false }) => {
    const extractSessions = useWadExtractStore((s) => s.extractSessions);
    const activeExtractId = useWadExtractStore((s) => s.activeExtractId);
    const showToast = useNotificationStore((s) => s.showToast);
    const setStatus = useAppMetadataStore((s) => s.setStatus);
    const targetId = sessionId ?? activeExtractId;
    const session = extractSessions.find(s => s.id === targetId);

    const isSearching = !!session?.searchQuery?.trim();

    const openContextMenu = useModalStore((s) => s.openContextMenu);
    const [isExtracting, setIsExtracting] = useState(false);
    const [isUnhashing, setIsUnhashing] = useState(false);
    const [isSavingWad, setIsSavingWad] = useState(false);
    const [renamingHash, setRenamingHash] = useState<string | null>(null);
    // Inline expand/collapse tree state (mirrors WadExplorer's look): the set of
    // expanded folder paths. Local — search mode bypasses it entirely.
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
    // Directory listings fetched from the mount, keyed by directory path ('' is
    // the root). Populated on expand, so an unopened folder costs nothing.
    const [dirs, setDirs] = useState<Map<string, WadTreeNode[]>>(new Map());

    const mount = session?.mount;
    // Chunk rows come back from the mount keyed the way that mount addresses
    // them; a WAD by hash, a package by path.
    const byKey = useMemo(
        () => (session && mount ? chunkLookup(session.chunks, mount.keyedBy) : new Map<string, WadChunk>()),
        [session?.chunks, mount],
    );

    // Drop cached listings when the CONTENT changes, keyed by the chunk array
    // identity rather than the mount object. A WAD swaps its mount mid-session
    // (the read-only on-disk mount becomes a writable one once the edit session
    // opens, which happens moments after the chunks land); keying on the mount
    // would collapse every folder the user had opened at that moment.
    const chunks = session?.chunks;
    useEffect(() => {
        setDirs(new Map());
    }, [chunks]);

    // Identifies the chunk set a listing was requested against, so a listing
    // that resolves after the content changed can be discarded. Several folders
    // load concurrently, so "stale" means superseded content, not merely older.
    const loadTokenRef = useRef<object>({});
    useEffect(() => {
        loadTokenRef.current = {};
    }, [chunks]);

    // Expanding a folder records it here; an effect below does the fetching, so
    // no listing is kicked off from inside a state updater.
    const wantedDirs = useMemo(() => {
        const out = [''];
        for (const dir of expandedFolders) out.push(dir);
        return out;
    }, [expandedFolders]);

    useEffect(() => {
        if (!mount) return;
        const token = loadTokenRef.current;
        for (const dir of wantedDirs) {
            if (dirs.has(dir)) continue;
            listLevel(mount, dir, byKey)
                .then((nodes) => {
                    if (token !== loadTokenRef.current) return;
                    setDirs((prev) => {
                        if (prev.has(dir)) return prev;
                        const next = new Map(prev);
                        next.set(dir, nodes);
                        return next;
                    });
                })
                .catch((e) => console.error('[WadBrowser] Failed to list directory', dir, e));
        }
    }, [mount, byKey, wantedDirs, dirs]);

    const toggleFolder = useCallback((fullPath: string) => {
        setExpandedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(fullPath)) next.delete(fullPath);
            else next.add(fullPath);
            return next;
        });
        // Where a folder grid sits beside the tree, the clicked folder becomes
        // what the grid shows and any file preview is dropped so the grid is on
        // screen — selecting a folder in the project tree behaves the same way.
        // The archive editor has a preview panel there instead, so it opts out.
        if (session && withGrid) {
            useWadExtractStore.getState().setCurrentDir(session.id, fullPath);
            useWadExtractStore.getState().setPreview(session.id, null);
        }
    }, [session?.id, withGrid]);

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

    const nodes = dirs.get('') ?? [];

    // Search runs through the mount so its matching rules (a bare '.' stays
    // literal, a real metacharacter engages regex) are the same ones every
    // other browser surface uses, instead of a second substring test here.
    const [filteredChunks, setFilteredChunks] = useState<WadChunk[]>([]);
    const query = session?.searchQuery ?? '';
    useEffect(() => {
        if (!mount || !query.trim()) {
            setFilteredChunks([]);
            return;
        }
        const token = loadTokenRef.current;
        let cancelled = false;
        mount.search(query)
            .then((entries) => {
                if (cancelled || token !== loadTokenRef.current) return;
                const out: WadChunk[] = [];
                for (const e of entries) {
                    const chunk = byKey.get(e.key);
                    if (chunk) out.push(chunk);
                    if (out.length >= 500) break;
                }
                setFilteredChunks(out);
            })
            .catch((e) => console.error('[WadBrowser] Search failed:', e));
        return () => { cancelled = true; };
    }, [mount, query, byKey]);

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
        const hashes = chunkHashesUnder(session.chunks, node.fullPath);
        const allSelected = hashes.length > 0 && hashes.every(h => session.selectedHashes.has(h));
        
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
                        const hashes = chunkHashesUnder(session.chunks, node.fullPath);
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
            // From the chunk list, not the rendered children — a collapsed
            // folder has not been listed yet but still has contents to reflect.
            const childHashes = chunkHashesUnder(session.chunks, node.fullPath);
            const allSelected = childHashes.length > 0 && childHashes.every(h => session.selectedHashes.has(h));
            const someSelected = !allSelected && childHashes.some(h => session.selectedHashes.has(h));
            const folderState = allSelected ? 'all' : someSelected ? 'some' : 'none';
            const children = dirs.get(node.fullPath);
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
                    {isExpanded && (
                        children === undefined
                            // Listed on expand, so a deep folder shows feedback
                            // instead of looking like it opened onto nothing.
                            ? <div className="file-tree__item" style={{ paddingLeft: `${indent + 16}px`, color: 'var(--text-muted)', fontSize: '11px' }}>Loading…</div>
                            : children.map(c => renderNode(c, depth + 1))
                    )}
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
            {/* One compact header: filter, then the archive's own affordances.
                These used to be two stacked bands, which spent a whole row on a
                filename the tab already shows. */}
            <div className="wadb-header">
                <div className="wadb-search">
                    <span className="wadb-search__icon" dangerouslySetInnerHTML={{ __html: getIcon('search') }} />
                    <input
                        type="text"
                        className="wadb-search__input"
                        placeholder="Filter files…"
                        value={session.searchQuery}
                        onChange={onSearchChange}
                    />
                </div>
                {unknownChunksCount > 0 && (
                    <button
                        className="wadb-chip"
                        onClick={handleUnhashWad}
                        disabled={isUnhashing}
                        title={`Scan this archive's BIN/SKN files for asset paths to unhash ${unknownChunksCount} unresolved file${unknownChunksCount === 1 ? '' : 's'}`}
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('wrench') }} />
                        <span>{isUnhashing ? 'Unhashing…' : `Unhash ${unknownChunksCount.toLocaleString()}`}</span>
                    </button>
                )}
                {session.readOnly && (
                    <span
                        className="wadb-chip wadb-chip--readonly"
                        title="This is a game WAD archive. It is read-only and cannot be modified."
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('warning') }} />
                        <span>Read-only</span>
                    </span>
                )}
            </div>

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
                ) : !dirs.has('') ? (
                    // The root listing is still in flight — distinct from a root
                    // that came back empty, which would otherwise flash "empty"
                    // every time an archive opens.
                    <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '12px' }}>
                        Reading contents…
                    </div>
                ) : nodes.length === 0 ? (
                    <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '12px' }}>
                        This archive is empty.
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
                {session.editSessionId && session.isDirty && !session.embedded && (
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
