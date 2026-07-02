import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useModalStore, useAppMetadataStore, useProjectTabStore, useConfigStore, useNavigationStore } from '../../lib/stores';
import { formatRelativeTime } from '../../lib/util/utils';
import { open } from '@tauri-apps/plugin-dialog';
import { appDataDir } from '@tauri-apps/api/path';
import { Button, Icon, Input, Modal, ModalBody, ModalFooter, ModalHeader, Picker } from '../ui';
import * as api from '../../lib/api';
import { listen } from '@tauri-apps/api/event';
import type { SavedProject } from '../../lib/types';

type SortMode = 'recent' | 'name' | 'champion';

const SORT_OPTIONS = [
    { value: 'recent',   label: 'Recently opened' },
    { value: 'name',     label: 'Project name (A–Z)' },
    { value: 'champion', label: 'Champion (A–Z)' },
] as const;

function projectSubtitle(p: SavedProject): string {
    if (p.kind === 'tft') return p.champion ? `TFT · ${p.champion}` : 'TFT';
    if (p.kind === 'map') return p.mapId ? `Map · ${p.mapId}` : 'Map';
    if (p.kind === 'loading-screen') return 'Loading Screen';
    return p.champion || 'Project';
}

function monogram(p: SavedProject): string {
    if (p.kind === 'tft') return 'TF';
    if (p.kind === 'map') return 'M';
    if (p.kind === 'loading-screen') return 'LS';
    const c = (p.champion || p.name || '?').trim();
    if (!c) return '?';
    if (c.length <= 2) return c.toUpperCase();
    return (c[0] + c[1]).toUpperCase();
}

function hueFor(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
}

function normalizeChampionAlias(alias: string): string {
    if (!alias) return '';
    const lower = alias.toLowerCase().replace(/['\s]/g, '');
    
    // Hardcoded overrides for champions with multiple capital letters or special casing in DDragon
    const overrides: Record<string, string> = {
        aurelionsol: 'AurelionSol',
        belveth: 'BelVeth',
        chogath: 'ChoGath',
        drmundo: 'DrMundo',
        jarvaniv: 'JarvanIV',
        kaisa: 'KaiSa',
        khazix: 'KhaZix',
        kogmaw: 'KogMaw',
        ksante: 'KSante',
        leblanc: 'LeBlanc',
        leesin: 'LeeSin',
        masteryi: 'MasterYi',
        missfortune: 'MissFortune',
        nunu: 'Nunu',
        reksai: 'RekSai',
        renata: 'Renata',
        renataglasc: 'Renata',
        tahmkench: 'TahmKench',
        twistedfate: 'TwistedFate',
        velkoz: 'VelKoz',
        xinzhao: 'XinZhao',
        monkeyking: 'MonkeyKing',
        wukong: 'MonkeyKing',
    };

    if (overrides[lower]) {
        return overrides[lower];
    }

    // Default: Capitalize first letter (e.g. yone -> Yone)
    return alias.charAt(0).toUpperCase() + alias.slice(1).toLowerCase();
}

/** Only valid for skin projects with a real champion alias; map /
 *  loading-screen projects fall back to the monogram tile. */
function championSplashUrl(alias: string): string {
    const normalized = normalizeChampionAlias(alias);
    return `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${normalized}_0.jpg`;
}

/** Keyed by absolute project path. */
const thumbnailCache = new Map<string, string | null>();

/** Keyed by image URL. */
const colorCache = new Map<string, [number, number, number]>();

/**
 * Samples a 32×32 thumbnail, weights each pixel by saturation (so vibrant
 * pixels dominate over the background), and averages the result. Skips
 * near-black/near-white pixels so murky backgrounds don't drag toward gray.
 */
function extractDominantColor(img: HTMLImageElement): [number, number, number] | null {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, 32, 32);
        const { data } = ctx.getImageData(0, 0, 32, 32);

        let totalR = 0, totalG = 0, totalB = 0, totalWeight = 0;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            if (a < 128) continue;

            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            if (max < 40 || min > 220) continue;
            const sat = max === 0 ? 0 : (max - min) / max;       // 0–1
            const lum = (r + g + b) / 3;
            const weight = sat * sat * (lum > 30 && lum < 230 ? 1 : 0.3);

            totalR += r * weight;
            totalG += g * weight;
            totalB += b * weight;
            totalWeight += weight;
        }
        if (totalWeight < 0.5) return null;
        return [
            Math.round(totalR / totalWeight),
            Math.round(totalG / totalWeight),
            Math.round(totalB / totalWeight),
        ];
    } catch {
        return null; // CORS taint, etc.
    }
}

/**
 * Resolve a project's tile artwork URL:
 *   1. `{project.path}/thumbnail.webp` via Tauri read — only when `visible`
 *      (lazy load via IntersectionObserver, so a big list doesn't fire a
 *      readFileBytes per card on open).
 *   2. Champion's centered DDragon splash (skin only — maps/loading-screens
 *      go straight to the monogram tile).
 *   3. null → caller renders the monogram fallback.
 */
function useProjectArtUrl(project: SavedProject, visible: boolean) {
    const [thumb, setThumb] = useState<string | null>(() => project.thumbnail ?? thumbnailCache.get(project.path) ?? null);
    const [thumbFailed, setThumbFailed] = useState(thumbnailCache.get(project.path) === null && !project.thumbnail);
    const cancelled = useRef(false);

    useEffect(() => {
        cancelled.current = false;
        if (project.thumbnail) {
            setThumb(project.thumbnail);
            return;
        }
        if (!visible) return;
        if (thumbnailCache.has(project.path)) return;
        (async () => {
            try {
                const folder = project.path.replace(/[\\/](mod\.config|flint|project)\.json$/, '');
                const thumbPath = `${folder.replace(/\\/g, '/')}/thumbnail.webp`;
                const bytes = await api.readFileBytes(thumbPath, { silent: true });
                if (cancelled.current) return;
                const blob = new Blob([new Uint8Array(bytes)], { type: 'image/webp' });
                const url = URL.createObjectURL(blob);
                thumbnailCache.set(project.path, url);
                setThumb(url);
            } catch {
                if (cancelled.current) return;
                thumbnailCache.set(project.path, null);
                setThumbFailed(true);
            }
        })();
        return () => { cancelled.current = true; };
    }, [project.path, visible, project.thumbnail]);

    const hasSplashFallback = project.kind === 'skin' && !!project.champion;
    return {
        url: thumb ?? (thumbFailed && hasSplashFallback ? championSplashUrl(project.champion) : null),
        isLoading: visible && !thumb && !thumbFailed,
        usingFallback: thumbFailed,
    };
}

const ProjectCard: React.FC<{
    project: SavedProject;
    index: number;
    removing: boolean;
    onOpen: () => void;
    onRemove: (e: React.MouseEvent) => void;
}> = ({ project, index, removing, onOpen, onRemove }) => {
    const cardRef = useRef<HTMLButtonElement>(null);
    const [visible, setVisible] = useState(() => thumbnailCache.has(project.path));

    useEffect(() => {
        if (visible) return;
        const el = cardRef.current;
        if (!el) return;
        const io = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting) {
                    setVisible(true);
                    io.disconnect();
                    break;
                }
            }
        }, { rootMargin: '120px' });
        io.observe(el);
        return () => io.disconnect();
    }, [visible]);

    const { url, isLoading } = useProjectArtUrl(project, visible);
    const [splashFailed, setSplashFailed] = useState(false);
    const [tint, setTint] = useState<[number, number, number] | null>(() =>
        url && colorCache.has(url) ? colorCache.get(url)! : null);

    const showMonogram = splashFailed || (!url && !isLoading);

    useEffect(() => {
        if (!url) return;
        const cached = colorCache.get(url);
        if (cached) setTint(cached);
        else setTint(null);
    }, [url]);

    const handleImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget;
        if (!url || colorCache.has(url)) return;
        const color = extractDominantColor(img);
        if (color) {
            colorCache.set(url, color);
            setTint(color);
        }
    };

    const [r, g, b] = tint ?? [120, 130, 150];
    const subtitle = projectSubtitle(project);
    const cssVars: React.CSSProperties = {
        animationDelay: `${Math.min(index, 12) * 28}ms`,
        ['--pl-r' as never]: r,
        ['--pl-g' as never]: g,
        ['--pl-b' as never]: b,
        ['--pl-hue' as never]: hueFor(project.kind === 'map' ? (project.mapId || 'map') : project.champion || project.name),
    };

    return (
        <button
            ref={cardRef}
            type="button"
            className={`pl-card ${removing ? 'pl-card--removing' : ''}`}
            onClick={onOpen}
            style={cssVars}
            title={`Open ${subtitle} — ${project.name}`}
        >
            {showMonogram ? (
                <span className="pl-card__tile">
                    <span className="pl-card__monogram">{monogram(project)}</span>
                </span>
            ) : isLoading || !url ? (
                <span className="pl-card__tile pl-card__tile--loading" />
            ) : (
                <span className="pl-card__tile pl-card__tile--art">
                    <img
                        src={url}
                        alt=""
                        className="pl-card__art"
                        loading="lazy"
                        crossOrigin="anonymous"
                        onLoad={handleImgLoad}
                        onError={() => setSplashFailed(true)}
                    />
                </span>
            )}
            <span className="pl-card__body">
                <span className="pl-card__name">{project.name}</span>
                <span className="pl-card__champ">{subtitle}</span>
                <span className="pl-card__path" title={project.path}>{project.path}</span>
            </span>
            <span className="pl-card__meta">
                <span className="pl-card__time">{formatRelativeTime(project.lastOpened)}</span>
                <span
                    className="pl-card__remove"
                    role="button"
                    tabIndex={-1}
                    onClick={onRemove}
                    title="Delete project"
                >
                    <Icon name="trash" />
                </span>
            </span>
        </button>
    );
};

export const ProjectListModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const openConfirmDialog = useModalStore((s) => s.openConfirmDialog);
    const setWorking = useAppMetadataStore((s) => s.setWorking);
    const setReady = useAppMetadataStore((s) => s.setReady);
    const setError = useAppMetadataStore((s) => s.setError);
    const savedProjects = useConfigStore((s) => s.savedProjects);
    const recentProjects = useConfigStore((s) => s.recentProjects);
    const leaguePath = useConfigStore((s) => s.leaguePath);
    const creatorName = useConfigStore((s) => s.creatorName);
    const defaultProjectPath = useConfigStore((s) => s.defaultProjectPath);
    const setSavedProjects = useConfigStore((s) => s.setSavedProjects);
    const [removingId, setRemovingId] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [sortMode, setSortMode] = useState<SortMode>('recent');

    const isVisible = activeModal === 'projectList';

    useEffect(() => {
        if (isVisible) {
            setSearch('');
            setSortMode('recent');
        }
    }, [isVisible]);

    // Rebuild saved-projects from disk on open so a clean reinstall recovers
    // projects (backend reads each project's flint.json/mod.config.json and
    // reconciles with projects.json under the right pid).
    useEffect(() => {
        if (!isVisible || !defaultProjectPath) return;
        let cancelled = false;
        (async () => {
            try {
                const listings = await api.discoverProjects(defaultProjectPath);
                if (cancelled) return;
                const mapped: SavedProject[] = listings
                    .map((l) => ({
                        id: l.pid,
                        name: l.display_name || l.name || 'Unnamed',
                        kind: l.kind ?? 'skin',
                        champion: l.champion,
                        mapId: l.map_id ?? null,
                        path: l.path,
                        lastOpened: l.last_seen_at || l.modified_at || l.created_at,
                        thumbnail: l.thumbnail || null,
                    }));
                setSavedProjects(mapped);
            } catch (err) {
                console.error('[ProjectList] discover_projects failed:', err);
            }
        })();
        return () => { cancelled = true; };
    }, [isVisible, defaultProjectPath, setSavedProjects]);

    useEffect(() => {
        const unlistenFantome = listen<{ status: string; message: string }>('fantome-import-progress', (event) => {
            const { status, message } = event.payload;
            if (status === 'error') setError(message);
            else setWorking(message);
        });
        const unlistenModpkg = listen<{ status: string; message: string }>('modpkg-import-progress', (event) => {
            const { status, message } = event.payload;
            if (status === 'error') setError(message);
            else setWorking(message);
        });
        return () => {
            unlistenFantome.then((fn) => fn());
            unlistenModpkg.then((fn) => fn());
        };
    }, [setWorking, setError]);

    const handleOpenProject = useCallback(async (projectPath: string) => {
        closeModal();
        try {
            setWorking('Opening project…');
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

            setReady();

            const recent = recentProjects.filter((p) => p.path !== normalizedPath);
            recent.unshift({
                name: project.display_name || project.name,
                champion: project.champion,
                skin: project.skin_id,
                path: normalizedPath,
                lastOpened: new Date().toISOString(),
            });
            useConfigStore.getState().setRecentProjects(recent.slice(0, 10));
        } catch (error) {
            console.error('Failed to open project:', error);
            const flintError = error as api.FlintError;
            setError(flintError.getUserMessage?.() || 'Failed to open project');
        }
    }, [recentProjects, closeModal, setWorking, setReady, setError]);

    const handleBrowseFiles = useCallback(async () => {
        try {
            const selected = await open({
                title: 'Open Flint Project',
                filters: [{ name: 'Flint Project', extensions: ['json'] }],
                multiple: false,
            });
            if (selected) await handleOpenProject(selected as string);
        } catch (error) {
            console.error('Failed to open project:', error);
        }
    }, [handleOpenProject]);

    const handleRemoveProject = useCallback((e: React.MouseEvent, projectId: string) => {
        e.stopPropagation();
        const project = savedProjects.find((p) => p.id === projectId);
        if (!project) return;

        openConfirmDialog({
            title: 'Delete Folder',
            message: `Are you sure you want to delete "${project.name}"?\n\nThis will permanently delete all folder files and cannot be undone.`,
            confirmLabel: 'Delete',
            cancelLabel: 'Cancel',
            danger: true,
            onConfirm: async () => {
                try {
                    setRemovingId(projectId);
                    setWorking('Deleting folder files…');
                    try {
                        await api.deleteProject(project.path);
                    } catch (deleteError) {
                        console.warn('Project folder may not exist, removing from list anyway:', deleteError);
                    }
                    setTimeout(() => {
                        useConfigStore.getState().removeSavedProject(projectId);
                        setRemovingId(null);
                        setReady();
                    }, 200);
                } catch (error) {
                    console.error('Failed to delete project:', error);
                    const flintError = error as api.FlintError;
                    setError(flintError.getUserMessage?.() || 'Failed to delete project');
                    setRemovingId(null);
                }
            },
        });
    }, [savedProjects, setWorking, setReady, setError, openConfirmDialog]);

    const handleImportMod = useCallback(async () => {
        try {
            const selected = await open({
                title: 'Import Mod File',
                filters: [
                    { name: 'Mod Packages', extensions: ['fantome', 'modpkg'] },
                    { name: 'Fantome Package', extensions: ['fantome'] },
                    { name: 'ModPkg Package', extensions: ['modpkg'] },
                    { name: 'WAD Archive', extensions: ['wad', 'client'] },
                    { name: 'ZIP Archive', extensions: ['zip'] },
                    { name: 'All Files', extensions: ['*'] },
                ],
                multiple: false,
                directory: false,
            });
            if (!selected) return;

            const filePath = selected as string;
            const isModpkg = filePath.toLowerCase().endsWith('.modpkg');

            let champion: string;
            let skinId: number;
            let importCreatorName: string;
            let modName: string;

            if (isModpkg) {
                setWorking('Analyzing ModPkg…');
                const analysis = await api.analyzeModpkg(filePath);
                if (!analysis.is_champion_mod) {
                    setError('This does not appear to be a champion mod. Only champion mods are supported.');
                    return;
                }
                champion = analysis.champion || 'Unknown';
                skinId = analysis.skin_ids[0] || 0;
                importCreatorName = analysis.authors[0] || creatorName || 'Unknown';
                modName = analysis.display_name || analysis.name || `${champion}_Skin${skinId}_Imported`;
            } else {
                setWorking('Analyzing Fantome mod…');
                const analysis = await api.analyzeFantome(filePath);
                if (!analysis.is_champion_mod) {
                    setError('This does not appear to be a champion mod. Only champion mods are supported.');
                    return;
                }
                champion = analysis.champion || 'Unknown';
                skinId = analysis.skin_ids[0] || 0;
                importCreatorName = analysis.metadata?.author || creatorName || 'Unknown';
                modName = analysis.metadata?.name || `${champion}_Skin${skinId}_Imported`;
            }

            const appData = await appDataDir();
            const parts = appData.replace(/\\/g, '/').split('/');
            parts.pop();
            const defaultProjectsDir = `${parts.join('/')}/RitoShark/Flint/Projects`;

            const sanitizedModName = modName.replace(/[^a-zA-Z0-9_-]/g, '_');
            const dirName = `${champion}_Skin${skinId}_${sanitizedModName}`;

            setWorking('Importing and refathering mod files…');
            const projectDir = `${defaultProjectsDir}/${dirName}`;

            const options: api.ImportOptions = {
                refather: true,
                creator_name: importCreatorName,
                project_name: modName,
                champion: champion || null,
                target_skin_id: skinId,
                cleanup_unused: false,
                match_from_league: !isModpkg,
                league_path: leaguePath || null,
            };

            const project = isModpkg
                ? await api.importModpkg(filePath, projectDir, options)
                : await api.importFantomeWad(filePath, projectDir, options);

            setWorking('Opening project…');
            useProjectTabStore.getState().addTab(project, projectDir);
            useNavigationStore.getState().setView('preview');
            useConfigStore.getState().addSavedProject({
                id: `proj-${Date.now()}`,
                name: project.display_name || project.name,
                kind: project.kind ?? 'skin',
                champion: project.champion,
                mapId: project.map_id ?? null,
                path: projectDir,
                lastOpened: new Date().toISOString(),
            });

            try {
                const files = await api.listProjectFiles(projectDir);
                const tabId = useProjectTabStore.getState().activeTabId;
                if (tabId) useProjectTabStore.getState().setFileTree(tabId, files);
            } catch (filesError) {
                console.error('Failed to load project files:', filesError);
            }

            const recent = recentProjects.filter((p) => p.path !== projectDir);
            recent.unshift({
                name: project.display_name || project.name,
                champion: project.champion,
                skin: project.skin_id,
                path: projectDir,
                lastOpened: new Date().toISOString(),
            });
            useConfigStore.getState().setRecentProjects(recent.slice(0, 10));

            closeModal();
            setReady();
        } catch (error) {
            console.error('Failed to import mod:', error);
            const flintError = error as api.FlintError;
            closeModal();
            setError(flintError.getUserMessage?.() || 'Failed to import mod');
        }
    }, [leaguePath, creatorName, recentProjects, closeModal, setWorking, setReady, setError]);

    const visibleProjects = useMemo(() => {
        const q = search.trim().toLowerCase();
        const haystack = (p: SavedProject) =>
            `${p.kind} ${p.champion} ${p.mapId ?? ''} ${p.name} ${p.path}`.toLowerCase();
        let list = q
            ? savedProjects.filter((p) => haystack(p).includes(q))
            : savedProjects.slice();

        switch (sortMode) {
            case 'name':
                list.sort((a, b) => a.name.localeCompare(b.name));
                break;
            case 'champion':
                // Group by kind first, then champion / map id.
                list.sort((a, b) => {
                    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
                    const aKey = a.kind === 'map' ? (a.mapId || '') : (a.champion || '');
                    const bKey = b.kind === 'map' ? (b.mapId || '') : (b.champion || '');
                    return aKey.localeCompare(bKey) || a.name.localeCompare(b.name);
                });
                break;
            case 'recent':
            default:
                list.sort((a, b) => (b.lastOpened || '').localeCompare(a.lastOpened || ''));
                break;
        }
        return list;
    }, [savedProjects, search, sortMode]);

    return (
        <Modal open={isVisible} onClose={closeModal} modifier="modal--project-list">
            <ModalHeader
                title={
                    <span className="pl-title">
                        <span className="pl-title__icon"><Icon name="folder" /></span>
                        <span>
                            <span className="pl-title__name">My Folders</span>
                            <span className="pl-title__sub">
                                {savedProjects.length === 0
                                    ? 'No saved folders yet'
                                    : `${savedProjects.length} saved · open or import`}
                            </span>
                        </span>
                    </span>
                }
                onClose={closeModal}
            />

            {savedProjects.length > 0 && (
                <div className="pl-toolbar">
                    <div className="pl-search">
                        <Icon name="search" />
                        <Input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search by kind, champion, name, or path…"
                        />
                    </div>
                    <Picker<SortMode>
                        value={sortMode}
                        onChange={(v) => setSortMode(v as SortMode)}
                        options={SORT_OPTIONS as unknown as { value: SortMode; label: string }[]}
                        width={200}
                    />
                </div>
            )}

            <ModalBody className="pl-body">
                {savedProjects.length === 0 ? (
                    <ProjectsEmpty onBrowse={handleBrowseFiles} onImport={handleImportMod} />
                ) : visibleProjects.length === 0 ? (
                    <div className="pl-no-match">
                        <Icon name="search" />
                        <span>No folders match “{search}”.</span>
                    </div>
                ) : (
                    <div className="pl-grid">
                        {visibleProjects.map((project: SavedProject, i: number) => (
                            <ProjectCard
                                key={project.id}
                                project={project}
                                index={i}
                                removing={removingId === project.id}
                                onOpen={() => handleOpenProject(project.path)}
                                onRemove={(e) => handleRemoveProject(e, project.id)}
                            />
                        ))}
                    </div>
                )}
            </ModalBody>

            <ModalFooter>
                <Button variant="secondary" icon="folder" onClick={handleBrowseFiles}>
                    Open from disk
                </Button>
                <Button variant="success" icon="download" onClick={handleImportMod}>
                    Import Mod
                </Button>
            </ModalFooter>
        </Modal>
    );
};

// =============================================================================
// Empty state
// =============================================================================

const ProjectsEmpty: React.FC<{ onBrowse: () => void; onImport: () => void }> = ({ onBrowse, onImport }) => (
    <div className="pl-empty">
        <div className="pl-empty__art">
            <span className="pl-empty__ring" />
            <span className="pl-empty__ring pl-empty__ring--2" />
            <span className="pl-empty__icon"><Icon name="folder" /></span>
        </div>
        <h3 className="pl-empty__title">No folders yet</h3>
        <p className="pl-empty__desc">
            Create a new workspace, open one from disk, or import a <code>.fantome</code> /
            <code>.modpkg</code> to get started.
        </p>
        <div className="pl-empty__actions">
            <Button icon="folder" onClick={onBrowse}>Open from disk</Button>
            <Button variant="success" icon="download" onClick={onImport}>Import Mod</Button>
        </div>
    </div>
);
