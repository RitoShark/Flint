/**
 * Inline preview shown in the right pane when the user selects a chunk in
 * the WAD Explorer tree. Self-contained — no ExtractSession needed.
 *
 * Handles textures (DDS / TEX), images (PNG / JPEG), BIN (Monaco + ritobin),
 * luabin / troybin (Monaco), plain text, an on-demand SKN 3D preview, and a
 * hex dump fallback.
 *
 * Note: SVG icons are inlined via React's dangerouslySetInnerHTML escape
 * hatch. The string source is always `getIcon()` from our local fileIcons
 * module — never untrusted input — so XSS isn't a concern here.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useNotificationStore } from '../../../lib/stores';
import * as api from '../../../lib/api';
import { open } from '@tauri-apps/plugin-dialog';
import { getIcon } from '../../../lib/ui-helpers/fileIcons';
import type { WadChunk } from '../../../lib/types';
import LazyModelPreview from '../../preview/LazyModelPreview';
import { MonacoBinViewer, MonacoTextViewer } from './MonacoViewers';
import { detectType, formatBytes, type PreviewData } from './helpers';

export const ChunkPreview: React.FC<{
    wadPath: string;
    chunk: WadChunk;
    onClose: () => void;
}> = ({ wadPath, chunk, onClose }) => {
    const showToast = useNotificationStore((s) => s.showToast);
    const [data, setData] = useState<PreviewData | null>(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [zoom, setZoom] = useState<'fit' | number>('fit');
    const [extracting, setExtracting] = useState(false);
    const blobUrlRef = useRef<string | null>(null);
    const [modelPreviewPath, setModelPreviewPath] = useState<string | null>(null);
    const [modelTempDir, setModelTempDir] = useState<string | null>(null);
    const [modelLoading, setModelLoading] = useState(false);
    const [unknownView, setUnknownView] = useState<'prompt' | 'hex' | 'text'>('prompt');

    useEffect(() => {
        return () => {
            if (modelTempDir) api.cleanupWadModelPreview(modelTempDir).catch(() => {});
        };
    }, [modelTempDir]);

    useEffect(() => {
        let cancelled = false;
        if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
        setLoading(true); setErr(null); setData(null); setZoom('fit'); setUnknownView('prompt');
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
                } else if (fileType === 'application/x-inibin') {
                    if (!cancelled) text = await api.readWadInibin(wadPath, chunk.hash);
                } else if (fileType === 'application/x-rst') {
                    if (!cancelled) text = await api.readWadRst(wadPath, chunk.hash);
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
                        if (fileType === 'application/x-bin') {
                            return <MonacoBinViewer text={text} />;
                        }
                        if (fileType === 'application/x-luabin') {
                            return <MonacoTextViewer text={text} language="lua" />;
                        }
                        if (fileType === 'application/x-troybin') {
                            return <MonacoTextViewer text={text} language="ini" />;
                        }
                        if (fileType === 'application/x-inibin') {
                            return <MonacoTextViewer text={text} language="json" />;
                        }
                        if (fileType === 'application/x-rst') {
                            return <MonacoTextViewer text={text} language="json" />;
                        }
                        
                        // Fallback: try to guess language from extension or fileType, default to plaintext
                        let lang = 'plaintext';
                        if (fileType === 'application/json' || fileName.endsWith('.json')) lang = 'json';
                        else if (fileType === 'application/xml' || fileName.endsWith('.xml')) lang = 'xml';
                        else if (fileName.endsWith('.js')) lang = 'javascript';
                        else if (fileName.endsWith('.py')) lang = 'python';
                        else if (fileName.endsWith('.ini')) lang = 'ini';
                        
                        return <MonacoTextViewer text={text} language={lang} />;
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

                    if (unknownView === 'prompt') {
                        return (
                            <div className="preview-panel__empty" style={{ display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center', justifyContent: 'center' }}>
                                <div dangerouslySetInnerHTML={{ __html: getIcon('document') }} style={{ width: '48px', height: '48px', color: 'var(--text-muted)', opacity: 0.7 }} />
                                <div style={{ fontSize: '14px', fontWeight: 500 }}>Unknown File Format</div>
                                <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>How would you like to view this file?</div>
                                <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                                    <button className="btn btn--primary" onClick={() => setUnknownView('text')}>Open in Text Editor</button>
                                    <button className="btn btn--secondary" onClick={() => setUnknownView('hex')}>Open in Hex View</button>
                                </div>
                            </div>
                        );
                    }
                    if (unknownView === 'text') {
                        const decodedText = text !== null ? text : new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                        return <MonacoTextViewer text={decodedText} language="plaintext" />;
                    }

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
