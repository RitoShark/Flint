import React, { useState, useMemo, useCallback, useRef, useEffect, CSSProperties } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useAppMetadataStore, useProjectTabStore, useModalStore, useNotificationStore, useConfigStore, useNavigationStore } from '../../lib/stores';
import { openWadInExtract, isWadPath } from '../../lib/openWad';
import { getFileIcon, getExpanderIcon, getIcon } from '../../lib/ui-helpers/fileIcons';
import { VirtualizedList, type VirtualizedListHandle } from './wad-explorer/VirtualizedList';
import { useAction, useScope } from '../../lib/shortcuts/hooks';
import {
    stepFocus,
    edgeFocus,
    rangeBetween,
    arrowRight,
    arrowLeft,
    typeToFind,
    type NavRow,
} from '../../lib/shortcuts/treeNav';
import * as api from '../../lib/api';
import { buildFileContextMenuOptions } from '../../lib/editor/fileContextMenuOptions';
import { beginPointerDrag } from '../../lib/pointerDrag';
import { copyablePath } from '../../lib/wadPath';
import { useTransferStore } from '../../lib/stores/transferStore';
import type { TreeDragPayload, TreeDragItem } from '../../lib/dnd';
import type { FileTreeNode, ProjectTab } from '../../lib/types';

const ROW_HEIGHT = 22;
const ROW_OVERSCAN = 8;

const BIN_TEXT_EXTS = ['.bin', '.ritobin', '.py'];
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
    node: FileTreeNode;
    /** Displayed path; for compacted folders this includes the merged segments. */
    displayPath: string;
    depth: number;
    isExpanded: boolean;
    isRenaming: boolean;
    status?: 'new' | 'modified';
}

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

function flattenTree(
    root: FileTreeNode,
    expandedFolders: Set<string>,
    renamingPath: string | null,
    statusByRelPath: Map<string, 'new' | 'modified'>,
): TreeRowData[] {
    const rows: TreeRowData[] = [];
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

    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
    const anchorRef = useRef<string | null>(null);
    const rowsRef = useRef(rows);
    rowsRef.current = rows;
    const selectedPathsRef = useRef(selectedPaths);
    selectedPathsRef.current = selectedPaths;

    /** Keyboard cursor, and whether the tree owns focus (gates the shortcut scope). */
    const [focusedPathState, setFocusedPathState] = useState<string | null>(null);
    const [treeFocused, setTreeFocused] = useState(false);
    const listRef = useRef<VirtualizedListHandle>(null);

    useEffect(() => {
        setSelectedPaths(new Set());
        anchorRef.current = null;
        setFocusedPathState(null);
    }, [activeTabId]);

    const refreshFileTree = useCallback(async () => {
        if (!activeTab) return;
        const files = await api.listProjectFiles(activeTab.projectPath);
        setFileTree(activeTab.id, files);
    }, [activeTab, setFileTree]);

    // ── Keyboard navigation ──────────────────────────────────────────────────
    // The 'file-tree' scope is pushed only while the tree actually holds focus,
    // which is what makes bare ArrowDown/Delete safe: with a view-wide scope they
    // would also fire over the 3D preview and the editors.
    useScope('file-tree', treeFocused);

    /** Flattened rows in the shape treeNav works on. */
    const navRows = useMemo<NavRow[]>(() => rows.map((r) => ({
        path: r.node.path,
        name: r.node.name,
        isDirectory: r.node.isDirectory,
        isExpanded: r.isExpanded,
        depth: r.depth,
    })), [rows]);
    const navRowsRef = useRef(navRows);
    navRowsRef.current = navRows;

    /** Keyboard cursor. Falls back to the mouse selection so the two stay in step. */
    const focusedPath = focusedPathState ?? selectedFile;
    const focusedPathRef = useRef(focusedPath);
    focusedPathRef.current = focusedPath;

    const scrollPathIntoView = useCallback((path: string) => {
        const index = navRowsRef.current.findIndex((r) => r.path === path);
        if (index >= 0) listRef.current?.scrollToIndex(index);
    }, []);

    /** Move the cursor, collapsing the selection onto the new row. */
    const focusRow = useCallback((path: string | null) => {
        if (!path || !activeTabRef.current) return;
        setFocusedPathState(path);
        setSelectedPaths(new Set([path]));
        anchorRef.current = path;
        setSelectedFile(activeTabRef.current.id, path);
        scrollPathIntoView(path);
    }, [setSelectedFile, scrollPathIntoView]);

    /** Move the cursor while growing the range from the existing anchor. */
    const extendTo = useCallback((path: string | null) => {
        if (!path || !activeTabRef.current) return;
        const anchor = anchorRef.current ?? focusedPathRef.current;
        setFocusedPathState(path);
        if (anchor) setSelectedPaths(new Set(rangeBetween(navRowsRef.current, anchor, path)));
        setSelectedFile(activeTabRef.current.id, path);
        scrollPathIntoView(path);
    }, [setSelectedFile, scrollPathIntoView]);

    const beginRename = useCallback(() => {
        const sel = focusedPathRef.current;
        if (renamingPath || !sel || sel === '.') return;
        setRenamingPath(sel);
    }, [renamingPath]);

    const deleteSelection = useCallback(() => {
        const tab = activeTabRef.current;
        const sel = focusedPathRef.current;
        if (renamingPath || !tab || !sel) return;

        const selPaths = selectedPathsRef.current;
        const targets = (selPaths.size > 0 ? [...selPaths] : [sel]).filter((p) => p && p !== '.');
        if (!targets.length) return;

        const label = targets.length === 1
            ? `"${targets[0].split('/').pop()}"`
            : `${targets.length} items`;
        openConfirmDialog({
            title: 'Delete',
            message: `Are you sure you want to delete ${label}? This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: async () => {
                try {
                    for (const p of targets) await api.deleteFile(tab.projectPath, p);
                    await refreshFileTree();
                    setSelectedPaths(new Set());
                    showToastRef.current('success', targets.length === 1 ? 'Deleted' : `Deleted ${targets.length} items`);
                } catch (err) {
                    const fe = err as api.FlintError;
                    showToastRef.current('error', fe.getUserMessage?.() || 'Failed to delete');
                }
            },
        });
    }, [renamingPath, openConfirmDialog, refreshFileTree]);

    useAction('tree.moveDown', () => focusRow(stepFocus(navRowsRef.current, focusedPathRef.current, 1)));
    useAction('tree.moveUp', () => focusRow(stepFocus(navRowsRef.current, focusedPathRef.current, -1)));
    useAction('tree.extendDown', () => extendTo(stepFocus(navRowsRef.current, focusedPathRef.current, 1)));
    useAction('tree.extendUp', () => extendTo(stepFocus(navRowsRef.current, focusedPathRef.current, -1)));
    useAction('tree.first', () => focusRow(edgeFocus(navRowsRef.current, 'first')));
    useAction('tree.last', () => focusRow(edgeFocus(navRowsRef.current, 'last')));

    useAction('tree.expand', () => {
        const outcome = arrowRight(navRowsRef.current, focusedPathRef.current);
        if (!outcome) return;
        if (outcome.kind === 'expand') handleExpanderClick(outcome.path);
        else focusRow(outcome.path);
    });

    useAction('tree.collapse', () => {
        const outcome = arrowLeft(navRowsRef.current, focusedPathRef.current);
        if (!outcome) return;
        if (outcome.kind === 'collapse') handleExpanderClick(outcome.path);
        else focusRow(outcome.path);
    });

    useAction('tree.selectAll', () => {
        // The project root is excluded: it is never a valid delete or drag target.
        setSelectedPaths(new Set(navRowsRef.current.map((r) => r.path).filter((p) => p !== '.')));
    });

    useAction('tree.open', () => {
        const path = focusedPathRef.current;
        if (!path) return;
        const target = rowsRef.current.find((r) => r.node.path === path);
        if (!target) return;
        if (target.node.isDirectory) handleExpanderClick(path);
        else handleDoubleClick(target.node);
    });

    useAction('tree.copyPath', () => {
        const selPaths = selectedPathsRef.current;
        const paths =
            selPaths.size > 0
                ? [...selPaths]
                : [focusedPathRef.current].filter((p): p is string => Boolean(p));
        if (!paths.length) return;
        // Matches the 'Copy relative path' context-menu item in fileContextMenuOptions.
        void navigator.clipboard.writeText(paths.map(copyablePath).join('\n'));
        showToastRef.current('success', paths.length === 1 ? 'Path copied' : `${paths.length} paths copied`);
    });

    useAction('tree.rename', beginRename);
    useAction('tree.delete', deleteSelection);

    // Type-to-find runs only when no declared binding matched, so a real shortcut
    // always beats the search buffer.
    const typeBufferRef = useRef('');
    const typeTimerRef = useRef<number | null>(null);
    const handleTypeAhead = useCallback((e: React.KeyboardEvent) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key.length !== 1 || e.key === ' ') return;
        if (renamingPath) return;

        typeBufferRef.current += e.key;
        if (typeTimerRef.current !== null) window.clearTimeout(typeTimerRef.current);
        typeTimerRef.current = window.setTimeout(() => { typeBufferRef.current = ''; }, 600);

        const match = typeToFind(navRowsRef.current, typeBufferRef.current, focusedPathRef.current);
        if (match) {
            e.preventDefault();
            focusRow(match);
        }
    }, [renamingPath, focusRow]);

    useEffect(() => () => {
        if (typeTimerRef.current !== null) window.clearTimeout(typeTimerRef.current);
    }, []);

    const handleItemClick = useCallback((path: string, mods?: { ctrl: boolean; shift: boolean }) => {
        if (!activeTab) return;
        if (mods?.shift && anchorRef.current) {
            const paths = rowsRef.current.map((r) => r.node.path);
            const i = paths.indexOf(anchorRef.current);
            const j = paths.indexOf(path);
            if (i >= 0 && j >= 0) {
                const [lo, hi] = i <= j ? [i, j] : [j, i];
                setSelectedPaths(new Set(paths.slice(lo, hi + 1)));
            }
        } else if (mods?.ctrl) {
            setSelectedPaths((prev) => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path); else next.add(path);
                return next;
            });
            anchorRef.current = path;
        } else {
            setSelectedPaths(new Set([path]));
            anchorRef.current = path;
        }
        setSelectedFile(activeTab.id, path);
        // Keep the keyboard cursor on whatever the mouse just touched, so a click
        // followed by ArrowDown continues from there rather than from a stale row.
        setFocusedPathState(path);
        useNavigationStore.getState().setView('preview');
    }, [activeTab, setSelectedFile]);

    const handleRowPointerDown = useCallback((node: FileTreeNode, e: React.PointerEvent) => {
        if (node.path === '.' || !projectPath || renamingPath) return;
        const sel = selectedPathsRef.current;
        let items: TreeDragItem[];
        if (sel.has(node.path) && sel.size > 1) {
            items = rowsRef.current
                .filter((r) => sel.has(r.node.path) && r.node.path !== '.')
                .map((r) => ({ relPath: r.node.path, name: r.node.name, isDirectory: r.node.isDirectory }));
        } else {
            items = [{ relPath: node.path, name: node.name, isDirectory: node.isDirectory }];
        }
        if (!items.length) return;
        const payload: TreeDragPayload = { projectPath, items };
        const label = items.length === 1 ? items[0].name : `${items.length} items`;
        beginPointerDrag(e, {
            label,
            onMove: (x, y) => onTreeDragMove(x, y, projectPath),
            onDrop: ({ clientX, clientY }) => onTreeDrop(clientX, clientY, payload),
            onEnd: () => { clearSpringLoad(); clearFolderExpand(); clearDragHighlights(); },
        });
    }, [projectPath, renamingPath]);

    const handleExpanderClick = useCallback((path: string) => {
        if (activeTab) toggleFolder(activeTab.id, path);
    }, [activeTab, toggleFolder]);

    const handleDeepToggle = useCallback((node: FileTreeNode, expand: boolean) => {
        if (!activeTab) return;
        bulkSetFolders(activeTab.id, collectAllFolderPaths(node), expand);
    }, [activeTab, bulkSetFolders]);

    const openWad = useCallback((fullFilePath: string) => {
        showToastRef.current('info', 'Opening WAD…');
        openWadInExtract(fullFilePath).catch((err) => {
            const fe = err as api.FlintError;
            showToastRef.current('error', fe.getUserMessage?.() || 'Failed to open WAD');
        });
    }, []);

    const handleDoubleClick = useCallback((node: FileTreeNode) => {
        if (node.isDirectory) return;
        const path = node.path;
        const lower = path.toLowerCase();
        const fullFilePath = `${projectPath}/${path}`;
        const nav = useNavigationStore.getState();

        if (isWadPath(lower)) {
            openWad(fullFilePath);
        } else if (lower.endsWith('.fantome') || lower.endsWith('.modpkg')) {
            nav.navigateToArchiveEditor(fullFilePath);
        } else if (node.name === 'mod.config.json') {
            nav.navigateToFileEditor({ filePath: fullFilePath, kind: 'modConfig', projectPath });
        } else if (lower.endsWith('.troybin')) {
            // .troybin is a binary League config with a read-only viewer, NOT ritobin text.
            nav.navigateToFileEditor({ filePath: fullFilePath, kind: 'troybin', projectPath });
        } else if (BIN_TEXT_EXTS.some(ext => lower.endsWith(ext))) {
            nav.navigateToFileEditor({ filePath: fullFilePath, kind: 'binText', projectPath });
        } else if (LUA_BIN_EXTS.some(ext => lower.endsWith(ext))) {
            nav.navigateToFileEditor({ filePath: fullFilePath, kind: 'luaBin64', projectPath });
        } else if (lower.endsWith('.json') || lower.endsWith('.txt') || lower.endsWith('.lua') || lower.endsWith('.py')) {
            nav.navigateToFileEditor({ filePath: fullFilePath, kind: 'raw', projectPath });
        }
    }, [projectPath, openWad]);

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

    // focusedPath is part of the epoch so the focus ring repaints as it moves.
    const renderEpoch = rows.length + (selectedFile?.length ?? 0) + (dropTargetPath?.length ?? 0)
        + selectedPaths.size + (focusedPath?.length ?? 0) + (treeFocused ? 1 : 0);

    return (
        <div
            className="file-tree"
            // Focusable so the tree can own the 'file-tree' shortcut scope; clicking
            // a row focuses this container, which is how F2/Delete stay reachable.
            tabIndex={0}
            onFocus={() => setTreeFocused(true)}
            onBlur={(e) => {
                // focusout bubbles from children too, so ignore focus moving *within*
                // the tree (e.g. into the rename input) — otherwise the scope flickers.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setTreeFocused(false);
                }
            }}
            onKeyDown={handleTypeAhead}
        >
            <VirtualizedList
                ref={listRef}
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
                            projectPath={activeTab?.projectPath || ''}
                            isSelected={selectedPaths.has(row.node.path) || selectedFile === row.node.path}
                            isFocused={treeFocused && focusedPath === row.node.path}
                            isDropTarget={dropTargetPath === row.node.path}
                            onItemClick={handleItemClick}
                            onRowPointerDown={handleRowPointerDown}
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
    projectPath: string;
    isSelected: boolean;
    /** Keyboard cursor position — drawn as a ring, distinct from selection fill. */
    isFocused: boolean;
    isDropTarget: boolean;
    onItemClick: (path: string, mods?: { ctrl: boolean; shift: boolean }) => void;
    onRowPointerDown: (node: FileTreeNode, e: React.PointerEvent) => void;
    onExpanderClick: (path: string) => void;
    onDeepToggle: (node: FileTreeNode, expand: boolean) => void;
    onDoubleClick: (node: FileTreeNode) => void;
    onRenameSubmit: (path: string, newName: string) => void;
    onRenameCancel: () => void;
    onContextMenu: (e: React.MouseEvent, node: FileTreeNode, depth: number) => void;
}

// ── Cross-project drag hit-testing (pointer-drag; see lib/pointerDrag.ts) ──────

const SPRING_LOAD_MS = 600;
let springTimer: number | null = null;
let springTargetProject: string | null = null;
let folderExpandTimer: number | null = null;
let folderExpandTarget: string | null = null;

function clearSpringLoad(): void {
    if (springTimer !== null) { clearTimeout(springTimer); springTimer = null; }
    springTargetProject = null;
}

function clearFolderExpand(): void {
    if (folderExpandTimer !== null) { clearTimeout(folderExpandTimer); folderExpandTimer = null; }
    folderExpandTarget = null;
}

/** Project tab under the given client point, if any (tabs carry data-project-tab). */
function projectTabAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return (el?.closest('[data-project-tab]') as HTMLElement | null) ?? null;
}

/** Folder row (the tree node element) under the point — folders carry data-drop-path. */
function folderRowAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return (el?.closest('[data-drop-path]') as HTMLElement | null) ?? null;
}

function clearDragHighlights(): void {
    document.querySelectorAll('.titlebar__tab--drop-target, .file-tree__node--drop-target, .file-tree__item--drop-target')
        .forEach((el) => el.classList.remove('titlebar__tab--drop-target', 'file-tree__node--drop-target', 'file-tree__item--drop-target'));
}

/** The currently-active project tab's path + display name (post spring-load). */
function activeProjectInfo(): { path: string; name: string } | null {
    const st = useProjectTabStore.getState();
    const tab = st.openTabs.find((t) => t.id === st.activeTabId);
    if (!tab) return null;
    return { path: tab.projectPath, name: tab.project.display_name || tab.project.name };
}

function onTreeDragMove(x: number, y: number, sourceProject: string): void {
    clearDragHighlights();

    const tab = projectTabAt(x, y);
    if (tab) {
        clearFolderExpand();
        const pp = tab.getAttribute('data-project-tab');
        if (pp && pp !== sourceProject) {
            tab.classList.add('titlebar__tab--drop-target');
            if (springTargetProject !== pp) {
                clearSpringLoad();
                springTargetProject = pp;
                springTimer = window.setTimeout(() => {
                    const st = useProjectTabStore.getState();
                    const t = st.openTabs.find((tb) => tb.projectPath === pp);
                    if (t) {
                        st.switchTab(t.id);
                        useNavigationStore.getState().setView('preview');
                    }
                    springTimer = null;
                }, SPRING_LOAD_MS);
            }
        }
        return;
    }

    clearSpringLoad();
    const active = activeProjectInfo();
    if (active && active.path !== sourceProject) {
        const folder = folderRowAt(x, y);
        if (folder) {
            folder.classList.add('file-tree__node--drop-target');
            const folderPath = folder.getAttribute('data-drop-path');
            if (folderPath && folderPath !== '.' && folderExpandTarget !== folderPath) {
                clearFolderExpand();
                folderExpandTarget = folderPath;
                folderExpandTimer = window.setTimeout(() => {
                    const st = useProjectTabStore.getState();
                    if (st.activeTabId) st.bulkSetFolders(st.activeTabId, [folderPath], true);
                    folderExpandTimer = null;
                }, SPRING_LOAD_MS);
            }
        } else {
            clearFolderExpand();
        }
    }
}

function onTreeDrop(x: number, y: number, payload: TreeDragPayload): void {
    clearSpringLoad();
    clearFolderExpand();
    clearDragHighlights();

    const folder = folderRowAt(x, y);
    if (folder) {
        const destFolder = folder.getAttribute('data-drop-path');
        const active = activeProjectInfo();
        if (destFolder && active && active.path !== payload.projectPath) {
            useTransferStore.getState().openTransfer({
                payload,
                destProjectPath: active.path,
                destProjectName: active.name,
                destFolder,
            });
        }
        return;
    }

    const tab = projectTabAt(x, y);
    if (!tab) return;
    const destProjectPath = tab.getAttribute('data-project-tab');
    const destProjectName = tab.getAttribute('data-project-name') || 'project';
    if (!destProjectPath || destProjectPath === payload.projectPath) return;
    useTransferStore.getState().openTransfer({ payload, destProjectPath, destProjectName, destFolder: '.' });
}

const TreeRow: React.FC<TreeRowProps> = React.memo(({
    row,
    projectPath,
    isSelected,
    isFocused,
    isDropTarget,
    onItemClick,
    onRowPointerDown,
    onExpanderClick,
    onDeepToggle,
    onDoubleClick,
    onRenameSubmit,
    onRenameCancel,
    onContextMenu,
}) => {
    const { node, displayPath, depth, isExpanded, isRenaming, status } = row;
    const renameInputRef = useRef<HTMLInputElement>(null);

    void projectPath;
    const handlePointerDown = (e: React.PointerEvent) => {
        onRowPointerDown(node, e);
    };

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
        onItemClick(node.path, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
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
                className={`file-tree__item ${isSelected ? 'file-tree__item--selected' : ''} ${statusClass}${isDropTarget ? ' file-tree__item--drop-target' : ''}${isFocused ? ' file-tree__item--focused' : ''}`}
                style={{ paddingLeft: 4 + depth * 12 }}
                onPointerDown={handlePointerDown}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onContextMenu={(e) => onContextMenu(e, node, depth)}
            >
                {node.isDirectory ? (
                    <span
                        className="file-tree__expander"
                        onClick={(e) => {
                            e.stopPropagation();
                            if (e.shiftKey) onDeepToggle(node, !isExpanded);
                            else onExpanderClick(node.path);
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
