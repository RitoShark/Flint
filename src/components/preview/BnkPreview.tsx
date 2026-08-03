import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import * as api from '../../lib/api';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { useAppMetadataStore, useProjectTabStore } from '../../lib/stores';
import type { AudioBankInfo, AudioEntryInfo, EventMapping } from '../../lib/types';
import { AudioCutterModal } from './AudioCutterModal';
import { applyGainToWem, decodeAudioFile } from './audioUtils';
import { isWwiseWem } from '../../lib/audioDsp';

import type {
    BnkPreviewProps, ViewMode, BinLinkState, HircSource, DecodedCacheEntry, EventGroup,
} from './bnk/types';
import { PLAY_GLYPH, STOP_GLYPH, CARET_ICON } from './bnk/types';
import {
    formatBytes, findBinCandidate,
    findCompanionEventsBank, groupMappings,
} from './bnk/helpers';
import { CtxItem, CtxDivider } from './bnk/CtxMenu';
import { panelStyles } from './bnk/styles';

export const BnkPreview: React.FC<BnkPreviewProps> = ({ filePath }) => {
    const [info, setInfo] = useState<AudioBankInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState('');
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [playingId, setPlayingId] = useState<number | null>(null);
    const [decodingId, setDecodingId] = useState<number | null>(null);
    const [volume, setVolume] = useState(0.8);
    const [viewMode, setViewMode] = useState<ViewMode>('flat');

    const [binLink, setBinLink] = useState<BinLinkState>({ kind: 'idle' });
    const [hircSource, setHircSource] = useState<HircSource>({ kind: 'self' });
    const [mappings, setMappings] = useState<EventMapping[] | null>(null);
    const [mappingError, setMappingError] = useState<string | null>(null);
    const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());

    const [bankBytes, setBankBytes] = useState<Uint8Array | null>(null);
    const [isDirty, setIsDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [busyId, setBusyId] = useState<number | null>(null);
    const undoStackRef = useRef<Uint8Array[]>([]);
    const overlayDownRef = useRef(false);
    const [undoDepth, setUndoDepth] = useState(0);

    const [ctxMenu, setCtxMenu] = useState<
        { x: number; y: number; entry: AudioEntryInfo; eventName?: string } | null
    >(null);

    const [volumeModal, setVolumeModal] = useState<{ entry: AudioEntryInfo; gainDb: number; busy: boolean } | null>(
        null,
    );

    const [cutterModal, setCutterModal] = useState<{
        entry: AudioEntryInfo;
        source?: { buffer: AudioBuffer; name: string };
    } | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const cacheRef = useRef<Map<number, DecodedCacheEntry>>(new Map());

    const fileVersion = useAppMetadataStore((state) => {
        void state.fileVersionsRev;
        return state.getFileVersion(filePath);
    });
    const fileTree = useProjectTabStore((s) => {
        const tab = s.openTabs.find((t) => t.id === s.activeTabId);
        return tab?.fileTree ?? null;
    });
    const projectPath = useProjectTabStore((s) => {
        const tab = s.openTabs.find((t) => t.id === s.activeTabId);
        return tab?.projectPath ?? null;
    });

    const invalidateCache = useCallback((id?: number) => {
        if (id === undefined) {
            for (const { url } of cacheRef.current.values()) URL.revokeObjectURL(url);
            cacheRef.current.clear();
            return;
        }
        const cached = cacheRef.current.get(id);
        if (cached) {
            URL.revokeObjectURL(cached.url);
            cacheRef.current.delete(id);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setInfo(null);
        setSelectedId(null);
        setPlayingId(null);
        setBankBytes(null);
        setIsDirty(false);
        undoStackRef.current = [];
        setUndoDepth(0);
        invalidateCache();
        setMappings(null);
        setMappingError(null);
        setBinLink({ kind: 'idle' });
        setHircSource({ kind: 'self' });
        setExpandedEvents(new Set());

        api.parseAudioBank(filePath)
            .then((result) => {
                if (!cancelled) setInfo(result);
            })
            .catch((err) => {
                if (!cancelled) setError((err as Error).message || String(err));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [filePath, fileVersion, invalidateCache]);

    useEffect(() => {
        if (!info || !fileTree || !projectPath || binLink.kind !== 'idle') return;

        const normProject = projectPath.replaceAll('\\', '/');
        const normBank = filePath.replaceAll('\\', '/');
        const relBank = normBank.startsWith(normProject)
            ? normBank.slice(normProject.length).replace(/^\/+/, '')
            : normBank;

        let resolvedHirc: HircSource;
        if (info.has_hirc) {
            resolvedHirc = { kind: 'self' };
        } else {
            const companion = findCompanionEventsBank(relBank, fileTree);
            if (companion) {
                const absPath = `${normProject}/${companion}`.replaceAll('/', '\\');
                resolvedHirc = { kind: 'external', path: absPath, source: 'auto' };
            } else {
                resolvedHirc = { kind: 'missing' };
            }
        }
        setHircSource(resolvedHirc);

        if (resolvedHirc.kind === 'missing') {
            setBinLink({ kind: 'none' });
            return;
        }

        const candidate = findBinCandidate(relBank, fileTree);
        if (candidate) {
            const absBinPath = `${normProject}/${candidate}`.replaceAll('/', '\\');
            void linkBinFile(absBinPath, 'auto', resolvedHirc);
        } else {
            setBinLink({ kind: 'none' });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [info, fileTree, projectPath, filePath]);

    const linkBinFile = useCallback(
        async (binPath: string, source: 'auto' | 'manual', hircOverride?: HircSource) => {
            const activeHirc = hircOverride ?? hircSource;
            if (activeHirc.kind === 'missing') {
                setMappingError(
                    'No HIRC section available — current bank has no events and no companion events BNK was found. Link an events BNK first.',
                );
                setBinLink({ kind: 'none' });
                return;
            }

            setBinLink({ kind: 'loading' });
            setMappingError(null);
            try {
                const hircPath = activeHirc.kind === 'external' ? activeHirc.path : filePath;
                const hircBytes =
                    activeHirc.kind === 'self' && bankBytes
                        ? bankBytes
                        : await api.readFileBytes(hircPath);
                const binBytes = await api.readFileBytes(binPath);

                const result = await api.mapAudioEvents(Array.from(binBytes), Array.from(hircBytes));
                setMappings(result);
                setBinLink({ kind: 'linked', path: binPath, source });
                if (result.length > 0) setViewMode('events');
            } catch (err) {
                const msg = (err as Error).message || String(err);
                setMappingError(msg);
                setBinLink({ kind: 'none' });
            }
        },
        [filePath, bankBytes, hircSource],
    );

    const handlePickBin = useCallback(async () => {
        const selected = await open({
            title: 'Link skin BIN file',
            filters: [
                { name: 'BIN files', extensions: ['bin'] },
                { name: 'All Files', extensions: ['*'] },
            ],
            multiple: false,
            directory: false,
        });
        if (!selected) return;
        await linkBinFile(selected as string, 'manual');
    }, [linkBinFile]);

    const handlePickEvents = useCallback(async () => {
        const selected = await open({
            title: 'Link events BNK file (HIRC source)',
            filters: [
                { name: 'Wwise Sound Banks', extensions: ['bnk'] },
                { name: 'All Files', extensions: ['*'] },
            ],
            multiple: false,
            directory: false,
        });
        if (!selected) return;
        const newHirc: HircSource = { kind: 'external', path: selected as string, source: 'manual' };
        setHircSource(newHirc);
        if (binLink.kind === 'linked') {
            await linkBinFile(binLink.path, binLink.source, newHirc);
        }
    }, [binLink, linkBinFile]);

    const handleUnlinkBin = useCallback(() => {
        setBinLink({ kind: 'none' });
        setMappings(null);
        setMappingError(null);
        setViewMode('flat');
    }, []);

    useEffect(() => {
        return () => {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.src = '';
            }
            invalidateCache();
        };
    }, [invalidateCache]);

    useEffect(() => {
        if (audioRef.current) audioRef.current.volume = volume;
    }, [volume]);

    useEffect(() => {
        if (!ctxMenu) return;
        const close = () => setCtxMenu(null);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setCtxMenu(null);
        };
        window.addEventListener('click', close);
        window.addEventListener('contextmenu', close);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('click', close);
            window.removeEventListener('contextmenu', close);
            window.removeEventListener('keydown', onKey);
        };
    }, [ctxMenu]);


    const ensureDecoded = useCallback(
        async (id: number): Promise<DecodedCacheEntry> => {
            const cached = cacheRef.current.get(id);
            if (cached) return cached;

            const wemBytes: Uint8Array = bankBytes
                ? await api.readAudioEntryBytes(bankBytes, id)
                : await api.readAudioEntry(filePath, id);
            const decoded = await api.decodeWem(wemBytes);
            const bytes = new Uint8Array(decoded.data);
            const mime = decoded.format === 'ogg' ? 'audio/ogg' : 'audio/wav';
            const blob = new Blob([bytes as BlobPart], { type: mime });
            const url = URL.createObjectURL(blob);
            const entry: DecodedCacheEntry = { url, format: decoded.format, bytes };
            cacheRef.current.set(id, entry);
            return entry;
        },
        [filePath, bankBytes],
    );

    const handlePlayToggle = useCallback(
        async (id: number) => {
            const audio = audioRef.current;
            if (!audio) return;

            if (playingId === id && !audio.paused) {
                audio.pause();
                return;
            }
            if (playingId === id && audio.paused) {
                audio.play().catch(() => {});
                return;
            }

            try {
                setDecodingId(id);
                const entry = await ensureDecoded(id);
                setDecodingId(null);
                audio.src = entry.url;
                audio.volume = volume;
                setPlayingId(id);
                setSelectedId(id);
                await audio.play();
            } catch (err) {
                setDecodingId(null);
                setError(`Failed to play WEM ${id}: ${(err as Error).message || err}`);
            }
        },
        [playingId, volume, ensureDecoded],
    );

    const handleStop = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
        }
        setPlayingId(null);
    }, []);

    const handleExtract = useCallback(
        async (entry: AudioEntryInfo, mode: 'wem' | 'decoded') => {
            try {
                let bytes: Uint8Array;
                let ext: string;
                if (mode === 'wem') {
                    bytes = bankBytes
                        ? await api.readAudioEntryBytes(bankBytes, entry.id)
                        : await api.readAudioEntry(filePath, entry.id);
                    ext = 'wem';
                } else {
                    const decoded = await ensureDecoded(entry.id);
                    bytes = decoded.bytes;
                    ext = decoded.format;
                }
                const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${entry.id}.${ext}`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (err) {
                setError(`Extract failed: ${(err as Error).message || err}`);
            }
        },
        [filePath, bankBytes, ensureDecoded],
    );

    const ensureEditableBytes = useCallback(async (): Promise<Uint8Array> => {
        if (bankBytes) return bankBytes;
        const bytes = await api.readFileBytes(filePath);
        setBankBytes(bytes);
        return bytes;
    }, [bankBytes, filePath]);

    const applyEdit = useCallback(
        async (id: number, producer: (curr: number[]) => Promise<number[]>) => {
            try {
                setBusyId(id);
                const curr = await ensureEditableBytes();
                const prevSnapshot = new Uint8Array(curr);
                const newArr = await producer(Array.from(curr));
                const newBytes = new Uint8Array(newArr);

                undoStackRef.current.push(prevSnapshot);
                setUndoDepth(undoStackRef.current.length);
                setBankBytes(newBytes);
                setIsDirty(true);
                invalidateCache(id);

                const refreshed = await api.parseAudioBankBytes(newBytes);
                setInfo(refreshed);
            } catch (err) {
                setError(`Edit failed: ${(err as Error).message || err}`);
            } finally {
                setBusyId(null);
            }
        },
        [ensureEditableBytes, invalidateCache],
    );

    const handleReplace = useCallback(
        async (entry: AudioEntryInfo) => {
            const selected = await open({
                title: `Replace WEM ${entry.id} with audio file`,
                filters: [
                    {
                        name: 'Audio',
                        extensions: ['wem', 'wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus'],
                    },
                    { name: 'All Files', extensions: ['*'] },
                ],
                multiple: false,
                directory: false,
            });
            if (!selected) return;

            const path = selected as string;
            try {
                const newBytes = await api.readFileBytes(path);

                // An actual wem is embedded verbatim — decoding and re-encoding
                // it would lose quality for nothing.
                if (isWwiseWem(newBytes)) {
                    await applyEdit(entry.id, async (curr) =>
                        api.replaceAudioEntry(curr, entry.id, Array.from(newBytes)),
                    );
                    return;
                }

                // Everything else goes through the cutter, so the trim, fades and
                // sample rate are chosen before it is encoded.
                const buffer = await decodeAudioFile(newBytes);
                setCutterModal({
                    entry,
                    source: { buffer, name: path.split(/[\\/]/).pop() || 'audio' },
                });
            } catch (err) {
                setError(`Replace failed: ${(err as Error).message || err}`);
            }
        },
        [applyEdit],
    );

    const handleSilence = useCallback(
        async (entry: AudioEntryInfo) => {
            await applyEdit(entry.id, async (curr) => api.silenceAudioEntry(curr, entry.id));
        },
        [applyEdit],
    );

    const handleUndo = useCallback(async () => {
        const prev = undoStackRef.current.pop();
        setUndoDepth(undoStackRef.current.length);
        if (!prev) return;
        setBankBytes(prev);
        setIsDirty(undoStackRef.current.length > 0);
        invalidateCache();
        try {
            const refreshed = await api.parseAudioBankBytes(prev);
            setInfo(refreshed);
        } catch (err) {
            setError(`Undo reparse failed: ${(err as Error).message || err}`);
        }
    }, [invalidateCache]);

    const handleSave = useCallback(async () => {
        if (!bankBytes || !isDirty) return;
        try {
            setSaving(true);
            await api.saveAudioFile(filePath, bankBytes);
            setIsDirty(false);
            undoStackRef.current = [];
            setUndoDepth(0);
        } catch (err) {
            setError(`Save failed: ${(err as Error).message || err}`);
        } finally {
            setSaving(false);
        }
    }, [filePath, bankBytes, isDirty]);

    const handleRemove = useCallback(
        async (entry: AudioEntryInfo) => {
            await applyEdit(entry.id, async (curr) => api.removeAudioEntry(curr, entry.id));
        },
        [applyEdit],
    );

    const handleCopyName = useCallback(async (entry: AudioEntryInfo, eventName?: string) => {
        try {
            const text = eventName ? `${eventName} (${entry.id}.wem)` : `${entry.id}.wem`;
            await navigator.clipboard.writeText(text);
        } catch (err) {
            setError(`Copy failed: ${(err as Error).message || err}`);
        }
    }, []);

    const handleApplyVolume = useCallback(async () => {
        if (!volumeModal) return;
        const { entry, gainDb } = volumeModal;
        if (Math.abs(gainDb) < 0.01) {
            setVolumeModal(null);
            return;
        }
        setVolumeModal((prev) => (prev ? { ...prev, busy: true } : null));
        try {
            const wemBytes = bankBytes
                ? await api.readAudioEntryBytes(bankBytes, entry.id)
                : await api.readAudioEntry(filePath, entry.id);
            const newWav = await applyGainToWem(wemBytes, gainDb);
            await applyEdit(entry.id, async (curr) =>
                api.replaceAudioEntry(curr, entry.id, Array.from(newWav)),
            );
            setVolumeModal(null);
        } catch (err) {
            setError(`Volume adjust failed: ${(err as Error).message || err}`);
            setVolumeModal((prev) => (prev ? { ...prev, busy: false } : null));
        }
    }, [volumeModal, bankBytes, filePath, applyEdit]);

    const { events, mappedIds } = useMemo(
        () => (mappings ? groupMappings(mappings) : { events: [], mappedIds: new Set<number>() }),
        [mappings],
    );

    const entriesById = useMemo(() => {
        const m = new Map<number, AudioEntryInfo>();
        if (info) for (const e of info.entries) m.set(e.id, e);
        return m;
    }, [info]);

    const filteredFlatEntries = useMemo(() => {
        if (!info) return [];
        const q = filter.trim().toLowerCase();
        if (!q) return info.entries;
        return info.entries.filter((e) => String(e.id).includes(q));
    }, [info, filter]);

    const filteredEvents = useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return events;
        return events.filter(
            (e) => e.name.toLowerCase().includes(q) || e.wemIds.some((id) => String(id).includes(q)),
        );
    }, [events, filter]);

    const unmappedEntries = useMemo(() => {
        if (!info) return [];
        return info.entries.filter((e) => !mappedIds.has(e.id));
    }, [info, mappedIds]);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement | null)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || volumeModal || ctxMenu || cutterModal) return;
            if (selectedId === null) return;
            const entry = entriesById.get(selectedId);
            if (!entry) return;

            if (e.code === 'Space') {
                e.preventDefault();
                handlePlayToggle(selectedId);
            } else if (e.key === 'Delete') {
                e.preventDefault();
                if (e.shiftKey) void handleRemove(entry);
                else void handleSilence(entry);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [selectedId, entriesById, volumeModal, ctxMenu, cutterModal, handlePlayToggle, handleSilence, handleRemove]);

    if (loading) {
        return (
            <div style={panelStyles.centered}>
                <div className="spinner" />
                <span style={{ marginTop: 8, color: 'var(--text-muted)' }}>Parsing audio bank...</span>
            </div>
        );
    }

    if (error && !info) {
        return (
            <div style={panelStyles.centered}>
                <span dangerouslySetInnerHTML={{ __html: getIcon('warning') }} />
                <span style={{ marginTop: 8, color: 'var(--text-error, #f87171)' }}>{error}</span>
            </div>
        );
    }

    if (!info) return null;

    const canUseEventView = mappings !== null && events.length > 0;

    const renderEntryRow = (entry: AudioEntryInfo, depth = 0, eventName?: string) => {
        const isPlaying = playingId === entry.id;
        const isDecoding = decodingId === entry.id;
        const isSelected = selectedId === entry.id;
        const isBusy = busyId === entry.id;
        const onRowContextMenu = (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setSelectedId(entry.id);
            setCtxMenu({ x: e.clientX, y: e.clientY, entry, eventName });
        };
        return (
            <tr
                key={`row-${entry.id}-${depth}`}
                style={{
                    ...panelStyles.tr,
                    background: isSelected ? 'var(--bg-hover, #2a2d35)' : 'transparent',
                }}
                onClick={() => setSelectedId(entry.id)}
                onDoubleClick={() => handlePlayToggle(entry.id)}
                onContextMenu={onRowContextMenu}
            >
                <td style={{ ...panelStyles.td, paddingLeft: 8 + depth * 14, paddingRight: 4, width: 64 }}>
                    <button
                        onClick={(e) => { e.stopPropagation(); handlePlayToggle(entry.id); }}
                        disabled={isDecoding || isBusy}
                        title={isPlaying ? 'Stop' : 'Play'}
                        style={{
                            ...panelStyles.playBtn,
                            color: isPlaying ? 'var(--accent-primary)' : 'var(--text-primary)',
                            opacity: isDecoding || isBusy ? 0.5 : 1,
                        }}
                    >
                        {isDecoding ? (
                            <div className="spinner" style={{ width: 10, height: 10 }} />
                        ) : (
                            <span>{isPlaying ? STOP_GLYPH : PLAY_GLYPH}</span>
                        )}
                    </button>
                </td>
                <td style={{ ...panelStyles.td, fontFamily: 'var(--font-mono, monospace)' }}>
                    {isBusy ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                            <div className="spinner" style={{ width: 10, height: 10 }} />
                            {entry.id}.wem
                        </span>
                    ) : (
                        <span>{entry.id}.wem</span>
                    )}
                </td>
                <td style={{ ...panelStyles.td, color: 'var(--text-muted)', textAlign: 'right' }}>{formatBytes(entry.size)}</td>
            </tr>
        );
    };

    const renderEventRow = (evt: EventGroup) => {
        const expanded = expandedEvents.has(evt.name);
        const toggle = () => {
            setExpandedEvents((prev) => {
                const next = new Set(prev);
                if (next.has(evt.name)) next.delete(evt.name);
                else next.add(evt.name);
                return next;
            });
        };
        return (
            <React.Fragment key={`evt-${evt.name}`}>
                <tr style={panelStyles.eventRow} onClick={toggle}>
                    <td style={{ ...panelStyles.td, paddingLeft: 12 }}>
                        <span
                            style={{
                                display: 'inline-block',
                                transition: 'transform 0.15s',
                                transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                                color: 'var(--text-muted)',
                            }}
                            dangerouslySetInnerHTML={{ __html: CARET_ICON }}
                        />
                    </td>
                    <td colSpan={2} style={{ ...panelStyles.td, fontWeight: 500 }}>
                        <span style={{ color: 'var(--accent-primary)' }}>{evt.name}</span>
                        <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 11 }}>
                            ({evt.wemIds.length} sound{evt.wemIds.length === 1 ? '' : 's'})
                        </span>
                    </td>
                </tr>
                {expanded &&
                    evt.wemIds.map((id) => {
                        const entry = entriesById.get(id);
                        if (!entry) {
                            return (
                                <tr key={`evt-${evt.name}-missing-${id}`} style={panelStyles.tr}>
                                    <td style={{ ...panelStyles.td, paddingLeft: 30 }} />
                                    <td style={panelStyles.td} colSpan={2}>
                                        <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                            {id}.wem — not present in this bank
                                        </span>
                                    </td>
                                </tr>
                            );
                        }
                        return renderEntryRow(entry, 1, evt.name);
                    })}
            </React.Fragment>
        );
    };

    return (
        <div style={panelStyles.root}>
            <div style={panelStyles.header}>
                <div style={panelStyles.summary}>
                    <span style={panelStyles.badge}>{info.format.toUpperCase()}</span>
                    <span style={panelStyles.metaItem}>
                        <span style={panelStyles.metaLabel}>Version:</span> {info.version}
                    </span>
                    <span style={panelStyles.metaItem}>
                        <span style={panelStyles.metaLabel}>Entries:</span>{' '}
                        {info.entry_count.toLocaleString()}
                    </span>
                    {info.has_hirc && (
                        <span style={{ ...panelStyles.badge, background: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' }}>
                            HIRC
                        </span>
                    )}
                    {isDirty && (
                        <span style={{ ...panelStyles.badge, background: 'rgba(251,146,60,0.2)', color: '#fb923c' }}>
                            ● Modified
                        </span>
                    )}
                </div>

                <div style={panelStyles.controls}>
                    <div style={panelStyles.modeGroup}>
                        <button
                            className={`btn btn--sm ${viewMode === 'flat' ? 'btn--active' : ''}`}
                            onClick={() => setViewMode('flat')}
                        >
                            Flat
                        </button>
                        <button
                            className={`btn btn--sm ${viewMode === 'events' ? 'btn--active' : ''}`}
                            onClick={() => setViewMode('events')}
                            disabled={!canUseEventView}
                            title={canUseEventView ? 'Group by event name' : 'Link a BIN file to enable events view'}
                        >
                            Events
                        </button>
                    </div>

                    <input
                        type="text"
                        placeholder="Filter..."
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        style={panelStyles.filterInput}
                    />
                    <div style={panelStyles.volumeWrap} title={`Volume: ${Math.round(volume * 100)}%`}>
                        <span dangerouslySetInnerHTML={{ __html: getIcon('audio') }} />
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={volume}
                            onChange={(e) => setVolume(Number(e.target.value))}
                            style={{ width: 80 }}
                        />
                    </div>
                    <button
                        className="btn btn--sm"
                        onClick={handleStop}
                        disabled={playingId === null}
                        title="Stop playback"
                    >
                        Stop
                    </button>
                </div>
            </div>

            <div style={panelStyles.binBar}>
                <div style={panelStyles.binStatus}>
                    <span style={panelStyles.sourceChip}>
                        <span style={panelStyles.sourceLabel}>Events:</span>
                        {hircSource.kind === 'self' && (
                            <span style={panelStyles.subtle}>(in current bank)</span>
                        )}
                        {hircSource.kind === 'external' && (
                            <>
                                <span style={panelStyles.binPath} title={hircSource.path}>
                                    {hircSource.path.split(/[\\/]/).pop()}
                                </span>
                                <span style={panelStyles.subtle}>({hircSource.source})</span>
                            </>
                        )}
                        {hircSource.kind === 'missing' && (
                            <span style={{ color: 'var(--text-warning, #fbbf24)' }}>missing</span>
                        )}
                    </span>

                    <span style={panelStyles.sourceSep}>·</span>

                    <span style={panelStyles.sourceChip}>
                        <span style={panelStyles.sourceLabel}>BIN:</span>
                        {binLink.kind === 'loading' && (
                            <>
                                <div className="spinner" style={{ width: 10, height: 10 }} />
                                <span>loading...</span>
                            </>
                        )}
                        {binLink.kind === 'linked' && (
                            <>
                                <span style={panelStyles.binPath} title={binLink.path}>
                                    {binLink.path.split(/[\\/]/).pop()}
                                </span>
                                <span style={panelStyles.subtle}>
                                    ({binLink.source}) — {events.length} events, {mappings?.length ?? 0} mappings
                                </span>
                            </>
                        )}
                        {binLink.kind === 'none' && <span style={panelStyles.subtle}>not linked</span>}
                        {binLink.kind === 'idle' && <span style={panelStyles.subtle}>searching...</span>}
                    </span>

                    {mappingError && (
                        <span style={{ color: 'var(--text-error, #f87171)' }}>— {mappingError}</span>
                    )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn--sm" onClick={handlePickEvents} title="Pick an events BNK to supply HIRC">
                        {hircSource.kind === 'external' ? 'Change Events...' : 'Link Events...'}
                    </button>
                    <button className="btn btn--sm" onClick={handlePickBin} disabled={binLink.kind === 'loading'}>
                        {binLink.kind === 'linked' ? 'Change BIN...' : 'Link BIN...'}
                    </button>
                    {binLink.kind === 'linked' && (
                        <button className="btn btn--sm btn--ghost" onClick={handleUnlinkBin}>
                            Unlink
                        </button>
                    )}
                </div>
            </div>

            <div style={panelStyles.editBar}>
                <div style={panelStyles.subtle}>
                    {isDirty
                        ? `${undoDepth} change${undoDepth === 1 ? '' : 's'} pending`
                        : 'No unsaved changes'}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                    <button
                        className="btn btn--sm"
                        onClick={handleUndo}
                        disabled={undoDepth === 0 || saving}
                        title="Undo last edit"
                    >
                        Undo
                    </button>
                    <button
                        className="btn btn--sm btn--primary"
                        onClick={handleSave}
                        disabled={!isDirty || saving}
                        title="Save to disk"
                    >
                        {saving ? 'Saving...' : 'Save'}
                    </button>
                </div>
            </div>

            {error && (
                <div style={panelStyles.errorBanner}>
                    <span>{error}</span>
                    <button className="btn btn--sm btn--ghost" onClick={() => setError(null)}>
                        Dismiss
                    </button>
                </div>
            )}

            <div style={panelStyles.listWrap}>
                <table style={panelStyles.table}>
                    <thead>
                        <tr>
                            <th style={{ ...panelStyles.th, width: 64 }}></th>
                            <th style={panelStyles.th}>
                                {viewMode === 'events' ? 'Event / WEM' : 'WEM ID'}
                            </th>
                            <th style={{ ...panelStyles.th, width: 96, textAlign: 'right' }}>Size</th>
                        </tr>
                    </thead>
                    <tbody>
                        {viewMode === 'flat' && filteredFlatEntries.length === 0 && (
                            <tr>
                                <td colSpan={3} style={panelStyles.empty}>
                                    {info.entries.length === 0
                                        ? 'No audio entries in this bank.'
                                        : 'No entries match filter.'}
                                </td>
                            </tr>
                        )}
                        {viewMode === 'flat' && filteredFlatEntries.map((entry) => renderEntryRow(entry))}

                        {viewMode === 'events' && filteredEvents.length === 0 && unmappedEntries.length === 0 && (
                            <tr>
                                <td colSpan={3} style={panelStyles.empty}>No events match filter.</td>
                            </tr>
                        )}
                        {viewMode === 'events' && filteredEvents.map((evt) => renderEventRow(evt))}

                        {viewMode === 'events' && unmappedEntries.length > 0 && !filter && (
                            <>
                                <tr style={panelStyles.sectionHeader}>
                                    <td colSpan={3} style={{ ...panelStyles.td, color: 'var(--text-muted)' }}>
                                        Unmapped WEMs ({unmappedEntries.length})
                                    </td>
                                </tr>
                                {unmappedEntries.map((entry) => renderEntryRow(entry))}
                            </>
                        )}
                    </tbody>
                </table>
            </div>

            <audio
                ref={audioRef}
                onEnded={() => setPlayingId(null)}
                onPause={() => {
                    if (audioRef.current && audioRef.current.ended) setPlayingId(null);
                }}
                style={{ display: 'none' }}
            />

            {ctxMenu && (
                <div
                    style={{
                        ...panelStyles.ctxMenu,
                        left: Math.min(ctxMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 220),
                        top: Math.min(ctxMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 9999) - 320),
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <CtxItem
                        label="Play audio"
                        icon={`<span style="font-size:11px">${PLAY_GLYPH}</span>`}
                        onClick={() => { handlePlayToggle(ctxMenu.entry.id); setCtxMenu(null); }}
                    />
                    <CtxDivider />
                    <CtxItem
                        label="Extract WEM"
                        icon={getIcon('download')}
                        onClick={() => { handleExtract(ctxMenu.entry, 'wem'); setCtxMenu(null); }}
                    />
                    <CtxItem
                        label="Extract OGG/WAV"
                        icon={getIcon('download')}
                        onClick={() => { handleExtract(ctxMenu.entry, 'decoded'); setCtxMenu(null); }}
                    />
                    <CtxDivider />
                    <CtxItem
                        label="Replace WEM data..."
                        onClick={() => { handleReplace(ctxMenu.entry); setCtxMenu(null); }}
                    />
                    <CtxItem
                        label="Make silent"
                        onClick={() => { handleSilence(ctxMenu.entry); setCtxMenu(null); }}
                    />
                    <CtxItem
                        label="Adjust volume..."
                        onClick={() => {
                            setVolumeModal({ entry: ctxMenu.entry, gainDb: 0, busy: false });
                            setCtxMenu(null);
                        }}
                    />
                    <CtxItem
                        label="Open in audio cutter..."
                        onClick={() => {
                            setCutterModal({ entry: ctxMenu.entry });
                            setCtxMenu(null);
                        }}
                    />
                    <CtxDivider />
                    <CtxItem
                        label="Remove from bank"
                        danger
                        onClick={() => { handleRemove(ctxMenu.entry); setCtxMenu(null); }}
                    />
                    <CtxDivider />
                    <CtxItem
                        label="Copy name"
                        onClick={() => { handleCopyName(ctxMenu.entry, ctxMenu.eventName); setCtxMenu(null); }}
                    />
                </div>
            )}

            {volumeModal && (
                <div
                    style={panelStyles.modalOverlay}
                    onMouseDown={(e) => {
                        overlayDownRef.current = e.target === e.currentTarget;
                    }}
                    onClick={(e) => {
                        if (!volumeModal.busy && overlayDownRef.current && e.target === e.currentTarget) {
                            setVolumeModal(null);
                        }
                        overlayDownRef.current = false;
                    }}
                >
                    <div style={panelStyles.modal} onClick={(e) => e.stopPropagation()}>
                        <div style={panelStyles.modalHeader}>
                            <span style={{ fontWeight: 600 }}>Adjust volume</span>
                            <span style={panelStyles.subtle}>WEM {volumeModal.entry.id}</span>
                        </div>
                        <div style={panelStyles.modalBody}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
                                <span>-24 dB</span>
                                <span style={{ color: 'var(--accent-primary)', fontWeight: 600, fontSize: 13 }}>
                                    {volumeModal.gainDb > 0 ? '+' : ''}{volumeModal.gainDb.toFixed(1)} dB
                                </span>
                                <span>+24 dB</span>
                            </div>
                            <input
                                type="range"
                                min={-24}
                                max={24}
                                step={0.5}
                                value={volumeModal.gainDb}
                                onChange={(e) =>
                                    setVolumeModal((prev) =>
                                        prev ? { ...prev, gainDb: Number(e.target.value) } : null,
                                    )
                                }
                                disabled={volumeModal.busy}
                                style={{ width: '100%' }}
                            />
                            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                                {[-6, -3, 0, 3, 6].map((v) => (
                                    <button
                                        key={v}
                                        className="btn btn--sm btn--ghost"
                                        onClick={() =>
                                            setVolumeModal((prev) =>
                                                prev ? { ...prev, gainDb: v } : null,
                                            )
                                        }
                                        disabled={volumeModal.busy}
                                    >
                                        {v > 0 ? `+${v}` : v} dB
                                    </button>
                                ))}
                            </div>
                            <div style={{ ...panelStyles.subtle, marginTop: 8, fontSize: 11 }}>
                                Applies gain via Web Audio, re-encodes as PCM WAV, and replaces the entry.
                                The original Vorbis encoding is not preserved.
                            </div>
                        </div>
                        <div style={panelStyles.modalFooter}>
                            <button
                                className="btn btn--sm btn--ghost"
                                onClick={() => setVolumeModal(null)}
                                disabled={volumeModal.busy}
                            >
                                Cancel
                            </button>
                            <button
                                className="btn btn--sm btn--primary"
                                onClick={handleApplyVolume}
                                disabled={volumeModal.busy}
                            >
                                {volumeModal.busy ? 'Applying...' : 'Apply'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {cutterModal && (
                <AudioCutterModal
                    entry={cutterModal.entry}
                    filePath={filePath}
                    bankBytes={bankBytes}
                    source={cutterModal.source}
                    onClose={() => setCutterModal(null)}
                    onApply={async (newWav) => {
                        const id = cutterModal.entry.id;
                        setCutterModal(null);
                        await applyEdit(id, async (curr) =>
                            api.replaceAudioEntry(curr, id, Array.from(newWav)),
                        );
                    }}
                />
            )}
        </div>
    );
};
