/**
 * Flint - Project List Modal
 *
 * Modernized "open existing project" view: searchable, sortable, card-based.
 * Each row shows a champion monogram tile, project + path, relative time, and
 * a trash control. Footer hosts "Open from disk" and the green "Import Mod"
 * primary action.
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppState, useConfigStore } from '../../lib/stores';
import { formatRelativeTime } from '../../lib/utils';
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

/** What kind of label / tile we should render for a saved project. The list
 *  modal mixes skin / map / loading-screen rows so each card needs a
 *  type-specific subtitle and fallback artwork. */
function projectSubtitle(p: SavedProject): string {
    if (p.kind === 'map') return p.mapId ? `Map · ${p.mapId}` : 'Map';
    if (p.kind === 'loading-screen') return 'Loading Screen';
    return p.champion || 'Project';
}

/** Two-letter monogram for the tile. For maps and loading-screens we don't
 *  have a champion name, so derive something readable from the project kind. */
function monogram(p: SavedProject): string {
    if (p.kind === 'map') return 'M';
    if (p.kind === 'loading-screen') return 'LS';
    const c = (p.champion || p.name || '?').trim();
    if (!c) return '?';
    if (c.length <= 2) return c.toUpperCase();
    return (c[0] + c[1]).toUpperCase();
}

/** Stable hue 0–360 derived from a string. */
function hueFor(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
}

/** DDragon centered loading splash for the base skin (skin 0). Only valid for
 *  skin projects with a real champion alias; map / loading-screen projects
 *  fall back to the monogram tile. */
function championSplashUrl(alias: string): string {
    return `https://ddragon.leagueoflegends.com/cdn/img/champion/loading/${alias}_0.jpg`;
}

/** Module-level memo for thumbnail blob URLs — avoids re-reading bytes
 *  every time the modal reopens. Keyed by absolute project path. */
const thumbnailCache = new Map<string, string | null>();

/** Module-level memo for extracted dominant colors. Keyed by image URL. */
const colorCache = new Map<string, [number, number, number]>();

/**
 * Extract a dominant, vibrant color from an HTMLImageElement.
 *
 * Samples a 32×32 thumbnail of the image, weights each pixel by saturation
 * (so vibrant pixels dominate over the background), and averages the result.
 * Skips near-black/near-white pixels so murky backgrounds don't drag the
 * result toward gray.
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
            // Skip near-black and near-white
            if (max < 40 || min > 220) continue;
            const sat = max === 0 ? 0 : (max - min) / max;       // 0–1
            const lum = (r + g + b) / 3;
            // Heavily favour saturated, mid-bright pixels
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
 *   1. Try `{project.path}/thumbnail.webp` via Tauri read — only when the
 *      caller has flagged the card as visible (lazy load via IntersectionObserver).
 *   2. Fall back to the champion's centered splash from DDragon (skin only —
 *      maps and loading-screens go straight to the monogram tile).
 *   3. null → caller should render the monogram fallback.
 *
 * Returns `{ url, isLoading, splashFailed }`. When `splashFailed` flips true
 * the consumer should render the monogram instead of trying another image.
 *
 * Skipping the read entirely until the card is visible is the perf win: a
 * 50-project list used to fire 50 readFileBytes invokes the moment the modal
 * opened, which is why the modal felt sluggish to launch. Now we only read
 * for what the user is actually looking at.
 */
function useProjectArtUrl(project: SavedProject, visible: boolean) {
    const [thumb, setThumb] = useState<string | null>(() => thumbnailCache.get(project.path) ?? null);
    const [thumbFailed, setThumbFailed] = useState(thumbnailCache.get(project.path) === null);
    const cancelled = useRef(false);

    useEffect(() => {
        cancelled.current = false;
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
    }, [project.path, visible]);

    // Only skin projects have a meaningful DDragon splash fallback. Maps and
    // loading-screens go directly to the monogram tile when no thumbnail is
    // on disk — there's no public champion-shaped art for them.
    const hasSplashFallback = project.kind === 'skin' && !!project.champion;
    return {
        url: thumb ?? (thumbFailed && hasSplashFallback ? championSplashUrl(project.champion) : null),
        isLoading: visible && !thumb && !thumbFailed,
        usingFallback: thumbFailed,
    };
}

/** Card row — owns the URL state and dominant-color extraction so the
 *  whole card (border, hover halo, label text, monogram fallback) is
 *  tinted to match the tile artwork.
 *
 *  Tile artwork is fetched lazily on first intersection via IntersectionObserver
 *  so we only readFileBytes for thumbnails the user can actually see. */
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

    // Try cached color when URL changes
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

    // CSS vars for the per-card tint
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
    const { state, dispatch, closeModal, setWorking, setReady, setError, openConfirmDialog } = useAppState();
    const configStore = useConfigStore();
    const [removingId, setRemovingId] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [sortMode, setSortMode] = useState<SortMode>('recent');

    const isVisible = state.activeModal === 'projectList';
    const savedProjects = state.savedProjects || [];

    // Reset search when modal opens
    useEffect(() => {
        if (isVisible) {
            setSearch('');
            setSortMode('recent');
        }
    }, [isVisible]);

    // Discover-and-merge: each time the modal opens, walk the configured
    // projects root and rebuild the saved-projects list from disk. This
    // lets users recover their projects after a clean reinstall (the
    // backend reads each project's flint.json/mod.config.json directly,
    // and reconciles with projects.json so renamed/relocated folders still
    // show under the right pid).
    const projectsRoot = configStore.defaultProjectPath;
    useEffect(() => {
        if (!isVisible || !projectsRoot) return;
        let cancelled = false;
        (async () => {
            try {
                const listings = await api.discoverProjects(projectsRoot);
                if (cancelled) return;
                const mapped: SavedProject[] = listings
                    // Prefer rows that exist on disk; missing entries still
                    // render so users can re-locate or remove them.
                    .map((l) => ({
                        id: l.pid,
                        name: l.display_name || l.name || 'Unnamed',
                        kind: l.kind ?? 'skin',
                        champion: l.champion,
                        mapId: l.map_id ?? null,
                        path: l.path,
                        lastOpened: l.last_seen_at || l.modified_at || l.created_at,
                    }));
                configStore.setSavedProjects(mapped);
            } catch (err) {
                console.error('[ProjectList] discover_projects failed:', err);
            }
        })();
        return () => { cancelled = true; };
    }, [isVisible, projectsRoot, configStore]);

    // Listen for import progress events
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

            const project = await api.openProject(normalizedPath);
            dispatch({ type: 'SET_PROJECT', payload: { project, path: normalizedPath } });

            try {
                const files = await api.listProjectFiles(normalizedPath);
                dispatch({ type: 'SET_FILE_TREE', payload: files });
            } catch (filesError) {
                console.error('Failed to load project files:', filesError);
            }

            setReady();

            const recent = state.recentProjects.filter((p) => p.path !== normalizedPath);
            recent.unshift({
                name: project.display_name || project.name,
                champion: project.champion,
                skin: project.skin_id,
                path: normalizedPath,
                lastOpened: new Date().toISOString(),
            });
            dispatch({ type: 'SET_RECENT_PROJECTS', payload: recent.slice(0, 10) });
        } catch (error) {
            console.error('Failed to open project:', error);
            const flintError = error as api.FlintError;
            setError(flintError.getUserMessage?.() || 'Failed to open project');
        }
    }, [state.recentProjects, dispatch, closeModal, setWorking, setReady, setError]);

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
            title: 'Delete Project',
            message: `Are you sure you want to delete "${project.name}"?\n\nThis will permanently delete all project files and cannot be undone.`,
            confirmLabel: 'Delete',
            cancelLabel: 'Cancel',
            danger: true,
            onConfirm: async () => {
                try {
                    setRemovingId(projectId);
                    setWorking('Deleting project files…');
                    try {
                        await api.deleteProject(project.path);
                    } catch (deleteError) {
                        console.warn('Project folder may not exist, removing from list anyway:', deleteError);
                    }
                    setTimeout(() => {
                        dispatch({ type: 'REMOVE_SAVED_PROJECT', payload: projectId });
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
    }, [savedProjects, dispatch, setWorking, setReady, setError, openConfirmDialog]);

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
            let creatorName: string;
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
                creatorName = analysis.authors[0] || state.creatorName || 'Unknown';
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
                creatorName = analysis.metadata?.author || state.creatorName || 'Unknown';
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
                creator_name: creatorName,
                project_name: modName,
                target_skin_id: skinId,
                cleanup_unused: false,
                match_from_league: !isModpkg,
                league_path: state.leaguePath || null,
                use_jade: configStore.binConverterEngine === 'jade',
            };

            const project = isModpkg
                ? await api.importModpkg(filePath, projectDir, options)
                : await api.importFantomeWad(filePath, projectDir, options);

            setWorking('Opening project…');
            dispatch({ type: 'SET_PROJECT', payload: { project, path: projectDir } });

            try {
                const files = await api.listProjectFiles(projectDir);
                dispatch({ type: 'SET_FILE_TREE', payload: files });
            } catch (filesError) {
                console.error('Failed to load project files:', filesError);
            }

            const recent = state.recentProjects.filter((p) => p.path !== projectDir);
            recent.unshift({
                name: project.display_name || project.name,
                champion: project.champion,
                skin: project.skin_id,
                path: projectDir,
                lastOpened: new Date().toISOString(),
            });
            dispatch({ type: 'SET_RECENT_PROJECTS', payload: recent.slice(0, 10) });

            closeModal();
            setReady();
        } catch (error) {
            console.error('Failed to import mod:', error);
            const flintError = error as api.FlintError;
            closeModal();
            setError(flintError.getUserMessage?.() || 'Failed to import mod');
        }
    }, [state.leaguePath, state.creatorName, state.recentProjects, dispatch, closeModal, setWorking, setReady, setError, configStore.binConverterEngine]);

    // Filtered + sorted view
    const visibleProjects = useMemo(() => {
        const q = search.trim().toLowerCase();
        // Build a per-project search haystack that includes the kind label
        // (e.g. "map · map11") so typing "map" matches map projects.
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
                // Group by kind first (skin, map, loading-screen) then by champion / map id
                // so the "Champion A–Z" sort isn't a meaningless mash of map/skin rows.
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
                            <span className="pl-title__name">My Projects</span>
                            <span className="pl-title__sub">
                                {savedProjects.length === 0
                                    ? 'No saved projects yet'
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
                        <span>No projects match “{search}”.</span>
                    </div>
                ) : (
                    <div className="pl-grid">
                        {visibleProjects.map((project: SavedProject, i) => (
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
        <h3 className="pl-empty__title">No projects yet</h3>
        <p className="pl-empty__desc">
            Create a new project, open one from disk, or import a <code>.fantome</code> /
            <code>.modpkg</code> to get started.
        </p>
        <div className="pl-empty__actions">
            <Button icon="folder" onClick={onBrowse}>Open from disk</Button>
            <Button variant="success" icon="download" onClick={onImport}>Import Mod</Button>
        </div>
    </div>
);
