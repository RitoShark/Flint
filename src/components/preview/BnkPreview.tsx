/**
 * Flint - BNK / WPK Audio Bank Preview + Editor
 *
 * - Read-only: lists all WEM entries, decodes & plays via WebAudio
 * - Event tree: groups WEM IDs under human-readable event names from a linked skin BIN
 * - Edit mode: Replace (WAV/WEM) / Silence / Save / Undo operate on in-memory bank bytes
 *
 * Replacement accepts plain PCM WAV files directly — WEM is just RIFF, so a valid
 * WAV with wFormatTag=1 is a valid WEM payload (no Wwise SDK needed).
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import * as api from '../../lib/api';
import { getIcon } from '../../lib/fileIcons';
import { useAppMetadataStore, useProjectTabStore } from '../../lib/stores';
import type { AudioBankInfo, AudioEntryInfo, EventMapping, FileTreeNode } from '../../lib/types';
import { AudioCutterModal } from './AudioCutterModal';
import { applyGainToWem } from './audioUtils';

interface BnkPreviewProps {
    filePath: string;
}

type ViewMode = 'flat' | 'events';

type BinLinkState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'linked'; path: string; source: 'auto' | 'manual' }
    | { kind: 'none' };

/**
 * HIRC comes from either the current bank (if it already has HIRC) or a
 * companion events BNK (the common case in League: `*_audio.bnk` pairs with
 * `*_events.bnk` in the same folder).
 */
type HircSource =
    | { kind: 'self' }
    | { kind: 'external'; path: string; source: 'auto' | 'manual' }
    | { kind: 'missing' };

interface DecodedCacheEntry {
    url: string;
    format: 'ogg' | 'wav';
    bytes: Uint8Array;
}

interface EventGroup {
    name: string;
    /** Unique WEM IDs in mapping order (may include repeats from containers). */
    wemIds: number[];
}

// Unicode glyphs match the Audio Cutter modal toolbar ('▶ Play' / '■ Stop')
const PLAY_GLYPH = '▶';
const STOP_GLYPH = '■';
const CARET_ICON = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 2l4 3-4 3V2z" fill="currentColor"/></svg>`;

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Extract a `skinNN` token from a path, returning the numeric part (zero-padded preserved). */
function extractSkinToken(path: string): string | null {
    const m = /skin(\d+)/i.exec(path);
    return m ? m[1] : null;
}

/** Walk a FileTreeNode and collect all file paths matching a predicate. */
function walkTreeFiles(root: FileTreeNode | null, predicate: (path: string) => boolean): string[] {
    if (!root) return [];
    const out: string[] = [];
    const stack: FileTreeNode[] = [root];
    while (stack.length) {
        const node = stack.pop()!;
        if (!node.isDirectory && predicate(node.path)) {
            out.push(node.path);
        }
        if (node.children) stack.push(...node.children);
    }
    return out;
}

/**
 * Pick the most likely sibling skin BIN for a given BNK/WPK path.
 * Strategy: look for `.bin` files whose path contains the same `skinNN` token
 * as the bank file. Prefer paths that also contain `data/characters`. If multiple
 * remain, pick the shortest path (usually the canonical skin definition, not a
 * nested subvariant).
 */
function findBinCandidate(bankPath: string, fileTree: FileTreeNode | null): string | null {
    const bankSkin = extractSkinToken(bankPath);
    if (!bankSkin) return null;

    const allBins = walkTreeFiles(fileTree, (p) => /\.bin$/i.test(p));
    const skinRe = new RegExp(`skin0*${bankSkin}(?:\\b|[^0-9])`, 'i');
    const matchedSkin = allBins.filter((p) => skinRe.test(p));
    if (matchedSkin.length === 0) return null;

    const preferred = matchedSkin.filter((p) => /data[\\/]+characters/i.test(p));
    const pool = preferred.length ? preferred : matchedSkin;
    pool.sort((a, b) => a.length - b.length);
    return pool[0];
}

/**
 * Find a companion events BNK for the given audio bank.
 * League convention: `<stem>_audio.{bnk,wpk}` ↔ `<stem>_events.bnk` in the same folder.
 * Fallback: if the direct swap doesn't exist in the tree, look for any `*_events.bnk`
 * sharing the same `skinNN` token in the same directory branch.
 */
function findCompanionEventsBank(
    bankRelPath: string,
    fileTree: FileTreeNode | null,
): string | null {
    const norm = bankRelPath.replaceAll('\\', '/');
    const allBanks = walkTreeFiles(fileTree, (p) =>
        /_events\.bnk$/i.test(p.replaceAll('\\', '/')),
    );
    if (allBanks.length === 0) return null;

    // Direct swap: foo_audio.bnk → foo_events.bnk  (or .wpk → _events.bnk)
    const swapped = norm
        .replace(/_audio\.bnk$/i, '_events.bnk')
        .replace(/_audio\.wpk$/i, '_events.bnk');
    if (swapped !== norm) {
        const hit = allBanks.find((p) => p.replaceAll('\\', '/').toLowerCase() === swapped.toLowerCase());
        if (hit) return hit;
    }

    // Fallback: same folder + same skin token
    const dir = norm.slice(0, norm.lastIndexOf('/'));
    const skinTok = extractSkinToken(norm);
    const sameFolder = allBanks.filter((p) => p.replaceAll('\\', '/').startsWith(dir + '/'));
    if (sameFolder.length === 1) return sameFolder[0];
    if (skinTok) {
        const skinRe = new RegExp(`skin0*${skinTok}(?:\\b|[^0-9])`, 'i');
        const matches = sameFolder.filter((p) => skinRe.test(p));
        if (matches.length >= 1) {
            matches.sort((a, b) => a.length - b.length);
            return matches[0];
        }
    }
    return null;
}

/** Group event mappings by event name, preserving WEM-id order (deduped). */
function groupMappings(mappings: EventMapping[]): { events: EventGroup[]; mappedIds: Set<number> } {
    const byName = new Map<string, number[]>();
    const mappedIds = new Set<number>();
    for (const m of mappings) {
        mappedIds.add(m.wem_id);
        const arr = byName.get(m.event_name);
        if (arr) {
            if (!arr.includes(m.wem_id)) arr.push(m.wem_id);
        } else {
            byName.set(m.event_name, [m.wem_id]);
        }
    }
    const events: EventGroup[] = Array.from(byName.entries())
        .map(([name, wemIds]) => ({ name, wemIds }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return { events, mappedIds };
}

function isRiffWave(bytes: Uint8Array): boolean {
    if (bytes.length < 12) return false;
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const form = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    return magic === 'RIFF' && form === 'WAVE';
}

export const BnkPreview: React.FC<BnkPreviewProps> = ({ filePath }) => {
    // -------------------------------------------------------------------
    // Core bank state
    // -------------------------------------------------------------------
    const [info, setInfo] = useState<AudioBankInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState('');
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [playingId, setPlayingId] = useState<number | null>(null);
    const [decodingId, setDecodingId] = useState<number | null>(null);
    const [volume, setVolume] = useState(0.8);
    const [viewMode, setViewMode] = useState<ViewMode>('flat');

    // -------------------------------------------------------------------
    // Event-name mapping state
    // -------------------------------------------------------------------
    const [binLink, setBinLink] = useState<BinLinkState>({ kind: 'idle' });
    const [hircSource, setHircSource] = useState<HircSource>({ kind: 'self' });
    const [mappings, setMappings] = useState<EventMapping[] | null>(null);
    const [mappingError, setMappingError] = useState<string | null>(null);
    const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());

    // -------------------------------------------------------------------
    // Edit state
    // -------------------------------------------------------------------
    const [bankBytes, setBankBytes] = useState<Uint8Array | null>(null);
    const [isDirty, setIsDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [busyId, setBusyId] = useState<number | null>(null);
    const undoStackRef = useRef<Uint8Array[]>([]);
    // Tracks whether a click gesture started ON the modal overlay itself;
    // prevents drag-then-release-outside from accidentally closing modals.
    const overlayDownRef = useRef(false);
    const [undoDepth, setUndoDepth] = useState(0);

    // Context menu state
    const [ctxMenu, setCtxMenu] = useState<
        { x: number; y: number; entry: AudioEntryInfo; eventName?: string } | null
    >(null);

    // Volume-adjust modal state
    const [volumeModal, setVolumeModal] = useState<{ entry: AudioEntryInfo; gainDb: number; busy: boolean } | null>(
        null,
    );

    // Audio-cutter modal state
    const [cutterModal, setCutterModal] = useState<{ entry: AudioEntryInfo } | null>(null);

    // -------------------------------------------------------------------
    // Refs
    // -------------------------------------------------------------------
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const cacheRef = useRef<Map<number, DecodedCacheEntry>>(new Map());

    // -------------------------------------------------------------------
    // Store selectors
    // -------------------------------------------------------------------
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

    // -------------------------------------------------------------------
    // Decoded-audio cache invalidation
    // -------------------------------------------------------------------
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

    // -------------------------------------------------------------------
    // Initial & hot-reload parse
    // -------------------------------------------------------------------
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

    // -------------------------------------------------------------------
    // Auto-detect HIRC source (events BNK) + skin BIN once info + tree load
    // -------------------------------------------------------------------
    useEffect(() => {
        if (!info || !fileTree || !projectPath || binLink.kind !== 'idle') return;

        const normProject = projectPath.replaceAll('\\', '/');
        const normBank = filePath.replaceAll('\\', '/');
        const relBank = normBank.startsWith(normProject)
            ? normBank.slice(normProject.length).replace(/^\/+/, '')
            : normBank;

        // 1. Figure out where HIRC lives
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

        // 2. If we have a HIRC source, try to auto-link the skin BIN
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

    // -------------------------------------------------------------------
    // Link a BIN file (auto or manual) — reads bytes, parses events, maps
    // -------------------------------------------------------------------
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
                // If HIRC is from the current bank *and* we have modified bytes, prefer those
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
        // Re-run mapping if BIN is already linked
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

    // -------------------------------------------------------------------
    // Cleanup
    // -------------------------------------------------------------------
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

    // Close context menu on outside click / Escape
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


    // -------------------------------------------------------------------
    // Audio playback
    // -------------------------------------------------------------------
    const ensureDecoded = useCallback(
        async (id: number): Promise<DecodedCacheEntry> => {
            const cached = cacheRef.current.get(id);
            if (cached) return cached;

            let wemBytes: number[];
            if (bankBytes) {
                wemBytes = await api.readAudioEntryBytes(Array.from(bankBytes), id);
            } else {
                wemBytes = await api.readAudioEntry(filePath, id);
            }
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

    // -------------------------------------------------------------------
    // Extract (download)
    // -------------------------------------------------------------------
    const handleExtract = useCallback(
        async (entry: AudioEntryInfo, mode: 'wem' | 'decoded') => {
            try {
                let bytes: Uint8Array;
                let ext: string;
                if (mode === 'wem') {
                    const raw = bankBytes
                        ? await api.readAudioEntryBytes(Array.from(bankBytes), entry.id)
                        : await api.readAudioEntry(filePath, entry.id);
                    bytes = new Uint8Array(raw);
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

    // -------------------------------------------------------------------
    // Edit operations (replace / silence / save / undo)
    // -------------------------------------------------------------------
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
                const prevSnapshot = new Uint8Array(curr); // copy for undo
                const newArr = await producer(Array.from(curr));
                const newBytes = new Uint8Array(newArr);

                undoStackRef.current.push(prevSnapshot);
                setUndoDepth(undoStackRef.current.length);
                setBankBytes(newBytes);
                setIsDirty(true);
                invalidateCache(id);

                // Refresh entry list (sizes may have changed)
                const refreshed = await api.parseAudioBankBytes(Array.from(newBytes));
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
                    { name: 'Audio (WAV / WEM)', extensions: ['wav', 'wem'] },
                    { name: 'All Files', extensions: ['*'] },
                ],
                multiple: false,
                directory: false,
            });
            if (!selected) return;

            try {
                const newBytes = await api.readFileBytes(selected as string);
                if (!isRiffWave(newBytes)) {
                    setError(
                        'Unsupported file: expected a RIFF/WAVE container (.wav or .wem). ' +
                        'Convert MP3/OGG/FLAC to PCM WAV first (Audacity, ffmpeg, or any audio editor).',
                    );
                    return;
                }
                await applyEdit(entry.id, async (curr) =>
                    api.replaceAudioEntry(curr, entry.id, Array.from(newBytes)),
                );
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
            const refreshed = await api.parseAudioBankBytes(Array.from(prev));
            setInfo(refreshed);
        } catch (err) {
            setError(`Undo reparse failed: ${(err as Error).message || err}`);
        }
    }, [invalidateCache]);

    const handleSave = useCallback(async () => {
        if (!bankBytes || !isDirty) return;
        try {
            setSaving(true);
            await api.saveAudioFile(filePath, Array.from(bankBytes));
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
            // Get current WEM bytes
            const wemBytes = bankBytes
                ? new Uint8Array(await api.readAudioEntryBytes(Array.from(bankBytes), entry.id))
                : new Uint8Array(await api.readAudioEntry(filePath, entry.id));
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

    // -------------------------------------------------------------------
    // Derived data
    // -------------------------------------------------------------------
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

    // Keyboard shortcuts (scoped — ignored while typing in inputs / modals)
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

    // -------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------
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
            {/* Header */}
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

            {/* Sources bar — HIRC (events BNK) + skin BIN */}
            <div style={panelStyles.binBar}>
                <div style={panelStyles.binStatus}>
                    {/* HIRC source status */}
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

                    {/* BIN status */}
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

            {/* Edit toolbar */}
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

            {/* Entry list */}
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

            {/* Right-click context menu */}
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

            {/* Volume-adjust modal */}
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

            {/* Audio-cutter modal */}
            {cutterModal && (
                <AudioCutterModal
                    entry={cutterModal.entry}
                    filePath={filePath}
                    bankBytes={bankBytes}
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

// ---------------------------------------------------------------------------
// Context menu item components
// ---------------------------------------------------------------------------

const CtxItem: React.FC<{
    label: string;
    icon?: string;
    danger?: boolean;
    onClick: () => void;
    disabled?: boolean;
}> = ({ label, icon, danger, onClick, disabled }) => {
    const [hover, setHover] = useState(false);
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 12px',
                cursor: disabled ? 'default' : 'pointer',
                color: disabled
                    ? 'var(--text-muted)'
                    : danger
                    ? '#f87171'
                    : 'var(--text-primary)',
                background: hover && !disabled ? 'var(--bg-hover, #2a2d35)' : 'transparent',
                fontSize: 12,
                opacity: disabled ? 0.5 : 1,
                userSelect: 'none',
            }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            onClick={disabled ? undefined : onClick}
        >
            <span
                style={{ display: 'inline-flex', width: 14, justifyContent: 'center' }}
                dangerouslySetInnerHTML={icon ? { __html: icon } : undefined}
            />
            <span>{label}</span>
        </div>
    );
};

const CtxDivider: React.FC = () => (
    <div style={{ height: 1, margin: '4px 0', background: 'var(--border)' }} />
);

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

const panelStyles: Record<string, React.CSSProperties> = {
    root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        overflow: 'hidden',
    },
    centered: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 8,
    },
    header: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
    },
    summary: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    badge: {
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 4,
        background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)',
        color: 'var(--accent-primary)',
        letterSpacing: 0.5,
    },
    metaItem: { fontSize: 12, color: 'var(--text-primary)' },
    metaLabel: { color: 'var(--text-muted)', marginRight: 4 },
    controls: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    modeGroup: { display: 'flex', gap: 4 },
    filterInput: {
        width: 130,
        padding: '4px 8px',
        fontSize: 12,
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        outline: 'none',
    },
    volumeWrap: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' },
    binBar: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '6px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-tertiary, var(--bg-secondary))',
        fontSize: 12,
        gap: 8,
    },
    binStatus: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
    sourceChip: { display: 'inline-flex', alignItems: 'center', gap: 6 },
    sourceLabel: { color: 'var(--accent-primary)', fontWeight: 500 },
    sourceSep: { color: 'var(--text-muted)', margin: '0 2px' },
    binPath: {
        fontFamily: 'var(--font-mono, monospace)',
        color: 'var(--text-primary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: 240,
    },
    subtle: { color: 'var(--text-muted)', fontSize: 12 },
    editBar: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '6px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        fontSize: 12,
    },
    errorBanner: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '6px 12px',
        background: 'rgba(239,68,68,0.1)',
        color: 'var(--text-error, #f87171)',
        fontSize: 12,
        borderBottom: '1px solid var(--border)',
    },
    listWrap: { flex: 1, overflow: 'auto' },
    empty: {
        textAlign: 'center',
        padding: 40,
        color: 'var(--text-muted)',
        fontSize: 13,
    },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' },
    th: {
        textAlign: 'left',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        color: 'var(--text-muted)',
        fontWeight: 500,
        position: 'sticky',
        top: 0,
        background: 'var(--bg-secondary)',
        zIndex: 1,
    },
    tr: { cursor: 'pointer', transition: 'background 0.1s' },
    eventRow: {
        cursor: 'pointer',
        transition: 'background 0.1s',
        background: 'var(--bg-tertiary, rgba(255,255,255,0.02))',
    },
    sectionHeader: {
        background: 'var(--bg-tertiary, rgba(255,255,255,0.03))',
        textTransform: 'uppercase',
        fontSize: 10,
        letterSpacing: 1,
    },
    td: {
        padding: '6px 12px',
        borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.04))',
        verticalAlign: 'middle',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    playBtn: {
        width: 26,
        height: 26,
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        color: 'var(--text-primary)',
        fontSize: 11,
        lineHeight: 1,
    },
    ctxMenu: {
        position: 'fixed',
        minWidth: 200,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        padding: '4px 0',
        zIndex: 1000,
        fontSize: 12,
    },
    modalOverlay: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1001,
    },
    modal: {
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        minWidth: 360,
        maxWidth: 440,
        boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
    },
    modalHeader: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        fontSize: 13,
    },
    modalBody: {
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
    },
    modalFooter: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 8,
        padding: '10px 16px',
        borderTop: '1px solid var(--border)',
    },
};
