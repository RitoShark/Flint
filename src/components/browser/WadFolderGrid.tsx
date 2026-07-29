/**
 * Card grid for a WAD/package folder — the same surface the project screen shows
 * when you select a folder in its tree, sourced from a VFS mount instead of disk.
 *
 * The WAD viewer used to leave the whole right-hand side blank until a file was
 * previewed. This fills it: pick a folder in the tree and its contents appear as
 * cards, with textures decoded into thumbnails.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../lib/api';
import { getFileIcon, getIcon } from '../../lib/ui-helpers/fileIcons';
import type { Vfs, VfsEntry } from '../../lib/vfs/types';

const TEXTURE_EXTS = new Set(['dds', 'tex', 'png', 'jpg', 'jpeg', 'webp']);

const CARD_SIZE_DEFAULT = 160;
const CARD_SIZE_MIN = 96;
const CARD_SIZE_MAX = 320;
const CARD_SIZE_STEP = 16;

function formatBytes(bytes: number | undefined): string {
    if (bytes === undefined) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(name: string): string {
    const i = name.lastIndexOf('.');
    return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

interface WadFolderGridProps {
    mount: Vfs;
    /** Folder being shown; '' is the archive root. */
    dir: string;
    /** Chunk count of the whole archive, for the root's summary line. */
    archiveLabel: string;
    onOpenFolder: (path: string) => void;
    onPreviewFile: (entry: VfsEntry) => void;
    onEntryContextMenu?: (e: React.MouseEvent, entry: VfsEntry) => void;
}

export const WadFolderGrid: React.FC<WadFolderGridProps> = ({
    mount,
    dir,
    archiveLabel,
    onOpenFolder,
    onPreviewFile,
    onEntryContextMenu,
}) => {
    const [entries, setEntries] = useState<VfsEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [cardSize, setCardSize] = useState(CARD_SIZE_DEFAULT);

    useEffect(() => {
        let cancelled = false;
        setEntries(null);
        setError(null);
        mount.list(dir)
            .then((res) => { if (!cancelled) setEntries(res); })
            .catch((e) => { if (!cancelled) setError((e as { message?: string })?.message ?? String(e)); });
        return () => { cancelled = true; };
    }, [mount, dir]);

    const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setCardSize((prev) => {
            const next = e.deltaY < 0 ? prev + CARD_SIZE_STEP : prev - CARD_SIZE_STEP;
            return Math.max(CARD_SIZE_MIN, Math.min(CARD_SIZE_MAX, next));
        });
    };

    /** Parent of the current folder; `null` at the root. */
    const parentDir = useMemo(() => {
        if (!dir) return null;
        const i = dir.lastIndexOf('/');
        return i === -1 ? '' : dir.slice(0, i);
    }, [dir]);

    const parentLabel = parentDir === null
        ? null
        : parentDir === '' ? archiveLabel : parentDir.slice(parentDir.lastIndexOf('/') + 1);

    return (
        <div className="wgrid">
            <div className="wgrid__bar">
                {parentDir !== null ? (
                    <button
                        type="button"
                        className="wgrid__up"
                        onClick={() => onOpenFolder(parentDir)}
                        title={`Go up to ${parentLabel}`}
                    >
                        <span className="wgrid__up-icon" dangerouslySetInnerHTML={{ __html: getIcon('chevronUp') }} />
                        <span className="wgrid__up-label">{parentLabel}</span>
                    </button>
                ) : (
                    <span className="wgrid__root">
                        <span className="wgrid__root-icon" dangerouslySetInnerHTML={{ __html: getIcon('package') }} />
                        {archiveLabel}
                    </span>
                )}
                <span className="wgrid__path" title={dir}>{dir || '(root)'}</span>
                <span className="wgrid__count">
                    {entries === null ? 'Loading…' : `${entries.length} item${entries.length === 1 ? '' : 's'}`}
                </span>
                <span className="wgrid__zoom" title="Hold Ctrl and scroll inside the grid to resize cards">
                    {cardSize}px
                </span>
            </div>

            <div className="wgrid__body" onWheel={handleWheel}>
                {error && <div className="wgrid__error">Error: {error}</div>}
                {!error && entries !== null && entries.length === 0 && (
                    <div className="wgrid__empty">This folder is empty</div>
                )}
                {entries !== null && entries.length > 0 && (
                    <div
                        className="wgrid__cards"
                        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` }}
                    >
                        {entries.map((entry) => (
                            <GridCard
                                key={entry.path}
                                mount={mount}
                                entry={entry}
                                cardSize={cardSize}
                                onOpen={() => entry.isDirectory ? onOpenFolder(entry.path) : onPreviewFile(entry)}
                                onContextMenu={onEntryContextMenu ? (e) => onEntryContextMenu(e, entry) : undefined}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

interface GridCardProps {
    mount: Vfs;
    entry: VfsEntry;
    cardSize: number;
    onOpen: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
}

const GridCard: React.FC<GridCardProps> = ({ mount, entry, cardSize, onOpen, onContextMenu }) => {
    const isTexture = !entry.isDirectory && TEXTURE_EXTS.has(extensionOf(entry.name));
    const [thumbnail, setThumbnail] = useState<string | null>(null);
    const cardRef = useRef<HTMLButtonElement>(null);
    const [inView, setInView] = useState(false);

    // Decode only what scrolls into view: a champion WAD folder can hold
    // hundreds of textures and each decode is a backend round trip.
    useEffect(() => {
        if (!isTexture || thumbnail) return;
        const el = cardRef.current;
        if (!el) return;
        const obs = new IntersectionObserver((es) => {
            for (const e of es) {
                if (e.isIntersecting) { setInView(true); obs.disconnect(); break; }
            }
        }, { rootMargin: '200px' });
        obs.observe(el);
        return () => obs.disconnect();
    }, [isTexture, thumbnail]);

    useEffect(() => {
        if (!isTexture || !inView || thumbnail) return;
        let cancelled = false;
        let objectUrl: string | null = null;
        (async () => {
            try {
                // Bytes come from the mount, so a staged edit previews as the
                // edited chunk rather than what is still on disk.
                const bytes = await mount.read(entry);
                const ext = extensionOf(entry.name);
                if (ext === 'dds' || ext === 'tex') {
                    // Raw RGBA straight onto a canvas — the repo's rule is not to
                    // add new Rust-PNG-encode → base64 → data-URL preview paths.
                    const { width, height, rgba } = await api.decodeBytesToRgba(bytes);
                    if (cancelled) return;
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    canvas.getContext('2d')?.putImageData(new ImageData(rgba, width, height), 0, 0);
                    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res));
                    if (cancelled || !blob) return;
                    objectUrl = URL.createObjectURL(blob);
                } else {
                    objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart]));
                }
                if (cancelled) {
                    URL.revokeObjectURL(objectUrl);
                    return;
                }
                setThumbnail(objectUrl);
            } catch {
                // A decode failure just leaves the type icon in place.
            }
        })();
        return () => { cancelled = true; };
    }, [isTexture, inView, thumbnail, mount, entry]);

    // Object URLs are owned by this card; release on unmount so scrolling a
    // large folder does not leak every thumbnail it decoded.
    useEffect(() => () => {
        if (thumbnail?.startsWith('blob:')) URL.revokeObjectURL(thumbnail);
    }, [thumbnail]);

    return (
        <button
            ref={cardRef}
            type="button"
            className="wgrid-card"
            onClick={onOpen}
            onContextMenu={onContextMenu}
            title={entry.path}
        >
            <div className="wgrid-card__art">
                {thumbnail ? (
                    <img src={thumbnail} alt={entry.name} />
                ) : (
                    <span
                        className="wgrid-card__icon"
                        style={{ width: `${Math.round(cardSize * 0.5)}px`, height: `${Math.round(cardSize * 0.5)}px` }}
                        ref={(el) => {
                            if (!el) return;
                            const svg = el.querySelector('svg');
                            if (svg) {
                                svg.setAttribute('width', '100%');
                                svg.setAttribute('height', '100%');
                            }
                        }}
                        dangerouslySetInnerHTML={{ __html: getFileIcon(entry.name, entry.isDirectory, false) }}
                    />
                )}
            </div>
            <span className="wgrid-card__name">{entry.name}</span>
            <span className="wgrid-card__meta">
                {entry.isDirectory ? 'folder' : formatBytes(entry.size)}
            </span>
        </button>
    );
};
