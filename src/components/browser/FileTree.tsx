/**
 * Flint - File Tree Component
 *
 * The tree is flattened into a row array during render and only the visible
 * window is mounted. `TreeRow` is a pure leaf renderer with no store
 * subscriptions — all handlers come from the parent as stable callbacks.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect, CSSProperties } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useAppMetadataStore, useProjectTabStore, useModalStore, useNotificationStore, useConfigStore, useNavigationStore } from '../../lib/stores';
import { getFileIcon, getExpanderIcon, getIcon } from '../../lib/ui-helpers/fileIcons';
import { VirtualizedList } from './wad-explorer/VirtualizedList';
import * as api from '../../lib/api';
import { buildFileContextMenuOptions } from '../../lib/editor/fileContextMenuOptions';
import type { FileTreeNode, ProjectTab } from '../../lib/types';

const ROW_HEIGHT = 22;
const ROW_OVERSCAN = 8;

const BIN_TEXT_EXTS = ['.bin', '.ritobin', '.py', '.troybin'];
const LUA_BIN_EXTS = ['.luabin', '.luabin64'];

function getActiveTab(activeTabId: string | null, openTabs: ProjectTab[]): ProjectTab | null {
    if (!activeTabId) return null;
    return openTabs.find(t => t.id === activeTabId) || null;
}

interface LeftPanelProps {
    style?: CSSProperties;
}

export const LeftPanel: React.FC<LeftPanelProps> = ({ style }) => {
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const showToast = useNotificationStore((s) => s.showToast);
    const [searchQuery, setSearchQuery] = useState('');

    const activeTab = getActiveTab(activeTabId, openTabs);
    if (!activeTab) return null;

    const isMapProject = activeTab.project.kind === 'map';
    const projectPath = activeTab.projectPath;

    return (
        <aside className="left-panel" id="left-panel" style={style}>
            {isMapProject && (
                <button
                    className="btn btn--sm"
                    style={{ margin: '8px 8px 0', width: 'calc(100% - 16px)', justifyContent: 'center' }}
                    title="Open a 3D preview of this map in a separate window"
                    onClick={async () => {
                        try {
                            await api.openMapPreviewWindow(projectPath);
                        } catch (err) {
                            const msg = (err as Error).message || String(err);
                            console.error('[LeftPanel] open map preview failed:', msg);
                            showToast('error', `Failed to open map preview: ${msg}`);
                        }
                    }}
                >
                    <span dangerouslySetInnerHTML={{ __html: getIcon('image') }} />
                    <span>Preview Map</span>
                </button>
            )}
            <div className="search-box">
                <input
                    type="text"
                    className="search-box__input"
                    placeholder="Filter files..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                />
            </div>
            <FileTree searchQuery={searchQuery} />
        </aside>
    );
};

interface FileTreeProps {
    searchQuery: string;
}

interface TreeRowData {
    /** Underlying node after compact-folder merging. */
    node: FileTreeNode;
    /** Displayed path; for compacted folders this includes the merged segments. */
    displayPath: string;
    depth: number;
    isExpanded: boolean;
    /** When set, the row should render as the inline-rename input. */
    isRenaming: boolean;
    /** Status badge state, if any. */
    status?: 'new' | 'modified';
}

/** Compact single-child directory chains into one row label. */
function compactNode(node: FileTreeNode): { displayPath: string; effectiveNode: FileTreeNode } {
    let current = node;
    const parts = [current.name];
    while (
        current.isDirectory &&
        current.children?.length === 1 &&
        current.children[0].isDirectory
    ) {
        current = current.children[0];
        parts.push(current.name);
    }
    return { displayPath: parts.join('/'), effectiveNode: current };
}

function collectAllFolderPaths(node: FileTreeNode): string[] {
    if (!node.isDirectory) return [];
    const result = [node.path];
    for (const child of node.children ?? []) {
        result.push(...collectAllFolderPaths(child));
    }
    return result;
}

function getFileName(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
}

function filterTreeByQuery(node: FileTreeNode, query: string): FileTreeNode | null {
    if (node.name.toLowerCase().includes(query)) {
        return node;
    }

    if (node.isDirectory && node.children) {
        const filteredChildren = node.children
            .map((child) => filterTreeByQuery(child, query))
            .filter((child): child is FileTreeNode => child !== null);

        if (filteredChildren.length > 0) {
            return { ...node, children: filteredChildren };
        }
    }

    return null;
}

/**
 * Walk the tree in display order, applying compact-folder merging + expanded
 * filter, and emit one `TreeRowData` per visible row. Iterative to avoid stack
 * pressure on deep trees.
 */
function flattenTree(
    root: FileTreeNode,
    expandedFolders: Set<string>,
    renamingPath: string | null,
    statusByRelPath: Map<string, 'new' | 'modified'>,
): TreeRowData[] {
    const rows: TreeRowData[] = [];
    // Stack frames: (node, depth). DFS, children pushed in reverse so the
    // first child is processed first.
    const stack: Array<{ node: FileTreeNode; depth: number }> = [
        { node: root, depth: 0 },
    ];

    while (stack.length > 0) {
        const { node, depth } = stack.pop()!;
        const { displayPath, effectiveNode } = node.isDirectory
            ? compactNode(node)
            : { displayPath: node.name, effectiveNode: node };

        const isExpanded = expandedFolders.has(effectiveNode.path);
        rows.push({
            node: effectiveNode,
            displayPath,
            depth,
            isExpanded,
            isRenaming: renamingPath === effectiveNode.path,
            status: statusByRelPath.get(effectiveNode.path),
        });

        if (effectiveNode.isDirectory && isExpanded && effectiveNode.children) {
            // Reverse-push so children render in their natural order.
            for (let i = effectiveNode.children.length - 1; i >= 0; i--) {
                stack.push({ node: effectiveNode.children[i], depth: depth + 1 });
            }
        }
    }

    return rows;
}

const FileTree: React.FC<FileTreeProps> = ({ searchQuery }) => {
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const toggleFolder = useProjectTabStore((s) => s.toggleFolder);
    const setFileTree = useProjectTabStore((s) => s.setFileTree);
    const setSelectedFile = useProjectTabStore((s) => s.setSelectedFile);
    const bulkSetFolders = useProjectTabStore((s) => s.bulkSetFolders);
    const showToast = useNotificationStore((s) => s.showToast);
    const openModal = useModalStore((s) => s.openModal);
    const openContextMenu = useModalStore((s) => s.openContextMenu);
    const openConfirmDialog = useModalStore((s) => s.openConfirmDialog);
    const leaguePath = useConfigStore((s) => s.leaguePath);

    const activeTab = getActiveTab(activeTabId, openTabs);
    const fileTree = activeTab?.fileTree || null;
    const selectedFile = activeTab?.selectedFile || null;
    const expandedFolders = activeTab?.expandedFolders || new Set<string>();

    const fileTreeVersion = useAppMetadataStore((s) => s.fileTreeVersion);
    useEffect(() => {
        if (!activeTab || fileTreeVersion === 0) return;
        api.listProjectFiles(activeTab.projectPath).then((files) => {
            setFileTree(activeTab.id, files);
        }).catch(() => {});
    }, [fileTreeVersion]); // eslint-disable-line react-hooks/exhaustive-deps

    // One subscription on the file-status revision counter. Read the Map
    // snapshot once and pass it as a prop into the row data.
    const fileStatusesRev = useAppMetadataStore((s) => s.fileStatusesRev);
    const projectPathForStatus = activeTab?.projectPath || '';
    const statusByRelPath = useMemo(() => {
        const map = new Map<string, 'new' | 'modified'>();
        if (!projectPathForStatus) return map;
        const prefix = `${projectPathForStatus.replaceAll('\\', '/')}/`;
        const store = useAppMetadataStore.getState();
        for (const fullKey of store.getFileStatusKeys()) {
            if (!fullKey.startsWith(prefix)) continue;
            const status = store.getFileStatus(fullKey);
            if (status) map.set(fullKey.slice(prefix.length), status);
        }
        return map;
    }, [fileStatusesRev, projectPathForStatus]);

    const [renamingPath, setRenamingPath] = useState<string | null>(null);
    const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

    // Fresh refs so the long-lived OS drag listener always sees current state.
    const activeTabRef = useRef(activeTab);
    useEffect(() => { activeTabRef.current = activeTab; });
    const setFileTreeRef = useRef(setFileTree);
    useEffect(() => { setFileTreeRef.current = setFileTree; });
    const showToastRef = useRef(showToast);
    useEffect(() => { showToastRef.current = showToast; });
    const bulkSetFoldersRef = useRef(bulkSetFolders);
    useEffect(() => { bulkSetFoldersRef.current = bulkSetFolders; });

    useEffect(() => {
        let unlisten: (() => void) | null = null;
        let expandTimer: number | null = null;
        let lastHover: string | null = null;
        let cancelled = false;

        const hitTest = (x: number, y: number): string | null => {
            const el = document.elementFromPoint(x, y) as HTMLElement | null;
            const folderEl = el?.closest('[data-drop-path]') as HTMLElement | null;
            return folderEl?.getAttribute('data-drop-path') ?? null;
        };

        // The webview drag-drop event reports physical pixel coordinates;
        // the DOM uses CSS pixels.
        const cssCoords = (pos: { x: number; y: number }) => ({
            x: pos.x / window.devicePixelRatio,
            y: pos.y / window.devicePixelRatio,
        });

        getCurrentWebview()
            .onDragDropEvent((event) => {
                if (cancelled) return;
                const { type } = event.payload as { type: string };

                if (type === 'over') {
                    const { x, y } = cssCoords((event.payload as any).position);
                    const path = hitTest(x, y);
                    if (path !== lastHover) {
                        if (expandTimer !== null) { clearTimeout(expandTimer); expandTimer = null; }
                        lastHover = path;
                        setDropTargetPath(path);
                        if (path) {
                            const target = path;
                            expandTimer = window.setTimeout(() => {
                                const tab = activeTabRef.current;
                                if (tab) bulkSetFoldersRef.current(tab.id, [target], true);
                                expandTimer = null;
                            }, 1200);
                        }
                    }
                } else if (type === 'drop') {
                    const payload = event.payload as { position: { x: number; y: number }; paths: string[] };
                    const { x, y } = cssCoords(payload.position);
                    const target = hitTest(x, y) ?? lastHover;
                    if (expandTimer !== null) { clearTimeout(expandTimer); expandTimer = null; }
                    lastHover = null;
                    setDropTargetPath(null);

                    const tab = activeTabRef.current;
                    if (!tab || !target || !payload.paths?.length) return;

                    (async () => {
                        try {
                            const created = await api.importExternalFiles(tab.projectPath, target, payload.paths);
                            const files = await api.listProjectFiles(tab.projectPath);
                            setFileTreeRef.current(tab.id, files);
                            showToastRef.current('success', `Imported ${created.length} item${created.length === 1 ? '' : 's'}`);
                        } catch (err) {
                            const fe = err as api.FlintError;
                            showToastRef.current('error', fe.getUserMessage?.() || 'Failed to import');
                        }
                    })();
                } else {
                    if (expandTimer !== null) { clearTimeout(expandTimer); expandTimer = null; }
                    lastHover = null;
                    setDropTargetPath(null);
                }
            })
            .then((fn) => {
                if (cancelled) fn();
                else unlisten = fn;
            })
            .catch(() => {});

        return () => {
            cancelled = true;
            if (expandTimer !== null) clearTimeout(expandTimer);
            if (unlisten) unlisten();
        };
    }, []);

    const filteredTree = useMemo(() => {
        if (!fileTree || !searchQuery) return fileTree;
        return filterTreeByQuery(fileTree, searchQuery.toLowerCase());
    }, [fileTree, searchQuery]);

    const rows = useMemo(() => {
        if (!filteredTree) return [];
        return flattenTree(filteredTree, expandedFolders, renamingPath, statusByRelPath);
    }, [filteredTree, expandedFolders, renamingPath, statusByRelPath]);

    const projectPath = activeTab?.projectPath || '';

    const refreshFileTree = useCallback(async () => {
        if (!activeTab) return;
        const files = await api.listProjectFiles(activeTab.projectPath);
        setFileTree(activeTab.id, files);
    }, [activeTab, setFileTree]);

    const handleItemClick = useCallback((path: string) => {
        if (!activeTab) return;
        setSelectedFile(activeTab.id, path);
        useNavigationStore.getState().setView('preview');
    }, [activeTab, setSelectedFile]);

    const handleExpanderClick = useCallback((path: string) => {
        if (activeTab) toggleFolder(activeTab.id, path);
    }, [activeTab, toggleFolder]);

    const handleDeepToggle = useCallback((node: FileTreeNode, expand: boolean) => {
        if (!activeTab) return;
        bulkSetFolders(activeTab.id, collectAllFolderPaths(node), expand);
    }, [activeTab, bulkSetFolders]);

    const handleDoubleClick = useCallback((node: FileTreeNode) => {
        if (node.isDirectory) return;
        const path = node.path;
        const lower = path.toLowerCase();
        const fullFilePath = `${projectPath}/${path}`;
        const nav = useNavigationStore.getState();

        if (node.name === 'mod.config.json') {
            nav.navigateToFileEditor({ filePath: fullFilePath, kind: 'modConfig', projectPath });
        } else if (BIN_TEXT_EXTS.some(ext => lower.endsWith(ext))) {
            nav.navigateToFileEditor({ filePath: fullFilePath, kind: 'binText', projectPath });
        } else if (LUA_BIN_EXTS.some(ext => lower.endsWith(ext))) {
            nav.navigateToFileEditor({ filePath: fullFilePath, kind: 'luaBin64', projectPath });
        } else if (lower.endsWith('.json') || lower.endsWith('.txt') || lower.endsWith('.lua') || lower.endsWith('.py')) {
            nav.navigateToFileEditor({ filePath: fullFilePath, kind: 'raw', projectPath });
        }
    }, [projectPath]);

    const handleRenameSubmit = useCallback(async (path: string, newName: string) => {
        setRenamingPath(null);
        const currentName = getFileName(path);
        if (!newName || newName === currentName) return;
        try {
            const result = await api.renameFile(projectPath, path, newName);
            await refreshFileTree();
            if (result.bin_updates > 0) {
                showToast('success', `Renamed and updated ${result.bin_updates} BIN file${result.bin_updates > 1 ? 's' : ''}`);
            } else {
                showToast('success', 'File renamed');
            }
        } catch (err) {
            const flintError = err as api.FlintError;
            showToast('error', flintError.getUserMessage?.() || 'Failed to rename');
        }
    }, [projectPath, refreshFileTree, showToast]);

    const handleContextMenu = useCallback((
        e: React.MouseEvent,
        node: FileTreeNode,
        depth: number,
    ) => {
        e.preventDefault();
        e.stopPropagation();
        const options = buildFileContextMenuOptions({
            node: { path: node.path, name: getFileName(node.path), isDirectory: node.isDirectory },
            projectPath,
            depth,
            refreshFileTree,
            openModal,
            openConfirmDialog,
            showToast,
            onRename: (path) => setRenamingPath(path),
            leaguePath,
        });
        openContextMenu(e.clientX, e.clientY, options);
    }, [projectPath, refreshFileTree, openModal, openConfirmDialog, showToast, leaguePath, openContextMenu]);

    if (!filteredTree) {
        return (
            <div className="file-tree">
                <div className="file-tree__empty">No project files loaded</div>
            </div>
        );
    }

    // renderEpoch bumps whenever the rows array identity changes (selection,
    // expand, rename, drop target, file status).
    const renderEpoch = rows.length + (selectedFile?.length ?? 0) + (dropTargetPath?.length ?? 0);

    return (
        <div className="file-tree">
            <VirtualizedList
                totalRows={rows.length}
                rowHeight={ROW_HEIGHT}
                overscan={ROW_OVERSCAN}
                renderEpoch={renderEpoch}
                renderRow={(index) => {
                    const row = rows[index];
                    if (!row) return null;
                    return (
                        <TreeRow
                            row={row}
                            isSelected={selectedFile === row.node.path}
                            isDropTarget={dropTargetPath === row.node.path}
                            onItemClick={handleItemClick}
                            onExpanderClick={handleExpanderClick}
                            onDeepToggle={handleDeepToggle}
                            onDoubleClick={handleDoubleClick}
                            onRenameSubmit={handleRenameSubmit}
                            onRenameCancel={() => setRenamingPath(null)}
                            onContextMenu={handleContextMenu}
                        />
                    );
                }}
            />
        </div>
    );
};

interface TreeRowProps {
    row: TreeRowData;
    isSelected: boolean;
    isDropTarget: boolean;
    onItemClick: (path: string) => void;
    onExpanderClick: (path: string) => void;
    onDeepToggle: (node: FileTreeNode, expand: boolean) => void;
    onDoubleClick: (node: FileTreeNode) => void;
    onRenameSubmit: (path: string, newName: string) => void;
    onRenameCancel: () => void;
    onContextMenu: (e: React.MouseEvent, node: FileTreeNode, depth: number) => void;
}

const TreeRow: React.FC<TreeRowProps> = React.memo(({
    row,
    isSelected,
    isDropTarget,
    onItemClick,
    onExpanderClick,
    onDeepToggle,
    onDoubleClick,
    onRenameSubmit,
    onRenameCancel,
    onContextMenu,
}) => {
    const { node, displayPath, depth, isExpanded, isRenaming, status } = row;
    const renameInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isRenaming && renameInputRef.current) {
            const input = renameInputRef.current;
            input.focus();
            const name = getFileName(node.path);
            const dotIdx = name.lastIndexOf('.');
            if (!node.isDirectory && dotIdx > 0) {
                input.setSelectionRange(0, dotIdx);
            } else {
                input.select();
            }
        }
    }, [isRenaming, node.path, node.isDirectory]);

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isRenaming) return;
        if (e.shiftKey && node.isDirectory) {
            onDeepToggle(node, !isExpanded);
        } else {
            onItemClick(node.path);
        }
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isRenaming) return;
        onDoubleClick(node);
    };

    const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            onRenameSubmit(node.path, e.currentTarget.value.trim());
        } else if (e.key === 'Escape') {
            onRenameCancel();
        }
    };

    const icon = getFileIcon(node.name, node.isDirectory, isExpanded);
    const expanderIcon = getExpanderIcon(isExpanded);
    const statusClass = status ? `file-tree__item--${status}` : '';

    return (
        <div
            className={`file-tree__node${isDropTarget ? ' file-tree__node--drop-target' : ''}`}
            data-drop-path={node.isDirectory ? node.path : undefined}
        >
            <div
                className={`file-tree__item ${isSelected ? 'file-tree__item--selected' : ''} ${statusClass}${isDropTarget ? ' file-tree__item--drop-target' : ''}`}
                style={{ paddingLeft: 4 + depth * 12 }}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onContextMenu={(e) => onContextMenu(e, node, depth)}
            >
                {node.isDirectory ? (
                    <span
                        className="file-tree__expander"
                        onClick={(e) => {
                            // Chevron only toggles expansion; clicking the row
                            // body is what opens the folder grid view.
                            e.stopPropagation();
                            onExpanderClick(node.path);
                        }}
                        style={{ cursor: 'pointer' }}
                        dangerouslySetInnerHTML={{ __html: expanderIcon }}
                    />
                ) : (
                    <span className="file-tree__expander" style={{ visibility: 'hidden' }} />
                )}
                <span
                    className="file-tree__icon"
                    dangerouslySetInnerHTML={{ __html: icon }}
                />
                {isRenaming ? (
                    <input
                        ref={renameInputRef}
                        className="file-tree__rename-input"
                        defaultValue={getFileName(node.path)}
                        onBlur={(e) => onRenameSubmit(node.path, e.currentTarget.value.trim())}
                        onKeyDown={handleRenameKeyDown}
                        onClick={(e) => e.stopPropagation()}
                    />
                ) : (
                    <>
                        <span className="file-tree__name">
                            {displayPath.includes('/') ? (
                                displayPath.split('/').map((segment, idx, arr) => (
                                    <React.Fragment key={idx}>
                                        <span className="file-tree__compact-segment">{segment}</span>
                                        {idx < arr.length - 1 && <span className="file-tree__compact-separator">/</span>}
                                    </React.Fragment>
                                ))
                            ) : (
                                displayPath
                            )}
                        </span>
                        {status && (
                            <span className={`file-tree__status-badge file-tree__status-badge--${status}`}>
                                {status === 'new' ? 'N' : 'M'}
                            </span>
                        )}
                    </>
                )}
            </div>
        </div>
    );
});

TreeRow.displayName = 'TreeRow';

const ProjectsPanel: React.FC = () => {
    const openModal = useModalStore((s) => s.openModal);
    const recentProjects = useConfigStore((s) => s.recentProjects);
    const { setWorking, setReady, setError } = useAppMetadataStore();

    const handleOpenProject = async (projectPath: string) => {
        try {
            setWorking('Opening project...');

            let normalizedPath = projectPath;
            if (normalizedPath.endsWith('.json')) {
                normalizedPath = normalizedPath.replace(/[\\/](mod\.config|flint|project)\.json$/, '');
            }

            const { project, fileTree: files } = await api.openProjectWithTree(normalizedPath);

            useProjectTabStore.getState().addTab(project, normalizedPath);
            useNavigationStore.getState().setView('preview');

            useConfigStore.getState().addSavedProject({
                id: `proj-${Date.now()}`,
                name: project.display_name || project.name,
                kind: project.kind ?? 'skin',
                champion: project.champion,
                mapId: project.map_id ?? null,
                path: normalizedPath,
                lastOpened: new Date().toISOString(),
            });

            const tabId = useProjectTabStore.getState().activeTabId;
            if (tabId) useProjectTabStore.getState().setFileTree(tabId, files);

            useAppMetadataStore.getState().clearFileStatuses();

            setReady();
        } catch (error) {
            console.error('Failed to open project:', error);
            const flintError = error as api.FlintError;
            setError(flintError.getUserMessage?.() || 'Failed to open project');
        }
    };

    return (
        <aside className="left-panel projects-panel">
            <div className="projects-panel__header">
                <span className="projects-panel__title">Recent Folders</span>
                <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                        className="btn btn--ghost btn--small"
                        title="Open Folder"
                        onClick={() => openModal('projectList')}
                        dangerouslySetInnerHTML={{ __html: getIcon('folderOpen2') }}
                    />
                    <button
                        className="btn btn--ghost btn--small"
                        title="New Workspace"
                        onClick={() => openModal('newProject')}
                        dangerouslySetInnerHTML={{ __html: getIcon('plus') }}
                    />
                </div>
            </div>
            <div className="projects-panel__list">
                {recentProjects.length === 0 ? (
                    <div className="projects-panel__empty">
                        <p>No recent folders</p>
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                            Open a folder to get started
                        </p>
                    </div>
                ) : (
                    recentProjects.map((project) => (
                        <div
                            key={project.path}
                            className="projects-panel__item"
                            onClick={() => handleOpenProject(project.path)}
                        >
                            <span
                                className="projects-panel__icon"
                                dangerouslySetInnerHTML={{ __html: getIcon('folder') }}
                            />
                            <div className="projects-panel__info">
                                <div className="projects-panel__name">
                                    {project.name}
                                </div>
                                <div className="projects-panel__meta" title={project.path} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '170px' }}>{project.path}</div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </aside>
    );
};

export { FileTree, ProjectsPanel };
