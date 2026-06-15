import React, {
    useState, useCallback, useEffect, useRef, useMemo,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useConfigStore, useWadExplorerStore, useNavigationStore, useModalStore, useNotificationStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { open } from '@tauri-apps/plugin-dialog';
import { getIcon, getFileIcon } from '../../lib/ui-helpers/fileIcons';
import type { ContextMenuOption, WadChunk, WadExplorerWad } from '../../lib/types';
import { WadCheatSheetModal } from '../modals/WadCheatSheetModal';

import {
    checkboxSvg,
    type VFSNode, type VFSFolder, type VFSFile,
    buildVFSSubtree,
    type SearchMode, matchChunk, formatBytes,
    makeFileKey, collectFolderFileKeys, collectFolderHashes,
    getFolderCheckState, getWadCheckState, getCheckStateForKeys,
    ROW_HEIGHT, OVERSCAN,
    type FlatRow,
    collectAllVFSFolderKeys,
    flattenTree, flattenSearchResults,
} from './wad-explorer/helpers';
import { VirtualizedList, type VirtualizedListHandle } from './wad-explorer/VirtualizedList';
import { ChunkPreview } from './wad-explorer/ChunkPreview';
import { QuickActionPanel, WadListSkeleton } from './wad-explorer/QuickActionPanel';
import { ExtractOverlay } from './wad-explorer/ExtractOverlay';

export const WadExplorer: React.FC = () => {
    const wadExplorer = useWadExplorerStore(useShallow((s) => ({
        isOpen: s.isOpen,
        wads: s.wads,
        scanStatus: s.scanStatus,
        scanError: s.scanError,
        selected: s.selected,
        expandedWads: s.expandedWads,
        expandedFolders: s.expandedFolders,
        searchQuery: s.searchQuery,
        checkedFiles: s.checkedFiles,
        checkedCountPerWad: s.checkedCountPerWad,
    })));
    const leaguePath = useConfigStore((s) => s.leaguePath);
    const currentView = useNavigationStore((s) => s.currentView);
    const openContextMenu = useModalStore((s) => s.openContextMenu);
    const showToast = useNotificationStore((s) => s.showToast);

    // ── Local UI state ───────────────────────────────────────────────────────
    const [leftWidth, setLeftWidth] = useState(420);
    const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
    const isResizingRef = useRef(false);

    const handleToggleCategory = useCallback((cat: string) => {
        setCollapsedCategories(prev => {
            const next = new Set(prev);
            if (next.has(cat)) next.delete(cat); else next.add(cat);
            return next;
        });
    }, []);

    const [showCheatSheet, setShowCheatSheet] = useState(false);
    const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
    const listRef = useRef<VirtualizedListHandle | null>(null);
    const pendingNavRef = useRef<{ wadPath: string; filePath?: string; phase: 'wad' | 'file' } | null>(null);
    const flatRowsRef = useRef<FlatRow[] | null>(null);

    const [inputValue, setInputValue] = useState(wadExplorer.searchQuery);
    const [searchMode, setSearchMode] = useState<SearchMode>('contains');
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    // ── Derived search state ─────────────────────────────────────────────────
    const trimmed = inputValue.trim();
    const isRegex = searchMode === 'regex';
    let searchRe: RegExp | null = null;
    let regexError = false;
    if (isRegex && trimmed) {
        try { searchRe = new RegExp(trimmed, 'i'); } catch { regexError = true; }
    }
    const plainLower = trimmed.toLowerCase();
    const hasQuery = trimmed.length > 0;

    // ── PBE / Live branch toggle ────────────────────────────────────────────
    const configStore = useConfigStore();
    const [branch, setBranch] = useState<'live' | 'pbe'>('live');
    const branchSnapshotRef = useRef<Map<'live' | 'pbe', {
        wads: WadExplorerWad[];
        scanStatus: 'idle' | 'scanning' | 'ready' | 'error';
        scanError: string | null;
    }>>(new Map());

    const effectiveLeagueRoot = branch === 'pbe' ? configStore.leaguePathPbe : leaguePath;
    const effectiveGamePath = effectiveLeagueRoot ? `${effectiveLeagueRoot}/Game` : null;

    // ── Scan on mount if not yet scanned ────────────────────────────────────
    useEffect(() => {
        if (wadExplorer.scanStatus !== 'idle') return;
        if (!effectiveGamePath) return;
        runScan(effectiveGamePath);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const runScan = async (gamePath: string) => {
        useWadExplorerStore.getState().setScan('scanning');
        try {
            const wads = await api.scanGameWads(gamePath);
            useWadExplorerStore.getState().setScan('ready', wads);
        } catch (e) {
            useWadExplorerStore.getState().setScan('error', undefined, (e as Error).message);
            showToast('error', 'Failed to scan WAD directory');
        }
    };

    const handlePickGamePath = async () => {
        const picked = await open({ title: 'Select League Game/ Folder', directory: true });
        if (!picked) return;
        await runScan(picked as string);
    };

    const handleSwitchBranch = useCallback((next: 'live' | 'pbe') => {
        if (next === branch) return;

        if (next === 'pbe' && !configStore.leaguePathPbe) {
            showToast('error', 'No PBE League path configured. Open Settings (Ctrl+,) to set one.');
            return;
        }

        branchSnapshotRef.current.set(branch, {
            wads: wadExplorer.wads,
            scanStatus: wadExplorer.scanStatus,
            scanError: wadExplorer.scanError,
        });

        setBranch(next);

        const cached = branchSnapshotRef.current.get(next);
        if (cached && cached.scanStatus === 'ready' && cached.wads.length > 0) {
            const baseWads = cached.wads.map(w => ({
                path: w.path,
                name: w.name,
                category: w.category,
            }));
            useWadExplorerStore.getState().setScan('ready', baseWads);
            const loaded = cached.wads.filter(w => w.status === 'loaded' && w.chunks.length > 0);
            if (loaded.length > 0) {
                useWadExplorerStore.getState().batchSetWadStatuses(
                    loaded.map(w => ({ wadPath: w.path, status: 'loaded' as const, chunks: w.chunks })),
                );
            }
            return;
        }

        const nextRoot = next === 'pbe' ? configStore.leaguePathPbe : leaguePath;
        const nextGamePath = nextRoot ? `${nextRoot}/Game` : null;
        if (!nextGamePath) {
            useWadExplorerStore.getState().setScan('idle');
            return;
        }
        runScan(nextGamePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [branch, configStore.leaguePathPbe, leaguePath, wadExplorer.wads, wadExplorer.scanStatus, wadExplorer.scanError]);

    // ── Lazy WAD loading: load on-demand when WAD is expanded ─────────────────
    const loadWad = useCallback(async (wadPath: string) => {
        useWadExplorerStore.getState().setWadStatus(wadPath, 'loading');
        try {
            const chunks = await api.getWadChunks(wadPath);
            useWadExplorerStore.getState().setWadStatus(wadPath, 'loaded', chunks);
        } catch (e) {
            useWadExplorerStore.getState().setWadStatus(wadPath, 'error', undefined, (e as Error).message);
        }
    }, []);

    const pushRecentWad = useWadExplorerStore((s) => s.pushRecentWad);
    const handleToggleWad = useCallback((wadPath: string) => {
        const wad = wadExplorer.wads.find(w => w.path === wadPath);
        const wasCollapsed = !wadExplorer.expandedWads.has(wadPath);

        useWadExplorerStore.getState().toggleWad(wadPath);

        if (wasCollapsed) pushRecentWad(wadPath);

        if (wad?.status === 'idle' && wasCollapsed) {
            loadWad(wadPath);
        }
    }, [loadWad, wadExplorer.wads, wadExplorer.expandedWads, pushRecentWad]);

    // ── Cheat sheet navigation ────────────────────────────────────────────────
    const processNavigation = useCallback(() => {
        const nav = pendingNavRef.current;
        const rows = flatRowsRef.current;
        if (!nav || !rows) return;

        if (nav.phase === 'wad') {
            const wadRowIdx = rows.findIndex(r => r.kind === 'wad' && r.wad.path === nav.wadPath);
            if (wadRowIdx !== -1) {
                listRef.current?.scrollToIndex(wadRowIdx);
                if (!nav.filePath) {
                    setHighlightedKey(nav.wadPath);
                    pendingNavRef.current = null;
                    return;
                }
                nav.phase = 'file';
            }
        }

        if (nav.phase === 'file') {
            const wad = wadExplorer.wads.find(w => w.path === nav.wadPath);
            if (wad?.status !== 'loaded') return;

            const filePath = nav.filePath!.replace(/\\/g, '/').toLowerCase();
            const segs = filePath.split('/');
            const folderKeys: string[] = [];
            let cur = '';
            for (let i = 0; i < segs.length - 1; i++) {
                cur = cur ? `${cur}/${segs[i]}` : segs[i];
                folderKeys.push(`${nav.wadPath}::${cur}`);
            }
            const unexpanded = folderKeys.filter(k => !wadExplorer.expandedFolders.has(k));
            if (unexpanded.length > 0) {
                useWadExplorerStore.getState().bulkSetFolders(unexpanded, true);
                return;
            }

            const fileRowIdx = rows.findIndex(r =>
                r.kind === 'file' &&
                r.node.wadPath === nav.wadPath &&
                (r.node.chunk.path?.replace(/\\/g, '/').toLowerCase() ?? '') === filePath
            );
            if (fileRowIdx !== -1) {
                const fileRow = rows[fileRowIdx] as { kind: 'file'; node: VFSFile; depth: number };
                listRef.current?.scrollToIndex(fileRowIdx);
                setHighlightedKey(`${fileRow.node.wadPath}::${fileRow.node.chunk.hash}`);
                pendingNavRef.current = null;
            }
        }
    }, [wadExplorer.wads, wadExplorer.expandedFolders]);

    const handleCheatSheetOpenWad = useCallback((wadName: string, filePath?: string) => {
        const wad = wadExplorer.wads.find(w => w.name.toLowerCase() === wadName.toLowerCase());
        if (!wad) return;

        pendingNavRef.current = { wadPath: wad.path, filePath, phase: 'wad' };

        if (!wadExplorer.expandedWads.has(wad.path)) {
            handleToggleWad(wad.path);
        } else if (wad.status === 'idle') {
            loadWad(wad.path);
        } else {
            requestAnimationFrame(() => processNavigation());
        }
    }, [wadExplorer.wads, wadExplorer.expandedWads, handleToggleWad, loadWad, processNavigation]);

    const handleCheatSheetFilter = useCallback((path: string) => {
        setSearchMode('regex');
        setInputValue(path);
        useWadExplorerStore.getState().setSearch(path);
        setTimeout(() => searchRef.current?.focus(), 50);
    }, []);

    // ── Background bulk indexing for whole-game search ─────────────────────────
    useEffect(() => {
        if (wadExplorer.scanStatus !== 'ready') return;
        const idlePaths = wadExplorer.wads.filter(w => w.status === 'idle').map(w => w.path);
        if (idlePaths.length === 0) return;

        useWadExplorerStore.getState().batchSetWadStatuses(
            idlePaths.map(p => ({ wadPath: p, status: 'loading' as const })),
        );

        let cancelled = false;
        (async () => {
            try {
                const batches = await api.loadAllWadChunks(idlePaths);
                if (cancelled) return;
                useWadExplorerStore.getState().batchSetWadStatuses(
                    batches.map(b => ({
                        wadPath: b.path,
                        status: (b.error ? 'error' : 'loaded') as WadExplorerWad['status'],
                        chunks: b.chunks,
                        error: b.error ?? undefined,
                    })),
                );
            } catch (e) {
                if (cancelled) return;
                useWadExplorerStore.getState().batchSetWadStatuses(
                    idlePaths.map(p => ({
                        wadPath: p,
                        status: 'error' as const,
                        error: (e as Error).message,
                    })),
                );
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [wadExplorer.scanStatus]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleToggleFolder = useCallback((key: string) => {
        useWadExplorerStore.getState().toggleFolder(key);
    }, []);

    const handleDeepToggleFolder = useCallback((keys: string[], expand: boolean) => {
        useWadExplorerStore.getState().bulkSetFolders(keys, expand);
    }, []);

    const handleSelectFile = useCallback((wadPath: string, chunk: WadChunk) => {
        useWadExplorerStore.getState().setSelected(wadPath, chunk.hash);
    }, []);

    const handleToggleCheck = useCallback((keys: string[], checked: boolean) => {
        useWadExplorerStore.getState().toggleCheck(keys, checked);
    }, []);

    const handleSelectAll = useCallback(() => {
        const keys: string[] = [];
        for (const w of wadExplorer.wads) {
            if (w.status !== 'loaded') continue;
            if (hasQuery) {
                for (const c of w.chunks) {
                    if (matchChunk(c, searchRe, plainLower, searchMode)) keys.push(makeFileKey(w.path, c.hash));
                }
            } else {
                for (const c of w.chunks) keys.push(makeFileKey(w.path, c.hash));
            }
        }
        useWadExplorerStore.getState().toggleCheck(keys, true);
    }, [wadExplorer.wads, hasQuery, searchRe, plainLower, searchMode]);

    const handleDeselectAll = useCallback(() => {
        useWadExplorerStore.getState().clearChecks();
    }, []);

    /**
     * Shared progress state for the extract overlay. Every extract path
     * (selected files, single file, folder, full WAD, sniff-result row)
     * routes through `runExtract` so the user always sees the same overlay
     * with a spinner, progress bar, and current/total WAD counter.
     */
    type ExtractGroup = { wadPath: string; hashes: string[] | null; wadLabel?: string };
    const [extractProgress, setExtractProgress] = useState<{
        visible: boolean;
        title: string;
        currentLabel: string;
        currentIndex: number;
        totalGroups: number;
        extractedCount: number;
        plannedCount: number;
    } | null>(null);
    const extracting = !!extractProgress?.visible;

    // Persisted preference: when true, every extract destination is nested
    // under a `<wadName>/` folder so multi-WAD dumps don't pile loose
    // assets/data/ trees on top of each other. This mirrors how Obsidian /
    // Quartz lay out their extractions. Stored in localStorage so the
    // user's preference survives reloads — the in-menu submenu can override
    // it per-extraction.
    const [wrapInWadFolder, setWrapInWadFolder] = useState<boolean>(() => {
        try { return localStorage.getItem('flint.wadExplorer.wrapInWadFolder') !== 'false'; }
        catch { return true; }
    });
    const setWrapPref = useCallback((v: boolean) => {
        setWrapInWadFolder(v);
        try { localStorage.setItem('flint.wadExplorer.wrapInWadFolder', String(v)); } catch { /* ignore */ }
    }, []);

    /** Join a base dest with a wad filename so the extract lands in
     *  `<dest>/<wadName>/...`. Forward-slashes are fine on Rust side; the
     *  backend's WalkDir + create_dir_all handles either separator. */
    const wadFolderFor = (wadPath: string) =>
        wadPath.split(/[\\/]/).pop() ?? wadPath;

    const runExtract = useCallback(async (
        groups: ExtractGroup[],
        dest: string,
        title: string,
        opts?: { wrap?: boolean },
    ): Promise<number> => {
        const wrap = opts?.wrap ?? wrapInWadFolder;
        const plannedCount = groups.reduce((n, g) => n + (g.hashes?.length ?? 0), 0);
        setExtractProgress({
            visible: true,
            title,
            currentLabel: groups[0]?.wadLabel ?? groups[0]?.wadPath ?? '',
            currentIndex: 0,
            totalGroups: groups.length,
            extractedCount: 0,
            plannedCount,
        });
        let total = 0;
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            setExtractProgress((p) => p && {
                ...p,
                currentLabel: g.wadLabel ?? g.wadPath,
                currentIndex: i,
            });
            // Per-group wrap: each WAD gets its own folder when wrapping is
            // on. This is the only way to do a sensible multi-WAD dump —
            // otherwise files from different WADs collide on identical
            // internal paths (assets/, data/...).
            const groupDest = wrap
                ? `${dest.replace(/[\\/]+$/, '')}/${wadFolderFor(g.wadPath)}`
                : dest;
            const res = await api.extractWad(g.wadPath, groupDest, g.hashes);
            total += res.extracted;
            setExtractProgress((p) => p && { ...p, extractedCount: total, currentIndex: i + 1 });
        }
        // Brief hold so the bar visibly fills before the overlay disappears.
        await new Promise((r) => setTimeout(r, 240));
        setExtractProgress(null);
        return total;
    }, [wrapInWadFolder]);

    const handleExtractSelected = useCallback(async () => {
        const { checkedFiles } = wadExplorer;
        if (checkedFiles.size === 0) return;
        try {
            const dest = await open({ title: 'Choose Extraction Folder', directory: true });
            if (!dest) return;
            const map = new Map<string, string[]>();
            for (const key of checkedFiles) {
                const sep = key.indexOf('::');
                const wadPath = key.slice(0, sep);
                const hash = key.slice(sep + 2);
                const list = map.get(wadPath) ?? [];
                list.push(hash);
                map.set(wadPath, list);
            }
            const groups: ExtractGroup[] = Array.from(map.entries()).map(([wadPath, hashes]) => ({
                wadPath,
                hashes,
                wadLabel: wadPath.split(/[\\/]/).pop() ?? wadPath,
            }));
            const total = await runExtract(groups, dest as string, `Extracting ${checkedFiles.size} selected file${checkedFiles.size > 1 ? 's' : ''}`);
            showToast('success', `Extracted ${total} files from ${groups.length} WAD${groups.length > 1 ? 's' : ''}`);
            useWadExplorerStore.getState().clearChecks();
        } catch {
            setExtractProgress(null);
            showToast('error', 'Extraction failed');
        }
    }, [wadExplorer, showToast, runExtract]);

    // ── Search ───────────────────────────────────────────────────────────────
    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setInputValue(val);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            useWadExplorerStore.getState().setSearch(val);
        }, 300);
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.key === 'f' && currentView === 'wad-explorer') {
                e.preventDefault();
                searchRef.current?.focus();
                searchRef.current?.select();
            }
            if (e.key === 'Escape' && document.activeElement === searchRef.current) {
                setInputValue('');
                useWadExplorerStore.getState().setSearch('');
                searchRef.current?.blur();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [currentView]);

    // ── Context menus ────────────────────────────────────────────────────────
    /** Build the "Extract ▸" submenu for any extraction action. Default item
     *  uses the persisted preference; the two child items override it for
     *  the current click and update the preference (so the user's "I want
     *  wrapping today" choice sticks). */
    const buildExtractSubmenu = useCallback((
        run: (wrap: boolean) => Promise<void>,
    ): ContextMenuOption[] => [
        {
            label: 'Wrap in WAD folder',
            icon: getIcon('folder'),
            shortcut: wrapInWadFolder ? '✓' : undefined,
            onClick: () => { setWrapPref(true); void run(true); },
        },
        {
            label: 'Flat (no wrapper)',
            icon: getIcon('export'),
            shortcut: !wrapInWadFolder ? '✓' : undefined,
            onClick: () => { setWrapPref(false); void run(false); },
        },
    ], [wrapInWadFolder, setWrapPref]);

    const handleContextMenu = useCallback((chunk: WadChunk, wadPath: string, x: number, y: number) => {
        const key = makeFileKey(wadPath, chunk.hash);
        const isChecked = wadExplorer.checkedFiles.has(key);
        const checkedCount = wadExplorer.checkedFiles.size;
        const wadName = wadFolderFor(wadPath);

        const runExtractFile = async (wrap: boolean) => {
            try {
                const dest = await open({ title: 'Choose Extraction Folder', directory: true });
                if (!dest) return;
                const total = await runExtract(
                    [{ wadPath, hashes: [chunk.hash], wadLabel: wadName }],
                    dest as string,
                    `Extracting ${chunk.path ?? chunk.hash}`,
                    { wrap },
                );
                showToast('success', `Extracted ${total} file${total === 1 ? '' : 's'}${wrap ? ` → ${wadName}/` : ''}`);
            } catch { setExtractProgress(null); showToast('error', 'Extraction failed'); }
        };

        const options: ContextMenuOption[] = [];

        // ── Selection ──
        options.push({
            label: isChecked ? 'Uncheck' : 'Check',
            icon: getIcon(isChecked ? 'close' : 'check'),
            onClick: () => useWadExplorerStore.getState().toggleCheck([key], !isChecked),
        });

        // ── Extract ▸ ──
        options.push({
            label: 'Extract',
            icon: getIcon('export'),
            separator: true,
            onClick: () => runExtractFile(wrapInWadFolder),
            submenu: buildExtractSubmenu(runExtractFile),
        });
        if (checkedCount > 0) {
            options.push({
                label: `Extract Selected (${checkedCount})…`,
                icon: getIcon('export'),
                onClick: handleExtractSelected,
            });
        }

        // ── Copy ▸ ──
        const copySubmenu: ContextMenuOption[] = [];
        if (chunk.path) {
            copySubmenu.push({ label: 'Path', icon: getIcon('copy'), onClick: () => navigator.clipboard.writeText(chunk.path!) });
            copySubmenu.push({ label: 'File Name', icon: getIcon('file'), onClick: () => navigator.clipboard.writeText(chunk.path!.split('/').pop() ?? chunk.path!) });
        }
        copySubmenu.push({ label: 'Hash', icon: getIcon('copy'), onClick: () => navigator.clipboard.writeText(chunk.hash) });
        copySubmenu.push({ label: 'WAD Name', icon: getIcon('wad'), onClick: () => navigator.clipboard.writeText(wadName) });
        options.push({
            label: 'Copy',
            icon: getIcon('copy'),
            separator: true,
            submenu: copySubmenu,
        });

        openContextMenu(x, y, options);
    }, [openContextMenu, showToast, wadExplorer.checkedFiles, handleExtractSelected, runExtract, buildExtractSubmenu, wrapInWadFolder]);

    const handleFolderContextMenu = useCallback((folder: VFSFolder, wadPath: string, x: number, y: number) => {
        const fileKeys = collectFolderFileKeys(folder, wadPath);
        const folderCheckState = getFolderCheckState(folder, wadPath, wadExplorer.checkedFiles);
        const checkedCount = wadExplorer.checkedFiles.size;
        const hashes = collectFolderHashes(folder);
        const wadName = wadFolderFor(wadPath);

        const runExtractFolder = async (wrap: boolean) => {
            try {
                const dest = await open({ title: 'Choose Extraction Folder', directory: true });
                if (!dest) return;
                const total = await runExtract(
                    [{ wadPath, hashes, wadLabel: wadName }],
                    dest as string,
                    `Extracting ${hashes.length} file${hashes.length > 1 ? 's' : ''} from folder`,
                    { wrap },
                );
                showToast('success', `Extracted ${total} files${wrap ? ` → ${wadName}/` : ''}`);
            } catch { setExtractProgress(null); showToast('error', 'Extraction failed'); }
        };

        const options: ContextMenuOption[] = [];
        options.push({
            label: folderCheckState === 'all' ? 'Uncheck All in Folder' : 'Check All in Folder',
            icon: getIcon(folderCheckState === 'all' ? 'close' : 'check'),
            onClick: () => useWadExplorerStore.getState().toggleCheck(fileKeys, folderCheckState !== 'all'),
        });
        options.push({
            label: `Extract Folder (${hashes.length})`,
            icon: getIcon('export'),
            separator: true,
            onClick: () => runExtractFolder(wrapInWadFolder),
            submenu: buildExtractSubmenu(runExtractFolder),
        });
        if (checkedCount > 0) {
            options.push({
                label: `Extract Selected (${checkedCount})…`,
                icon: getIcon('export'),
                onClick: handleExtractSelected,
            });
        }
        // Folder path lives in the VFS key: `${wadPath}::${folderPath}`
        const folderPath = folder.key.split('::').slice(1).join('::') || folder.name;
        options.push({
            label: 'Copy',
            icon: getIcon('copy'),
            separator: true,
            submenu: [
                { label: 'Folder Path', icon: getIcon('code'), onClick: () => navigator.clipboard.writeText(folderPath) },
                { label: 'Folder Name', icon: getIcon('folder'), onClick: () => navigator.clipboard.writeText(folder.name) },
                { label: 'WAD Name', icon: getIcon('wad'), onClick: () => navigator.clipboard.writeText(wadName) },
            ],
        });
        openContextMenu(x, y, options);
    }, [openContextMenu, showToast, wadExplorer.checkedFiles, handleExtractSelected, runExtract, buildExtractSubmenu, wrapInWadFolder]);

    const handleWadContextMenu = useCallback((wad: WadExplorerWad, x: number, y: number) => {
        const wadCheckState = getWadCheckState(wad, wadExplorer.checkedFiles);
        const checkedCount = wadExplorer.checkedFiles.size;
        const wadFileKeys = wad.status === 'loaded' ? wad.chunks.map(c => makeFileKey(wad.path, c.hash)) : [];
        const wadName = wadFolderFor(wad.path);
        const loaded = wad.status === 'loaded';

        const runExtractWad = async (wrap: boolean) => {
            try {
                const dest = await open({ title: 'Choose Extraction Folder', directory: true });
                if (!dest) return;
                const total = await runExtract(
                    [{ wadPath: wad.path, hashes: null, wadLabel: wadName }],
                    dest as string,
                    `Extracting full WAD: ${wadName}`,
                    { wrap },
                );
                showToast('success', `Extracted ${total} files${wrap ? ` → ${wadName}/` : ''}`);
            } catch { setExtractProgress(null); showToast('error', 'Extraction failed'); }
        };

        const options: ContextMenuOption[] = [];

        // ── Selection ──
        options.push({
            label: wadCheckState === 'all' ? 'Uncheck All in WAD' : 'Check All in WAD',
            icon: getIcon(wadCheckState === 'all' ? 'close' : 'check'),
            onClick: () => useWadExplorerStore.getState().toggleCheck(wadFileKeys, wadCheckState !== 'all'),
            disabled: !loaded,
        });

        // ── Extract ▸ ──
        options.push({
            label: 'Extract WAD',
            icon: getIcon('export'),
            separator: true,
            disabled: !loaded,
            onClick: () => runExtractWad(wrapInWadFolder),
            submenu: buildExtractSubmenu(runExtractWad),
        });
        if (checkedCount > 0) {
            options.push({
                label: `Extract Selected (${checkedCount})…`,
                icon: getIcon('export'),
                onClick: handleExtractSelected,
            });
        }

        // ── WAD lifecycle ▸ ──
        options.push({
            label: 'WAD',
            icon: getIcon('wad'),
            separator: true,
            submenu: [
                {
                    label: 'Reload',
                    icon: getIcon('refresh'),
                    disabled: !loaded,
                    onClick: async () => {
                        try {
                            await api.invalidateWadCache(wad.path);
                            useWadExplorerStore.getState().setWadStatus(wad.path, 'loading');
                            const chunks = await api.getWadChunks(wad.path);
                            useWadExplorerStore.getState().setWadStatus(wad.path, 'loaded', chunks);
                            showToast('success', 'WAD reloaded');
                        } catch (e) {
                            useWadExplorerStore.getState().setWadStatus(wad.path, 'error', undefined, (e as Error).message);
                            showToast('error', 'Failed to reload WAD');
                        }
                    },
                },
                {
                    label: 'Reveal in Explorer',
                    icon: getIcon('folderOpen2'),
                    onClick: () => api.openInExplorer(wad.path).catch(() => {}),
                },
            ],
        });

        // ── Copy ▸ ──
        options.push({
            label: 'Copy',
            icon: getIcon('copy'),
            separator: true,
            submenu: [
                {
                    label: 'WAD Path',
                    icon: getIcon('code'),
                    onClick: () => {
                        navigator.clipboard.writeText(wad.path);
                        showToast('success', 'WAD path copied');
                    },
                },
                {
                    label: 'WAD Name',
                    icon: getIcon('wad'),
                    onClick: () => navigator.clipboard.writeText(wadName),
                },
            ],
        });

        openContextMenu(x, y, options);
    }, [openContextMenu, showToast, wadExplorer.checkedFiles, handleExtractSelected, runExtract, buildExtractSubmenu, wrapInWadFolder]);

    // ── Resizer ───────────────────────────────────────────────────────────────
    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!isResizingRef.current) return;
            setLeftWidth(Math.min(800, Math.max(200, e.clientX)));
        };
        const onUp = () => {
            if (isResizingRef.current) {
                isResizingRef.current = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    }, []);

    // ── Current selection ────────────────────────────────────────────────────
    const selectedWad = wadExplorer.selected
        ? wadExplorer.wads.find(w => w.path === wadExplorer.selected!.wadPath)
        : null;
    const selectedChunk = selectedWad?.status === 'loaded'
        ? selectedWad.chunks.find(c => c.hash === wadExplorer.selected!.hash) ?? null
        : null;

    // ── Search results (grouped by WAD → folder) ──────────────────────────
    const [collapsedSearchWads, setCollapsedSearchWads] = useState<Set<string>>(new Set());
    const [collapsedSearchFolders, setCollapsedSearchFolders] = useState<Set<string>>(new Set());

    const groupedSearchResults = useMemo(() => {
        if (!trimmed) return null;

        const wadGroups: Array<{
            wadPath: string;
            wadName: string;
            folders: Array<{
                folderPath: string;
                files: Array<{ chunk: WadChunk; fileName: string }>;
            }>;
            totalMatches: number;
        }> = [];

        let totalCapped = 0;
        const MAX_RESULTS = 5000;

        for (const w of wadExplorer.wads) {
            if (w.status !== 'loaded') continue;
            const folderMap = new Map<string, Array<{ chunk: WadChunk; fileName: string }>>();

            for (const chunk of w.chunks) {
                if (totalCapped >= MAX_RESULTS) break;
                if (!matchChunk(chunk, searchRe, plainLower, searchMode)) continue;

                const fullPath = (chunk.path ?? chunk.hash).replace(/\\/g, '/');
                const lastSlash = fullPath.lastIndexOf('/');
                const folderPath = lastSlash >= 0 ? fullPath.slice(0, lastSlash) : '';
                const fileName = lastSlash >= 0 ? fullPath.slice(lastSlash + 1) : fullPath;

                let folder = folderMap.get(folderPath);
                if (!folder) { folder = []; folderMap.set(folderPath, folder); }
                folder.push({ chunk, fileName });
                totalCapped++;
            }

            if (folderMap.size > 0) {
                const folders = Array.from(folderMap.entries())
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([fp, files]) => ({ folderPath: fp, files }));
                const totalMatches = folders.reduce((s, f) => s + f.files.length, 0);
                wadGroups.push({ wadPath: w.path, wadName: w.name, folders, totalMatches });
            }
            if (totalCapped >= MAX_RESULTS) break;
        }

        return wadGroups;
    }, [wadExplorer.wads, trimmed, searchMode, inputValue]); // eslint-disable-line react-hooks/exhaustive-deps

    const searchResultCount = useMemo(() => {
        if (!groupedSearchResults) return 0;
        return groupedSearchResults.reduce((s, g) => s + g.totalMatches, 0);
    }, [groupedSearchResults]);

    // ── Grouped WAD categories for tree ─────────────────────────────────────
    const categories = useMemo(() => {
        const map = new Map<string, WadExplorerWad[]>();
        for (const w of wadExplorer.wads) {
            const list = map.get(w.category) ?? [];
            list.push(w);
            map.set(w.category, list);
        }
        return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
    }, [wadExplorer.wads]);

    // When non-regex searching, also filter the WAD tree by name so unloaded
    // WADs (which can't contribute to file-level results) stay reachable.
    const filteredCategories = useMemo(() => {
        if (!hasQuery || isRegex) return null;
        const result: [string, WadExplorerWad[]][] = [];
        for (const [cat, wads] of categories) {
            const matching = wads.filter(w => {
                const name = w.name.toLowerCase();
                return searchMode === 'starts' ? name.startsWith(plainLower) : name.includes(plainLower);
            });
            if (matching.length > 0) result.push([cat, matching]);
        }
        return result;
    }, [hasQuery, isRegex, searchMode, categories, plainLower]);

    // ── WAD subtrees (lazily built per WAD, cached by chunks reference) ────
    const vfsCacheRef = useRef<Map<string, { chunks: WadChunk[]; tree: VFSNode[] }>>(new Map());
    const wadSubtrees = useMemo(() => {
        const cache = vfsCacheRef.current;
        const m = new Map<string, VFSNode[]>();
        for (const w of wadExplorer.wads) {
            if (w.status !== 'loaded') continue;
            if (!wadExplorer.expandedWads.has(w.path)) continue;
            const cached = cache.get(w.path);
            if (cached && cached.chunks === w.chunks) {
                m.set(w.path, cached.tree);
            } else {
                const tree = buildVFSSubtree(w.chunks, w.path);
                cache.set(w.path, { chunks: w.chunks, tree });
                m.set(w.path, tree);
            }
        }
        return m;
    }, [wadExplorer.wads, wadExplorer.expandedWads]);

    // ── O(1) WAD check state (no full chunk walk) ─────────────────────────
    const checkedCountPerWad = wadExplorer.checkedCountPerWad;
    const getWadCheckStateFast = useCallback(
        (wad: WadExplorerWad): 'none' | 'some' | 'all' => {
            if (wad.status !== 'loaded' || wad.chunks.length === 0) return 'none';
            const count = checkedCountPerWad.get(wad.path) ?? 0;
            if (count === 0) return 'none';
            if (count >= wad.chunks.length) return 'all';
            return 'some';
        },
        [checkedCountPerWad],
    );

    const toolbarCheckState = useMemo((): 'none' | 'some' | 'all' => {
        if (wadExplorer.checkedFiles.size === 0) return 'none';
        let total = 0;
        for (const w of wadExplorer.wads) {
            if (w.status !== 'loaded') continue;
            total += w.chunks.length;
        }
        if (total === 0) return 'none';
        if (wadExplorer.checkedFiles.size >= total) return 'all';
        return 'some';
    }, [wadExplorer.wads, wadExplorer.checkedFiles]);

    // ── Lazy folder/search check-state caches ─────────────────────────────
    const folderCheckStateCacheRef = useRef<WeakMap<VFSFolder, 'none' | 'some' | 'all'>>(
        new WeakMap(),
    );
    const searchCheckStateCacheRef = useRef<Map<string, 'none' | 'some' | 'all'>>(new Map());
    useMemo(() => {
        folderCheckStateCacheRef.current = new WeakMap();
        searchCheckStateCacheRef.current = new Map();
    }, [wadExplorer.checkedFiles]);

    const getFolderCheckStateLazy = useCallback(
        (node: VFSFolder, wadPath: string): 'none' | 'some' | 'all' => {
            const cache = folderCheckStateCacheRef.current;
            const cached = cache.get(node);
            if (cached !== undefined) return cached;
            const state = getFolderCheckState(node, wadPath, wadExplorer.checkedFiles);
            cache.set(node, state);
            return state;
        },
        [wadExplorer.checkedFiles],
    );

    const getSearchCheckStateLazy = useCallback(
        (cacheKey: string, getKeys: () => string[]): 'none' | 'some' | 'all' => {
            const cache = searchCheckStateCacheRef.current;
            const cached = cache.get(cacheKey);
            if (cached !== undefined) return cached;
            const state = getCheckStateForKeys(getKeys(), wadExplorer.checkedFiles);
            cache.set(cacheKey, state);
            return state;
        },
        [wadExplorer.checkedFiles],
    );

    // ── Memoized flat rows (tree mode) ───────────────────────────────────────
    const isSearching = groupedSearchResults !== null;
    const flatRows = useMemo(() => {
        if (isSearching) return null;
        return flattenTree(
            filteredCategories ?? categories,
            collapsedCategories,
            wadExplorer.expandedWads,
            wadExplorer.expandedFolders,
            wadSubtrees,
        );
    }, [isSearching, filteredCategories, categories, collapsedCategories, wadExplorer.expandedWads, wadExplorer.expandedFolders, wadSubtrees]);
    flatRowsRef.current = flatRows;

    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { processNavigation(); }, [flatRows, processNavigation]);

    // ── Memoized flat rows (search mode) ─────────────────────────────────────
    const flatSearchRows = useMemo(() => {
        if (!groupedSearchResults) return null;
        return flattenSearchResults(groupedSearchResults, collapsedSearchWads, collapsedSearchFolders);
    }, [groupedSearchResults, collapsedSearchWads, collapsedSearchFolders]);

    const totalRows = isSearching ? (flatSearchRows?.length ?? 0) : (flatRows?.length ?? 0);

    // ── Stable renderRow ref (prevents VirtualizedList re-renders) ───────────
    const renderRowRef = useRef<(index: number) => React.ReactNode>(() => null);
    const stableRenderRow = useCallback((index: number) => renderRowRef.current(index), []);
    const renderEpoch = useMemo(() => Date.now(), [
        wadExplorer.checkedFiles,
        wadExplorer.selected,
        wadExplorer.expandedWads,
        wadExplorer.expandedFolders,
        highlightedKey,
        collapsedCategories,
        collapsedSearchWads,
        collapsedSearchFolders,
        groupedSearchResults,
        flatRows,
        flatSearchRows,
    ]);

    // ─────────────────────────────────────────────────────────────────────────
    // Row renderers (assigned to ref so VirtualizedList never sees prop change)
    // ─────────────────────────────────────────────────────────────────────────

    renderRowRef.current = (index: number) => {
        if (isSearching && flatSearchRows) {
            const row = flatSearchRows[index];
            if (!row) return null;
            switch (row.kind) {
                case 'search-wad': {
                    const isWadCollapsed = collapsedSearchWads.has(row.wadPath);
                    const checkState = getSearchCheckStateLazy(row.wadPath, () =>
                        row.folders.flatMap(f => f.files.map(m => makeFileKey(row.wadPath, m.chunk.hash))),
                    );
                    return (
                        <div
                            className="file-tree__item"
                            style={{ padding: '4px 8px 2px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', userSelect: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                            onClick={() => setCollapsedSearchWads(prev => {
                                const next = new Set(prev);
                                if (next.has(row.wadPath)) next.delete(row.wadPath); else next.add(row.wadPath);
                                return next;
                            })}
                            onContextMenu={e => {
                                e.preventDefault();
                                const wad = wadExplorer.wads.find(w => w.path === row.wadPath);
                                if (wad) handleWadContextMenu(wad, e.clientX, e.clientY);
                            }}
                        >
                            <span dangerouslySetInnerHTML={{ __html: getIcon(isWadCollapsed ? 'chevronRight' : 'chevronDown') }} />
                            <span
                                className="file-tree__checkbox"
                                style={{ cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}
                                dangerouslySetInnerHTML={{ __html: checkboxSvg(checkState) }}
                                onClick={e => {
                                    e.stopPropagation();
                                    const matchKeys = row.folders.flatMap(f => f.files.map(m => makeFileKey(row.wadPath, m.chunk.hash)));
                                    handleToggleCheck(matchKeys, checkState !== 'all');
                                }}
                            />
                            <span className="file-tree__icon" dangerouslySetInnerHTML={{ __html: getIcon('wad') }} />
                            <span style={{ flex: 1, textTransform: 'none', letterSpacing: 0, fontWeight: 500, fontSize: '11px' }}>{row.wadName}</span>
                            <span style={{ fontSize: '9px', opacity: 0.5, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                                {row.totalMatches}
                            </span>
                        </div>
                    );
                }
                case 'search-folder': {
                    const folderKey = `${row.wadPath}::s::${row.folderPath}`;
                    const isFolderCollapsed = collapsedSearchFolders.has(folderKey);
                    const checkState = getSearchCheckStateLazy(folderKey, () => {
                        const group = groupedSearchResults?.find(g => g.wadPath === row.wadPath);
                        const folder = group?.folders.find(f => f.folderPath === row.folderPath);
                        return folder?.files.map(f => makeFileKey(row.wadPath, f.chunk.hash)) ?? [];
                    });
                    return (
                        <div
                            className="file-tree__item"
                            style={{ paddingLeft: '22px' }}
                            onClick={() => setCollapsedSearchFolders(prev => {
                                const next = new Set(prev);
                                if (next.has(folderKey)) next.delete(folderKey); else next.add(folderKey);
                                return next;
                            })}
                            onContextMenu={e => {
                                e.preventDefault();
                                const group = groupedSearchResults?.find(g => g.wadPath === row.wadPath);
                                const folder = group?.folders.find(f => f.folderPath === row.folderPath);
                                if (!folder) return;
                                const fileKeys = folder.files.map(f => makeFileKey(row.wadPath, f.chunk.hash));
                                const hashes = folder.files.map(f => f.chunk.hash);
                                const fcs = getSearchCheckStateLazy(folderKey, () => fileKeys);
                                const wadName = wadFolderFor(row.wadPath);
                                const runExtractFolder = async (wrap: boolean) => {
                                    try {
                                        const dest = await open({ title: 'Choose Extraction Folder', directory: true });
                                        if (!dest) return;
                                        const total = await runExtract(
                                            [{ wadPath: row.wadPath, hashes, wadLabel: wadName }],
                                            dest as string,
                                            `Extracting ${hashes.length} file${hashes.length > 1 ? 's' : ''} from folder`,
                                            { wrap },
                                        );
                                        showToast('success', `Extracted ${total} files${wrap ? ` → ${wadName}/` : ''}`);
                                    } catch { setExtractProgress(null); showToast('error', 'Extraction failed'); }
                                };
                                const options: ContextMenuOption[] = [
                                    {
                                        label: fcs === 'all' ? 'Uncheck All in Folder' : 'Check All in Folder',
                                        icon: getIcon(fcs === 'all' ? 'close' : 'check'),
                                        onClick: () => handleToggleCheck(fileKeys, fcs !== 'all'),
                                    },
                                    {
                                        label: `Extract Folder (${hashes.length})`,
                                        icon: getIcon('export'),
                                        separator: true,
                                        onClick: () => runExtractFolder(wrapInWadFolder),
                                        submenu: buildExtractSubmenu(runExtractFolder),
                                    },
                                ];
                                if (wadExplorer.checkedFiles.size > 0) {
                                    options.push({
                                        label: `Extract Selected (${wadExplorer.checkedFiles.size})…`,
                                        icon: getIcon('export'),
                                        onClick: handleExtractSelected,
                                    });
                                }
                                openContextMenu(e.clientX, e.clientY, options);
                            }}
                        >
                            <span className="file-tree__chevron" dangerouslySetInnerHTML={{ __html: getIcon(isFolderCollapsed ? 'chevronRight' : 'chevronDown') }} />
                            <span
                                className="file-tree__checkbox"
                                style={{ cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}
                                dangerouslySetInnerHTML={{ __html: checkboxSvg(checkState) }}
                                onClick={e => {
                                    e.stopPropagation();
                                    const group = groupedSearchResults?.find(g => g.wadPath === row.wadPath);
                                    const folder = group?.folders.find(f => f.folderPath === row.folderPath);
                                    if (!folder) return;
                                    const fKeys = folder.files.map(f => makeFileKey(row.wadPath, f.chunk.hash));
                                    handleToggleCheck(fKeys, checkState !== 'all');
                                }}
                            />
                            <span className="file-tree__icon" dangerouslySetInnerHTML={{ __html: getIcon(isFolderCollapsed ? 'folder' : 'folderOpen') }} />
                            <span className="file-tree__name" style={{ fontSize: '11px' }}>{row.folderPath}</span>
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)', paddingRight: '4px', flexShrink: 0 }}>
                                {row.fileCount}
                            </span>
                        </div>
                    );
                }
                case 'search-file': {
                    const isSelected = wadExplorer.selected?.hash === row.chunk.hash && wadExplorer.selected?.wadPath === row.wadPath;
                    const isChecked = wadExplorer.checkedFiles.has(makeFileKey(row.wadPath, row.chunk.hash));
                    const isHighlighted = highlightedKey === `${row.wadPath}::${row.chunk.hash}`;
                    return (
                        <div
                            className={`file-tree__item${isSelected ? ' file-tree__item--selected' : ''}${isHighlighted ? ' file-tree__item--highlighted' : ''}`}
                            style={{ paddingLeft: row.folderPath ? '44px' : '22px' }}
                            title={`${row.chunk.path ?? row.chunk.hash}\nSize: ${formatBytes(row.chunk.size)}`}
                            onClick={() => { if (isHighlighted) setHighlightedKey(null); handleSelectFile(row.wadPath, row.chunk); }}
                            onContextMenu={e => { e.preventDefault(); handleContextMenu(row.chunk, row.wadPath, e.clientX, e.clientY); }}
                        >
                            <span
                                className="file-tree__checkbox"
                                style={{ cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}
                                dangerouslySetInnerHTML={{ __html: checkboxSvg(isChecked ? 'all' : 'none') }}
                                onClick={e => {
                                    e.stopPropagation();
                                    handleToggleCheck([makeFileKey(row.wadPath, row.chunk.hash)], !isChecked);
                                }}
                            />
                            <span className="file-tree__icon" dangerouslySetInnerHTML={{ __html: getFileIcon(row.fileName, false) }} />
                            <span className="file-tree__name" style={{ flex: 1, minWidth: 0 }}>{row.fileName}</span>
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)', paddingRight: '4px', flexShrink: 0 }}>
                                {formatBytes(row.chunk.size)}
                            </span>
                        </div>
                    );
                }
            }
            return null;
        }

        if (flatRows) {
            const row = flatRows[index];
            if (!row) return null;
            switch (row.kind) {
                case 'category': {
                    const isCatCollapsed = collapsedCategories.has(row.cat);
                    return (
                        <div
                            className="file-tree__item"
                            style={{ padding: '4px 8px 2px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', userSelect: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                            onClick={() => handleToggleCategory(row.cat)}
                        >
                            <span dangerouslySetInnerHTML={{ __html: getIcon(isCatCollapsed ? 'chevronRight' : 'chevronDown') }} />
                            <span style={{ flex: 1 }}>{row.cat}</span>
                            <span style={{ fontSize: '9px', opacity: 0.5, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                                {row.loadedCount}/{row.totalCount}
                            </span>
                        </div>
                    );
                }
                case 'wad': {
                    const wad = row.wad;
                    const isExp = wadExplorer.expandedWads.has(wad.path);
                    const isHighlighted = highlightedKey === wad.path;
                    return (
                        <div
                            className={`file-tree__item${isHighlighted ? ' file-tree__item--highlighted' : ''}`}
                            style={{ paddingLeft: '8px' }}
                            onClick={() => { if (isHighlighted) setHighlightedKey(null); handleToggleWad(wad.path); }}
                            onContextMenu={e => { e.preventDefault(); handleWadContextMenu(wad, e.clientX, e.clientY); }}
                            title={wad.path}
                        >
                            <span className="file-tree__chevron" dangerouslySetInnerHTML={{ __html: getIcon(isExp ? 'chevronDown' : 'chevronRight') }} />
                            <span
                                className="file-tree__checkbox"
                                style={{ cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}
                                dangerouslySetInnerHTML={{ __html: checkboxSvg(getWadCheckStateFast(wad)) }}
                                onClick={e => {
                                    e.stopPropagation();
                                    if (wad.status === 'loaded') {
                                        const keys = wad.chunks.map(c => makeFileKey(wad.path, c.hash));
                                        handleToggleCheck(keys, getWadCheckStateFast(wad) !== 'all');
                                    }
                                }}
                            />
                            <span className="file-tree__icon" dangerouslySetInnerHTML={{ __html: getIcon('wad') }} />
                            <span className="file-tree__name" style={{ flex: 1 }}>{wad.name}</span>
                            {wad.status === 'loading' && <span style={{ fontSize: '10px', opacity: 0.5, marginRight: '4px' }}>···</span>}
                            {wad.status === 'loaded' && <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginRight: '4px' }}>{wad.chunks.length.toLocaleString()}</span>}
                            {wad.status === 'error' && <span style={{ fontSize: '10px', color: 'var(--error, #f44)', marginRight: '4px' }} title={wad.error}>!</span>}
                        </div>
                    );
                }
                case 'wad-loading':
                    return (
                        <div style={{ paddingLeft: '24px', padding: '4px 24px', fontSize: '11px', color: 'var(--text-muted)' }}>
                            <div className="spinner" style={{ display: 'inline-block', width: '12px', height: '12px', marginRight: '6px', verticalAlign: 'middle' }} />
                            Loading chunks…
                        </div>
                    );
                case 'wad-error':
                    return (
                        <div style={{ paddingLeft: '24px', fontSize: '11px', color: 'var(--error, #f44)', padding: '4px 24px' }}>
                            {row.error}
                        </div>
                    );
                case 'folder': {
                    const indent = row.depth * 14;
                    const isExp = wadExplorer.expandedFolders.has(row.effectiveNode.key);
                    const folderCheckState = row.wadPath
                        ? getFolderCheckStateLazy(row.effectiveNode, row.wadPath)
                        : 'none';
                    return (
                        <div
                            className="file-tree__item"
                            style={{ paddingLeft: `${8 + indent}px` }}
                            onClick={(e: React.MouseEvent) => {
                                if (e.shiftKey) {
                                    const allKeys = collectAllVFSFolderKeys(row.effectiveNode);
                                    handleDeepToggleFolder(allKeys, !isExp);
                                } else {
                                    handleToggleFolder(row.effectiveNode.key);
                                }
                            }}
                            onContextMenu={e => {
                                e.preventDefault();
                                if (row.wadPath) handleFolderContextMenu(row.effectiveNode, row.wadPath, e.clientX, e.clientY);
                            }}
                        >
                            <span className="file-tree__chevron" dangerouslySetInnerHTML={{ __html: getIcon(isExp ? 'chevronDown' : 'chevronRight') }} />
                            <span
                                className="file-tree__checkbox"
                                style={{ cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}
                                dangerouslySetInnerHTML={{ __html: checkboxSvg(folderCheckState) }}
                                onClick={e => {
                                    e.stopPropagation();
                                    if (!row.wadPath) return;
                                    const keys = collectFolderFileKeys(row.effectiveNode, row.wadPath);
                                    handleToggleCheck(keys, folderCheckState !== 'all');
                                }}
                            />
                            <span className="file-tree__icon" dangerouslySetInnerHTML={{ __html: getIcon(isExp ? 'folderOpen' : 'folder') }} />
                            <span className="file-tree__name">
                                {row.displayPath.includes('/') ? (
                                    row.displayPath.split('/').map((segment, idx, arr) => (
                                        <React.Fragment key={idx}>
                                            <span className="file-tree__compact-segment">{segment}</span>
                                            {idx < arr.length - 1 && <span className="file-tree__compact-separator">/</span>}
                                        </React.Fragment>
                                    ))
                                ) : (
                                    row.displayPath
                                )}
                            </span>
                        </div>
                    );
                }
                case 'file': {
                    const indent = row.depth * 14;
                    const node = row.node;
                    const isSelected = node.chunk.hash === wadExplorer.selected?.hash && node.wadPath === wadExplorer.selected?.wadPath;
                    const isChecked = wadExplorer.checkedFiles.has(makeFileKey(node.wadPath, node.chunk.hash));
                    const isHighlighted = highlightedKey === `${node.wadPath}::${node.chunk.hash}`;
                    const tooltip = node.chunk.path
                        ? `${node.chunk.path}\nHash: ${node.chunk.hash}\nSize: ${formatBytes(node.chunk.size)}`
                        : `Hash: ${node.chunk.hash}\nSize: ${formatBytes(node.chunk.size)}`;
                    return (
                        <div
                            className={`file-tree__item${isSelected ? ' file-tree__item--selected' : ''}${isHighlighted ? ' file-tree__item--highlighted' : ''}`}
                            style={{ paddingLeft: `${8 + indent + 16}px` }}
                            title={tooltip}
                            onClick={() => { if (isHighlighted) setHighlightedKey(null); handleSelectFile(node.wadPath, node.chunk); }}
                            onContextMenu={e => { e.preventDefault(); handleContextMenu(node.chunk, node.wadPath, e.clientX, e.clientY); }}
                        >
                            <span
                                className="file-tree__checkbox"
                                style={{ cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}
                                dangerouslySetInnerHTML={{ __html: checkboxSvg(isChecked ? 'all' : 'none') }}
                                onClick={e => {
                                    e.stopPropagation();
                                    handleToggleCheck([makeFileKey(node.wadPath, node.chunk.hash)], !isChecked);
                                }}
                            />
                            <span className="file-tree__icon" dangerouslySetInnerHTML={{ __html: getFileIcon(node.name, false) }} />
                            <span className="file-tree__name" style={{ flex: 1, minWidth: 0 }}>{node.name}</span>
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)', paddingRight: '4px', flexShrink: 0 }}>
                                {formatBytes(node.chunk.size)}
                            </span>
                        </div>
                    );
                }
            }
        }
        return null;
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Render
    // ─────────────────────────────────────────────────────────────────────────

    return (
        <>
        <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>
            {/* ── LEFT: VFS tree ── */}
            <div className="left-panel" style={{ width: leftWidth, minWidth: 200, maxWidth: 800, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
                <div className="left-panel__header" style={{ padding: '10px 12px 6px', flexShrink: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                        <span dangerouslySetInnerHTML={{ __html: getIcon('wad') }} />
                        <span style={{ fontSize: '12px', fontWeight: 600, flex: 1 }}>WAD Explorer</span>
                        <button
                            className="btn btn--sm"
                            title="Asset Path Cheat Sheet"
                            onClick={() => setShowCheatSheet(true)}
                            style={{ fontSize: '11px', padding: '1px 6px', opacity: 0.7, fontWeight: 600 }}
                        >?</button>
                        <div
                            className="wad-explorer__branch-toggle"
                            role="tablist"
                            aria-label="WAD source branch"
                            title={configStore.leaguePathPbe
                                ? 'Switch between Live and PBE game folders. Cached on swap.'
                                : 'Set a PBE League path in Settings (Ctrl+,) to enable PBE.'}
                        >
                            <button
                                role="tab"
                                aria-selected={branch === 'live'}
                                className={`wad-explorer__branch-btn${branch === 'live' ? ' wad-explorer__branch-btn--active' : ''}`}
                                onClick={() => handleSwitchBranch('live')}
                            >Live</button>
                            <button
                                role="tab"
                                aria-selected={branch === 'pbe'}
                                className={`wad-explorer__branch-btn${branch === 'pbe' ? ' wad-explorer__branch-btn--active' : ''}${!configStore.leaguePathPbe ? ' wad-explorer__branch-btn--disabled' : ''}`}
                                onClick={() => handleSwitchBranch('pbe')}
                            >PBE</button>
                        </div>
                        {wadExplorer.scanStatus === 'scanning' && (
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)', opacity: 0.7 }}>Scanning…</span>
                        )}
                        {wadExplorer.scanStatus === 'idle' && !effectiveLeagueRoot && (
                            <button className="btn btn--sm" onClick={handlePickGamePath} title="Select game folder" style={{ fontSize: '10px', padding: '2px 6px' }}>
                                Pick folder
                            </button>
                        )}
                    </div>
                    <div className="file-tree__search" style={{ position: 'relative' }}>
                        <span style={{ position: 'absolute', left: '6px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.5 }}
                            dangerouslySetInnerHTML={{ __html: getIcon('search') }} />
                        <input
                            ref={searchRef}
                            type="text"
                            className="file-tree__search-input"
                            placeholder={
                                searchMode === 'regex' ? 'Regex filter… (Ctrl+F)'
                                    : searchMode === 'starts' ? 'Starts with… (Ctrl+F)'
                                        : 'Filter files… (Ctrl+F)'
                            }
                            value={inputValue}
                            onChange={handleInputChange}
                            style={{ paddingLeft: '26px', paddingRight: '76px', width: '100%', borderColor: regexError ? 'var(--error, #f44)' : undefined }}
                        />
                        <button
                            className={`btn btn--sm ${searchMode === 'starts' ? 'btn--active' : ''}`}
                            onClick={() => setSearchMode(m => m === 'starts' ? 'contains' : 'starts')}
                            title={searchMode === 'starts' ? 'Starts-with mode (click to disable)' : 'Match files whose name starts with the query'}
                            style={{ position: 'absolute', right: '38px', top: '50%', transform: 'translateY(-50%)', padding: '4px 8px', fontSize: '13px', fontFamily: 'monospace', minWidth: '28px', height: '24px', lineHeight: 1 }}
                        >^</button>
                        <button
                            className={`btn btn--sm ${searchMode === 'regex' ? 'btn--active' : ''}`}
                            onClick={() => setSearchMode(m => m === 'regex' ? 'contains' : 'regex')}
                            title={searchMode === 'regex' ? 'Regex mode (click to disable)' : 'Regex mode'}
                            style={{ position: 'absolute', right: '4px', top: '50%', transform: 'translateY(-50%)', padding: '4px 8px', fontSize: '13px', fontFamily: 'monospace', minWidth: '28px', height: '24px', lineHeight: 1 }}
                        >.*</button>
                    </div>
                </div>

                {wadExplorer.scanStatus === 'ready' && (
                    <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border)', padding: '4px 12px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
                        <span
                            style={{ cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}
                            dangerouslySetInnerHTML={{ __html: checkboxSvg(toolbarCheckState) }}
                            onClick={() => {
                                if (toolbarCheckState === 'all') handleDeselectAll();
                                else handleSelectAll();
                            }}
                            title={toolbarCheckState !== 'none' ? 'Deselect all' : 'Select all'}
                        />
                        {wadExplorer.checkedFiles.size > 0 ? (
                            <>
                                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                                    {wadExplorer.checkedFiles.size.toLocaleString()} selected
                                </span>
                                <div style={{ flex: 1 }} />
                                <button className="btn btn--sm" onClick={handleDeselectAll} style={{ fontSize: '10px', padding: '2px 6px' }}>
                                    Deselect All
                                </button>
                                <button className="btn btn--sm btn--primary" onClick={handleExtractSelected} disabled={extracting} style={{ fontSize: '10px', padding: '2px 8px' }}>
                                    <span dangerouslySetInnerHTML={{ __html: getIcon('export') }} />
                                    <span>{extracting ? 'Extracting…' : 'Extract Selected'}</span>
                                </button>
                            </>
                        ) : (
                            <span style={{ color: 'var(--text-muted)' }}>Select files to extract</span>
                        )}
                    </div>
                )}

                <div className="file-tree" style={{ flex: 1, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {wadExplorer.scanStatus === 'idle' && effectiveLeagueRoot && (
                        <div className="wad-empty">
                            <span className="wad-empty__icon" dangerouslySetInnerHTML={{ __html: getIcon('refresh') }} />
                            <strong className="wad-empty__title">Preparing scan…</strong>
                            <span className="wad-empty__desc">Indexing the game directory.</span>
                        </div>
                    )}
                    {wadExplorer.scanStatus === 'scanning' && (
                        <div className="wad-empty">
                            <div className="spinner wad-empty__spinner" />
                            <strong className="wad-empty__title">Scanning game directory</strong>
                            <span className="wad-empty__desc">Locating WAD archives…</span>
                        </div>
                    )}
                    {wadExplorer.scanStatus === 'error' && (
                        <div className="wad-empty wad-empty--error">
                            <span className="wad-empty__icon" dangerouslySetInnerHTML={{ __html: getIcon('error') }} />
                            <strong className="wad-empty__title">Scan failed</strong>
                            <span className="wad-empty__desc">{wadExplorer.scanError}</span>
                            <button className="btn btn--sm" onClick={handlePickGamePath}>Pick game folder</button>
                        </div>
                    )}
                    {wadExplorer.scanStatus === 'idle' && !effectiveLeagueRoot && (
                        <div className="wad-empty">
                            <span className="wad-empty__icon" dangerouslySetInnerHTML={{ __html: getIcon('folder') }} />
                            <strong className="wad-empty__title">
                                No {branch === 'pbe' ? 'PBE ' : ''}League path
                            </strong>
                            <span className="wad-empty__desc">
                                Point Flint at your {branch === 'pbe' ? 'PBE ' : ''}League of Legends folder to start exploring WADs.
                            </span>
                            <button className="btn btn--sm btn--primary" onClick={handlePickGamePath}>
                                Select {branch === 'pbe' ? 'PBE ' : ''}Game Folder
                            </button>
                        </div>
                    )}

                    {/* ── Virtualized tree / search view ─────────────────────── */}
                    {wadExplorer.scanStatus === 'ready' && (
                        wadExplorer.wads.length > 0
                            && wadExplorer.wads.every(w => w.status === 'idle' || w.status === 'loading')
                        ? <WadListSkeleton count={Math.min(wadExplorer.wads.length, 14)} />
                        : <VirtualizedList
                            ref={listRef}
                            totalRows={totalRows}
                            rowHeight={ROW_HEIGHT}
                            overscan={OVERSCAN}
                            renderRow={stableRenderRow}
                            renderEpoch={renderEpoch}
                        />
                    )}
                </div>

                {wadExplorer.scanStatus === 'ready' && (
                    <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)', padding: '6px 12px', fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '8px' }}>
                        <span>{wadExplorer.wads.length.toLocaleString()} WADs</span>
                        <span>·</span>
                        <span>{wadExplorer.wads.filter(w => w.status === 'loaded').length} loaded</span>
                        {groupedSearchResults && <><span>·</span><span>{searchResultCount.toLocaleString()} matches</span></>}
                        {filteredCategories && <><span>·</span><span>{filteredCategories.reduce((s, [, w]) => s + w.length, 0)} matching WADs</span></>}
                    </div>
                )}
            </div>

            {/* ── RESIZER ── */}
            <div
                className="panel-resizer"
                style={{ cursor: 'col-resize', flexShrink: 0 }}
                onMouseDown={() => {
                    isResizingRef.current = true;
                    document.body.style.cursor = 'col-resize';
                    document.body.style.userSelect = 'none';
                }}
            />

            {/* ── RIGHT: preview or quick-action cards ── */}
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                {wadExplorer.selected && selectedChunk ? (
                    <ChunkPreview
                        key={`${wadExplorer.selected.wadPath}::${wadExplorer.selected.hash}`}
                        wadPath={wadExplorer.selected.wadPath}
                        chunk={selectedChunk}
                        onClose={() => useWadExplorerStore.getState().setSelected(null, null)}
                    />
                ) : (
                    <QuickActionPanel
                        wads={wadExplorer.wads}
                        onSetFilter={query => {
                            setInputValue(query);
                            setSearchMode('regex');
                            useWadExplorerStore.getState().setSearch(query);
                            searchRef.current?.focus();
                        }}
                        onOpenRecent={(wadPath) => {
                            const wad = wadExplorer.wads.find((w) => w.path === wadPath);
                            if (!wad) return;
                            pendingNavRef.current = { wadPath: wad.path, phase: 'wad' };
                            if (!wadExplorer.expandedWads.has(wad.path)) {
                                handleToggleWad(wad.path);
                            } else if (wad.status === 'idle') {
                                loadWad(wad.path);
                            } else {
                                requestAnimationFrame(() => processNavigation());
                            }
                        }}
                    />
                )}
            </div>
        </div>

        {showCheatSheet && (
            <WadCheatSheetModal
                onClose={() => setShowCheatSheet(false)}
                onOpenWad={handleCheatSheetOpenWad}
                onFilterPath={handleCheatSheetFilter}
            />
        )}

        {extractProgress?.visible && (
            <ExtractOverlay progress={extractProgress} />
        )}
        </>
    );
};
