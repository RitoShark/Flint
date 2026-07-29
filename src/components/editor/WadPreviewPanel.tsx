import React, { useState, useEffect, useRef } from 'react';
import { useWadExtractStore, useNotificationStore, useModalStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { open } from '@tauri-apps/plugin-dialog';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import * as monaco from 'monaco-editor';
import { RITOBIN_LANGUAGE_ID, RITOBIN_THEME_ID, registerRitobinLanguage, registerRitobinTheme } from '../../lib/editor/ritobinLanguage';
import { Dropdown } from '../ui/Dropdown';
import LazyModelPreview from '../preview/LazyModelPreview';
import type { WadChunk } from '../../lib/types';
import type { Vfs, VfsEntry } from '../../lib/vfs/types';

// =============================================================================
// File-type detection from magic bytes + path hint
// =============================================================================

interface ChunkTypeInfo {
    fileType: string;
    extension: string;
}

function detectChunkType(bytes: Uint8Array, pathHint: string | null): ChunkTypeInfo {
    const ext = pathHint?.split('.').pop()?.toLowerCase() ?? '';

    if (bytes.length >= 4) {
        const b = bytes;
        // TEX\0
        if (b[0] === 0x54 && b[1] === 0x45 && b[2] === 0x58 && b[3] === 0x00)
            return { fileType: 'image/tex', extension: 'tex' };
        // DDS (space)
        if (b[0] === 0x44 && b[1] === 0x44 && b[2] === 0x53 && b[3] === 0x20)
            return { fileType: 'image/dds', extension: 'dds' };
        // PNG magic
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
            return { fileType: 'image/png', extension: 'png' };
        // JPEG magic
        if (b[0] === 0xff && b[1] === 0xd8)
            return { fileType: 'image/jpeg', extension: 'jpg' };
        // luabin bytecode: \x1bLua
        if (b[0] === 0x1b && b[1] === 0x4c && b[2] === 0x75 && b[3] === 0x61)
            return { fileType: 'application/x-luabin', extension: 'luabin' };
        // BIN: PROP / PTCH
        const magic = String.fromCharCode(b[0], b[1], b[2], b[3]);
        if (magic === 'PROP' || magic === 'PTCH')
            return { fileType: 'application/x-bin', extension: 'bin' };
        // SKN mesh
        if (b[0] === 0x33 && b[1] === 0x22 && b[2] === 0x11 && b[3] === 0x00)
            return { fileType: 'model/x-lol-skn', extension: 'skn' };
    }

    const extMap: Record<string, string> = {
        dds: 'image/dds',
        tex: 'image/tex',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        bin: 'application/x-bin',
        json: 'application/json',
        txt: 'text/plain',
        py: 'text/x-python',
        lua: 'text/x-lua',
        xml: 'application/xml',
        js: 'text/javascript',
        ts: 'text/typescript',
        skn: 'model/x-lol-skn',
        skl: 'model/x-lol-skl',
        scb: 'model/x-lol-scb',
        sco: 'model/x-lol-sco',
        anm: 'animation/x-lol-anm',
        bnk: 'audio/x-wwise-bnk',
        wpk: 'audio/x-wwise-wpk',
        luabin: 'application/x-luabin',
        luabin64: 'application/x-luabin',
        troybin: 'application/x-troybin',
    };

    return { fileType: extMap[ext] ?? 'application/octet-stream', extension: ext };
}

// =============================================================================
// Hex dump renderer
// =============================================================================

/**
 * Adapt a chunk to the VFS entry a mount expects.
 *
 * Mounts differ in what they key on — a WAD addresses chunks by hash, a modpkg
 * by path — so the caller passes the mount and we take its convention. Getting
 * this wrong reads the wrong chunk rather than failing loudly, hence the
 * explicit branch.
 */
function vfsEntryFor(chunk: WadChunk, mount: Vfs): VfsEntry {
    const path = chunk.path ?? chunk.hash;
    return {
        path,
        name: path.split('/').pop() ?? path,
        isDirectory: false,
        size: chunk.size,
        key: mount.keyedBy === 'path' ? path : chunk.hash,
    };
}

const MAX_HEX_BYTES = 16 * 512; // 8 KB max for hex display

const HexDump: React.FC<{ bytes: Uint8Array }> = ({ bytes }) => {
    const slice = bytes.slice(0, MAX_HEX_BYTES);
    const rows: React.ReactNode[] = [];
    for (let i = 0; i < slice.length; i += 16) {
        const rowBytes = slice.slice(i, i + 16);
        const hex = Array.from(rowBytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join(' ');
        const ascii = Array.from(rowBytes)
            .map(b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
            .join('');
        rows.push(
            <div key={i} style={{ display: 'flex', gap: '16px', fontFamily: 'monospace', fontSize: '12px', lineHeight: '1.5' }}>
                <span style={{ color: 'var(--text-muted)', minWidth: '60px' }}>
                    {i.toString(16).padStart(8, '0')}
                </span>
                <span style={{ color: 'var(--text-primary)', flex: 1 }}>{hex}</span>
                <span style={{ color: 'var(--text-muted)' }}>{ascii}</span>
            </div>
        );
    }
    return (
        <div style={{ padding: '12px', overflow: 'auto', height: '100%', background: 'var(--bg-secondary)' }}>
            {rows}
            {bytes.length > MAX_HEX_BYTES && (
                <div style={{ marginTop: '8px', color: 'var(--text-muted)', fontSize: '11px' }}>
                    … {(bytes.length - MAX_HEX_BYTES).toLocaleString()} more bytes (extract the file to view all)
                </div>
            )}
        </div>
    );
};

// =============================================================================
// Type label helper
// =============================================================================

function getTypeLabel(fileType: string): string {
    const labels: Record<string, string> = {
        'image/dds': 'DDS Texture',
        'image/tex': 'TEX Texture',
        'image/png': 'PNG Image',
        'image/jpeg': 'JPEG Image',
        'application/x-bin': 'BIN Property File',
        'application/x-luabin': 'Lua Bytecode (Luabin)',
        'application/x-troybin': 'Troybin Config',
        'application/json': 'JSON',
        'text/plain': 'Plain Text',
        'text/x-python': 'Ritobin / Python',
        'text/x-lua': 'Lua Script',
        'application/xml': 'XML',
        'model/x-lol-skn': 'SKN Skinned Mesh',
        'model/x-lol-skl': 'SKL Skeleton',
        'model/x-lol-scb': 'SCB Static Mesh',
        'model/x-lol-sco': 'SCO Static Mesh',
        'animation/x-lol-anm': 'ANM Animation',
        'audio/x-wwise-bnk': 'Wwise Sound Bank',
        'audio/x-wwise-wpk': 'Wwise Audio Package',
        'application/octet-stream': 'Binary File',
    };
    return labels[fileType] ?? fileType;
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// =============================================================================
// Shared state for a loaded preview
// =============================================================================

interface PreviewState {
    fileType: string;
    extension: string;
    bytes: Uint8Array;
    /** base64 PNG data URL — only set for texture/image types */
    imageDataUrl: string | null;
    /** decoded text — only set for text/BIN types */
    textContent: string | null;
    /** image natural dimensions */
    dimensions: [number, number] | null;
}

// =============================================================================
// Empty / Loading / Error states
// =============================================================================

const EmptyState: React.FC = () => (
    <div className="preview-panel__empty">
        <div className="preview-panel__empty-icon" dangerouslySetInnerHTML={{ __html: getIcon('wad') }} />
        <div className="preview-panel__empty-text">Select a file from the WAD browser to preview it</div>
    </div>
);

const LoadingState: React.FC = () => (
    <div className="preview-panel__loading">
        <div className="spinner" />
        <span>Loading preview…</span>
    </div>
);

const ErrorState: React.FC<{ message: string }> = ({ message }) => (
    <div className="preview-panel__error">
        <span className="error-icon" dangerouslySetInnerHTML={{ __html: getIcon('warning') }} />
        <span>{message}</span>
    </div>
);

// =============================================================================
// Monaco BIN Viewer Component (read-only with syntax highlighting)
// =============================================================================

registerRitobinLanguage(monaco as any);
registerRitobinTheme(monaco as any);

const MonacoBinViewer: React.FC<{
    text: string;
    readOnly?: boolean;
    onChange?: (value: string) => void;
}> = ({ text, readOnly = true, onChange }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const editor = monaco.editor.create(containerRef.current, {
            value: text,
            language: RITOBIN_LANGUAGE_ID,
            theme: RITOBIN_THEME_ID,
            readOnly,
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

        const model = editor.getModel();
        if (model) {
            const listener = model.onDidChangeContent(() => {
                if (onChange) {
                    onChange(editor.getValue());
                }
            });
            return () => {
                listener.dispose();
                editor.dispose();
                editorRef.current = null;
            };
        }

        return () => {
            editor.dispose();
            editorRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (editorRef.current) {
            editorRef.current.updateOptions({ readOnly });
        }
    }, [readOnly]);

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

// =============================================================================
// Generic Monaco Viewer (Lua, INI, etc. with built-in language support)
// =============================================================================

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
    }, [language]);

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

// =============================================================================
// Main component
// =============================================================================

export const WadPreviewPanel: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
    const extractSessions = useWadExtractStore((s) => s.extractSessions);
    const activeExtractId = useWadExtractStore((s) => s.activeExtractId);
    const showToast = useNotificationStore((s) => s.showToast);

    const [preview, setPreview] = useState<PreviewState | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [imageZoom, setImageZoom] = useState<'fit' | number>('fit');
    const [isExtracting, setIsExtracting] = useState(false);

    const [editedContent, setEditedContent] = useState<string | null>(null);
    const [isContentDirty, setIsContentDirty] = useState(false);
    const [isSavingChunk, setIsSavingChunk] = useState(false);

    const blobUrlRef = useRef<string | null>(null);

    const [modelPreviewPath, setModelPreviewPath] = useState<string | null>(null);
    const [modelTempDir, setModelTempDir] = useState<string | null>(null);
    const [modelLoading, setModelLoading] = useState(false);
    // Auto-prepare failed (e.g. folder-backed session) → fall back to the
    // generic "Extract File" empty state instead of erroring repeatedly.
    const [modelPrepFailed, setModelPrepFailed] = useState(false);

    const session = extractSessions.find(s => s.id === activeExtractId);
    const chunk = session?.chunks.find(c => c.hash === session.previewHash) ?? null;
    // Editable through either route: a WAD edit session, or a writable mount for
    // an archive that is not a WAD (a modpkg).
    const canEditChunks = !!session?.editSessionId || !!session?.mount?.caps.write;

    useEffect(() => {
        if (preview && preview.textContent !== null) {
            setEditedContent(preview.textContent);
            setIsContentDirty(false);
        } else {
            setEditedContent(null);
            setIsContentDirty(false);
        }
    }, [preview]);

    useEffect(() => {
        return () => {
            if (modelTempDir) api.cleanupWadModelPreview(modelTempDir).catch(() => {});
        };
    }, [modelTempDir]);

    const meshKind: 'skinned' | 'static' | null =
        preview?.fileType === 'model/x-lol-skn' ? 'skinned'
            : preview?.fileType === 'model/x-lol-scb' || preview?.fileType === 'model/x-lol-sco' ? 'static'
                : null;

    // Auto-prepare the inline 3D preview when a mesh chunk is selected (no
    // "extract to preview" ask). On failure (e.g. folder-backed session where
    // the WAD path isn't a real file) fall back to the extract empty state.
    useEffect(() => {
        if (!meshKind || modelPrepFailed || modelPreviewPath || modelLoading || !session || !chunk) return;
        let cancelled = false;
        setModelLoading(true);
        api.extractWadModelPreview(session.wadPath, chunk.hash)
            .then(result => {
                if (cancelled) {
                    api.cleanupWadModelPreview(result.temp_dir).catch(() => {});
                    return;
                }
                setModelPreviewPath(result.skn_path);
                setModelTempDir(result.temp_dir);
            })
            .catch(() => {
                if (!cancelled) setModelPrepFailed(true);
            })
            .finally(() => {
                if (!cancelled) setModelLoading(false);
            });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meshKind, session?.wadPath, chunk?.hash, preview]);

    useEffect(() => {
        if (blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
        }

        setModelPreviewPath(null);
        setModelPrepFailed(false);
        if (modelTempDir) {
            api.cleanupWadModelPreview(modelTempDir).catch(() => {});
            setModelTempDir(null);
        }

        if (!session || !chunk) {
            setPreview(null);
            setError(null);
            return;
        }

        let cancelled = false;

        const loadPreview = async () => {
            setLoading(true);
            setError(null);
            setPreview(null);
            setImageZoom('fit');

            try {
                // A mount is present for archives that are not WADs (a modpkg
                // keys chunks by path, not hash), so it takes precedence over
                // the WAD session commands.
                const bytes = session.mount
                    ? await session.mount.read(vfsEntryFor(chunk, session.mount))
                    : session.editSessionId
                        ? await api.readSessionChunk(session.editSessionId, chunk.hash)
                        : await api.readWadChunkData(session.wadPath, chunk.hash);

                if (cancelled) return;

                const { fileType, extension } = detectChunkType(bytes, chunk.path);

                let imageDataUrl: string | null = null;
                let textContent: string | null = null;
                let dimensions: [number, number] | null = null;

                if (fileType === 'image/dds' || fileType === 'image/tex') {
                    const decoded = await api.decodeBytesToPng(bytes);
                    if (!cancelled) {
                        imageDataUrl = `data:image/png;base64,${decoded.data}`;
                        dimensions = [decoded.width, decoded.height];
                    }
                } else if (fileType === 'image/png' || fileType === 'image/jpeg') {
                    const mimeType = fileType === 'image/png' ? 'image/png' : 'image/jpeg';
                    const buf = new ArrayBuffer(bytes.byteLength);
                    new Uint8Array(buf).set(bytes);
                    const blob = new Blob([buf], { type: mimeType });
                    const url = URL.createObjectURL(blob);
                    blobUrlRef.current = url;
                    if (!cancelled) imageDataUrl = url;
                } else if (fileType === 'application/x-bin') {
                    const text = await api.convertBinToText(bytes);
                    if (!cancelled) textContent = text;
                } else if (fileType === 'application/x-luabin') {
                    const text = await api.readWadLuabin(session.wadPath, chunk.hash);
                    if (!cancelled) textContent = text;
                } else if (fileType === 'application/x-troybin') {
                    const text = await api.readWadTroybin(session.wadPath, chunk.hash);
                    if (!cancelled) textContent = text;
                } else if (
                    fileType.startsWith('text/') ||
                    fileType === 'application/json' ||
                    fileType === 'application/xml'
                ) {
                    textContent = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
                }

                if (!cancelled) {
                    setPreview({ fileType, extension, bytes, imageDataUrl, textContent, dimensions });
                }
            } catch (err) {
                if (!cancelled) {
                    console.error('[WadPreviewPanel] Preview error:', err);
                    setError((err as Error).message || 'Failed to load preview');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        loadPreview();

        return () => { cancelled = true; };
    }, [session?.id, chunk?.hash]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        return () => {
            if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        };
    }, []);

    const handleExtractThis = async () => {
        if (!session || !chunk) return;
        try {
            const destDir = await open({ title: 'Choose Extraction Folder', directory: true });
            if (!destDir) return;
            setIsExtracting(true);
            const result = await api.extractWad(session.wadPath, destDir as string, [chunk.hash]);
            showToast('success', `Extracted ${result.extracted} file${result.extracted !== 1 ? 's' : ''}`);
        } catch (err) {
            console.error('[WadPreviewPanel] Extract failed:', err);
            showToast('error', 'Extraction failed');
        } finally {
            setIsExtracting(false);
        }
    };

    const handleSaveChunk = async () => {
        // Writable via either route: a WAD edit session, or a mount for an
        // archive that is not a WAD.
        const writableMount = session?.mount?.caps.write ? session.mount : null;
        if (!session || !chunk || editedContent === null) return;
        if (!session.editSessionId && !writableMount) return;

        setIsSavingChunk(true);
        try {
            const binBytes = await api.compileRitobinTextToBytes(editedContent);

            if (writableMount) {
                await writableMount.write!(vfsEntryFor(chunk, writableMount), binBytes);
            } else {
                await api.writeSessionChunk(session.editSessionId!, chunk.hash, binBytes);
            }

            useWadExtractStore.getState().stageChunkEdit(session.id, chunk.hash, binBytes.length);

            setPreview(p => p ? { ...p, bytes: binBytes, textContent: editedContent } : null);
            setIsContentDirty(false);

            showToast(
                'success',
                writableMount
                    ? 'File edited in memory. Save the archive to persist changes on disk.'
                    : 'File edited in memory. Save the WAD to persist changes on disk.',
            );
        } catch (err) {
            console.error('[WadPreviewPanel] Save chunk failed:', err);
            const msg = err instanceof api.FlintError ? err.getUserMessage() : String(err);
            showToast('error', `Failed to compile/save: ${msg}`);
        } finally {
            setIsSavingChunk(false);
        }
    };

    const handleDeleteFromWad = () => {
        const removableMount = session?.mount?.caps.remove ? session.mount : null;
        if (!session || !chunk) return;
        if (!session.editSessionId && !removableMount) return;
        const editSessionId = session.editSessionId;
        const sessionId = session.id;
        const hash = chunk.hash;
        const entry = removableMount ? vfsEntryFor(chunk, removableMount) : null;
        const container = removableMount ? 'archive' : 'WAD';
        const label = chunk.path ? (chunk.path.split(/[\\/]/).pop() ?? chunk.path) : chunk.hash;
        useModalStore.getState().openConfirmDialog({
            title: `Delete from ${container}?`,
            message: `Remove "${label}" from this ${container}? The deletion is staged in memory and applied when you save.`,
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: async () => {
                try {
                    if (removableMount && entry) {
                        await removableMount.remove!(entry);
                    } else {
                        await api.removeSessionChunk(editSessionId!, hash);
                    }
                    useWadExtractStore.getState().stageChunkDelete(sessionId, hash);
                    useWadExtractStore.getState().setPreview(sessionId, null);
                    showToast('success', `File removed. Save the ${container} to persist the deletion.`);
                } catch (err) {
                    const msg = err instanceof api.FlintError ? err.getUserMessage() : String(err);
                    showToast('error', `Failed to delete: ${msg}`);
                }
            },
        });
    };

    const saveChunkRef = useRef<() => void>(() => {});
    saveChunkRef.current = () => {
        const canWrite = !!session?.editSessionId || !!session?.mount?.caps.write;
        if (canWrite && isContentDirty && editedContent !== null && !isSavingChunk) {
            void handleSaveChunk();
        }
    };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                saveChunkRef.current();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    if (!session || !chunk) {
        return <div className="preview-panel" style={style}><EmptyState /></div>;
    }

    const fileName = chunk.path
        ? (chunk.path.split('/').pop() ?? chunk.path.split('\\').pop() ?? chunk.path)
        : chunk.hash;

    const isImage = preview?.fileType.startsWith('image/');

    const renderContent = () => {
        if (loading) return <LoadingState />;
        if (error) return <ErrorState message={error} />;
        if (!preview) return <EmptyState />;

        const { fileType, bytes, imageDataUrl, textContent, dimensions } = preview;

        if (isImage && imageDataUrl) {
            const imgStyle: React.CSSProperties =
                imageZoom === 'fit'
                    ? { width: '100%', height: '100%', objectFit: 'contain' }
                    : { width: `${(dimensions?.[0] ?? 0) * (imageZoom as number)}px` };

            return (
                <div
                    className="image-preview"
                    onWheel={e => {
                        e.preventDefault();
                        const cur = imageZoom === 'fit' ? 1 : (imageZoom as number);
                        setImageZoom(Math.max(0.1, Math.min(5, cur + (e.deltaY > 0 ? -0.1 : 0.1))));
                    }}
                >
                    <div className="image-preview__container">
                        <img
                            src={imageDataUrl}
                            alt={fileName}
                            draggable={false}
                            style={imgStyle}
                            onLoad={e => {
                                if (!dimensions) {
                                    const img = e.currentTarget;
                                    setPreview(p => p ? { ...p, dimensions: [img.naturalWidth, img.naturalHeight] } : p);
                                }
                            }}
                        />
                    </div>
                </div>
            );
        }

        if (textContent !== null) {
            if (fileType === 'application/x-bin') {
                return (
                    <MonacoBinViewer
                        text={textContent}
                        readOnly={!canEditChunks}
                        onChange={(val) => {
                            setEditedContent(val);
                            setIsContentDirty(val !== textContent);
                        }}
                    />
                );
            }
            if (fileType === 'application/x-luabin') {
                return <MonacoTextViewer text={textContent} language="lua" />;
            }
            if (fileType === 'application/x-troybin') {
                return <MonacoTextViewer text={textContent} language="ini" />;
            }
            return (
                <div
                    style={{
                        padding: '12px 16px',
                        overflow: 'auto',
                        height: '100%',
                        fontFamily: 'var(--font-mono, monospace)',
                        fontSize: '12px',
                        lineHeight: '1.6',
                        whiteSpace: 'pre',
                        color: 'var(--text-primary)',
                        background: 'var(--bg-secondary)',
                        boxSizing: 'border-box',
                    }}
                >
                    {textContent}
                </div>
            );
        }

        if (meshKind && !modelPrepFailed) {
            if (modelPreviewPath) {
                return (
                    <div style={{ height: '100%', width: '100%' }}>
                        <LazyModelPreview filePath={modelPreviewPath} meshType={meshKind} />
                    </div>
                );
            }
            return (
                <div className="preview-panel__loading">
                    <div className="spinner" />
                    <span>Preparing 3D preview…</span>
                </div>
            );
        }

        if (
            fileType.startsWith('model/') ||
            fileType.startsWith('audio/') ||
            fileType.startsWith('animation/')
        ) {
            return (
                <div className="preview-panel__empty">
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)', textAlign: 'center', padding: '0 24px' }}>
                        <div style={{ marginBottom: '12px' }}>{getTypeLabel(fileType)}</div>
                        <div style={{ marginBottom: '16px', fontSize: '12px' }}>
                            Extract the file to preview it in the project editor.
                        </div>
                        <button
                            className="btn btn--primary btn--sm"
                            onClick={handleExtractThis}
                            disabled={isExtracting}
                        >
                            <span dangerouslySetInnerHTML={{ __html: getIcon('export') }} />
                            <span>{isExtracting ? 'Extracting…' : 'Extract File'}</span>
                        </button>
                    </div>
                </div>
            );
        }

        return <HexDump bytes={bytes} />;
    };

    return (
        <div className="preview-panel" style={style}>
            <div className="preview-panel__toolbar" style={{ position: 'relative', paddingRight: '240px' }}>
                {isImage && (
                    <div className="preview-panel__zoom-controls" style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                        {(['fit', 1, 2] as const).map(z => (
                            <button
                                key={String(z)}
                                className={`btn btn--sm ${imageZoom === z ? 'btn--active' : ''}`}
                                onClick={() => setImageZoom(z)}
                            >
                                {z === 'fit' ? 'Fit' : `${(z as number) * 100}%`}
                            </button>
                        ))}
                        <div style={{ width: '1px', height: '16px', background: 'var(--border)', margin: '0 8px' }} />
                    </div>
                )}
                <span className="preview-panel__filename" style={{ minWidth: 0, flex: 1, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', margin: '0 8px' }}>
                    {fileName}
                </span>
                <div style={{ 
                    position: 'absolute', 
                    right: '12px', 
                    top: '50%', 
                    transform: 'translateY(-50%)', 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '8px' 
                }}>
                    <Dropdown
                        align="right"
                        trigger={(open, toggle) => (
                            <button
                                className={`btn btn--sm ${open ? 'btn--active' : ''}`}
                                onClick={toggle}
                                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                                title="Copy metadata to clipboard"
                            >
                                <span dangerouslySetInnerHTML={{ __html: getIcon('copy') }} />
                                <span>Copy</span>
                                <span style={{ opacity: 0.5, fontSize: '9px', marginLeft: '2px' }}>▼</span>
                            </button>
                        )}
                        items={[
                            ...(chunk.path ? [
                                {
                                    label: 'Copy Path',
                                    onClick: () => {
                                        navigator.clipboard.writeText(chunk.path!);
                                        showToast('success', 'Path copied to clipboard');
                                    }
                                },
                                {
                                    label: 'Copy File Name',
                                    onClick: () => {
                                        navigator.clipboard.writeText(chunk.path!.split('/').pop() ?? chunk.path!);
                                        showToast('success', 'File name copied to clipboard');
                                    }
                                },
                                { divider: true }
                            ] : []),
                            {
                                label: 'Copy Hash',
                                onClick: () => {
                                    navigator.clipboard.writeText(chunk.hash);
                                    showToast('success', 'Hash copied to clipboard');
                                }
                            },
                            {
                                label: 'Copy WAD Name',
                                onClick: () => {
                                    navigator.clipboard.writeText(session.wadName);
                                    showToast('success', 'WAD name copied to clipboard');
                                }
                            }
                        ]}
                    />
                    {canEditChunks && isContentDirty && (
                        <button
                            className="btn btn--sm btn--primary"
                            onClick={handleSaveChunk}
                            disabled={isSavingChunk}
                            title="Save this file in memory inside the WAD session"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'var(--success, #28a745)', borderColor: 'var(--success, #28a745)', color: '#fff' }}
                        >
                            <span dangerouslySetInnerHTML={{ __html: getIcon('save') || '💾' }} />
                            <span>{isSavingChunk ? 'Saving...' : 'Save File'}</span>
                        </button>
                    )}
                    <button
                        className="btn btn--sm btn--primary"
                        onClick={handleExtractThis}
                        disabled={isExtracting}
                        title="Extract this file to a folder"
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('export') }} />
                        <span>{isExtracting ? 'Extracting…' : 'Extract File'}</span>
                    </button>
                    {canEditChunks && (
                        <button
                            className="btn btn--sm btn--danger"
                            onClick={handleDeleteFromWad}
                            title="Delete this file from the WAD (applied when you save the WAD)"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                        >
                            <span dangerouslySetInnerHTML={{ __html: getIcon('trash') || '🗑' }} />
                            <span>Delete</span>
                        </button>
                    )}
                    <button
                        className="btn btn--sm"
                        onClick={() => {
                            useWadExtractStore.getState().setPreview(session.id, null);
                        }}
                        title="Close preview"
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', padding: 0 }}
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('close') || '✕' }} />
                    </button>
                </div>
            </div>

            <div className="preview-panel__content">{renderContent()}</div>

            {preview && (
                <div className="preview-panel__info-bar" style={{ height: '44px', boxSizing: 'border-box' }}>
                    <span className="preview-panel__info-item">
                        <span className="preview-panel__info-label">Type: </span>
                        {getTypeLabel(preview.fileType)}
                    </span>
                    {preview.dimensions && (
                        <span className="preview-panel__info-item">
                            <span className="preview-panel__info-label">Dimensions: </span>
                            {preview.dimensions[0]}×{preview.dimensions[1]}
                        </span>
                    )}
                    <span className="preview-panel__info-item">
                        <span className="preview-panel__info-label">Size: </span>
                        {formatFileSize(preview.bytes.length)}
                    </span>
                    <span className="preview-panel__info-item" style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '10px' }}>
                        {chunk.hash}
                    </span>
                </div>
            )}
        </div>
    );
};
