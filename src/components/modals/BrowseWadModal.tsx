/**
 * Flint - Browse WAD Modal
 *
 * Single full-width drop zone (also clickable to open the file picker) for
 * choosing a .wad / .wad.client. After the file is loaded we read the chunk
 * list, count chunks with no resolved path (unknown hashes), and — if more
 * than 3 — surface a callout offering to scan the WAD's BIN/SKN chunks and
 * write `hashes.extracted.txt` / `hashes.binhashes.extracted.txt` into the
 * user's hash directory. Algorithm ported from Quartz's `bin_hashes.rs`.
 */

import React, { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useModalStore, useNotificationStore, useConfigStore, useWadExtractStore, useNavigationStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { Button, Icon, Modal, ModalBody, ModalFooter, ModalHeader } from '../ui';

const UNKNOWN_THRESHOLD = 3;

type Phase = 'pick' | 'loading' | 'loaded' | 'error';

export const BrowseWadModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const leaguePath = useConfigStore((s) => s.leaguePath);
    const leaguePathPbe = useConfigStore((s) => s.leaguePathPbe);
    const isVisible = activeModal === 'browseWad';
    const effectiveLeaguePath = leaguePath || leaguePathPbe || null;

    const [phase, setPhase] = useState<Phase>('pick');
    const [wadPath, setWadPath] = useState<string | null>(null);
    const [chunks, setChunks] = useState<Array<{ hash: string; path: string | null; size: number }> | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [extracting, setExtracting] = useState(false);
    const [extractResult, setExtractResult] = useState<api.ExtractHashesResult | null>(null);
    const [dragOver, setDragOver] = useState(false);
    const dropZoneRef = useRef<HTMLDivElement | null>(null);
    /** Latest loadWad ref so the webview listener (mounted once) sees fresh state. */
    const loadWadRef = useRef<(p: string) => Promise<void>>(() => Promise.resolve());

    useEffect(() => {
        if (!isVisible) return;
        setPhase('pick');
        setWadPath(null);
        setChunks(null);
        setError(null);
        setExtracting(false);
        setExtractResult(null);
        setDragOver(false);
    }, [isVisible]);

    const loadWad = async (path: string) => {
        if (!/\.(wad|wad\.client)$/i.test(path) && !path.toLowerCase().endsWith('.client')) {
            setError(`Not a WAD file:\n${path}`);
            setPhase('error');
            return;
        }
        setWadPath(path);
        setPhase('loading');
        setError(null);
        try {
            const list = await api.getWadChunks(path);
            setChunks(list);
            setPhase('loaded');
        } catch (err) {
            const msg = err instanceof api.FlintError ? err.getUserMessage() : String(err);
            setError(msg);
            setPhase('error');
        }
    };

    const handleBrowse = async () => {
        try {
            const selected = await open({
                title: 'Open WAD File',
                filters: [{ name: 'WAD Archive', extensions: ['wad', 'client'] }],
                multiple: false,
            });
            if (!selected) return;
            await loadWad(selected as string);
        } catch (err) {
            console.error('[BrowseWad] picker failed', err);
        }
    };

    /** Open the file picker rooted at League's `Game/DATA/FINAL` (where the
        client WADs live — same root the champion-schema scanner uses).
        Handles whether `leaguePath` points at the install root, the Game
        folder, or already deeper inside DATA/FINAL. */
    const handleBrowseLeague = async () => {
        if (!effectiveLeaguePath) {
            showToast('error', 'League path not set — configure it in Settings');
            return;
        }
        const sep = effectiveLeaguePath.includes('\\') ? '\\' : '/';
        // Normalize: strip trailing slashes, split into segments.
        const norm = effectiveLeaguePath.replace(/[\\/]+$/, '');
        const lower = norm.toLowerCase().replace(/\\/g, '/');
        let dataFinal: string;
        if (lower.includes('/data/final')) {
            // Already inside DATA/FINAL — use as-is.
            dataFinal = norm;
        } else if (lower.endsWith('/data')) {
            // Sitting at DATA — append FINAL.
            dataFinal = `${norm}${sep}FINAL`;
        } else if (lower.endsWith('/game')) {
            // "Game" folder — append DATA/FINAL.
            dataFinal = `${norm}${sep}DATA${sep}FINAL`;
        } else {
            // Install root (e.g. ".../League of Legends") — append Game/DATA/FINAL.
            dataFinal = `${norm}${sep}Game${sep}DATA${sep}FINAL`;
        }
        try {
            const selected = await open({
                title: 'Open WAD File from League',
                defaultPath: dataFinal,
                filters: [{ name: 'WAD Archive', extensions: ['wad', 'client'] }],
                multiple: false,
            });
            if (!selected) return;
            await loadWad(selected as string);
        } catch (err) {
            console.error('[BrowseWad] league picker failed', err);
        }
    };

    /* Tauri's webview drag-drop pipeline (same approach FileTree uses): the
       OS-level drop event delivers absolute paths via `event.payload.paths`.
       We hit-test the drop position against the drop-zone's bounding rect to
       know whether the user actually dropped inside our target. */
    useEffect(() => {
        loadWadRef.current = loadWad;
    });

    useEffect(() => {
        if (!isVisible) return;
        let unlisten: (() => void) | null = null;
        let cancelled = false;

        const cssCoords = (pos: { x: number; y: number }) => ({
            x: pos.x / window.devicePixelRatio,
            y: pos.y / window.devicePixelRatio,
        });
        const insideDropZone = (x: number, y: number) => {
            const el = dropZoneRef.current;
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        };

        getCurrentWebview()
            .onDragDropEvent((event) => {
                if (cancelled) return;
                const { type } = event.payload as { type: string };

                if (type === 'over') {
                    const { x, y } = cssCoords((event.payload as any).position);
                    setDragOver(insideDropZone(x, y));
                } else if (type === 'drop') {
                    const payload = event.payload as { position: { x: number; y: number }; paths: string[] };
                    const { x, y } = cssCoords(payload.position);
                    setDragOver(false);
                    if (!insideDropZone(x, y)) return;
                    if (!payload.paths?.length) {
                        showToast('error', 'No file path in the drop');
                        return;
                    }
                    // Pick the first path that looks like a WAD; fall back to the first.
                    const wad = payload.paths.find((p) => /\.(wad|wad\.client|client)$/i.test(p)) ?? payload.paths[0];
                    void loadWadRef.current(wad);
                } else {
                    setDragOver(false);
                }
            })
            .then((fn) => {
                if (cancelled) fn();
                else unlisten = fn;
            })
            .catch((err) => console.error('[BrowseWad] drag listener failed', err));

        return () => {
            cancelled = true;
            if (unlisten) unlisten();
        };
    }, [isVisible, showToast]);

    const totalChunks = chunks?.length ?? 0;
    const unknownChunks = chunks?.filter((c) => !c.path).length ?? 0;
    const tooManyUnknown = unknownChunks > UNKNOWN_THRESHOLD;

    const handleExtractHashes = async () => {
        if (!wadPath) return;
        setExtracting(true);
        setExtractResult(null);
        try {
            const result = await api.extractHashesFromWad(wadPath);
            setExtractResult(result);
            const total = result.game_hashes_added + result.bin_hashes_added;

            // Re-resolve the chunk list so the "Resolved / Unknown" stats reflect
            // the freshly-merged hashes (the backend writes them straight to LMDB).
            const beforeUnknown = chunks?.filter((c) => !c.path).length ?? 0;
            try {
                const refreshed = await api.getWadChunks(wadPath);
                setChunks(refreshed);
                const afterUnknown = refreshed.filter((c) => !c.path).length;
                const newlyResolved = Math.max(0, beforeUnknown - afterUnknown);
                showToast(
                    newlyResolved > 0 ? 'success' : total > 0 ? 'info' : 'info',
                    newlyResolved > 0
                        ? `Resolved ${newlyResolved} new path${newlyResolved === 1 ? '' : 's'} (+${total} hashes from ${result.scanned} files)`
                        : total > 0
                            ? `Extracted ${total} hash${total === 1 ? '' : 'es'} — none matched chunks in this WAD`
                            : `Scanned ${result.scanned} BIN/SKN files — no new hashes found`,
                );
            } catch (refreshErr) {
                console.error('[BrowseWad] failed to refresh chunks after extract', refreshErr);
                showToast(
                    total > 0 ? 'success' : 'info',
                    total > 0
                        ? `Extracted ${total} new hash${total === 1 ? '' : 'es'} from ${result.scanned} files`
                        : `Scanned ${result.scanned} BIN/SKN files — no new hashes found`,
                );
            }
        } catch (err) {
            const msg = err instanceof api.FlintError ? err.getUserMessage() : String(err);
            showToast('error', `Extract failed: ${msg}`);
        } finally {
            setExtracting(false);
        }
    };

    const handleOpenInExplorer = () => {
        if (!wadPath || !chunks) return;
        const sessionId = `extract-${Date.now()}`;
        useWadExtractStore.getState().openSession(sessionId, wadPath);
        useNavigationStore.getState().setView('extract');
        useWadExtractStore.getState().setChunks(sessionId, chunks);
        closeModal();
    };

    if (!isVisible) return null;

    /* Picker phase is fully headless — heading + drop zone + manual button live
       inside the body. Other phases keep a compact ModalHeader for context. */
    const showHeader = phase !== 'pick';

    return (
        <Modal open={isVisible} onClose={closeModal} size="wide" modifier="modal--browse-wad">
            <style>{`
                .modal--browse-wad { max-width: 720px !important; width: 90vw !important; }
                .bwm-pick .bwm-code {
                    background: var(--bg-tertiary);
                    border: 1px solid var(--border);
                    border-radius: 4px;
                    padding: 1px 6px;
                    margin: 0 1px;
                    font-family: var(--font-mono);
                    font-size: 11px;
                    color: color-mix(in oklab, var(--accent-primary) 25%, var(--text-primary));
                }
                .bwm-drop:hover {
                    background: color-mix(in oklab, var(--accent-primary) 8%, var(--bg-tertiary)) !important;
                    border-color: color-mix(in oklab, var(--accent-primary) 55%, var(--border)) !important;
                    box-shadow: 0 8px 24px -10px color-mix(in oklab, var(--accent-primary) 35%, transparent);
                }
                .bwm-drop:hover .bwm-drop__icon {
                    color: var(--accent-primary) !important;
                    border-color: color-mix(in oklab, var(--accent-primary) 50%, var(--border)) !important;
                    transform: translateY(-3px);
                    transition: transform 320ms cubic-bezier(.34,1.56,.64,1), color 220ms, border-color 220ms;
                }
                .bwm-drop:active { transform: scale(0.995); }
                .bwm-drop:focus-visible {
                    outline: none;
                    border-color: var(--accent-primary) !important;
                    box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent-primary) 30%, transparent);
                }
                .bwm-drop--over {
                    animation: bwmPulse 1.6s ease-in-out infinite;
                }
                @keyframes bwmPulse {
                    0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--accent-primary) 35%, transparent); }
                    50%      { box-shadow: 0 0 0 12px color-mix(in oklab, var(--accent-primary) 8%, transparent); }
                }
                .bwm-manual:hover {
                    background: color-mix(in oklab, var(--accent-primary) 8%, transparent) !important;
                    border-color: color-mix(in oklab, var(--accent-primary) 50%, var(--border)) !important;
                    color: var(--text-primary) !important;
                }
                .bwm-manual:active { transform: scale(0.99); }
                .bwm-manual:focus-visible {
                    outline: none;
                    border-color: var(--accent-primary) !important;
                    box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent-primary) 30%, transparent);
                }
            `}</style>
            {showHeader && (
                <ModalHeader
                    title={
                        <span className="bw-title">
                            <span className="bw-title__icon"><Icon name="wad" /></span>
                            <span className="bw-title__text">
                                <span className="bw-title__name">Open WAD File</span>
                                <span className="bw-title__sub">
                                    {phase === 'loading' && 'Reading chunks…'}
                                    {phase === 'loaded' && `${totalChunks.toLocaleString()} chunks · ${unknownChunks.toLocaleString()} unresolved`}
                                    {phase === 'error' && 'Could not open this WAD'}
                                </span>
                            </span>
                        </span>
                    }
                />
            )}

            <ModalBody className="bw-body" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
                {phase === 'pick' && (
                    <div
                        className="bwm-pick"
                        style={{
                            padding: '32px 36px 28px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 18,
                            boxSizing: 'border-box',
                        }}
                    >
                        <header style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <h2
                                className="bwm-pick__title"
                                style={{
                                    margin: 0,
                                    fontSize: 26,
                                    fontWeight: 700,
                                    letterSpacing: '-0.02em',
                                    lineHeight: 1.15,
                                    color: 'var(--text-primary)',
                                }}
                            >
                                Open Your WAD File
                            </h2>
                            <p
                                style={{
                                    margin: 0,
                                    fontSize: 14,
                                    color: 'var(--text-secondary)',
                                    lineHeight: 1.5,
                                    maxWidth: 560,
                                }}
                            >
                                Load a League of Legends WAD archive (<code className="bwm-code">.wad</code> or{' '}
                                <code className="bwm-code">.wad.client</code>) to scan its contents and detect
                                missing path hashes.
                            </p>
                        </header>

                        <div
                            ref={dropZoneRef}
                            role="button"
                            tabIndex={0}
                            className={`bwm-drop ${dragOver ? 'bwm-drop--over' : ''}`}
                            onClick={handleBrowse}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleBrowse(); }
                            }}
                            aria-label="Drop a WAD file here, or click to browse"
                            style={{
                                boxSizing: 'border-box',
                                width: '100%',
                                minHeight: 220,
                                padding: '36px 24px',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 14,
                                background: dragOver
                                    ? 'color-mix(in oklab, var(--accent-primary) 18%, var(--bg-tertiary))'
                                    : 'color-mix(in oklab, var(--bg-primary) 80%, transparent)',
                                border: `2px ${dragOver ? 'solid' : 'dashed'} ${dragOver ? 'var(--accent-primary)' : 'color-mix(in oklab, var(--border) 90%, transparent)'}`,
                                borderRadius: 16,
                                color: 'var(--text-primary)',
                                cursor: 'pointer',
                                textAlign: 'center',
                                transition: 'background 220ms, border-color 220ms, transform 120ms, box-shadow 220ms',
                            }}
                        >
                            <span
                                className="bwm-drop__icon"
                                aria-hidden="true"
                                style={{
                                    boxSizing: 'border-box',
                                    width: 72,
                                    height: 72,
                                    minWidth: 72,
                                    flex: '0 0 72px',
                                    display: 'grid',
                                    placeItems: 'center',
                                    background: 'color-mix(in oklab, var(--bg-tertiary) 70%, transparent)',
                                    border: '1px solid color-mix(in oklab, var(--border) 80%, transparent)',
                                    borderRadius: '50%',
                                    color: dragOver ? '#fff' : 'var(--text-secondary)',
                                    overflow: 'hidden',
                                    pointerEvents: 'none',
                                }}
                            >
                                <svg
                                    width="32"
                                    height="32"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    style={{ display: 'block', flexShrink: 0 }}
                                >
                                    <path d="M12 4v12" />
                                    <path d="M6 10l6-6 6 6" />
                                    <path d="M5 19h14" />
                                </svg>
                            </span>
                            <strong
                                style={{
                                    display: 'block',
                                    margin: 0,
                                    fontSize: 18,
                                    fontWeight: 700,
                                    color: 'var(--text-primary)',
                                    letterSpacing: '-0.01em',
                                    lineHeight: 1.2,
                                    pointerEvents: 'none',
                                }}
                            >
                                {dragOver ? 'Release to load' : 'Drag & drop your WAD file'}
                            </strong>
                            <span
                                style={{
                                    display: 'block',
                                    margin: 0,
                                    fontSize: 13,
                                    color: 'var(--text-muted)',
                                    lineHeight: 1.5,
                                    pointerEvents: 'none',
                                }}
                            >
                                or{' '}
                                <span
                                    style={{
                                        color: 'var(--accent-primary)',
                                        fontWeight: 500,
                                        borderBottom: '1px dashed color-mix(in oklab, var(--accent-primary) 50%, transparent)',
                                    }}
                                >
                                    browse to upload
                                </span>
                            </span>
                        </div>

                        <button
                            type="button"
                            className="bwm-manual"
                            onClick={(e) => { e.stopPropagation(); handleBrowseLeague(); }}
                            disabled={!effectiveLeaguePath}
                            title={effectiveLeaguePath ?? 'League path not set in Settings'}
                            style={{
                                boxSizing: 'border-box',
                                width: '100%',
                                height: 56,
                                appearance: 'none',
                                WebkitAppearance: 'none',
                                fontFamily: 'inherit',
                                margin: 0,
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 10,
                                padding: '0 20px',
                                background: 'transparent',
                                border: '1px solid var(--border)',
                                borderRadius: 14,
                                color: effectiveLeaguePath ? 'var(--text-secondary)' : 'var(--text-muted)',
                                fontSize: 14,
                                fontWeight: 500,
                                cursor: effectiveLeaguePath ? 'pointer' : 'not-allowed',
                                opacity: effectiveLeaguePath ? 1 : 0.55,
                                textAlign: 'center',
                                transition: 'background 120ms, border-color 120ms, color 120ms, transform 120ms',
                            }}
                        >
                            <span
                                aria-hidden="true"
                                style={{
                                    display: 'inline-grid',
                                    placeItems: 'center',
                                    width: 18,
                                    height: 18,
                                    color: 'var(--accent-primary)',
                                    flexShrink: 0,
                                }}
                            >
                                {/* Compass-style icon hinting at the League install dir */}
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                                    <circle cx="12" cy="12" r="9" />
                                    <path d="M15.5 8.5l-2 5-5 2 2-5z" />
                                </svg>
                            </span>
                            <span>{effectiveLeaguePath ? 'Browse League directory' : 'League path not set'}</span>
                        </button>
                    </div>
                )}

                {phase === 'loading' && (
                    <div className="bw-state">
                        <div className="bw-state__spinner" />
                        <strong className="bw-state__title">Reading chunks…</strong>
                        <span className="bw-state__sub">{wadPath}</span>
                    </div>
                )}

                {phase === 'error' && (
                    <div className="bw-state bw-state--error">
                        <span className="bw-state__icon"><Icon name="error" /></span>
                        <strong className="bw-state__title">Failed to open WAD</strong>
                        <span className="bw-state__sub">{error}</span>
                        <Button onClick={() => setPhase('pick')}>Try another file</Button>
                    </div>
                )}

                {phase === 'loaded' && wadPath && chunks && (
                    <div className="bw-summary">
                        <div className="bw-file">
                            <span className="bw-file__icon"><Icon name="wad" /></span>
                            <span className="bw-file__body">
                                <span className="bw-file__name">{wadPath.split(/[\\/]/).pop()}</span>
                                <span className="bw-file__path">{wadPath}</span>
                            </span>
                            <Button variant="ghost" size="sm" onClick={() => setPhase('pick')} icon="folderOpen2">
                                Change
                            </Button>
                        </div>

                        <div className="bw-stats">
                            <div className="bw-stat">
                                <span className="bw-stat__label">Total chunks</span>
                                <span className="bw-stat__value">{totalChunks.toLocaleString()}</span>
                            </div>
                            <div className="bw-stat bw-stat--ok">
                                <span className="bw-stat__label">Resolved</span>
                                <span className="bw-stat__value">{(totalChunks - unknownChunks).toLocaleString()}</span>
                            </div>
                            <div className={`bw-stat ${unknownChunks > 0 ? 'bw-stat--warn' : ''}`}>
                                <span className="bw-stat__label">Unknown</span>
                                <span className="bw-stat__value">{unknownChunks.toLocaleString()}</span>
                            </div>
                        </div>

                        {tooManyUnknown && !extractResult && (
                            <div className="bw-callout">
                                <span className="bw-callout__icon"><Icon name="warning" /></span>
                                <div className="bw-callout__body">
                                    <strong>Unknown hashes found</strong>
                                    <p>
                                        {unknownChunks.toLocaleString()} chunks couldn't be resolved.
                                        Want to scan this WAD's BIN/SKN files for asset paths and
                                        write a <code>hashes.extracted.txt</code> you can keep?
                                    </p>
                                </div>
                                <Button
                                    variant="primary"
                                    icon="download"
                                    onClick={handleExtractHashes}
                                    disabled={extracting}
                                >
                                    {extracting ? 'Extracting…' : 'Extract hashes'}
                                </Button>
                            </div>
                        )}

                        {extractResult && (
                            <div className="bw-callout bw-callout--ok">
                                <span className="bw-callout__icon"><Icon name="success" /></span>
                                <div className="bw-callout__body">
                                    <strong>
                                        {extractResult.game_hashes_added + extractResult.bin_hashes_added > 0
                                            ? `Extracted ${extractResult.game_hashes_added + extractResult.bin_hashes_added} new hashes`
                                            : 'No new hashes found'}
                                    </strong>
                                    <p>
                                        Scanned <strong>{extractResult.scanned.toLocaleString()}</strong> BIN/SKN files.
                                        {extractResult.game_hashes_added > 0 && <> {extractResult.game_hashes_added} game </>}
                                        {extractResult.game_hashes_added > 0 && extractResult.bin_hashes_added > 0 && '· '}
                                        {extractResult.bin_hashes_added > 0 && <>{extractResult.bin_hashes_added} bin</>}
                                    </p>
                                    {extractResult.output_files.length > 0 && (
                                        <ul className="bw-callout__files">
                                            {extractResult.output_files.map((f) => (
                                                <li key={f}><code>{f}</code></li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </ModalBody>

            <ModalFooter>
                <Button variant="ghost" onClick={closeModal}>Cancel</Button>
                <Button
                    variant="success"
                    icon="success"
                    onClick={handleOpenInExplorer}
                    disabled={phase !== 'loaded'}
                >
                    Open in WAD Explorer
                </Button>
            </ModalFooter>
        </Modal>
    );
};
