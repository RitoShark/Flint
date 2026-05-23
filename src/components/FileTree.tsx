/**
 * Flint - File Tree Component
 */

import React, { useState, useMemo, useCallback, useRef, useEffect, CSSProperties } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useAppMetadataStore, useProjectTabStore, useModalStore, useNotificationStore, useConfigStore, useNavigationStore } from '../lib/stores';
import { getFileIcon, getExpanderIcon, getIcon } from '../lib/fileIcons';
import * as api from '../lib/api';
import { buildFileContextMenuOptions } from '../lib/fileContextMenuOptions';
import type { FileTreeNode, ProjectTab } from '../lib/types';

// Helper to get active tab from projectTabStore state
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
    const [searchQuery, setSearchQuery] = useState('');

    const activeTab = getActiveTab(activeTabId, openTabs);
    const hasProject = !!activeTab;

    if (!hasProject) {
        return null;
    }

    return (
        <aside className="left-panel" id="left-panel" style={style}>
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

const FileTree: React.FC<FileTreeProps> = ({ searchQuery }) => {
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const toggleFolder = useProjectTabStore((s) => s.toggleFolder);
    const setFileTree = useProjectTabStore((s) => s.setFileTree);
    const setSelectedFile = useProjectTabStore((s) => s.setSelectedFile);
    const bulkSetFolders = useProjectTabStore((s) => s.bulkSetFolders);
    const showToast = useNotificationStore((s) => s.showToast);

    // Get active tab for file tree data
    const activeTab = getActiveTab(activeTabId, openTabs);
    const fileTree = activeTab?.fileTree || null;
    const selectedFile = activeTab?.selectedFile || null;
    const expandedFolders = activeTab?.expandedFolders || new Set<string>();

    // Subscribe to file tree version changes — auto-refresh when files are created/removed
    const fileTreeVersion = useAppMetadataStore((s) => s.fileTreeVersion);
    useEffect(() => {
        if (!activeTab || fileTreeVersion === 0) return;
        api.listProjectFiles(activeTab.projectPath).then((files) => {
            setFileTree(activeTab.id, files);
        }).catch(() => {});
    }, [fileTreeVersion]); // eslint-disable-line react-hooks/exhaustive-deps

    // ONE subscription to the file-status revision counter. When it bumps,
    // we read the current Map snapshot and pass paths-with-status as plain
    // props down the tree. Previously every TreeNode had its own selector
    // subscription on this store — with hundreds of nodes, every status
    // update triggered hundreds of selector re-evaluations.
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

    // Rename state — shared across all tree nodes
    const [renamingPath, setRenamingPath] = useState<string | null>(null);

    // External drag & drop (OS files dropped onto the file tree).
    // WebView2 swallows HTML5 dragover/drop, so we use Tauri's webview-level
    // drag-drop event and hit-test the DOM with `position` from the payload.
    const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

    // Fresh refs so the listener always sees current state
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

        // The webview drag-drop event reports physical pixel coordinates; the
        // DOM uses CSS pixels. Divide by devicePixelRatio.
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
                    // 'leave' / 'cancelled'
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

    const dragProps: DragProps = useMemo(() => ({
        dropTargetPath,
    }), [dropTargetPath]);

    // Row body click = select. For folders that means routing to the
    // folder grid view in the preview panel. The chevron is the only
    // thing that toggles expansion (handled separately on the expander
    // span itself, see TreeNode below).
    const handleItemClick = useCallback((path: string, _isFolder: boolean) => {
        if (!activeTab) return;
        setSelectedFile(activeTab.id, path);
        useNavigationStore.getState().setView('preview');
    }, [activeTab, setSelectedFile]);

    const handleExpanderClick = useCallback((path: string) => {
        if (activeTab) toggleFolder(activeTab.id, path);
    }, [activeTab, toggleFolder]);

    const handleDeepToggle = useCallback((paths: string[], expand: boolean) => {
        if (activeTab) bulkSetFolders(activeTab.id, paths, expand);
    }, [activeTab, bulkSetFolders]);

    const filteredTree = useMemo(() => {
        if (!fileTree || !searchQuery) return fileTree;
        return filterTreeByQuery(fileTree, searchQuery.toLowerCase());
    }, [fileTree, searchQuery]);

    if (!filteredTree) {
        return (
            <div className="file-tree">
                <div className="file-tree__empty">No project files loaded</div>
            </div>
        );
    }

    return (
        <div className="file-tree">
            <TreeNode
                node={filteredTree}
                depth={0}
                selectedFile={selectedFile}
                expandedFolders={expandedFolders}
                onItemClick={handleItemClick}
                onExpanderClick={handleExpanderClick}
                onDeepToggle={handleDeepToggle}
                renamingPath={renamingPath}
                setRenamingPath={setRenamingPath}
                projectPath={activeTab?.projectPath || ''}
                dragProps={dragProps}
                statusByRelPath={statusByRelPath}
            />
        </div>
    );
};

interface DragProps {
    dropTargetPath: string | null;
}

interface TreeNodeProps {
    node: FileTreeNode;
    depth: number;
    selectedFile: string | null;
    expandedFolders: Set<string>;
    onItemClick: (path: string, isFolder: boolean) => void;
    onExpanderClick: (path: string) => void;
    onDeepToggle: (paths: string[], expand: boolean) => void;
    renamingPath: string | null;
    setRenamingPath: (path: string | null) => void;
    projectPath: string;
    dragProps: DragProps;
    statusByRelPath: Map<string, 'new' | 'modified'>;
}

// Compact folders: merge single-child directory chains into one label
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

// Collect all descendant folder paths for deep expand/collapse
function collectAllFolderPaths(node: FileTreeNode): string[] {
    if (!node.isDirectory) return [];
    const result = [node.path];
    for (const child of node.children ?? []) {
        result.push(...collectAllFolderPaths(child));
    }
    return result;
}

// Get just the filename from a path
function getFileName(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
}

const TreeNode: React.FC<TreeNodeProps> = React.memo(({
    node,
    depth,
    selectedFile,
    expandedFolders,
    onItemClick,
    onExpanderClick,
    onDeepToggle,
    renamingPath,
    setRenamingPath,
    projectPath,
    dragProps,
    statusByRelPath,
}) => {
    const openModal = useModalStore((s) => s.openModal);
    const openContextMenu = useModalStore((s) => s.openContextMenu);
    const openConfirmDialog = useModalStore((s) => s.openConfirmDialog);
    const showToast = useNotificationStore((s) => s.showToast);
    const leaguePath = useConfigStore((s) => s.leaguePath);
    const renameInputRef = useRef<HTMLInputElement>(null);

    // Apply compact-folder merging
    const { displayPath, effectiveNode } = node.isDirectory ? compactNode(node) : { displayPath: node.name, effectiveNode: node };
    const isExpanded = expandedFolders.has(effectiveNode.path);
    const isSelected = selectedFile === effectiveNode.path;
    const isRenaming = renamingPath === effectiveNode.path;

    // Drop-target highlight when external files are dragged over this folder
    const isDropTarget = dragProps.dropTargetPath === effectiveNode.path;

    // File status comes from the parent — no per-node store subscription.
    const fileStatus = statusByRelPath.get(effectiveNode.path);

    // Focus rename input when it appears
    useEffect(() => {
        if (isRenaming && renameInputRef.current) {
            const input = renameInputRef.current;
            input.focus();
            // Select filename without extension for files
            const name = getFileName(effectiveNode.path);
            const dotIdx = name.lastIndexOf('.');
            if (!effectiveNode.isDirectory && dotIdx > 0) {
                input.setSelectionRange(0, dotIdx);
            } else {
                input.select();
            }
        }
    }, [isRenaming]);

    const refreshFileTree = async () => {
        if (!projectPath) return;
        const files = await api.listProjectFiles(projectPath);
        const { activeTabId } = useProjectTabStore.getState();
        if (activeTabId) useProjectTabStore.getState().setFileTree(activeTabId, files);
    };

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isRenaming) return;
        if (e.shiftKey && effectiveNode.isDirectory) {
            // Deep expand/collapse
            const allPaths = collectAllFolderPaths(effectiveNode);
            onDeepToggle(allPaths, !isExpanded);
        } else {
            onItemClick(effectiveNode.path, effectiveNode.isDirectory);
        }
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isRenaming || effectiveNode.isDirectory) return;

        const path = effectiveNode.path;
        const lower = path.toLowerCase();
        const BIN_TEXT_EXTS = ['.bin', '.ritobin', '.py', '.luabin', '.luabin64', '.troybin'];
        const fullFilePath = `${projectPath}/${path}`;

        if (effectiveNode.name === 'mod.config.json') {
            useNavigationStore.getState().navigateToFileEditor({
                filePath: fullFilePath,
                kind: 'modConfig',
                projectPath,
            });
        } else if (BIN_TEXT_EXTS.some(ext => lower.endsWith(ext))) {
            useNavigationStore.getState().navigateToFileEditor({
                filePath: fullFilePath,
                kind: 'binText',
                projectPath,
            });
        } else if (lower.endsWith('.json') || lower.endsWith('.txt') || lower.endsWith('.lua') || lower.endsWith('.py')) {
            useNavigationStore.getState().navigateToFileEditor({
                filePath: fullFilePath,
                kind: 'raw',
                projectPath,
            });
        }
    };

    const handleRenameSubmit = async (newName: string) => {
        setRenamingPath(null);
        const currentName = getFileName(effectiveNode.path);
        if (!newName || newName === currentName) return;

        try {
            const result = await api.renameFile(projectPath, effectiveNode.path, newName);
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
    };

    const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            handleRenameSubmit(e.currentTarget.value.trim());
        } else if (e.key === 'Escape') {
            setRenamingPath(null);
        }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const options = buildFileContextMenuOptions({
            node: {
                path: effectiveNode.path,
                name: getFileName(effectiveNode.path),
                isDirectory: effectiveNode.isDirectory,
            },
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
    };

    const icon = getFileIcon(effectiveNode.name, effectiveNode.isDirectory, isExpanded);
    const expanderIcon = getExpanderIcon(isExpanded);

    const statusClass = fileStatus ? `file-tree__item--${fileStatus}` : '';

    return (
        <div
            className={`file-tree__node${isDropTarget ? ' file-tree__node--drop-target' : ''}`}
            data-drop-path={effectiveNode.isDirectory ? effectiveNode.path : undefined}
        >
            <div
                className={`file-tree__item ${isSelected ? 'file-tree__item--selected' : ''} ${statusClass}${isDropTarget ? ' file-tree__item--drop-target' : ''}`}
                style={{ paddingLeft: 4 + depth * 12 }}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onContextMenu={handleContextMenu}
            >
                {effectiveNode.isDirectory ? (
                    <span
                        className="file-tree__expander"
                        onClick={(e) => {
                            // Chevron toggles expansion only — does NOT
                            // also select the folder, so the user has to
                            // click the row body explicitly to open the
                            // folder grid view.
                            e.stopPropagation();
                            onExpanderClick(effectiveNode.path);
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
                        defaultValue={getFileName(effectiveNode.path)}
                        onBlur={(e) => handleRenameSubmit(e.currentTarget.value.trim())}
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
                        {fileStatus && (
                            <span className={`file-tree__status-badge file-tree__status-badge--${fileStatus}`}>
                                {fileStatus === 'new' ? 'N' : 'M'}
                            </span>
                        )}
                    </>
                )}
            </div>
            {effectiveNode.isDirectory && isExpanded && effectiveNode.children && (
                <div className="file-tree__children">
                    {effectiveNode.children.map((child) => (
                        <TreeNode
                            key={child.path}
                            node={child}
                            depth={depth + 1}
                            selectedFile={selectedFile}
                            expandedFolders={expandedFolders}
                            onItemClick={onItemClick}
                            onExpanderClick={onExpanderClick}
                            onDeepToggle={onDeepToggle}
                            renamingPath={renamingPath}
                            setRenamingPath={setRenamingPath}
                            projectPath={projectPath}
                            dragProps={dragProps}
                            statusByRelPath={statusByRelPath}
                        />
                    ))}
                </div>
            )}
        </div>
    );
});

const ProjectsPanel: React.FC = () => {
    const openModal = useModalStore((s) => s.openModal);
    const recentProjects = useConfigStore((s) => s.recentProjects);
    const { setWorking, setReady, setError } = useAppMetadataStore();

    const handleOpenProject = async (projectPath: string) => {
        try {
            setWorking('Opening project...');

            // Normalize path - strip project file name if present
            // Handles: mod.config.json, flint.json, project.json
            let normalizedPath = projectPath;
            if (normalizedPath.endsWith('.json')) {
                normalizedPath = normalizedPath.replace(/[\\/](mod\.config|flint|project)\.json$/, '');
            }

            const project = await api.openProject(normalizedPath);

            // Add tab + switch to preview
            useProjectTabStore.getState().addTab(project, normalizedPath);
            useNavigationStore.getState().setView('preview');

            // Auto-save to saved projects list
            useConfigStore.getState().addSavedProject({
                id: `proj-${Date.now()}`,
                name: project.display_name || project.name,
                kind: project.kind ?? 'skin',
                champion: project.champion,
                mapId: project.map_id ?? null,
                path: normalizedPath,
                lastOpened: new Date().toISOString(),
            });

            const files = await api.listProjectFiles(normalizedPath);
            const tabId = useProjectTabStore.getState().activeTabId;
            if (tabId) useProjectTabStore.getState().setFileTree(tabId, files);

            // Clear file statuses when opening a new project
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

export { FileTree, ProjectsPanel };
