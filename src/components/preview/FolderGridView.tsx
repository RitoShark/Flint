/**
 * Flint - Folder Grid View
 *
 * The "custom file explorer". When a folder is selected in the project
 * tree (left panel), this is what renders in the right-hand preview
 * panel: a grid of cards for the immediate children of that folder.
 *
 * - Texture children (.dds / .tex / .png / .jpg) get a small thumbnail
 *   decoded once and cached in the existing image cache.
 * - Other files show their type icon.
 * - Single click on a child = select it (drives the rest of the preview
 *   pipeline). Folders navigate "into" by updating the active tab's
 *   selectedFile to the child's relative path.
 * - Double click on a texture opens the full-resolution image modal.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectTabStore, useAppMetadataStore, useModalStore, useNotificationStore, useConfigStore, useNavigationStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { getFileIcon } from '../../lib/fileIcons';
import { getCachedImage, cacheImage } from '../../lib/imageCache';
import { buildFileContextMenuOptions } from '../../lib/fileContextMenuOptions';

interface FolderGridViewProps {
    /** Absolute path of the folder being shown. */
    folderAbsPath: string;
    /** Project root (absolute) used to compute relative paths for the VFS. */
    projectPath: string;
    /** Project-relative form of `folderAbsPath` — what's stored in the
     *  active tab's `selectedFile` field. Used to compute the parent
     *  folder for the "up" button. */
    folderRelPath: string;
}

const TEXTURE_EXTS = new Set(['dds', 'tex', 'png', 'jpg', 'jpeg', 'webp']);

const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Card sizing — bumped up from the original 120px so the icons aren't
 * tiny. Ctrl+scroll inside the grid scales this between MIN and MAX.
 */
const CARD_SIZE_DEFAULT = 160;
const CARD_SIZE_MIN = 96;
const CARD_SIZE_MAX = 320;
const CARD_SIZE_STEP = 16;

export const FolderGridView: React.FC<FolderGridViewProps> = ({
    folderAbsPath,
    projectPath,
    folderRelPath,
}) => {
    const [entries, setEntries] = useState<api.FolderEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Card minimum width in CSS px. Drives the grid template + thumbnail size. */
    const [cardSize, setCardSize] = useState(CARD_SIZE_DEFAULT);

    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const setSelectedFile = useProjectTabStore((s) => s.setSelectedFile);
    const fileTreeVersion = useAppMetadataStore((s) => s.fileTreeVersion);
    const openModal = useModalStore((s) => s.openModal);
    const openContextMenu = useModalStore((s) => s.openContextMenu);
    const openConfirmDialog = useModalStore((s) => s.openConfirmDialog);
    const showToast = useNotificationStore((s) => s.showToast);
    const leaguePath = useConfigStore((s) => s.leaguePath);

    const refreshFileTree = async () => {
        if (!projectPath) return;
        const files = await api.listProjectFiles(projectPath);
        const { activeTabId: tabId } = useProjectTabStore.getState();
        if (tabId) useProjectTabStore.getState().setFileTree(tabId, files);
    };

    const handleEntryContextMenu = (e: React.MouseEvent, entry: api.FolderEntry) => {
        e.preventDefault();
        e.stopPropagation();
        const options = buildFileContextMenuOptions({
            node: {
                path: entry.relative_path,
                name: entry.name,
                isDirectory: entry.is_directory,
            },
            projectPath,
            // FolderGridView always shows children of a folder, so the
            // displayed entries are never the project root — depth 1+.
            depth: 1,
            refreshFileTree,
            openModal,
            openConfirmDialog,
            showToast,
            leaguePath,
            // Inline rename isn't wired up in the grid yet; omit so the
            // option doesn't show up as a no-op.
        });
        openContextMenu(e.clientX, e.clientY, options);
    };

    // Ctrl+scroll → resize cards. Stays within MIN/MAX. Plain scroll
    // (no Ctrl) falls through to the container's normal scroll.
    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setCardSize((prev) => {
            const next = e.deltaY < 0 ? prev + CARD_SIZE_STEP : prev - CARD_SIZE_STEP;
            return Math.max(CARD_SIZE_MIN, Math.min(CARD_SIZE_MAX, next));
        });
    };

    // Refetch when the folder changes or the watcher signals a tree-level
    // change (file added / removed under this directory).
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        api.listFolderContents(projectPath, folderAbsPath)
            .then((res) => {
                if (cancelled) return;
                setEntries(res);
            })
            .catch((e) => {
                if (cancelled) return;
                setError((e as { message?: string })?.message ?? String(e));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [folderAbsPath, projectPath, fileTreeVersion]);

    const goTo = (relPath: string) => {
        if (!activeTabId) return;
        setSelectedFile(activeTabId, relPath);
    };

    // Parent folder for the "up" button. Empty string = no parent.
    const parentRel = useMemo(() => {
        if (!folderRelPath) return null;
        const idx = folderRelPath.replace(/\\/g, '/').lastIndexOf('/');
        if (idx <= 0) return null;
        return folderRelPath.slice(0, idx);
    }, [folderRelPath]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            {/* Breadcrumb / up nav */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border)',
                    flexShrink: 0,
                    fontSize: '12px',
                }}
            >
                {parentRel !== null ? (
                    <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        style={{ padding: '4px 10px' }}
                        onClick={() => goTo(parentRel)}
                        title="Go to parent folder"
                    >
                        ↑ Up
                    </button>
                ) : (
                    <span style={{ color: 'var(--text-muted)', padding: '4px 0' }}>📁 Project root</span>
                )}
                <span
                    style={{
                        flex: 1,
                        color: 'var(--text-muted)',
                        fontFamily: 'monospace',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                    title={folderRelPath}
                >
                    {folderRelPath || '(root)'}
                </span>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                    {loading ? 'Loading…' : `${entries.length} item${entries.length === 1 ? '' : 's'}`}
                </span>
                <span
                    style={{ color: 'var(--text-muted)', flexShrink: 0, fontSize: '11px' }}
                    title="Hold Ctrl and scroll inside the grid to resize cards"
                >
                    {cardSize}px
                </span>
            </div>

            {/* Grid — Ctrl+scroll resizes cards. */}
            <div
                style={{ flex: 1, overflow: 'auto', padding: '12px' }}
                onWheel={handleWheel}
            >
                {error && (
                    <div style={{ color: 'var(--accent-danger)', padding: '12px' }}>
                        Error: {error}
                    </div>
                )}
                {!loading && !error && entries.length === 0 && (
                    <div style={{ color: 'var(--text-muted)', padding: '24px', textAlign: 'center' }}>
                        Empty folder
                    </div>
                )}

                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))`,
                        gap: '12px',
                    }}
                >
                    {entries.map((entry) => {
                        const isTexture = !entry.is_directory && TEXTURE_EXTS.has(entry.extension);
                        const isBinText = !entry.is_directory && ['.bin', '.ritobin', '.py', '.troybin'].some(ext => entry.name.toLowerCase().endsWith(ext));
                        const isLuaBin = !entry.is_directory && ['.luabin', '.luabin64'].some(ext => entry.name.toLowerCase().endsWith(ext));
                        const isRawText = !entry.is_directory && ['.json', '.txt', '.lua', '.py'].some(ext => entry.name.toLowerCase().endsWith(ext)) && entry.name !== 'mod.config.json';

                        const handleDoubleClick = () => {
                            if (isTexture) {
                                openModal('fullResImage', {
                                    absPath: entry.absolute_path,
                                    fileName: entry.name,
                                });
                            } else if (entry.name === 'mod.config.json') {
                                useNavigationStore.getState().navigateToFileEditor({
                                    filePath: entry.absolute_path,
                                    kind: 'modConfig',
                                    projectPath,
                                });
                            } else if (isBinText) {
                                useNavigationStore.getState().navigateToFileEditor({
                                    filePath: entry.absolute_path,
                                    kind: 'binText',
                                    projectPath,
                                });
                            } else if (isLuaBin) {
                                useNavigationStore.getState().navigateToFileEditor({
                                    filePath: entry.absolute_path,
                                    kind: 'luaBin64',
                                    projectPath,
                                });
                            } else if (isRawText) {
                                useNavigationStore.getState().navigateToFileEditor({
                                    filePath: entry.absolute_path,
                                    kind: 'raw',
                                    projectPath,
                                });
                            }
                        };

                        return (
                            <FolderGridCard
                                key={entry.absolute_path}
                                entry={entry}
                                cardSize={cardSize}
                                onClick={() => goTo(entry.relative_path)}
                                onContextMenu={(e) => handleEntryContextMenu(e, entry)}
                                onDoubleClick={handleDoubleClick}
                            />
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

interface FolderGridCardProps {
    entry: api.FolderEntry;
    cardSize: number;
    onClick: () => void;
    onDoubleClick?: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
}

const FolderGridCard: React.FC<FolderGridCardProps> = ({ entry, cardSize, onClick, onDoubleClick, onContextMenu }) => {
    const isTexture = !entry.is_directory && TEXTURE_EXTS.has(entry.extension);
    const [thumbnail, setThumbnail] = useState<string | null>(null);
    const cardRef = useRef<HTMLButtonElement>(null);
    const [inView, setInView] = useState(false);

    // Cache hit short-circuits before any observer setup — visible or not,
    // if the data is already there we render it immediately.
    useEffect(() => {
        if (!isTexture) return;
        const cached = getCachedImage(entry.absolute_path);
        if (cached) setThumbnail(cached as string);
    }, [isTexture, entry.absolute_path]);

    // IntersectionObserver — only fire decode IPC for textures actually
    // scrolled into view. Folders with hundreds of textures used to kick
    // off every decode at once on mount; this caps work to what the user
    // is looking at, plus a 200px rootMargin so scrolling stays smooth.
    useEffect(() => {
        if (!isTexture || thumbnail) return;
        const el = cardRef.current;
        if (!el) return;
        const obs = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (e.isIntersecting) {
                        setInView(true);
                        obs.disconnect();
                        break;
                    }
                }
            },
            { rootMargin: '200px' },
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, [isTexture, thumbnail]);

    // Decode once the card has been seen. Cache the result so revisits +
    // adjacent components share work.
    useEffect(() => {
        if (!isTexture || !inView || thumbnail) return;
        let cancelled = false;
        (async () => {
            try {
                let url: string;
                if (entry.extension === 'dds' || entry.extension === 'tex') {
                    const decoded = await api.decodeDdsToPng(entry.absolute_path);
                    url = `data:image/png;base64,${decoded.data}`;
                } else {
                    const bytes = await api.readFileBytes(entry.absolute_path);
                    const blob = new Blob([bytes as BlobPart]);
                    url = URL.createObjectURL(blob);
                }
                if (cancelled) return;
                cacheImage(entry.absolute_path, url);
                setThumbnail(url);
            } catch {
                // Decode failure → falls back to icon. No toast — would be
                // noisy in folders with many bad/unsupported textures.
            }
        })();
        return () => { cancelled = true; };
    }, [isTexture, inView, thumbnail, entry.absolute_path, entry.extension]);

    return (
        <button
            ref={cardRef}
            type="button"
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            title={entry.name}
            style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '6px',
                padding: '8px',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                cursor: 'pointer',
                color: 'var(--text-primary)',
                textAlign: 'center',
                overflow: 'hidden',
            }}
        >
            <div
                style={{
                    width: '100%',
                    aspectRatio: '1 / 1',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--bg-tertiary, rgba(0,0,0,0.2))',
                    borderRadius: '4px',
                    overflow: 'hidden',
                }}
            >
                {thumbnail ? (
                    <img
                        src={thumbnail}
                        alt={entry.name}
                        style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'contain',
                            imageRendering: 'pixelated',
                        }}
                    />
                ) : (
                    // Icon size scales with the card so the SVG is
                    // readable at every zoom level. The CSS rule
                    // `.file-tree__icon svg` constrains size by default;
                    // bypass it here by writing dimensions directly into
                    // the wrapper and letting the inner SVG inherit.
                    <span
                        style={{
                            width: `${Math.round(cardSize * 0.55)}px`,
                            height: `${Math.round(cardSize * 0.55)}px`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                        ref={(el) => {
                            // Force the embedded SVG to fill the wrapper.
                            // dangerouslySetInnerHTML with size attrs on
                            // the SVG would override these; ref-based
                            // post-mutate dodges that.
                            if (!el) return;
                            const svg = el.querySelector('svg');
                            if (svg) {
                                svg.setAttribute('width', '100%');
                                svg.setAttribute('height', '100%');
                            }
                        }}
                        dangerouslySetInnerHTML={{
                            __html: getFileIcon(entry.name, entry.is_directory, false),
                        }}
                    />
                )}
            </div>
            <span
                style={{
                    fontSize: '11px',
                    width: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}
            >
                {entry.name}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                {entry.is_directory ? 'folder' : formatBytes(entry.size)}
            </span>
        </button>
    );
};
