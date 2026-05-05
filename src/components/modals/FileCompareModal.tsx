/**
 * Side-by-side comparison between a project file and its reference version
 * (either the original chunk in the user's League install, or a previously
 * created per-file backup under `.flint/backups/`).
 *
 * Triggered from the file-tree right-click menu via `openModal('fileCompare', ...)`.
 */

import React, { useEffect, useState } from 'react';
import { useAppState } from '../../lib/stores';
import * as api from '../../lib/api';
import { Button, Modal, ModalBody, ModalHeader, Spinner } from '../ui';
import type { OriginalFileMeta } from '../../lib/api';

interface FileCompareOptions {
    mode: 'original' | 'backup';
    /** Project-relative forward-slash path of the file. */
    filePath: string;
    fileName: string;
}

type RenderableContent =
    | { kind: 'image'; url: string; width?: number; height?: number }
    | { kind: 'text'; text: string }
    | { kind: 'binary'; size: number }
    | { kind: 'missing'; message: string };

const IMAGE_EXTS = new Set(['tex', 'dds', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']);
const TEXT_EXTS = new Set([
    'txt', 'json', 'ritobin', 'lua', 'xml', 'ini', 'cfg', 'log',
    'md', 'csv', 'yaml', 'yml', 'toml', 'js', 'ts', 'css', 'html',
]);

function getExt(name: string): string {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Decode a Uint8Array into a renderable form, picking by file extension. */
async function decodeForRender(bytes: Uint8Array, fileName: string): Promise<RenderableContent> {
    const ext = getExt(fileName);
    if (IMAGE_EXTS.has(ext)) {
        if (ext === 'tex' || ext === 'dds') {
            try {
                const decoded = await api.decodeBytesToPng(bytes);
                return {
                    kind: 'image',
                    url: `data:image/png;base64,${decoded.data}`,
                    width: decoded.width,
                    height: decoded.height,
                };
            } catch {
                return { kind: 'binary', size: bytes.byteLength };
            }
        }
        const blob = new Blob([bytes as BlobPart]);
        return { kind: 'image', url: URL.createObjectURL(blob) };
    }
    if (TEXT_EXTS.has(ext)) {
        try {
            const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            return { kind: 'text', text };
        } catch {
            return { kind: 'binary', size: bytes.byteLength };
        }
    }
    return { kind: 'binary', size: bytes.byteLength };
}

/** Cheap byte-equality check — short-circuits on length mismatch. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

export const FileCompareModal: React.FC = () => {
    const { state, closeModal } = useAppState();
    const isVisible = state.activeModal === 'fileCompare';
    const options = state.modalOptions as FileCompareOptions | null;
    const leaguePath = state.leaguePath;

    const activeTab = state.activeTabId
        ? state.openTabs.find(t => t.id === state.activeTabId)
        : null;
    const projectPath = activeTab?.projectPath || null;

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [statusBanner, setStatusBanner] = useState<string | null>(null);
    const [meta, setMeta] = useState<OriginalFileMeta | null>(null);
    const [current, setCurrent] = useState<RenderableContent | null>(null);
    const [reference, setReference] = useState<RenderableContent | null>(null);
    const [identical, setIdentical] = useState<boolean | null>(null);
    const [sizes, setSizes] = useState<{ current: number; reference: number } | null>(null);

    // Revoke blob URLs when the previewed value changes / modal unmounts.
    // Data URLs (used for decoded TEX/DDS) don't need revoking.
    useEffect(() => {
        return () => {
            if (current?.kind === 'image' && current.url.startsWith('blob:')) {
                URL.revokeObjectURL(current.url);
            }
        };
    }, [current]);
    useEffect(() => {
        return () => {
            if (reference?.kind === 'image' && reference.url.startsWith('blob:')) {
                URL.revokeObjectURL(reference.url);
            }
        };
    }, [reference]);

    useEffect(() => {
        if (!isVisible || !options || !projectPath) return;

        let cancelled = false;
        setLoading(true);
        setError(null);
        setStatusBanner(null);
        setMeta(null);
        setCurrent(null);
        setReference(null);
        setIdentical(null);
        setSizes(null);

        (async () => {
            try {
                // 1. Read the current project file.
                const absPath = `${projectPath.replace(/\\/g, '/')}/${options.filePath}`;
                const currentBytes = await api.readFileBytes(absPath);

                // 2. Read the reference bytes.
                let referenceBytes: Uint8Array | null = null;

                if (options.mode === 'original') {
                    if (!leaguePath) {
                        if (cancelled) return;
                        setError('League path is not set. Configure it in Settings (Ctrl+,) first.');
                        setLoading(false);
                        return;
                    }
                    const m = await api.findOriginalFile(leaguePath, projectPath, options.filePath);
                    if (cancelled) return;
                    setMeta(m);
                    if (!m.found || !m.wad_path || !m.matched_hash) {
                        const reason = !m.wad_found
                            ? `Original file not found — couldn't locate ${m.queried_wad_name} in your League install.`
                            : `Original file not found — no matching chunk for "${m.queried_internal_path}" (or any close variant) in ${m.queried_wad_name}.`;
                        setError(reason);
                        setLoading(false);
                        return;
                    }
                    referenceBytes = await api.readWadChunkData(m.wad_path, m.matched_hash);
                    if (!m.exact && m.matched_internal_path) {
                        setStatusBanner(
                            `Suffix-tolerant match: comparing against "${m.matched_internal_path}" ` +
                            `(your file is "${m.queried_internal_path}").`
                        );
                    }
                } else {
                    referenceBytes = await api.readFileBackup(projectPath, options.filePath);
                }

                if (cancelled || !referenceBytes) return;

                // 3. Compare + decode in parallel.
                setSizes({ current: currentBytes.byteLength, reference: referenceBytes.byteLength });
                setIdentical(bytesEqual(currentBytes, referenceBytes));

                const [currentRender, referenceRender] = await Promise.all([
                    decodeForRender(currentBytes, options.fileName),
                    decodeForRender(referenceBytes, options.fileName),
                ]);
                if (cancelled) return;
                setCurrent(currentRender);
                setReference(referenceRender);
                setLoading(false);
            } catch (e) {
                if (cancelled) return;
                const message = (e as { message?: string })?.message ?? String(e);
                setError(message);
                setLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [isVisible, options, projectPath, leaguePath]);

    if (!isVisible || !options) return null;

    const referenceLabel = options.mode === 'original' ? 'Original (League)' : 'Backup';
    const titleSuffix = options.mode === 'original' ? 'vs Original' : 'vs Backup';

    return (
        <Modal open={isVisible} onClose={closeModal} size="large">
            <ModalHeader title={`${options.fileName} — ${titleSuffix}`} onClose={closeModal}>
                {identical !== null && (
                    <span
                        style={{
                            fontSize: 12,
                            padding: '4px 10px',
                            borderRadius: 4,
                            background: identical ? 'var(--accent-success-bg, #2e7d32)' : 'var(--accent-warning-bg, #ad7d00)',
                            color: '#fff',
                        }}
                    >
                        {identical ? 'Identical' : 'Different'}
                    </span>
                )}
            </ModalHeader>
            <ModalBody>
                {loading && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12 }}>
                        <Spinner size="md" />
                        <span style={{ color: 'var(--text-muted)' }}>
                            {options.mode === 'original' ? 'Looking up original chunk…' : 'Loading backup…'}
                        </span>
                    </div>
                )}

                {error && !loading && (
                    <div style={{ padding: 24, textAlign: 'center' }}>
                        <p style={{ color: 'var(--accent-danger)', marginBottom: 12 }}>{error}</p>
                        <Button variant="secondary" onClick={closeModal}>Close</Button>
                    </div>
                )}

                {!loading && !error && (
                    <>
                        {statusBanner && (
                            <div
                                style={{
                                    padding: '8px 12px',
                                    marginBottom: 12,
                                    fontSize: 12,
                                    background: 'var(--bg-secondary)',
                                    border: '1px solid var(--border)',
                                    borderRadius: 4,
                                    color: 'var(--text-muted)',
                                }}
                            >
                                {statusBanner}
                            </div>
                        )}

                        {sizes && (
                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                                Current: {formatSize(sizes.current)} · {referenceLabel}: {formatSize(sizes.reference)}
                                {meta?.matched_internal_path && options.mode === 'original' && (
                                    <span> · {meta.matched_internal_path}</span>
                                )}
                            </div>
                        )}

                        <div
                            style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr',
                                gap: 12,
                                minHeight: 320,
                            }}
                        >
                            <ComparePane label="Current (project)" content={current} />
                            <ComparePane label={referenceLabel} content={reference} />
                        </div>
                    </>
                )}
            </ModalBody>
        </Modal>
    );
};

const ComparePane: React.FC<{ label: string; content: RenderableContent | null }> = ({ label, content }) => {
    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                border: '1px solid var(--border)',
                borderRadius: 4,
                overflow: 'hidden',
                minHeight: 0,
            }}
        >
            <div
                style={{
                    padding: '6px 10px',
                    fontSize: 12,
                    fontWeight: 600,
                    background: 'var(--bg-secondary)',
                    borderBottom: '1px solid var(--border)',
                }}
            >
                {label}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8 }}>
                <RenderContent content={content} />
            </div>
        </div>
    );
};

const RenderContent: React.FC<{ content: RenderableContent | null }> = ({ content }) => {
    if (!content) {
        return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</div>;
    }
    switch (content.kind) {
        case 'image':
            return (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                    <img
                        src={content.url}
                        alt={label_for_alt(content)}
                        style={{
                            maxWidth: '100%',
                            maxHeight: 360,
                            objectFit: 'contain',
                            imageRendering: 'pixelated',
                            background:
                                'repeating-conic-gradient(rgba(255,255,255,0.04) 0% 25%, transparent 0% 50%) 50% / 16px 16px',
                        }}
                    />
                </div>
            );
        case 'text':
            return (
                <pre
                    style={{
                        margin: 0,
                        fontSize: 11,
                        fontFamily: 'var(--font-mono, monospace)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        color: 'var(--text)',
                    }}
                >
                    {content.text.length > 50000
                        ? content.text.slice(0, 50000) + '\n\n… (truncated)'
                        : content.text}
                </pre>
            );
        case 'binary':
            return (
                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    Binary file ({formatSize(content.size)})
                </div>
            );
        case 'missing':
            return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{content.message}</div>;
    }
};

function label_for_alt(c: RenderableContent): string {
    return c.kind === 'image' && c.width ? `${c.width}×${c.height}` : '';
}
