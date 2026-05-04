/**
 * Flint - WAD Explorer
 *
 * A unified Virtual File System (VFS) browser for all League game assets.
 * WADs are discovered via scan_game_wads then lazily loaded on expand via
 * get_wad_chunks — no chunk bytes are ever read at this stage.
 *
 * Layout mirrors the Mod Project screen:
 *   Left  — resizable VFS tree with debounced regex search
 *   Right — quick-action cards when idle, inline preview when a file is selected
 */

import React, {
    useState, useCallback, useEffect, useRef, useMemo,
} from 'react';
import { useAppState, useConfigStore, useWadExplorerStore } from '../lib/stores';
import * as api from '../lib/api';
import { open } from '@tauri-apps/plugin-dialog';
import { getIcon, getFileIcon } from '../lib/fileIcons';
import type { WadChunk, WadExplorerWad } from '../lib/types';
import * as monaco from 'monaco-editor';
import { RITOBIN_LANGUAGE_ID, RITOBIN_THEME_ID, registerRitobinLanguage, registerRitobinTheme } from '../lib/ritobinLanguage';
import LazyModelPreview from './preview/LazyModelPreview';
import { WadCheatSheetModal } from './modals/WadCheatSheetModal';

// ─────────────────────────────────────────────────────────────────────────────
// Inline SVG icons (fallbacks for any missing icon keys)
// ─────────────────────────────────────────────────────────────────────────────

const ICON_GRID = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>`;

// ─────────────────────────────────────────────────────────────────────────────
// Checkbox SVG icons (unchecked, checked, indeterminate)
// ─────────────────────────────────────────────────────────────────────────────

const CHECKBOX_UNCHECKED = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.2" opacity="0.5"/></svg>`;
const CHECKBOX_CHECKED = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="var(--accent, #4fc3f7)" stroke="var(--accent, #4fc3f7)" stroke-width="1.2"/><path d="M4.5 8l2.5 2.5 4.5-5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHECKBOX_INDETERMINATE = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="var(--accent, #4fc3f7)" stroke="var(--accent, #4fc3f7)" stroke-width="1.2" opacity="0.6"/><line x1="4.5" y1="8" x2="11.5" y2="8" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>`;

function checkboxSvg(state: 'none' | 'some' | 'all'): string {
    if (state === 'all') return CHECKBOX_CHECKED;
    if (state === 'some') return CHECKBOX_INDETERMINATE;
    return CHECKBOX_UNCHECKED;
}

// ─────────────────────────────────────────────────────────────────────────────
// VFS Tree types
// ─────────────────────────────────────────────────────────────────────────────

interface VFSFolder {
    type: 'folder';
    name: string;
    /** Unique key: `${wadPath}::${folderPath}` */
    key: string;
    children: VFSNode[];
}

interface VFSFile {
    type: 'file';
    name: string;
    chunk: WadChunk;
    wadPath: string;
}

type VFSNode = VFSFolder | VFSFile;

// ─────────────────────────────────────────────────────────────────────────────
// VFS tree builder (from chunks)
// ─────────────────────────────────────────────────────────────────────────────

function buildVFSSubtree(chunks: WadChunk[], wadPath: string): VFSNode[] {
    const folderMap = new Map<string, VFSFolder>();
    const roots: VFSNode[] = [];

    const getOrCreate = (folderPath: string): VFSFolder => {
        const key = `${wadPath}::${folderPath}`;
        if (folderMap.has(key)) return folderMap.get(key)!;
        const parts = folderPath.split('/');
        const name = parts[parts.length - 1];
        const parentPath = parts.slice(0, -1).join('/');
        const folder: VFSFolder = { type: 'folder', name, key, children: [] };
        folderMap.set(key, folder);
        if (parentPath === '') {
            roots.push(folder);
        } else {
            getOrCreate(parentPath).children.push(folder);
        }
        return folder;
    };

    for (const chunk of chunks) {
        if (!chunk.path) continue;
        const normalized = chunk.path.replace(/\\/g, '/');
        const parts = normalized.split('/');
        const fileName = parts[parts.length - 1];
        const dirParts = parts.slice(0, -1);
        const fileNode: VFSFile = { type: 'file', name: fileName, chunk, wadPath };
        if (dirParts.length === 0) {
            roots.push(fileNode);
        } else {
            getOrCreate(dirParts.join('/')).children.push(fileNode);
        }
    }

    // Unknown hashes at the bottom
    const unknown = chunks.filter(c => !c.path);
    if (unknown.length > 0) {
        const key = `${wadPath}::__unknown__`;
        roots.push({
            type: 'folder',
            name: `[Unknown Hashes] (${unknown.length})`,
            key,
            children: unknown.map(c => ({
                type: 'file' as const,
                name: c.hash,
                chunk: c,
                wadPath,
            })),
        });
    }

    const sort = (nodes: VFSNode[]) => {
        nodes.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            return (a.name ?? '').localeCompare(b.name ?? '');
        });
        for (const n of nodes) {
            if (n.type === 'folder') sort(n.children);
        }
    };
    sort(roots);
    return roots;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search helpers
// ─────────────────────────────────────────────────────────────────────────────

type SearchMode = 'contains' | 'starts' | 'regex';

function matchChunk(chunk: WadChunk, re: RegExp | null, plain: string, mode: SearchMode): boolean {
    if (mode === 'regex') return re ? re.test(chunk.path ?? chunk.hash) : false;
    const haystack = chunk.path?.toLowerCase() ?? chunk.hash;
    if (mode === 'starts') {
        // Match either the file basename or the full path starting with the query
        const slash = haystack.lastIndexOf('/');
        const basename = slash >= 0 ? haystack.slice(slash + 1) : haystack;
        return basename.startsWith(plain) || haystack.startsWith(plain);
    }
    return haystack.includes(plain);
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton placeholder shown while load_all_wad_chunks is in flight. Mirrors
// the np-skel/shimmer treatment used by the New Project modal so the empty
// list area doesn't read as broken during the ~5s load. Pure CSS shimmer —
// no per-row state, no React re-render churn.
// ─────────────────────────────────────────────────────────────────────────────
const WadListSkeleton: React.FC<{ count: number }> = ({ count }) => {
    return (
        <div className="wad-skel" role="presentation" aria-hidden="true">
            <div className="wad-skel__header">
                <span className="wad-skel__shimmer" style={{ width: 120, height: 14 }} />
                <span className="wad-skel__shimmer wad-skel__shimmer--soft" style={{ width: 60, height: 12 }} />
            </div>
            <div className="wad-skel__rows">
                {Array.from({ length: count }).map((_, i) => (
                    <div key={i} className="wad-skel__row" style={{ animationDelay: `${i * 60}ms` }}>
                        <span className="wad-skel__caret" />
                        <span className="wad-skel__icon" />
                        <span className="wad-skel__shimmer wad-skel__shimmer--name" style={{ width: `${42 + ((i * 17) % 38)}%` }} />
                        <span className="wad-skel__shimmer wad-skel__shimmer--meta" style={{ width: 48 }} />
                    </div>
                ))}
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Checkbox state helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeFileKey(wadPath: string, hash: string): string {
    return `${wadPath}::${hash}`;
}

/** Collect all `${wadPath}::${hash}` keys from a VFS folder recursively */
function collectFolderFileKeys(node: VFSFolder, wadPath: string): string[] {
    const keys: string[] = [];
    const walk = (n: VFSNode) => {
        if (n.type === 'file') keys.push(makeFileKey(wadPath, n.chunk.hash));
        else for (const c of n.children) walk(c);
    };
    walk(node);
    return keys;
}

/** Collect all hashes from a VFS folder recursively (for extraction) */
function collectFolderHashes(node: VFSFolder): string[] {
    const hashes: string[] = [];
    const walk = (n: VFSNode) => {
        if (n.type === 'file') hashes.push(n.chunk.hash);
        else for (const c of n.children) walk(c);
    };
    walk(node);
    return hashes;
}

/** Get checkbox state for a VFS folder based on how many descendant files are checked */
function getFolderCheckState(node: VFSFolder, wadPath: string, checkedFiles: Set<string>): 'none' | 'some' | 'all' {
    let hasChecked = false;
    let hasUnchecked = false;
    const walk = (n: VFSNode): boolean => {
        if (n.type === 'file') {
            if (checkedFiles.has(makeFileKey(wadPath, n.chunk.hash))) hasChecked = true;
            else hasUnchecked = true;
            return !(hasChecked && hasUnchecked); // false = abort early
        }
        for (const c of n.children) { if (!walk(c)) return false; }
        return true;
    };
    walk(node);
    if (hasChecked && hasUnchecked) return 'some';
    return hasChecked ? 'all' : 'none';
}

function getWadCheckState(wad: WadExplorerWad, checkedFiles: Set<string>): 'none' | 'some' | 'all' {
    if (wad.status !== 'loaded' || wad.chunks.length === 0) return 'none';
    let hasChecked = false;
    let hasUnchecked = false;
    for (const c of wad.chunks) {
        if (checkedFiles.has(makeFileKey(wad.path, c.hash))) hasChecked = true;
        else hasUnchecked = true;
        if (hasChecked && hasUnchecked) return 'some';
    }
    return hasChecked ? 'all' : 'none';
}

/** Get check state for an arbitrary list of file keys */
function getCheckStateForKeys(keys: string[], checkedFiles: Set<string>): 'none' | 'some' | 'all' {
    if (keys.length === 0) return 'none';
    let checked = 0;
    for (const k of keys) {
        if (checkedFiles.has(k)) checked++;
    }
    if (checked === 0) return 'none';
    if (checked === keys.length) return 'all';
    return 'some';
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick-action card config
// ─────────────────────────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
    { label: 'Textures', regex: /\.(dds|tex|png|jpg|jpeg)$/i, iconHtml: getIcon('texture') },
    { label: 'BIN Files', regex: /\.bin$/i, iconHtml: getIcon('bin') },
    { label: 'Audio', regex: /\.(bnk|wpk)$/i, iconHtml: getIcon('audio') },
    { label: 'Models', regex: /\.(skn|skl|scb|sco)$/i, iconHtml: getIcon('model') },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Inline chunk preview (self-contained, no ExtractSession needed)
// ─────────────────────────────────────────────────────────────────────────────

interface PreviewData {
    fileType: string;
    bytes: Uint8Array;
    imageUrl: string | null;
    text: string | null;
    dims: [number, number] | null;
}

function detectType(bytes: Uint8Array, pathHint: string | null): string {
    const ext = pathHint?.split('.').pop()?.toLowerCase() ?? '';
    if (bytes.length >= 4) {
        const b = bytes;
        if (b[0] === 0x54 && b[1] === 0x45 && b[2] === 0x58 && b[3] === 0x00) return 'image/tex';
        if (b[0] === 0x44 && b[1] === 0x44 && b[2] === 0x53 && b[3] === 0x20) return 'image/dds';
        if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
        if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
        if (b[0] === 0x1b && b[1] === 0x4c && b[2] === 0x75 && b[3] === 0x61) return 'application/x-luabin'; // \x1bLua
        const magic = String.fromCharCode(b[0], b[1], b[2], b[3]);
        if (magic === 'PROP' || magic === 'PTCH') return 'application/x-bin';
    }
    const extMap: Record<string, string> = {
        dds: 'image/dds', tex: 'image/tex', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        bin: 'application/x-bin', json: 'application/json', txt: 'text/plain', lua: 'text/x-lua',
        xml: 'application/xml', js: 'text/javascript', ts: 'text/typescript',
        skn: 'model/x-lol-skn', skl: 'model/x-lol-skl', scb: 'model/x-lol-scb',
        anm: 'animation/x-lol-anm', bnk: 'audio/x-wwise-bnk', wpk: 'audio/x-wwise-wpk',
        luabin: 'application/x-luabin', luabin64: 'application/x-luabin', troybin: 'application/x-troybin',
    };
    return extMap[ext] ?? 'application/octet-stream';
}

const ChunkPreview: React.FC<{
    wadPath: string;
    chunk: WadChunk;
    onClose: () => void;
}> = ({ wadPath, chunk, onClose }) => {
    const { showToast } = useAppState();
    const [data, setData] = useState<PreviewData | null>(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [zoom, setZoom] = useState<'fit' | number>('fit');
    const [extracting, setExtracting] = useState(false);
    const blobUrlRef = useRef<string | null>(null);
    // SKN inline preview state
    const [modelPreviewPath, setModelPreviewPath] = useState<string | null>(null);
    const [modelTempDir, setModelTempDir] = useState<string | null>(null);
    const [modelLoading, setModelLoading] = useState(false);

    // Cleanup model temp dir on chunk change or unmount
    useEffect(() => {
        return () => {
            if (modelTempDir) api.cleanupWadModelPreview(modelTempDir).catch(() => {});
        };
    }, [modelTempDir]);

    useEffect(() => {
        let cancelled = false;
        if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
        setLoading(true); setErr(null); setData(null); setZoom('fit');
        setModelPreviewPath(null);
        if (modelTempDir) { api.cleanupWadModelPreview(modelTempDir).catch(() => {}); setModelTempDir(null); }

        (async () => {
            try {
                const bytes = await api.readWadChunkData(wadPath, chunk.hash);
                if (cancelled) return;
                const fileType = detectType(bytes, chunk.path);
                let imageUrl: string | null = null;
                let text: string | null = null;
                let dims: [number, number] | null = null;

                if (fileType === 'image/dds' || fileType === 'image/tex') {
                    const decoded = await api.decodeBytesToPng(bytes);
                    if (!cancelled) { imageUrl = `data:image/png;base64,${decoded.data}`; dims = [decoded.width, decoded.height]; }
                } else if (fileType === 'image/png' || fileType === 'image/jpeg') {
                    const mime = fileType === 'image/png' ? 'image/png' : 'image/jpeg';
                    const buf = new ArrayBuffer(bytes.byteLength);
                    new Uint8Array(buf).set(bytes);
                    const url = URL.createObjectURL(new Blob([buf], { type: mime }));
                    blobUrlRef.current = url;
                    if (!cancelled) imageUrl = url;
                } else if (fileType === 'application/x-bin') {
                    if (!cancelled) text = await api.convertBinToText(bytes);
                } else if (fileType === 'application/x-luabin') {
                    if (!cancelled) text = await api.readWadLuabin(wadPath, chunk.hash);
                } else if (fileType === 'application/x-troybin') {
                    if (!cancelled) text = await api.readWadTroybin(wadPath, chunk.hash);
                } else if (fileType.startsWith('text/') || fileType === 'application/json' || fileType === 'application/xml') {
                    if (!cancelled) text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                }

                if (!cancelled) setData({ fileType, bytes, imageUrl, text, dims });
            } catch (e) {
                if (!cancelled) setErr((e as Error).message ?? 'Failed to load preview');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [wadPath, chunk.hash]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current); }, []);

    const handleExtract = async () => {
        try {
            const dest = await open({ title: 'Choose Extraction Folder', directory: true });
            if (!dest) return;
            setExtracting(true);
            const res = await api.extractWad(wadPath, dest as string, [chunk.hash]);
            showToast('success', `Extracted ${res.extracted} file`);
        } catch { showToast('error', 'Extraction failed'); }
        finally { setExtracting(false); }
    };

    const fileName = chunk.path
        ? (chunk.path.split('/').pop() ?? chunk.path.split('\\').pop() ?? chunk.path)
        : chunk.hash;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Toolbar */}
            <div className="preview-panel__toolbar" style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                <button className="btn btn--sm" onClick={onClose} title="Close preview" style={{ padding: '2px 6px' }}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
                {data?.imageUrl && (
                    <>
                        {(['fit', 1, 2] as const).map(z => (
                            <button key={String(z)} className={`btn btn--sm ${zoom === z ? 'btn--active' : ''}`} onClick={() => setZoom(z)}>
                                {z === 'fit' ? 'Fit' : `${(z as number) * 100}%`}
                            </button>
                        ))}
                        <div style={{ width: '1px', height: '14px', background: 'var(--border)', margin: '0 2px' }} />
                    </>
                )}
                <span className="preview-panel__filename" style={{ fontSize: '12px', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fileName}
                </span>
                <button className="btn btn--sm btn--primary" onClick={handleExtract} disabled={extracting} title="Extract file to folder">
                    <span dangerouslySetInnerHTML={{ __html: getIcon('export') }} />
                    <span>{extracting ? 'Extracting…' : 'Extract'}</span>
                </button>
            </div>

            {/* Content */}
            <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                {loading && (
                    <div className="preview-panel__loading"><div className="spinner" /><span>Loading…</span></div>
                )}
                {err && (
                    <div className="preview-panel__error">
                        <span dangerouslySetInnerHTML={{ __html: getIcon('warning') }} />
                        <span>{err}</span>
                    </div>
                )}
                {data && !loading && !err && (() => {
                    const { fileType, bytes, imageUrl, text, dims } = data;

                    if (imageUrl) {
                        const imgStyle: React.CSSProperties = zoom === 'fit'
                            ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
                            : { width: `${(dims?.[0] ?? 0) * (zoom as number)}px` };
                        return (
                            <div
                                className="image-preview"
                                onWheel={e => {
                                    e.preventDefault();
                                    const cur = zoom === 'fit' ? 1 : (zoom as number);
                                    setZoom(Math.max(0.1, Math.min(5, cur + (e.deltaY > 0 ? -0.1 : 0.1))));
                                }}
                                style={{ overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}
                            >
                                <img src={imageUrl} alt={fileName} draggable={false} style={imgStyle}
                                    onLoad={e => {
                                        if (!dims) {
                                            const img = e.currentTarget;
                                            setData(p => p ? { ...p, dims: [img.naturalWidth, img.naturalHeight] } : p);
                                        }
                                    }}
                                />
                            </div>
                        );
                    }

                    if (text !== null) {
                        // BIN files get Monaco editor with Ritobin syntax highlighting
                        if (fileType === 'application/x-bin') {
                            return <MonacoBinViewer text={text} />;
                        }
                        // LuaBin files get Monaco editor with Lua syntax highlighting
                        if (fileType === 'application/x-luabin') {
                            return <MonacoTextViewer text={text} language="lua" />;
                        }
                        // TroyBin files get Monaco editor with INI syntax highlighting
                        if (fileType === 'application/x-troybin') {
                            return <MonacoTextViewer text={text} language="ini" />;
                        }
                        // Plain text files get simple pre tag
                        return (
                            <pre style={{ margin: 0, padding: '12px 16px', overflow: 'auto', height: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: '12px', lineHeight: '1.6', color: 'var(--text-primary)', background: 'var(--bg-secondary)', boxSizing: 'border-box', whiteSpace: 'pre-wrap' }}>
                                {text}
                            </pre>
                        );
                    }

                    if (fileType === 'model/x-lol-skn') {
                        if (modelPreviewPath) {
                            return (
                                <div style={{ height: '100%', width: '100%' }}>
                                    <LazyModelPreview filePath={modelPreviewPath} meshType="skinned" />
                                </div>
                            );
                        }
                        return (
                            <div className="preview-panel__empty">
                                <div style={{ fontSize: '13px', color: 'var(--text-muted)', textAlign: 'center' }}>
                                    <div style={{ marginBottom: '12px', opacity: 0.6 }}>{fileType}</div>
                                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                                        <button
                                            className="btn btn--primary btn--sm"
                                            disabled={modelLoading}
                                            onClick={async () => {
                                                setModelLoading(true);
                                                try {
                                                    const result = await api.extractWadModelPreview(wadPath, chunk.hash);
                                                    setModelPreviewPath(result.skn_path);
                                                    setModelTempDir(result.temp_dir);
                                                } catch (e) {
                                                    setErr((e as Error).message ?? 'Failed to prepare model preview');
                                                } finally {
                                                    setModelLoading(false);
                                                }
                                            }}
                                        >
                                            <span dangerouslySetInnerHTML={{ __html: getIcon('model') }} />
                                            <span>{modelLoading ? 'Preparing…' : 'Preview 3D Model'}</span>
                                        </button>
                                        <button className="btn btn--sm" onClick={handleExtract} disabled={extracting}>
                                            <span dangerouslySetInnerHTML={{ __html: getIcon('export') }} />
                                            <span>Extract</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    }

                    if (fileType.startsWith('model/') || fileType.startsWith('audio/') || fileType.startsWith('animation/')) {
                        return (
                            <div className="preview-panel__empty">
                                <div style={{ fontSize: '13px', color: 'var(--text-muted)', textAlign: 'center' }}>
                                    <div style={{ marginBottom: '12px', opacity: 0.6 }}>{fileType}</div>
                                    <button className="btn btn--primary btn--sm" onClick={handleExtract} disabled={extracting}>
                                        <span dangerouslySetInnerHTML={{ __html: getIcon('export') }} />
                                        <span>Extract to preview</span>
                                    </button>
                                </div>
                            </div>
                        );
                    }

                    // Hex dump
                    const slice = bytes.slice(0, 16 * 256);
                    const rows = [];
                    for (let i = 0; i < slice.length; i += 16) {
                        const row = slice.slice(i, i + 16);
                        const hex = Array.from(row).map(b => b.toString(16).padStart(2, '0')).join(' ');
                        const ascii = Array.from(row).map(b => b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.').join('');
                        rows.push(
                            <div key={i} style={{ display: 'flex', gap: '16px', fontFamily: 'monospace', fontSize: '11px', lineHeight: '1.5' }}>
                                <span style={{ color: 'var(--text-muted)', minWidth: '56px' }}>{i.toString(16).padStart(8, '0')}</span>
                                <span style={{ color: 'var(--text-primary)', flex: 1 }}>{hex}</span>
                                <span style={{ color: 'var(--text-muted)' }}>{ascii}</span>
                            </div>
                        );
                    }
                    return (
                        <div style={{ padding: '12px', overflow: 'auto', height: '100%', background: 'var(--bg-secondary)' }}>
                            {rows}
                            {bytes.length > slice.length && (
                                <div style={{ marginTop: '8px', color: 'var(--text-muted)', fontSize: '11px' }}>
                                    … {(bytes.length - slice.length).toLocaleString()} more bytes
                                </div>
                            )}
                        </div>
                    );
                })()}
            </div>

            {/* Info bar */}
            {data && (
                <div className="preview-panel__info-bar" style={{ display: 'flex', gap: '12px', padding: '4px 10px', fontSize: '11px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
                    <span><span style={{ opacity: 0.6 }}>Size: </span>{formatBytes(data.bytes.length)}</span>
                    {data.dims && <span><span style={{ opacity: 0.6 }}>Dims: </span>{data.dims[0]}×{data.dims[1]}</span>}
                    <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: '10px' }}>{chunk.hash}</span>
                </div>
            )}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Virtualized list – renders only the rows visible in the scroll viewport
// ─────────────────────────────────────────────────────────────────────────────

interface VirtualizedListProps {
    totalRows: number;
    rowHeight: number;
    overscan: number;
    renderRow: (index: number) => React.ReactNode;
}

interface VirtualizedListHandle {
    scrollToIndex: (index: number) => void;
}

const VirtualizedListInner = React.forwardRef<VirtualizedListHandle, VirtualizedListProps>(
    ({ totalRows, rowHeight, overscan, renderRow }, ref) => {
    const [scrollTop, setScrollTop] = React.useState(0);
    const [containerHeight, setContainerHeight] = React.useState(600);
    const containerRef = React.useRef<HTMLDivElement>(null);
    const rafRef = React.useRef<number | null>(null);

    // Track container height via ResizeObserver
    React.useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const ro = new ResizeObserver(entries => {
            for (const entry of entries) {
                setContainerHeight(entry.contentRect.height);
            }
        });
        ro.observe(el);
        setContainerHeight(el.clientHeight);
        return () => ro.disconnect();
    }, []);

    // Cleanup RAF on unmount
    React.useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

    React.useImperativeHandle(ref, () => ({
        scrollToIndex: (index: number) => {
            const el = containerRef.current;
            if (!el) return;
            const top = index * rowHeight;
            if (top < el.scrollTop || top + rowHeight > el.scrollTop + el.clientHeight) {
                el.scrollTop = Math.max(0, top - Math.floor(el.clientHeight / 3));
            }
        },
    }), [rowHeight]);

    const handleScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const target = e.target as HTMLDivElement;
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
            setScrollTop(target.scrollTop);
            rafRef.current = null;
        });
    }, []);

    const totalHeight = totalRows * rowHeight;
    const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const endIndex = Math.min(totalRows - 1, Math.ceil((scrollTop + containerHeight) / rowHeight) + overscan);

    const visibleRows: React.ReactNode[] = [];
    for (let i = startIndex; i <= endIndex; i++) {
        visibleRows.push(
            <div
                key={i}
                style={{
                    position: 'absolute',
                    top: i * rowHeight,
                    left: 0,
                    right: 0,
                    height: rowHeight,
                    overflow: 'hidden',
                }}
            >
                {renderRow(i)}
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
            onScroll={handleScroll}
        >
            <div style={{ position: 'relative', height: totalHeight, minHeight: '100%' }}>
                {visibleRows}
            </div>
        </div>
    );
});

const VirtualizedList = React.memo(VirtualizedListInner);
VirtualizedList.displayName = 'VirtualizedList';

// ─────────────────────────────────────────────────────────────────────────────
// Flat-row types for virtualized rendering
// ─────────────────────────────────────────────────────────────────────────────

const ROW_HEIGHT = 26;
const OVERSCAN = 8; // extra rows above/below viewport

type FlatRow =
    | { kind: 'category'; cat: string; loadedCount: number; totalCount: number }
    | { kind: 'wad'; wad: WadExplorerWad }
    | { kind: 'wad-loading'; wadPath: string }
    | { kind: 'wad-error'; wadPath: string; error: string }
    | { kind: 'folder'; node: VFSFolder; effectiveNode: VFSFolder; displayPath: string; wadPath: string; depth: number }
    | { kind: 'file'; node: VFSFile; depth: number };

type FlatSearchRow =
    | { kind: 'search-wad'; wadPath: string; wadName: string; totalMatches: number; folders: Array<{ folderPath: string; files: Array<{ chunk: WadChunk; fileName: string }> }> }
    | { kind: 'search-folder'; wadPath: string; folderPath: string; fileCount: number }
    | { kind: 'search-file'; wadPath: string; chunk: WadChunk; fileName: string; folderPath: string };

// Compact folders: merge single-child VFS folder chains into one label
function compactVFSNode(node: VFSFolder): { displayPath: string; effectiveNode: VFSFolder } {
    let current = node;
    const parts = [current.name];
    while (
        current.children.length === 1 &&
        current.children[0].type === 'folder'
    ) {
        current = current.children[0];
        parts.push(current.name);
    }
    return { displayPath: parts.join('/'), effectiveNode: current };
}

// Collect all descendant folder keys for deep expand/collapse
function collectAllVFSFolderKeys(node: VFSNode): string[] {
    if (node.type !== 'folder') return [];
    const result = [node.key];
    for (const child of node.children) {
        result.push(...collectAllVFSFolderKeys(child));
    }
    return result;
}

// Find wadPath from any descendant file
function findWadPath(node: VFSNode): string | null {
    if (node.type === 'file') return node.wadPath;
    for (const c of node.children) { const r = findWadPath(c); if (r) return r; }
    return null;
}

/** Flatten the category → WAD → VFS tree into a flat row array for virtualized rendering */
function flattenTree(
    categories: [string, WadExplorerWad[]][],
    collapsedCategories: Set<string>,
    expandedWads: Set<string>,
    expandedFolders: Set<string>,
    wadSubtrees: Map<string, VFSNode[]>,
): FlatRow[] {
    const rows: FlatRow[] = [];
    for (const [cat, wads] of categories) {
        const loadedCount = wads.filter(w => w.status === 'loaded').length;
        rows.push({ kind: 'category', cat, loadedCount, totalCount: wads.length });
        if (collapsedCategories.has(cat)) continue;

        for (const wad of wads) {
            rows.push({ kind: 'wad', wad });
            const isExp = expandedWads.has(wad.path);
            if (!isExp) continue;

            if (wad.status === 'loading') {
                rows.push({ kind: 'wad-loading', wadPath: wad.path });
                continue;
            }
            if (wad.status === 'error') {
                rows.push({ kind: 'wad-error', wadPath: wad.path, error: wad.error ?? 'Failed to load' });
                continue;
            }
            if (wad.status !== 'loaded') continue;

            const subtree = wadSubtrees.get(wad.path) ?? [];
            const walkNodes = (nodes: VFSNode[], depth: number) => {
                for (const node of nodes) {
                    if (node.type === 'file') {
                        rows.push({ kind: 'file', node, depth });
                    } else {
                        const { displayPath, effectiveNode } = compactVFSNode(node);
                        const wadP = findWadPath(effectiveNode);
                        rows.push({ kind: 'folder', node, effectiveNode, displayPath, wadPath: wadP ?? '', depth });
                        if (expandedFolders.has(effectiveNode.key)) {
                            walkNodes(effectiveNode.children, depth + 1);
                        }
                    }
                }
            };
            walkNodes(subtree, 1);
        }
    }
    return rows;
}

/** Flatten search results into a flat row array for virtualized rendering */
function flattenSearchResults(
    groups: Array<{
        wadPath: string;
        wadName: string;
        folders: Array<{ folderPath: string; files: Array<{ chunk: WadChunk; fileName: string }> }>;
        totalMatches: number;
    }>,
    collapsedSearchWads: Set<string>,
    collapsedSearchFolders: Set<string>,
): FlatSearchRow[] {
    const rows: FlatSearchRow[] = [];
    for (const group of groups) {
        rows.push({ kind: 'search-wad', wadPath: group.wadPath, wadName: group.wadName, totalMatches: group.totalMatches, folders: group.folders });
        if (collapsedSearchWads.has(group.wadPath)) continue;

        for (const folder of group.folders) {
            const folderKey = `${group.wadPath}::s::${folder.folderPath}`;
            if (folder.folderPath !== '') {
                rows.push({ kind: 'search-folder', wadPath: group.wadPath, folderPath: folder.folderPath, fileCount: folder.files.length });
            }
            if (!collapsedSearchFolders.has(folderKey)) {
                for (const f of folder.files) {
                    rows.push({ kind: 'search-file', wadPath: group.wadPath, chunk: f.chunk, fileName: f.fileName, folderPath: folder.folderPath });
                }
            }
        }
    }
    return rows;
}


// ─────────────────────────────────────────────────────────────────────────────
// Quick-action cards (shown when no file is previewed)
// ─────────────────────────────────────────────────────────────────────────────

interface QuickActionPanelProps {
    wads: WadExplorerWad[];
    onSetFilter: (query: string) => void;
    onOpenRecent: (wadPath: string) => void;
}

const QuickActionPanel: React.FC<QuickActionPanelProps> = ({ wads, onSetFilter, onOpenRecent }) => {
    const recentWads = useWadExplorerStore((s) => s.recentWads);

    const loadedChunks = useMemo(() => {
        const all: WadChunk[] = [];
        for (const w of wads) {
            if (w.status === 'loaded') all.push(...w.chunks);
        }
        return all;
    }, [wads]);

    const counts = useMemo(() =>
        QUICK_ACTIONS.map(qa => ({
            ...qa,
            count: loadedChunks.filter(c => c.path && qa.regex.test(c.path)).length,
        })),
        [loadedChunks]
    );

    const totalLoaded = wads.filter(w => w.status === 'loaded').length;
    const totalWads = wads.length;

    // Resolve recent WAD entries against the current scan so we can show the
    // friendly name + category and skip stale entries (e.g. paths from a
    // previous game install).
    const allRecentEntries = useMemo(() => {
        const byPath = new Map(wads.map((w) => [w.path, w] as const));
        return recentWads
            .map((p) => byPath.get(p))
            .filter((w): w is WadExplorerWad => !!w);
    }, [recentWads, wads]);

    // Compute how many recent rows fit between the header and the filter
    // grid. Without this, a tall list pushes the filter cards off-screen on
    // small windows. Re-measures on resize.
    const panelRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const filtersRef = useRef<HTMLDivElement>(null);
    const recentTitleRef = useRef<HTMLDivElement>(null);
    const ROW_HEIGHT = 38; // 8px padding + ~22px content + 4px gap (.btn--ghost)
    const ROW_GAP = 4;
    const [maxRows, setMaxRows] = useState(8);

    useEffect(() => {
        const recompute = () => {
            const panel = panelRef.current;
            const header = headerRef.current;
            const filters = filtersRef.current;
            if (!panel || !header || !filters) return;
            // 28px gap × 2 (header→recent, recent→filters) + 32px panel padding × 2
            const fixed = header.offsetHeight + filters.offsetHeight + (recentTitleRef.current?.offsetHeight ?? 24) + 28 * 2 + 32 * 2;
            const available = panel.clientHeight - fixed;
            const fit = Math.max(1, Math.floor((available + ROW_GAP) / (ROW_HEIGHT + ROW_GAP)));
            setMaxRows(Math.min(fit, 20));
        };

        recompute();
        const panel = panelRef.current;
        if (!panel) return;
        const ro = new ResizeObserver(recompute);
        ro.observe(panel);
        return () => ro.disconnect();
    }, []);

    const recentEntries = allRecentEntries.slice(0, maxRows);
    const hidden = allRecentEntries.length - recentEntries.length;

    return (
        <div ref={panelRef} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '28px', padding: '32px', overflow: 'hidden' }}>
            <div ref={headerRef} style={{ textAlign: 'center' }}>
                <div style={{ opacity: 0.4, marginBottom: '8px' }} dangerouslySetInnerHTML={{ __html: ICON_GRID }} />
                <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '6px' }}>WAD Explorer</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {totalWads === 0
                        ? 'Scanning game directory…'
                        : totalLoaded < totalWads
                            ? `Loading WADs… ${totalLoaded} / ${totalWads}`
                            : `${totalWads} WADs loaded — select a file to preview`}
                </div>
            </div>

            {recentEntries.length > 0 && (
                <div style={{ width: '100%', maxWidth: '480px' }}>
                    <div ref={recentTitleRef} style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '8px', paddingLeft: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <span>Recent WADs</span>
                        {hidden > 0 && (
                            <span style={{ textTransform: 'none', letterSpacing: 0, fontSize: '10px' }}>
                                +{hidden} more (resize to see)
                            </span>
                        )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: `${ROW_GAP}px` }}>
                        {recentEntries.map((wad) => (
                            <button
                                key={wad.path}
                                className="btn btn--ghost"
                                onClick={() => onOpenRecent(wad.path)}
                                title={wad.path}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: '12px',
                                    padding: '8px 12px',
                                    height: `${ROW_HEIGHT}px`,
                                    width: '100%',
                                    textAlign: 'left',
                                }}
                            >
                                <span style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {wad.name}
                                </span>
                                <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>
                                    {wad.category}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div ref={filtersRef} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', width: '100%', maxWidth: '480px' }}>
                {counts.map(qa => (
                    <button
                        key={qa.label}
                        className="btn btn--secondary"
                        onClick={() => onSetFilter(qa.regex.source)}
                        title={`Filter to ${qa.label} (${qa.count.toLocaleString()} in loaded WADs)`}
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '20px 12px', height: 'auto' }}
                    >
                        <span dangerouslySetInnerHTML={{ __html: qa.iconHtml }} />
                        <span style={{ fontSize: '13px', fontWeight: 500 }}>{qa.label}</span>
                        {qa.count > 0 && (
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                {qa.count.toLocaleString()}
                            </span>
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Monaco BIN Viewer Component (read-only with syntax highlighting)
// ─────────────────────────────────────────────────────────────────────────────

// Register Ritobin language once at module load
registerRitobinLanguage(monaco as any);
registerRitobinTheme(monaco as any);

const MonacoBinViewer: React.FC<{ text: string }> = ({ text }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        // Create Monaco editor
        const editor = monaco.editor.create(containerRef.current, {
            value: text,
            language: RITOBIN_LANGUAGE_ID,
            theme: RITOBIN_THEME_ID,
            readOnly: true,
            automaticLayout: true,
            fontFamily: 'var(--font-mono), "Cascadia Code", "Fira Code", Consolas, monospace',
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderWhitespace: 'none',
            folding: false,
            lineNumbers: 'on',
        });

        editorRef.current = editor;

        return () => {
            editor.dispose();
            editorRef.current = null;
        };
    }, []); // Only create once

    // Update content when text changes
    useEffect(() => {
        if (editorRef.current) {
            const model = editorRef.current.getModel();
            if (model && model.getValue() !== text) {
                model.setValue(text);
            }
        }
    }, [text]);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
};

// ─────────────────────────────────────────────────────────────────────────────
// Generic Monaco Viewer (Lua, INI, etc. with built-in language support)
// ─────────────────────────────────────────────────────────────────────────────

const MonacoTextViewer: React.FC<{ text: string; language: string }> = ({ text, language }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const editor = monaco.editor.create(containerRef.current, {
            value: text,
            language,
            theme: 'vs-dark',
            readOnly: true,
            automaticLayout: true,
            fontFamily: 'var(--font-mono), "Cascadia Code", "Fira Code", Consolas, monospace',
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderWhitespace: 'none',
            folding: true,
            lineNumbers: 'on',
        });

        editorRef.current = editor;

        return () => {
            editor.dispose();
            editorRef.current = null;
        };
    }, [language]); // Recreate if language changes

    useEffect(() => {
        if (editorRef.current) {
            const model = editorRef.current.getModel();
            if (model && model.getValue() !== text) {
                model.setValue(text);
            }
        }
    }, [text]);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main WadExplorer component
// ─────────────────────────────────────────────────────────────────────────────

export const WadExplorer: React.FC = () => {
    const { state, dispatch, showToast } = useAppState();
    const { wadExplorer } = state;

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
    // { wadPath, filePath?, phase: 'wad'|'file' } — drives async navigation
    const pendingNavRef = useRef<{ wadPath: string; filePath?: string; phase: 'wad' | 'file' } | null>(null);
    // Always-fresh mirrors so processNavigation can run without stale closures
    const flatRowsRef = useRef<FlatRow[] | null>(null);

    // Search input (debounced → global state)
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
    // The store only holds one wads list at a time. We snapshot it per branch
    // in a ref so toggling between PBE and Live is instant — no rescan, and
    // already-loaded chunks survive (vfsCacheRef is keyed by absolute WAD path,
    // so PBE and Live entries coexist there naturally without conflict).
    const configStore = useConfigStore();
    const [branch, setBranch] = useState<'live' | 'pbe'>('live');
    const branchSnapshotRef = useRef<Map<'live' | 'pbe', {
        wads: WadExplorerWad[];
        scanStatus: 'idle' | 'scanning' | 'ready' | 'error';
        scanError: string | null;
    }>>(new Map());

    const effectiveLeagueRoot = branch === 'pbe' ? configStore.leaguePathPbe : state.leaguePath;
    const effectiveGamePath = effectiveLeagueRoot ? `${effectiveLeagueRoot}/Game` : null;

    // ── Scan on mount if not yet scanned ────────────────────────────────────
    useEffect(() => {
        if (wadExplorer.scanStatus !== 'idle') return;
        if (!effectiveGamePath) return; // user must pick a folder
        runScan(effectiveGamePath);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const runScan = async (gamePath: string) => {
        dispatch({ type: 'SET_WAD_EXPLORER_SCAN', payload: { status: 'scanning' } });
        try {
            const wads = await api.scanGameWads(gamePath);
            dispatch({ type: 'SET_WAD_EXPLORER_SCAN', payload: { status: 'ready', wads } });
        } catch (e) {
            dispatch({ type: 'SET_WAD_EXPLORER_SCAN', payload: { status: 'error', error: (e as Error).message } });
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

        // Snapshot the current branch's full state before swapping.
        branchSnapshotRef.current.set(branch, {
            wads: wadExplorer.wads,
            scanStatus: wadExplorer.scanStatus,
            scanError: wadExplorer.scanError,
        });

        setBranch(next);

        // Restore cached snapshot for the new branch if we have one — instant swap.
        const cached = branchSnapshotRef.current.get(next);
        if (cached && cached.scanStatus === 'ready' && cached.wads.length > 0) {
            // setScan remaps every wad to {status:'idle', chunks:[]}, so seed the
            // base list first, then re-apply the cached loaded chunks per WAD.
            const baseWads = cached.wads.map(w => ({
                path: w.path,
                name: w.name,
                category: w.category,
            }));
            dispatch({
                type: 'SET_WAD_EXPLORER_SCAN',
                payload: { status: 'ready', wads: baseWads },
            });
            const loaded = cached.wads.filter(w => w.status === 'loaded' && w.chunks.length > 0);
            if (loaded.length > 0) {
                dispatch({
                    type: 'BATCH_SET_WAD_STATUSES',
                    payload: loaded.map(w => ({ wadPath: w.path, status: 'loaded' as const, chunks: w.chunks })),
                });
            }
            return;
        }

        // No cache for this branch yet — fresh scan against the new path.
        const nextRoot = next === 'pbe' ? configStore.leaguePathPbe : state.leaguePath;
        const nextGamePath = nextRoot ? `${nextRoot}/Game` : null;
        if (!nextGamePath) {
            dispatch({ type: 'SET_WAD_EXPLORER_SCAN', payload: { status: 'idle' } });
            return;
        }
        runScan(nextGamePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [branch, configStore.leaguePathPbe, state.leaguePath, wadExplorer.wads, wadExplorer.scanStatus, wadExplorer.scanError]);

    // ── Lazy WAD loading: load on-demand when WAD is expanded ─────────────────
    // This is MUCH faster than bulk-loading all 457 WADs upfront (was 15+ seconds).
    // Now the UI appears instantly and chunks load only when the user expands a WAD.
    const loadWad = useCallback(async (wadPath: string) => {
        dispatch({ type: 'SET_WAD_EXPLORER_WAD_STATUS', payload: { wadPath, status: 'loading' } });
        try {
            const chunks = await api.getWadChunks(wadPath);
            dispatch({ type: 'SET_WAD_EXPLORER_WAD_STATUS', payload: { wadPath, status: 'loaded', chunks } });
        } catch (e) {
            dispatch({ type: 'SET_WAD_EXPLORER_WAD_STATUS', payload: { wadPath, status: 'error', error: (e as Error).message } });
        }
    }, [dispatch]);

    const pushRecentWad = useWadExplorerStore((s) => s.pushRecentWad);
    const handleToggleWad = useCallback((wadPath: string) => {
        const wad = wadExplorer.wads.find(w => w.path === wadPath);
        const wasCollapsed = !wadExplorer.expandedWads.has(wadPath);

        dispatch({ type: 'TOGGLE_WAD_EXPLORER_WAD', payload: wadPath });

        // Track WAD as recently-opened on expand. Used by the empty-state
        // panel to offer one-click reopen.
        if (wasCollapsed) pushRecentWad(wadPath);

        // Load chunks lazily when WAD is being expanded (was collapsed, will be expanded)
        if (wad?.status === 'idle' && wasCollapsed) {
            loadWad(wadPath);
        }
    }, [dispatch, loadWad, wadExplorer.wads, wadExplorer.expandedWads, pushRecentWad]);

    // ── Cheat sheet navigation ────────────────────────────────────────────────
    // Reads always-fresh data from refs so it can be called from effects and
    // requestAnimationFrame without stale-closure issues.
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
                dispatch({ type: 'BULK_SET_WAD_EXPLORER_FOLDERS', payload: { keys: unexpanded, expand: true } });
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
    }, [dispatch, wadExplorer.wads, wadExplorer.expandedFolders]);

    const handleCheatSheetOpenWad = useCallback((wadName: string, filePath?: string) => {
        const wad = wadExplorer.wads.find(w => w.name.toLowerCase() === wadName.toLowerCase());
        if (!wad) return;

        pendingNavRef.current = { wadPath: wad.path, filePath, phase: 'wad' };

        if (!wadExplorer.expandedWads.has(wad.path)) {
            handleToggleWad(wad.path); // expands + starts load → flatRows will update → effect fires
        } else if (wad.status === 'idle') {
            loadWad(wad.path);
        } else {
            // Already expanded (and loaded/loading) — trigger on next frame since flatRows won't change
            requestAnimationFrame(() => processNavigation());
        }
    }, [wadExplorer.wads, wadExplorer.expandedWads, handleToggleWad, loadWad, processNavigation]);

    const handleCheatSheetFilter = useCallback((path: string) => {
        setSearchMode('regex');
        setInputValue(path);
        dispatch({ type: 'SET_WAD_EXPLORER_SEARCH', payload: path });
        setTimeout(() => searchRef.current?.focus(), 50);
    }, [dispatch]);

    // ── Background bulk indexing for whole-game search ─────────────────────────
    // Loads all WADs so search works across the entire game.
    //
    // Single-IPC approach (matches 1.7.1, which is ~10x faster than the
    // batched version that was here before).
    //
    // Why one call beats parallel batches:
    //   - Rust does ALL work in one shot — one rayon parallel pass over
    //     WAD headers, ONE LMDB read txn for the deduped union of every
    //     unique hash across every WAD. Splitting into batches forced
    //     N separate LMDB txns and lost cross-WAD hash deduplication
    //     (the same texture hash referenced by 50 WADs got resolved 50
    //     times instead of once).
    //   - Only one IPC payload to (de)serialize.
    //   - No per-batch React re-render churn. The single dispatch at the
    //     end means one state update, one tree render — eliminating the
    //     ~150ms inter-batch gaps the IPC trace was showing.
    useEffect(() => {
        if (wadExplorer.scanStatus !== 'ready') return;
        const idlePaths = wadExplorer.wads.filter(w => w.status === 'idle').map(w => w.path);
        if (idlePaths.length === 0) return;

        // Mark all as loading in one dispatch so the UI shows progress immediately.
        dispatch({
            type: 'BATCH_SET_WAD_STATUSES',
            payload: idlePaths.map(p => ({ wadPath: p, status: 'loading' as const })),
        });

        let cancelled = false;
        (async () => {
            try {
                const batches = await api.loadAllWadChunks(idlePaths);
                if (cancelled) return;
                dispatch({
                    type: 'BATCH_SET_WAD_STATUSES',
                    payload: batches.map(b => ({
                        wadPath: b.path,
                        status: (b.error ? 'error' : 'loaded') as WadExplorerWad['status'],
                        chunks: b.chunks,
                        error: b.error ?? undefined,
                    })),
                });
            } catch (e) {
                if (cancelled) return;
                dispatch({
                    type: 'BATCH_SET_WAD_STATUSES',
                    payload: idlePaths.map(p => ({
                        wadPath: p,
                        status: 'error' as const,
                        error: (e as Error).message,
                    })),
                });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [wadExplorer.scanStatus]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleToggleFolder = useCallback((key: string) => {
        dispatch({ type: 'TOGGLE_WAD_EXPLORER_FOLDER', payload: key });
    }, [dispatch]);

    const handleDeepToggleFolder = useCallback((keys: string[], expand: boolean) => {
        dispatch({ type: 'BULK_SET_WAD_EXPLORER_FOLDERS', payload: { keys, expand } });
    }, [dispatch]);

    const handleSelectFile = useCallback((wadPath: string, chunk: WadChunk) => {
        dispatch({ type: 'SET_WAD_EXPLORER_SELECTED', payload: { wadPath, hash: chunk.hash } });
    }, [dispatch]);

    const handleToggleCheck = useCallback((keys: string[], checked: boolean) => {
        dispatch({ type: 'WAD_EXPLORER_TOGGLE_CHECK', payload: { keys, checked } });
    }, [dispatch]);

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
        dispatch({ type: 'WAD_EXPLORER_TOGGLE_CHECK', payload: { keys, checked: true } });
    }, [dispatch, wadExplorer.wads, hasQuery, searchRe, plainLower, searchMode]);

    const handleDeselectAll = useCallback(() => {
        dispatch({ type: 'WAD_EXPLORER_CLEAR_CHECKS' });
    }, [dispatch]);

    const [extractingSelected, setExtractingSelected] = useState(false);
    const handleExtractSelected = useCallback(async () => {
        const { checkedFiles } = wadExplorer;
        if (checkedFiles.size === 0) return;
        try {
            const dest = await open({ title: 'Choose Extraction Folder', directory: true });
            if (!dest) return;
            setExtractingSelected(true);
            // Group by wadPath
            const groups = new Map<string, string[]>();
            for (const key of checkedFiles) {
                const sep = key.indexOf('::');
                const wadPath = key.slice(0, sep);
                const hash = key.slice(sep + 2);
                const list = groups.get(wadPath) ?? [];
                list.push(hash);
                groups.set(wadPath, list);
            }
            let total = 0;
            for (const [wadPath, hashes] of groups) {
                const res = await api.extractWad(wadPath, dest as string, hashes);
                total += res.extracted;
            }
            showToast('success', `Extracted ${total} files from ${groups.size} WAD${groups.size > 1 ? 's' : ''}`);
            dispatch({ type: 'WAD_EXPLORER_CLEAR_CHECKS' });
        } catch { showToast('error', 'Extraction failed'); }
        finally { setExtractingSelected(false); }
    }, [wadExplorer, dispatch, showToast]);

    // ── Search ───────────────────────────────────────────────────────────────
    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setInputValue(val);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            dispatch({ type: 'SET_WAD_EXPLORER_SEARCH', payload: val });
        }, 300);
    }, [dispatch]);

    // Ctrl+F → focus search; Escape → clear search
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.key === 'f' && state.currentView === 'wad-explorer') {
                e.preventDefault();
                searchRef.current?.focus();
                searchRef.current?.select();
            }
            if (e.key === 'Escape' && document.activeElement === searchRef.current) {
                setInputValue('');
                dispatch({ type: 'SET_WAD_EXPLORER_SEARCH', payload: '' });
                searchRef.current?.blur();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [dispatch, state.currentView]);

    // ── Context menus ────────────────────────────────────────────────────────
    const handleContextMenu = useCallback((chunk: WadChunk, wadPath: string, x: number, y: number) => {
        const key = makeFileKey(wadPath, chunk.hash);
        const isChecked = wadExplorer.checkedFiles.has(key);
        const checkedCount = wadExplorer.checkedFiles.size;
        const options: Array<{ label: string; icon?: string; onClick: () => void; separator?: boolean; disabled?: boolean }> = [];
        if (chunk.path) {
            options.push({ label: 'Copy Path', icon: getIcon('copy'), onClick: () => navigator.clipboard.writeText(chunk.path!) });
        }
        options.push({ label: 'Copy Hash', icon: getIcon('copy'), onClick: () => navigator.clipboard.writeText(chunk.hash) });
        options.push({ label: '', separator: true, onClick: () => { } });
        options.push({
            label: isChecked ? 'Uncheck' : 'Check',
            icon: getIcon(isChecked ? 'close' : 'check'),
            onClick: () => dispatch({ type: 'WAD_EXPLORER_TOGGLE_CHECK', payload: { keys: [key], checked: !isChecked } }),
        });
        options.push({ label: '', separator: true, onClick: () => { } });
        options.push({
            label: 'Extract File…', icon: getIcon('export'),
            onClick: async () => {
                try {
                    const dest = await open({ title: 'Choose Extraction Folder', directory: true });
                    if (!dest) return;
                    const res = await api.extractWad(wadPath, dest as string, [chunk.hash]);
                    showToast('success', `Extracted ${res.extracted} file`);
                } catch { showToast('error', 'Extraction failed'); }
            },
        });
        if (checkedCount > 0) {
            options.push({
                label: `Extract Selected (${checkedCount})…`, icon: getIcon('export'),
                onClick: handleExtractSelected,
            });
        }
        dispatch({ type: 'OPEN_CONTEXT_MENU', payload: { x, y, options } });
    }, [dispatch, showToast, wadExplorer.checkedFiles, handleExtractSelected]);

    const handleFolderContextMenu = useCallback((folder: VFSFolder, wadPath: string, x: number, y: number) => {
        const fileKeys = collectFolderFileKeys(folder, wadPath);
        const folderCheckState = getFolderCheckState(folder, wadPath, wadExplorer.checkedFiles);
        const checkedCount = wadExplorer.checkedFiles.size;
        const hashes = collectFolderHashes(folder);
        const options: Array<{ label: string; icon?: string; onClick: () => void; separator?: boolean }> = [];
        options.push({
            label: folderCheckState === 'all' ? 'Uncheck All in Folder' : 'Check All in Folder',
            icon: getIcon(folderCheckState === 'all' ? 'close' : 'check'),
            onClick: () => dispatch({ type: 'WAD_EXPLORER_TOGGLE_CHECK', payload: { keys: fileKeys, checked: folderCheckState !== 'all' } }),
        });
        options.push({ label: '', separator: true, onClick: () => { } });
        options.push({
            label: `Extract Folder (${hashes.length})…`, icon: getIcon('export'),
            onClick: async () => {
                try {
                    const dest = await open({ title: 'Choose Extraction Folder', directory: true });
                    if (!dest) return;
                    const res = await api.extractWad(wadPath, dest as string, hashes);
                    showToast('success', `Extracted ${res.extracted} files`);
                } catch { showToast('error', 'Extraction failed'); }
            },
        });
        if (checkedCount > 0) {
            options.push({
                label: `Extract Selected (${checkedCount})…`, icon: getIcon('export'),
                onClick: handleExtractSelected,
            });
        }
        dispatch({ type: 'OPEN_CONTEXT_MENU', payload: { x, y, options } });
    }, [dispatch, showToast, wadExplorer.checkedFiles, handleExtractSelected]);

    const handleWadContextMenu = useCallback((wad: WadExplorerWad, x: number, y: number) => {
        const wadCheckState = getWadCheckState(wad, wadExplorer.checkedFiles);
        const checkedCount = wadExplorer.checkedFiles.size;
        const wadFileKeys = wad.status === 'loaded' ? wad.chunks.map(c => makeFileKey(wad.path, c.hash)) : [];
        const options: Array<{ label: string; icon?: string; onClick: () => void; separator?: boolean; disabled?: boolean }> = [];
        options.push({
            label: wadCheckState === 'all' ? 'Uncheck All in WAD' : 'Check All in WAD',
            icon: getIcon(wadCheckState === 'all' ? 'close' : 'check'),
            onClick: () => dispatch({ type: 'WAD_EXPLORER_TOGGLE_CHECK', payload: { keys: wadFileKeys, checked: wadCheckState !== 'all' } }),
            disabled: wad.status !== 'loaded',
        });
        options.push({ label: '', separator: true, onClick: () => { } });
        options.push({
            label: 'Extract WAD…', icon: getIcon('export'),
            onClick: async () => {
                try {
                    const dest = await open({ title: 'Choose Extraction Folder', directory: true });
                    if (!dest) return;
                    const res = await api.extractWad(wad.path, dest as string, null);
                    showToast('success', `Extracted ${res.extracted} files`);
                } catch { showToast('error', 'Extraction failed'); }
            },
            disabled: wad.status !== 'loaded',
        });
        if (checkedCount > 0) {
            options.push({
                label: `Extract Selected (${checkedCount})…`, icon: getIcon('export'),
                onClick: handleExtractSelected,
            });
        }
        options.push({ label: '', separator: true, onClick: () => { } });
        options.push({
            label: 'Copy WAD Path', icon: getIcon('copy'),
            onClick: () => {
                navigator.clipboard.writeText(wad.path);
                showToast('success', 'WAD path copied');
            },
        });
        options.push({
            label: 'Reload WAD', icon: getIcon('refresh'),
            onClick: async () => {
                try {
                    await api.invalidateWadCache(wad.path);
                    dispatch({ type: 'SET_WAD_EXPLORER_WAD_STATUS', payload: { wadPath: wad.path, status: 'loading' } });
                    const chunks = await api.getWadChunks(wad.path);
                    dispatch({ type: 'SET_WAD_EXPLORER_WAD_STATUS', payload: { wadPath: wad.path, status: 'loaded', chunks } });
                    showToast('success', 'WAD reloaded');
                } catch (e) {
                    dispatch({ type: 'SET_WAD_EXPLORER_WAD_STATUS', payload: { wadPath: wad.path, status: 'error', error: (e as Error).message } });
                    showToast('error', 'Failed to reload WAD');
                }
            },
        });
        dispatch({ type: 'OPEN_CONTEXT_MENU', payload: { x, y, options } });
    }, [dispatch, showToast, wadExplorer.checkedFiles, handleExtractSelected]);

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

    // Keep a flat count for the footer
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
    // Only builds VFS tree for a WAD when it's expanded AND loaded.
    // Uses a ref cache keyed by wad path; invalidates when chunks array changes.
    const vfsCacheRef = useRef<Map<string, { chunks: WadChunk[]; tree: VFSNode[] }>>(new Map());
    const wadSubtrees = useMemo(() => {
        const cache = vfsCacheRef.current;
        const m = new Map<string, VFSNode[]>();
        for (const w of wadExplorer.wads) {
            if (w.status !== 'loaded') continue;
            // Only build tree for expanded WADs (lazy)
            if (!wadExplorer.expandedWads.has(w.path)) continue;
            const cached = cache.get(w.path);
            if (cached && cached.chunks === w.chunks) {
                // Same chunks reference — reuse cached tree
                m.set(w.path, cached.tree);
            } else {
                // Chunks changed or first build — rebuild tree
                const tree = buildVFSSubtree(w.chunks, w.path);
                cache.set(w.path, { chunks: w.chunks, tree });
                m.set(w.path, tree);
            }
        }
        return m;
    }, [wadExplorer.wads, wadExplorer.expandedWads]);

    // ── Pre-computed check states (avoid re-computing per row) ─────────────
    const wadCheckStates = useMemo(() => {
        const m = new Map<string, 'none' | 'some' | 'all'>();
        for (const w of wadExplorer.wads) {
            m.set(w.path, getWadCheckState(w, wadExplorer.checkedFiles));
        }
        return m;
    }, [wadExplorer.wads, wadExplorer.checkedFiles]);

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

    // ── Memoized flat rows (tree mode) ───────────────────────────────────────
    // NOT dependent on `selected` or `checkedFiles` — selection/check clicks
    // no longer trigger expensive tree recomputation.
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

    // Re-run navigation whenever flatRows changes (WAD loaded, folders expanded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { processNavigation(); }, [flatRows, processNavigation]);

    // ── Memoized flat rows (search mode) ─────────────────────────────────────
    const flatSearchRows = useMemo(() => {
        if (!groupedSearchResults) return null;
        return flattenSearchResults(groupedSearchResults, collapsedSearchWads, collapsedSearchFolders);
    }, [groupedSearchResults, collapsedSearchWads, collapsedSearchFolders]);

    const totalRows = isSearching ? (flatSearchRows?.length ?? 0) : (flatRows?.length ?? 0);

    // ── Pre-computed folder check states (O(1) lookup instead of subtree walk per row) ──
    const folderCheckStates = useMemo(() => {
        const m = new Map<string, 'none' | 'some' | 'all'>();
        if (wadExplorer.checkedFiles.size === 0) return m;
        for (const [wadPath, subtree] of wadSubtrees) {
            const walkFolders = (nodes: VFSNode[]) => {
                for (const node of nodes) {
                    if (node.type === 'folder') {
                        const { effectiveNode } = compactVFSNode(node);
                        m.set(effectiveNode.key, getFolderCheckState(effectiveNode, wadPath, wadExplorer.checkedFiles));
                        if (wadExplorer.expandedFolders.has(effectiveNode.key)) {
                            walkFolders(effectiveNode.children);
                        }
                    }
                }
            };
            walkFolders(subtree);
        }
        return m;
    }, [wadSubtrees, wadExplorer.checkedFiles, wadExplorer.expandedFolders]);

    // ── Pre-computed search check states ──────────────────────────────────────
    const searchCheckStates = useMemo(() => {
        if (!groupedSearchResults) return new Map<string, 'none' | 'some' | 'all'>();
        const m = new Map<string, 'none' | 'some' | 'all'>();
        for (const group of groupedSearchResults) {
            const wadMatchKeys = group.folders.flatMap(f => f.files.map(file => makeFileKey(group.wadPath, file.chunk.hash)));
            m.set(group.wadPath, getCheckStateForKeys(wadMatchKeys, wadExplorer.checkedFiles));
            for (const folder of group.folders) {
                const folderKey = `${group.wadPath}::s::${folder.folderPath}`;
                const fKeys = folder.files.map(f => makeFileKey(group.wadPath, f.chunk.hash));
                m.set(folderKey, getCheckStateForKeys(fKeys, wadExplorer.checkedFiles));
            }
        }
        return m;
    }, [groupedSearchResults, wadExplorer.checkedFiles]);

    // ── Stable renderRow ref (prevents VirtualizedList re-renders) ───────────
    const renderRowRef = useRef<(index: number) => React.ReactNode>(() => null);
    const stableRenderRow = useCallback((index: number) => renderRowRef.current(index), []);

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
                    const checkState = searchCheckStates.get(row.wadPath) ?? 'none';
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
                    const checkState = searchCheckStates.get(folderKey) ?? 'none';
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
                                const fcs = searchCheckStates.get(folderKey) ?? 'none';
                                const options: Array<{ label: string; icon?: string; onClick: () => void; separator?: boolean }> = [
                                    {
                                        label: fcs === 'all' ? 'Uncheck All in Folder' : 'Check All in Folder',
                                        icon: getIcon(fcs === 'all' ? 'close' : 'check'),
                                        onClick: () => handleToggleCheck(fileKeys, fcs !== 'all'),
                                    },
                                    { label: '', separator: true, onClick: () => { } },
                                    {
                                        label: `Extract Folder (${hashes.length})…`, icon: getIcon('export'),
                                        onClick: async () => {
                                            try {
                                                const dest = await open({ title: 'Choose Extraction Folder', directory: true });
                                                if (!dest) return;
                                                const res = await api.extractWad(row.wadPath, dest as string, hashes);
                                                showToast('success', `Extracted ${res.extracted} files`);
                                            } catch { showToast('error', 'Extraction failed'); }
                                        },
                                    },
                                ];
                                if (wadExplorer.checkedFiles.size > 0) {
                                    options.push({
                                        label: `Extract Selected (${wadExplorer.checkedFiles.size})…`, icon: getIcon('export'),
                                        onClick: handleExtractSelected,
                                    });
                                }
                                dispatch({ type: 'OPEN_CONTEXT_MENU', payload: { x: e.clientX, y: e.clientY, options } });
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
                                dangerouslySetInnerHTML={{ __html: checkboxSvg(wadCheckStates.get(wad.path) ?? 'none') }}
                                onClick={e => {
                                    e.stopPropagation();
                                    if (wad.status === 'loaded') {
                                        const keys = wad.chunks.map(c => makeFileKey(wad.path, c.hash));
                                        handleToggleCheck(keys, (wadCheckStates.get(wad.path) ?? 'none') !== 'all');
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
                    const folderCheckState = folderCheckStates.get(row.effectiveNode.key) ?? 'none';
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
                {/* Header */}
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
                        {/* Live / PBE branch toggle. Cached snapshots make swapping instant. */}
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
                    {/* Search */}
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

                {/* Selection toolbar */}
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
                                <button className="btn btn--sm btn--primary" onClick={handleExtractSelected} disabled={extractingSelected} style={{ fontSize: '10px', padding: '2px 8px' }}>
                                    <span dangerouslySetInnerHTML={{ __html: getIcon('export') }} />
                                    <span>{extractingSelected ? 'Extracting…' : 'Extract Selected'}</span>
                                </button>
                            </>
                        ) : (
                            <span style={{ color: 'var(--text-muted)' }}>Select files to extract</span>
                        )}
                    </div>
                )}

                {/* Tree / scan states */}
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
                        />
                    )}
                </div>

                {/* Footer stats */}
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
                        onClose={() => dispatch({ type: 'SET_WAD_EXPLORER_SELECTED', payload: null })}
                    />
                ) : (
                    <QuickActionPanel
                        wads={wadExplorer.wads}
                        onSetFilter={query => {
                            setInputValue(query);
                            setSearchMode('regex');
                            dispatch({ type: 'SET_WAD_EXPLORER_SEARCH', payload: query });
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
        </>
    );
};
