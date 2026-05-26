/**
 * Side-by-side comparison between a project file and its reference version
 * (either the original chunk in the user's League install, or a previously
 * created per-file backup under `.flint/backups/`).
 *
 * Triggered from the file-tree right-click menu via `openModal('fileCompare', ...)`.
 *
 * Uses the Design Lab visual language (`dl-*` classes from `design-lab.css`)
 * — portal-rendered backdrop, spring-eased entrance, status badge in the
 * header, hover-lift comparison panes.
 */

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalStore, useConfigStore, useProjectTabStore } from '../../lib/stores';
import * as api from '../../lib/api';
import type { OriginalFileMeta } from '../../lib/api';
import '../../styles/design-lab.css';

interface FileCompareOptions {
    mode: 'original' | 'backup';
    /** Project-relative forward-slash path of the file. */
    filePath: string;
    fileName: string;
}

type RenderableContent =
    | { kind: 'image'; url: string; width?: number; height?: number }
    | { kind: 'text'; text: string }
    | { kind: 'binary'; size: number };

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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// ─── Inline icons (file-local — keeps the modal independent of icon registry) ─
const CloseIcon: React.FC = () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
);

export const FileCompareModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);
    const leaguePath = useConfigStore((s) => s.leaguePath);
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const isVisible = activeModal === 'fileCompare';
    const options = modalOptions as FileCompareOptions | null;

    const activeTab = activeTabId
        ? openTabs.find(t => t.id === activeTabId)
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

    // Esc-to-close — match the design-lab Modal's behavior.
    useEffect(() => {
        if (!isVisible) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [isVisible, closeModal]);

    // Revoke blob URLs when the previewed value changes / modal closes.
    useEffect(() => () => {
        if (current?.kind === 'image' && current.url.startsWith('blob:')) {
            URL.revokeObjectURL(current.url);
        }
    }, [current]);
    useEffect(() => () => {
        if (reference?.kind === 'image' && reference.url.startsWith('blob:')) {
            URL.revokeObjectURL(reference.url);
        }
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
                const absPath = `${projectPath.replace(/\\/g, '/')}/${options.filePath}`;
                const currentBytes = await api.readFileBytes(absPath);

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
                            ? `Couldn't locate ${m.queried_wad_name} in your League install.`
                            : `No matching chunk for "${m.queried_internal_path}" (or any close variant) in ${m.queried_wad_name}.`;
                        setError(`Original file not found — ${reason}`);
                        setLoading(false);
                        return;
                    }
                    referenceBytes = await api.readWadChunkData(m.wad_path, m.matched_hash);
                    if (!m.exact && m.matched_internal_path) {
                        setStatusBanner(
                            `Suffix-tolerant match against ${m.matched_internal_path}`
                        );
                    }
                } else {
                    referenceBytes = await api.readFileBackup(projectPath, options.filePath);
                }

                if (cancelled || !referenceBytes) return;

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

    const badgeClass =
        identical === null
            ? 'dl-badge'
            : identical
                ? 'dl-badge dl-badge--success'
                : 'dl-badge dl-badge--warn';

    return createPortal(
        <div
            className="dl-modal-backdrop"
            onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}
        >
            <div className="dl-modal dl-modal--large dl-fc">
                <div className="dl-modal__head">
                    <h3 className="dl-modal__title">
                        <span className="dl-fc__filename">{options.fileName}</span>
                        <span className="dl-fc__title-divider">·</span>
                        <span className="dl-fc__title-mode">{titleSuffix}</span>
                    </h3>
                    {identical !== null && (
                        <span className={badgeClass}>
                            <span className="dl-badge__dot" />
                            {identical ? 'Identical' : 'Different'}
                        </span>
                    )}
                    <button className="dl-modal__close" onClick={closeModal} aria-label="Close">
                        <CloseIcon />
                    </button>
                </div>

                <div className="dl-modal__body dl-fc__body">
                    {loading && (
                        <div className="dl-fc__loading">
                            <div className="dl-fc__spinner" />
                            <span>
                                {options.mode === 'original' ? 'Looking up original chunk…' : 'Loading backup…'}
                            </span>
                        </div>
                    )}

                    {error && !loading && (
                        <div className="dl-fc__error">
                            <p>{error}</p>
                            <button className="dl-btn dl-btn--secondary" onClick={closeModal}>Close</button>
                        </div>
                    )}

                    {!loading && !error && (
                        <>
                            {statusBanner && (
                                <div className="dl-fc__banner">{statusBanner}</div>
                            )}

                            {sizes && (
                                <div className="dl-fc__meta">
                                    <span className="dl-fc__meta-pair">
                                        <span className="dl-fc__meta-label">Current</span>
                                        <span className="dl-fc__meta-value">{formatSize(sizes.current)}</span>
                                    </span>
                                    <span className="dl-fc__meta-sep" />
                                    <span className="dl-fc__meta-pair">
                                        <span className="dl-fc__meta-label">{referenceLabel}</span>
                                        <span className="dl-fc__meta-value">{formatSize(sizes.reference)}</span>
                                    </span>
                                    {meta?.matched_internal_path && options.mode === 'original' && (
                                        <>
                                            <span className="dl-fc__meta-sep" />
                                            <span className="dl-fc__meta-path" title={meta.matched_internal_path}>
                                                {meta.matched_internal_path}
                                            </span>
                                        </>
                                    )}
                                </div>
                            )}

                            <div className="dl-fc__grid">
                                <ComparePane label="Current (project)" tone="current" content={current} />
                                <ComparePane label={referenceLabel} tone="reference" content={reference} />
                            </div>
                        </>
                    )}
                </div>

                <div className="dl-modal__foot">
                    <button className="dl-btn dl-btn--secondary" onClick={closeModal}>Close</button>
                </div>
            </div>

            {/* Component-local styles — keeps this modal portable while still
                speaking the design-lab visual language. */}
            <style>{LOCAL_CSS}</style>
        </div>,
        document.body,
    );
};

const ComparePane: React.FC<{
    label: string;
    tone: 'current' | 'reference';
    content: RenderableContent | null;
}> = ({ label, tone, content }) => {
    return (
        <div className={`dl-card dl-fc__pane dl-fc__pane--${tone}`}>
            <div className="dl-fc__pane-head">
                <span className={`dl-fc__pane-tag dl-fc__pane-tag--${tone}`} />
                <span className="dl-fc__pane-label">{label}</span>
            </div>
            <div className="dl-fc__pane-body">
                <RenderContent content={content} />
            </div>
        </div>
    );
};

const RenderContent: React.FC<{ content: RenderableContent | null }> = ({ content }) => {
    if (!content) {
        return <div className="dl-fc__placeholder">—</div>;
    }
    switch (content.kind) {
        case 'image':
            return (
                <div className="dl-fc__image-wrap">
                    <img
                        src={content.url}
                        alt={content.width ? `${content.width}×${content.height}` : ''}
                        className="dl-fc__image"
                    />
                </div>
            );
        case 'text':
            return (
                <pre className="dl-fc__text">
                    {content.text.length > 50000
                        ? content.text.slice(0, 50000) + '\n\n… (truncated)'
                        : content.text}
                </pre>
            );
        case 'binary':
            return (
                <div className="dl-fc__placeholder">
                    Binary file ({formatSize(content.size)})
                </div>
            );
    }
};

// ─── Component-local CSS ────────────────────────────────────────────────────
// Inlined as a <style> tag so the modal stays self-contained alongside its
// own dl-* selectors. All custom rules sit under `.dl-fc` to avoid leaking.
const LOCAL_CSS = `
.dl-fc__filename {
    font-weight: 600;
}
.dl-fc__title-divider {
    color: var(--text-muted);
    margin: 0 8px;
    font-weight: 400;
}
.dl-fc__title-mode {
    color: var(--text-secondary);
    font-weight: 500;
}

.dl-fc__body {
    gap: 14px !important;
    padding: 20px 22px 22px !important;
}

.dl-fc__loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 56px 24px;
    color: var(--text-muted);
    font-size: 13px;
}
.dl-fc__spinner {
    width: 18px; height: 18px;
    border-radius: 50%;
    border: 2px solid color-mix(in oklab, var(--accent-primary) 25%, transparent);
    border-top-color: var(--accent-primary);
    animation: dl-fc-spin 0.8s linear infinite;
}
@keyframes dl-fc-spin {
    to { transform: rotate(360deg); }
}

.dl-fc__error {
    padding: 32px 24px;
    text-align: center;
    color: var(--color-danger);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
}
.dl-fc__error p {
    margin: 0;
    max-width: 560px;
    line-height: 1.5;
}

.dl-fc__banner {
    padding: 10px 14px;
    font-size: 12px;
    background: color-mix(in oklab, var(--color-warning) 12%, var(--bg-tertiary));
    border: 1px solid color-mix(in oklab, var(--color-warning) 30%, var(--border));
    color: color-mix(in oklab, var(--color-warning) 80%, var(--text-primary));
    border-radius: var(--dl-radius);
}

.dl-fc__meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    padding: 10px 14px;
    font-size: 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--dl-radius);
}
.dl-fc__meta-pair {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
}
.dl-fc__meta-label {
    color: var(--text-muted);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.06em;
    font-weight: 600;
}
.dl-fc__meta-value {
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 12px;
}
.dl-fc__meta-sep {
    width: 1px;
    height: 14px;
    background: var(--border);
}
.dl-fc__meta-path {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 120px;
}

.dl-fc__grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    min-height: 360px;
}

.dl-fc__pane {
    padding: 0 !important;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
}
.dl-fc__pane-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: linear-gradient(180deg,
        color-mix(in oklab, var(--bg-secondary) 80%, transparent) 0%,
        transparent 100%);
    border-bottom: 1px solid var(--border);
}
.dl-fc__pane-tag {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    box-shadow: 0 0 0 3px color-mix(in oklab, currentColor 18%, transparent);
}
.dl-fc__pane-tag--current {
    background: var(--accent-primary);
    color: var(--accent-primary);
}
.dl-fc__pane-tag--reference {
    background: var(--color-success, #10b981);
    color: var(--color-success, #10b981);
}
.dl-fc__pane-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: 0.02em;
}
.dl-fc__pane-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px;
    background:
        repeating-conic-gradient(rgba(255,255,255,0.018) 0% 25%, transparent 0% 50%) 50% / 16px 16px,
        var(--bg-primary);
}

.dl-fc__image-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100%;
}
.dl-fc__image {
    max-width: 100%;
    max-height: 360px;
    object-fit: contain;
    image-rendering: pixelated;
    border-radius: var(--dl-radius-sm);
    box-shadow: var(--dl-shadow-sm);
}

.dl-fc__text {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.55;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
}

.dl-fc__placeholder {
    color: var(--text-muted);
    font-size: 12px;
    text-align: center;
    padding: 24px;
}

@media (max-width: 720px) {
    .dl-fc__grid { grid-template-columns: 1fr; }
}
`;
