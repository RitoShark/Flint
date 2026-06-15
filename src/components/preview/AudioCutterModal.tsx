import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as api from '../../lib/api';
import type { AudioEntryInfo } from '../../lib/types';
import {
    audioBufferToWav,
    decodeWemToBuffer,
    sliceAudioBuffer,
    formatTime,
} from './audioUtils';

interface AudioCutterModalProps {
    entry: AudioEntryInfo;
    filePath: string;
    bankBytes: Uint8Array | null;
    onClose: () => void;
    onApply: (newWav: Uint8Array) => Promise<void>;
}

type DragKind = null | 'start' | 'end' | 'selection' | 'new' | 'pan' | 'cursor';

interface DragState {
    kind: Exclude<DragKind, null>;
    startClientX: number;
    startTime: number;
    origSel: { start: number; end: number };
    origScrollX: number;
    moved: boolean;
}

const HANDLE_HIT_PX = 8;
const RULER_HEIGHT = 22;
const WAVEFORM_HEIGHT = 220;
const MIN_ZOOM = 1;
const MAX_ZOOM = 200;

export const AudioCutterModal: React.FC<AudioCutterModalProps> = ({
    entry,
    filePath,
    bankBytes,
    onClose,
    onApply,
}) => {
    // -----------------------------------------------------------------------
    // Audio state
    // -----------------------------------------------------------------------
    const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [selection, setSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
    /** User anchor — set only by clicks/drags. Never modified by playback. */
    const [playhead, setPlayhead] = useState(0);
    /** Live position during playback — driven by rAF, only shown while playing. */
    const [playbackPos, setPlaybackPos] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [applying, setApplying] = useState(false);

    // -----------------------------------------------------------------------
    // View state
    // -----------------------------------------------------------------------
    const [zoom, setZoom] = useState(1);
    const [scrollT, setScrollT] = useState(0);   // time at left edge, seconds
    const [canvasSize, setCanvasSize] = useState({ w: 800, h: 180 });
    const [cursorStyle, setCursorStyle] = useState<string>('default');

    // -----------------------------------------------------------------------
    // Refs
    // -----------------------------------------------------------------------
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rulerCanvasRef = useRef<HTMLCanvasElement>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);
    const rafRef = useRef<number | null>(null);
    const playTrackerRef = useRef<{ ctxTime: number; offset: number; endAt: number } | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const peaksRef = useRef<{ min: Float32Array; max: Float32Array; pixels: number } | null>(null);

    const duration = buffer?.duration ?? 0;

    const selectionRef = useRef(selection);
    const playheadRef = useRef(playhead);
    const durationRef = useRef(duration);
    useEffect(() => { selectionRef.current = selection; }, [selection]);
    useEffect(() => { playheadRef.current = playhead; }, [playhead]);
    useEffect(() => { durationRef.current = duration; }, [duration]);

    // -----------------------------------------------------------------------
    // Derived layout — how one second maps to pixels, etc.
    // -----------------------------------------------------------------------
    const layout = useMemo(() => {
        const { w } = canvasSize;
        if (duration <= 0) {
            return { viewDuration: 1, pxPerSec: w, scrollT: 0, clampedScrollT: 0 };
        }
        const viewDuration = duration / zoom;
        const pxPerSec = w / viewDuration;
        const maxScroll = Math.max(0, duration - viewDuration);
        const clampedScrollT = Math.min(Math.max(scrollT, 0), maxScroll);
        return { viewDuration, pxPerSec, scrollT, clampedScrollT };
    }, [canvasSize, duration, zoom, scrollT]);

    const timeToX = useCallback(
        (t: number) => (t - layout.clampedScrollT) * layout.pxPerSec,
        [layout],
    );
    const xToTime = useCallback(
        (x: number) => x / layout.pxPerSec + layout.clampedScrollT,
        [layout],
    );

    // -----------------------------------------------------------------------
    // Load + decode
    // -----------------------------------------------------------------------
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const wemBytes = bankBytes
                    ? await api.readAudioEntryBytes(bankBytes, entry.id)
                    : await api.readAudioEntry(filePath, entry.id);
                const buf = await decodeWemToBuffer(wemBytes);
                if (cancelled) return;
                setBuffer(buf);
                setSelection({ start: 0, end: buf.duration });
                setPlayhead(0);
            } catch (err) {
                if (!cancelled) setLoadError((err as Error).message || String(err));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [entry.id, filePath, bankBytes]);

    useEffect(() => {
        peaksRef.current = null;
    }, [buffer, canvasSize.w, zoom, layout.clampedScrollT]);

    // -----------------------------------------------------------------------
    // Observe container size for responsive canvas
    // -----------------------------------------------------------------------
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const measure = () => {
            // clientWidth excludes border and scrollbars but INCLUDES padding,
            // so subtract the computed horizontal padding to get the actual
            // content box width that our canvases should occupy.
            const cs = getComputedStyle(el);
            const padL = parseFloat(cs.paddingLeft) || 0;
            const padR = parseFloat(cs.paddingRight) || 0;
            const w = Math.max(300, Math.floor(el.clientWidth - padL - padR));
            setCanvasSize({ w, h: WAVEFORM_HEIGHT });
        };
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        measure();
        return () => observer.disconnect();
    }, []);

    // -----------------------------------------------------------------------
    // Draw waveform, selection, handles, playhead
    // -----------------------------------------------------------------------
    useEffect(() => {
        if (!buffer) return;
        const canvas = canvasRef.current;
        if (!canvas) return;

        const { w, h } = canvasSize;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        ctx.fillStyle = 'rgba(255,255,255,0.02)';
        ctx.fillRect(0, 0, w, h);

        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();

        const accent =
            getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim() ||
            '#EF4444';

        const visibleStartFrame = Math.max(0, Math.floor(layout.clampedScrollT * buffer.sampleRate));
        const visibleEndFrame = Math.min(
            buffer.length,
            Math.ceil((layout.clampedScrollT + layout.viewDuration) * buffer.sampleRate),
        );
        const visibleFrames = visibleEndFrame - visibleStartFrame;
        if (visibleFrames <= 0) return;

        const ch0 = buffer.getChannelData(0);
        const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
        const samplesPerPixel = Math.max(1, visibleFrames / w);

        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.85;
        for (let x = 0; x < w; x++) {
            const from = visibleStartFrame + Math.floor(x * samplesPerPixel);
            const to = Math.min(
                buffer.length,
                visibleStartFrame + Math.floor((x + 1) * samplesPerPixel),
            );
            let mn = 1;
            let mx = -1;
            for (let i = from; i < to; i++) {
                const v = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
                if (v < mn) mn = v;
                if (v > mx) mx = v;
            }
            const y1 = (0.5 - mx / 2) * h;
            const y2 = (0.5 - mn / 2) * h;
            ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
        }
        ctx.globalAlpha = 1;

        const xStart = timeToX(selection.start);
        const xEnd = timeToX(selection.end);
        if (xEnd > 0 && xStart < w) {
            const ox = Math.max(0, xStart);
            const ow = Math.min(w, xEnd) - ox;
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            ctx.fillRect(ox, 0, ow, h);
        }

        drawHandle(ctx, xStart, h, w, accent, 'start');
        drawHandle(ctx, xEnd, h, w, accent, 'end');

        const pxAnchor = timeToX(playhead);
        if (pxAnchor >= 0 && pxAnchor <= w) {
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(pxAnchor + 0.5, 0);
            ctx.lineTo(pxAnchor + 0.5, h);
            ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.beginPath();
            ctx.moveTo(pxAnchor, 0);
            ctx.lineTo(pxAnchor + 9, 0);
            ctx.lineTo(pxAnchor, 7);
            ctx.closePath();
            ctx.fill();
        }

        if (isPlaying) {
            const pxLive = timeToX(playbackPos);
            if (pxLive >= 0 && pxLive <= w) {
                ctx.strokeStyle = 'var(--accent-primary)';
                const accent2 =
                    getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim() ||
                    '#EF4444';
                ctx.strokeStyle = accent2;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(pxLive + 0.5, 0);
                ctx.lineTo(pxLive + 0.5, h);
                ctx.stroke();
            }
        }
    }, [buffer, selection, playhead, playbackPos, isPlaying, canvasSize, layout, timeToX]);

    // -----------------------------------------------------------------------
    // Draw ruler (time ticks)
    // -----------------------------------------------------------------------
    useEffect(() => {
        const ruler = rulerCanvasRef.current;
        if (!ruler || !buffer) return;
        const { w } = canvasSize;
        const dpr = window.devicePixelRatio || 1;
        ruler.width = Math.floor(w * dpr);
        ruler.height = Math.floor(RULER_HEIGHT * dpr);
        ruler.style.width = `${w}px`;
        ruler.style.height = `${RULER_HEIGHT}px`;

        const ctx = ruler.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, RULER_HEIGHT);
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(0, 0, w, RULER_HEIGHT);

        const targetPx = 80;
        const targetSec = targetPx / layout.pxPerSec;
        const intervals = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
        const interval = intervals.find((v) => v >= targetSec) ?? 60;

        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '10px var(--font-mono, monospace)';
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';

        const firstTick = Math.ceil(layout.clampedScrollT / interval) * interval;
        for (let t = firstTick; t <= layout.clampedScrollT + layout.viewDuration + 0.0001; t += interval) {
            const x = timeToX(t);
            if (x < 0 || x > w) continue;
            ctx.beginPath();
            ctx.moveTo(x + 0.5, RULER_HEIGHT - 6);
            ctx.lineTo(x + 0.5, RULER_HEIGHT);
            ctx.stroke();
            ctx.fillText(formatTickLabel(t, interval), x + 3, RULER_HEIGHT - 8);
        }
    }, [buffer, canvasSize, layout, timeToX]);

    // -----------------------------------------------------------------------
    // Hit testing for cursor + drag
    // -----------------------------------------------------------------------
    const hitTest = useCallback(
        (x: number): DragKind => {
            if (!buffer) return null;
            const xStart = timeToX(selection.start);
            const xEnd = timeToX(selection.end);
            const xHead = timeToX(playhead);
            if (Math.abs(x - xStart) <= HANDLE_HIT_PX) return 'start';
            if (Math.abs(x - xEnd) <= HANDLE_HIT_PX) return 'end';
            if (Math.abs(x - xHead) <= 6) return 'cursor';
            if (x > xStart && x < xEnd) return 'selection';
            return 'new';
        },
        [buffer, selection, playhead, timeToX],
    );

    // -----------------------------------------------------------------------
    // Mouse handlers
    // -----------------------------------------------------------------------
    const onCanvasMouseMove = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            const canvas = canvasRef.current;
            if (!canvas || !buffer) return;
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const kind = hitTest(x);
            if (kind === 'start' || kind === 'end' || kind === 'cursor') setCursorStyle('ew-resize');
            else if (kind === 'selection') setCursorStyle('grab');
            else setCursorStyle('crosshair');
        },
        [buffer, hitTest],
    );

    const beginDrag = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            const canvas = canvasRef.current;
            if (!canvas || !buffer) return;
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const startT = xToTime(x);

            let kind: Exclude<DragKind, null> = hitTest(x) as Exclude<DragKind, null>;
            if (e.button === 1 || (e.button === 0 && e.altKey)) {
                kind = 'pan';
            }

            if (kind !== 'pan' && sourceRef.current) {
                stopPlayback();
            }

            dragRef.current = {
                kind,
                startClientX: e.clientX,
                startTime: startT,
                origSel: selection,
                origScrollX: layout.clampedScrollT,
                moved: false,
            };
            setCursorStyle(
                kind === 'selection' || kind === 'pan'
                    ? 'grabbing'
                    : kind === 'new'
                    ? 'crosshair'
                    : 'ew-resize',
            );
            e.preventDefault();
        },
        [buffer, selection, hitTest, xToTime, layout.clampedScrollT],
    );

    useEffect(() => {
        const CLICK_THRESHOLD = 6;
        const onMove = (e: MouseEvent) => {
            const drag = dragRef.current;
            if (!drag || !buffer) return;
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const t = xToTime(x);
            const moved = Math.abs(e.clientX - drag.startClientX) > CLICK_THRESHOLD;
            if (moved) drag.moved = true;

            if (drag.kind === 'start') {
                const newStart = Math.min(Math.max(t, 0), drag.origSel.end - 0.005);
                setSelection({ start: newStart, end: drag.origSel.end });
            } else if (drag.kind === 'end') {
                const newEnd = Math.max(Math.min(t, duration), drag.origSel.start + 0.005);
                setSelection({ start: drag.origSel.start, end: newEnd });
            } else if (drag.kind === 'cursor') {
                setPlayhead(Math.max(0, Math.min(duration, t)));
            } else if (drag.kind === 'new') {
                if (!drag.moved) return;
                const a = Math.min(drag.startTime, t);
                const b = Math.max(drag.startTime, t);
                setSelection({
                    start: Math.max(0, a),
                    end: Math.min(duration, b),
                });
            } else if (drag.kind === 'selection') {
                const delta = t - drag.startTime;
                const len = drag.origSel.end - drag.origSel.start;
                let newStart = drag.origSel.start + delta;
                newStart = Math.min(Math.max(newStart, 0), duration - len);
                setSelection({ start: newStart, end: newStart + len });
            } else if (drag.kind === 'pan') {
                const dtPx = e.clientX - drag.startClientX;
                const dtSec = -dtPx / layout.pxPerSec;
                setScrollT(drag.origScrollX + dtSec);
            }
        };
        const onUp = () => {
            const drag = dragRef.current;
            if (!drag) return;
            if ((drag.kind === 'new' || drag.kind === 'selection' || drag.kind === 'cursor') && !drag.moved) {
                const t = Math.max(0, Math.min(duration, drag.startTime));
                setPlayhead(t);
            }
            dragRef.current = null;
            setCursorStyle('default');
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [buffer, duration, xToTime, layout.pxPerSec]);

    // -----------------------------------------------------------------------
    // Wheel: Ctrl = zoom, otherwise pan
    // -----------------------------------------------------------------------
    const onWheel = useCallback(
        (e: React.WheelEvent<HTMLCanvasElement>) => {
            if (!buffer) return;
            e.preventDefault();
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;

            if (e.ctrlKey || e.metaKey) {
                const factor = e.deltaY > 0 ? 1 / 1.15 : 1.15;
                const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
                const tUnder = xToTime(x);
                setZoom(newZoom);
                const newViewDuration = duration / newZoom;
                const newPxPerSec = canvasSize.w / newViewDuration;
                const newScroll = tUnder - x / newPxPerSec;
                const maxScroll = Math.max(0, duration - newViewDuration);
                setScrollT(Math.min(Math.max(newScroll, 0), maxScroll));
            } else {
                const delta = (e.deltaY + e.deltaX) / layout.pxPerSec;
                const maxScroll = Math.max(0, duration - layout.viewDuration);
                setScrollT((prev) => Math.min(Math.max(prev + delta, 0), maxScroll));
            }
        },
        [buffer, zoom, xToTime, canvasSize.w, duration, layout.pxPerSec, layout.viewDuration],
    );

    // -----------------------------------------------------------------------
    // Playback
    // -----------------------------------------------------------------------
    const stopPlayback = useCallback(() => {
        try {
            sourceRef.current?.stop();
        } catch {}
        sourceRef.current?.disconnect();
        sourceRef.current = null;
        audioCtxRef.current?.close().catch(() => {});
        audioCtxRef.current = null;
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        playTrackerRef.current = null;
        setIsPlaying(false);
    }, []);

    const startPlayback = useCallback(
        (from: number, to: number) => {
            if (!buffer) return;
            stopPlayback();
            const start = Math.max(0, Math.min(from, duration - 0.01));
            const end = Math.min(duration, Math.max(to, start + 0.01));

            const ctx = new AudioContext();
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(ctx.destination);
            src.onended = () => {
                stopPlayback();
            };
            src.start(0, start, end - start);

            audioCtxRef.current = ctx;
            sourceRef.current = src;
            playTrackerRef.current = {
                ctxTime: ctx.currentTime,
                offset: start,
                endAt: end,
            };
            setIsPlaying(true);
            setPlaybackPos(start);

            const tick = () => {
                const tracker = playTrackerRef.current;
                const c = audioCtxRef.current;
                if (!tracker || !c) return;
                const elapsed = c.currentTime - tracker.ctxTime;
                const t = tracker.offset + elapsed;
                if (t >= tracker.endAt) {
                    stopPlayback();
                    return;
                }
                setPlaybackPos(t);
                rafRef.current = requestAnimationFrame(tick);
            };
            rafRef.current = requestAnimationFrame(tick);
        },
        [buffer, duration, stopPlayback],
    );

    useEffect(() => () => stopPlayback(), [stopPlayback]);

    // -----------------------------------------------------------------------
    // Toolbar actions — resolve playback ranges from the current ref values
    // so they're stable callbacks (don't go stale between renders).
    // -----------------------------------------------------------------------
    const isActuallyPlaying = () => sourceRef.current !== null;

    /** "Play all" — plays from the playhead to the end. Wraps to 0 if at end. */
    const playAll = useCallback(() => {
        const d = durationRef.current;
        const p = playheadRef.current;
        const from = p >= d - 0.01 ? 0 : p;
        startPlayback(from, d);
    }, [startPlayback]);

    /**
     * "Play selection" — if the playhead sits inside the selection, start
     * from the playhead; otherwise play from the selection start.
     */
    const playSelection = useCallback(() => {
        const sel = selectionRef.current;
        const p = playheadRef.current;
        const from = p >= sel.start && p < sel.end - 0.01 ? p : sel.start;
        startPlayback(from, sel.end);
    }, [startPlayback]);

    const toggleSpace = useCallback(() => {
        if (isActuallyPlaying()) stopPlayback();
        else {
            const sel = selectionRef.current;
            if (sel.end - sel.start > 0.01) playSelection();
            else playAll();
        }
    }, [stopPlayback, playSelection, playAll]);

    const toggleShiftSpace = useCallback(() => {
        if (isActuallyPlaying()) stopPlayback();
        else playAll();
    }, [stopPlayback, playAll]);

    // -----------------------------------------------------------------------
    // Keyboard
    // -----------------------------------------------------------------------
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement | null)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (e.key === 'Escape') {
                e.preventDefault();
                if (!applying) onClose();
            } else if (e.code === 'Space') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                if (document.activeElement && document.activeElement !== document.body) {
                    (document.activeElement as HTMLElement).blur();
                }
                if (e.shiftKey) toggleShiftSpace();
                else toggleSpace();
            } else if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                setZoom((z) => Math.min(MAX_ZOOM, z * 1.5));
            } else if (e.key === '-' || e.key === '_') {
                e.preventDefault();
                setZoom((z) => Math.max(MIN_ZOOM, z / 1.5));
            } else if (e.key === '0') {
                e.preventDefault();
                setZoom(1);
                setScrollT(0);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [toggleSpace, toggleShiftSpace, applying, onClose]);
    const zoomIn = () => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5));
    const zoomOut = () => setZoom((z) => Math.max(MIN_ZOOM, z / 1.5));
    const resetZoom = () => {
        setZoom(1);
        setScrollT(0);
    };
    const fitSelection = () => {
        if (!buffer) return;
        const len = selection.end - selection.start;
        if (len <= 0) return;
        const pad = len * 0.1;
        const newView = Math.max(0.05, len + pad * 2);
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, duration / newView));
        const center = (selection.start + selection.end) / 2;
        const newScroll = Math.max(0, Math.min(duration - newView, center - newView / 2));
        setZoom(newZoom);
        setScrollT(newScroll);
    };
    const selectAll = () => setSelection({ start: 0, end: duration });

    const handleApply = useCallback(async () => {
        if (!buffer) return;
        setApplying(true);
        try {
            stopPlayback();
            const sliced = sliceAudioBuffer(buffer, selection.start, selection.end);
            const wav = audioBufferToWav(sliced);
            await onApply(wav);
        } finally {
            setApplying(false);
        }
    }, [buffer, selection, onApply, stopPlayback]);

    // -----------------------------------------------------------------------
    // Zoom scrollbar (Premiere-style: thumb represents view, drag edges to zoom)
    // -----------------------------------------------------------------------
    const scrollbar = useMemo(() => {
        if (!buffer || duration <= 0) {
            return { thumbW: canvasSize.w, thumbX: 0, trackW: canvasSize.w };
        }
        const thumbW = Math.max(24, (layout.viewDuration / duration) * canvasSize.w);
        const thumbX = (layout.clampedScrollT / duration) * canvasSize.w;
        return { thumbW, thumbX, trackW: canvasSize.w };
    }, [buffer, duration, layout, canvasSize.w]);

    const SB_EDGE_HIT = 8;

    const scrollbarHitTest = (x: number): 'left' | 'right' | 'middle' | 'track' => {
        const { thumbX, thumbW } = scrollbar;
        const leftEdge = thumbX;
        const rightEdge = thumbX + thumbW;
        if (Math.abs(x - leftEdge) <= SB_EDGE_HIT) return 'left';
        if (Math.abs(x - rightEdge) <= SB_EDGE_HIT) return 'right';
        if (x >= thumbX && x <= rightEdge) return 'middle';
        return 'track';
    };

    const [sbCursor, setSbCursor] = useState<string>('default');

    const onScrollbarMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!buffer || duration <= 0) return;
        const track = e.currentTarget;
        const rect = track.getBoundingClientRect();
        const startX = e.clientX - rect.left;
        const origThumbX = scrollbar.thumbX;
        const origThumbW = scrollbar.thumbW;
        const trackW = rect.width;
        const mode = scrollbarHitTest(startX);

        if (mode === 'track') {
            const targetX = Math.max(0, Math.min(trackW - origThumbW, startX - origThumbW / 2));
            const ratio = trackW - origThumbW > 0 ? targetX / (trackW - origThumbW) : 0;
            setScrollT(ratio * Math.max(0, duration - layout.viewDuration));
        }

        const dragMode: 'left' | 'right' | 'middle' =
            mode === 'track' ? 'middle' : mode;

        const onMove = (ev: MouseEvent) => {
            const x = Math.max(0, Math.min(trackW, ev.clientX - rect.left));
            if (dragMode === 'middle') {
                let newX = origThumbX + (x - startX);
                newX = Math.max(0, Math.min(trackW - origThumbW, newX));
                const maxScroll = Math.max(0, duration - (origThumbW / trackW) * duration);
                const ratio = trackW - origThumbW > 0 ? newX / (trackW - origThumbW) : 0;
                setScrollT(ratio * maxScroll);
            } else if (dragMode === 'left') {
                const minLeft = 0;
                const maxLeft = origThumbX + origThumbW - 24;
                const newLeft = Math.max(minLeft, Math.min(maxLeft, x));
                const newRight = origThumbX + origThumbW;
                const newW = newRight - newLeft;
                const newView = (newW / trackW) * duration;
                const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, duration / newView));
                const newScroll = (newLeft / trackW) * duration;
                setZoom(newZoom);
                setScrollT(newScroll);
            } else if (dragMode === 'right') {
                const origLeft = origThumbX;
                const minRight = origLeft + 24;
                const maxRight = trackW;
                const newRight = Math.max(minRight, Math.min(maxRight, x));
                const newW = newRight - origLeft;
                const newView = (newW / trackW) * duration;
                const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, duration / newView));
                setZoom(newZoom);
            }
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            setSbCursor('default');
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        setSbCursor(dragMode === 'middle' ? 'grabbing' : 'ew-resize');
        e.preventDefault();
    };

    const onScrollbarMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const m = scrollbarHitTest(x);
        if (m === 'left' || m === 'right') setSbCursor('ew-resize');
        else if (m === 'middle') setSbCursor('grab');
        else setSbCursor('pointer');
    };

    const onScrollbarDoubleClick = () => {
        setZoom(1);
        setScrollT(0);
    };

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------
    const overlayDownRef = useRef(false);

    return (
        <div
            style={styles.overlay}
            onMouseDown={(e) => {
                overlayDownRef.current = e.target === e.currentTarget;
            }}
            onClick={(e) => {
                if (!applying && overlayDownRef.current && e.target === e.currentTarget) {
                    onClose();
                }
                overlayDownRef.current = false;
            }}
        >
            <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
                <div style={styles.header}>
                    <span style={{ fontWeight: 600 }}>Audio cutter</span>
                    <span style={styles.subtle}>
                        WEM {entry.id} · {duration > 0 ? formatTime(duration) : '—'}
                    </span>
                </div>

                {loadError && (
                    <div style={styles.errorBar}>Failed to decode: {loadError}</div>
                )}

                <div style={styles.toolbar}>
                    <button
                        className="btn btn--sm"
                        onClick={(e) => { e.currentTarget.blur(); toggleShiftSpace(); }}
                        disabled={!buffer || applying}
                        title="Shift+Space — play whole file"
                    >
                        {isPlaying ? '■ Stop' : '▶ Play all'}
                    </button>
                    <button
                        className="btn btn--sm"
                        onClick={(e) => { e.currentTarget.blur(); toggleSpace(); }}
                        disabled={!buffer || applying || selection.end <= selection.start + 0.001}
                        title="Space — play selection (from playhead if inside)"
                    >
                        ▶ Play selection
                    </button>

                    <span style={styles.toolbarSep} />

                    <button className="btn btn--sm btn--ghost" onClick={zoomOut} disabled={!buffer || zoom <= MIN_ZOOM} title="-">
                        −
                    </button>
                    <span style={styles.zoomLabel}>{zoom.toFixed(1)}×</span>
                    <button className="btn btn--sm btn--ghost" onClick={zoomIn} disabled={!buffer || zoom >= MAX_ZOOM} title="+">
                        +
                    </button>
                    <button className="btn btn--sm btn--ghost" onClick={resetZoom} disabled={!buffer} title="0">
                        Reset
                    </button>
                    <button className="btn btn--sm btn--ghost" onClick={fitSelection} disabled={!buffer}>
                        Fit selection
                    </button>

                    <span style={styles.toolbarSep} />

                    <button className="btn btn--sm btn--ghost" onClick={selectAll} disabled={!buffer}>
                        Select all
                    </button>
                </div>

                <div ref={containerRef} style={styles.canvasWrap}>
                    {!buffer && !loadError && (
                        <div style={styles.loading}>
                            <div className="spinner" />
                            <span>Decoding audio...</span>
                        </div>
                    )}
                    {buffer && (
                        <>
                            <canvas ref={rulerCanvasRef} style={{ display: 'block' }} />
                            <div style={{ position: 'relative', height: WAVEFORM_HEIGHT }}>
                                <canvas
                                    ref={canvasRef}
                                    style={{
                                        display: 'block',
                                        cursor: cursorStyle,
                                        userSelect: 'none',
                                        position: 'absolute',
                                        inset: 0,
                                    }}
                                    onMouseDown={beginDrag}
                                    onMouseMove={onCanvasMouseMove}
                                    onWheel={onWheel}
                                    onDoubleClick={selectAll}
                                />
                            </div>
                            <div
                                style={{ ...styles.scrollbarTrack, cursor: sbCursor }}
                                onMouseDown={onScrollbarMouseDown}
                                onMouseMove={onScrollbarMouseMove}
                                onDoubleClick={onScrollbarDoubleClick}
                                title="Drag to pan · Drag edges to zoom · Double-click to reset"
                            >
                                <div
                                    style={{
                                        ...styles.scrollbarThumb,
                                        width: scrollbar.thumbW,
                                        left: scrollbar.thumbX,
                                    }}
                                >
                                    <div style={styles.scrollbarEdgeLeft} />
                                    <div style={styles.scrollbarEdgeRight} />
                                </div>
                            </div>
                        </>
                    )}
                </div>

                <div style={styles.infoRow}>
                    <div style={styles.subtle}>
                        Click or drag the white line to move playhead · Drag elsewhere to select · Drag red bars to adjust selection · Space = play selection · Shift+Space = play all
                    </div>
                </div>

                <div style={styles.timeRow}>
                    <TimeField
                        label="Start"
                        value={selection.start}
                        max={duration}
                        onChange={(v) =>
                            setSelection((s) => ({ start: Math.min(v, s.end - 0.01), end: s.end }))
                        }
                    />
                    <TimeField
                        label="End"
                        value={selection.end}
                        max={duration}
                        onChange={(v) =>
                            setSelection((s) => ({ start: s.start, end: Math.max(v, s.start + 0.01) }))
                        }
                    />
                    <TimeField
                        label="Length"
                        value={selection.end - selection.start}
                        max={duration}
                        readOnly
                    />
                </div>

                <div style={styles.footer}>
                    <button className="btn btn--sm btn--ghost" onClick={onClose} disabled={applying}>
                        Cancel
                    </button>
                    <button
                        className="btn btn--sm btn--primary"
                        onClick={handleApply}
                        disabled={!buffer || applying || selection.end <= selection.start + 0.001}
                        title="Replace this WEM with the selected range"
                    >
                        {applying ? 'Applying...' : 'Apply trim'}
                    </button>
                </div>
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function drawHandle(
    ctx: CanvasRenderingContext2D,
    x: number,
    h: number,
    w: number,
    accent: string,
    _kind: 'start' | 'end',
) {
    ctx.save();
    const gripX = Math.max(3, Math.min(w - 3, x));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(gripX + 0.5, 0);
    ctx.lineTo(gripX + 0.5, h);
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.fillRect(gripX - 3, 0, 6, 10);
    ctx.fillRect(gripX - 3, h - 10, 6, 10);
    ctx.restore();
}

function formatTickLabel(t: number, interval: number): string {
    if (interval < 0.1) return t.toFixed(2) + 's';
    if (interval < 1) return t.toFixed(1) + 's';
    if (t < 60) return t.toFixed(0) + 's';
    return formatTime(t);
}

// ---------------------------------------------------------------------------
// Time input field
// ---------------------------------------------------------------------------

const TimeField: React.FC<{
    label: string;
    value: number;
    max: number;
    readOnly?: boolean;
    onChange?: (v: number) => void;
}> = ({ label, value, max, readOnly, onChange }) => {
    const [text, setText] = useState(value.toFixed(3));
    useEffect(() => {
        setText(value.toFixed(3));
    }, [value]);
    const commit = () => {
        if (readOnly || !onChange) return;
        const n = Number(text);
        if (!isNaN(n)) onChange(Math.max(0, Math.min(max, n)));
        else setText(value.toFixed(3));
    };
    return (
        <label style={styles.timeField}>
            <span style={styles.timeLabel}>{label}</span>
            <input
                type="number"
                step={0.01}
                min={0}
                max={max}
                value={text}
                readOnly={readOnly}
                onChange={(e) => setText(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                    }
                }}
                style={{
                    ...styles.timeInput,
                    opacity: readOnly ? 0.7 : 1,
                }}
            />
            <span style={styles.timeSuffix}>s</span>
        </label>
    );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
    overlay: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1001,
    },
    modal: {
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        width: 860,
        maxWidth: 'calc(100vw - 40px)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '14px 18px',
        borderBottom: '1px solid var(--border)',
    },
    subtle: { color: 'var(--text-muted)', fontSize: 12 },
    errorBar: {
        padding: '8px 16px',
        color: '#f87171',
        fontSize: 12,
        background: 'rgba(239,68,68,0.1)',
        borderBottom: '1px solid var(--border)',
    },
    toolbar: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        flexWrap: 'wrap',
    },
    toolbarSep: {
        width: 1,
        height: 18,
        background: 'var(--border)',
        margin: '0 6px',
    },
    zoomLabel: {
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 11,
        color: 'var(--text-muted)',
        minWidth: 40,
        textAlign: 'center',
    },
    canvasWrap: {
        position: 'relative',
        padding: '8px 16px',
        background: 'rgba(0,0,0,0.15)',
    },
    loading: {
        height: WAVEFORM_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        color: 'var(--text-muted)',
        fontSize: 12,
    },
    scrollbarTrack: {
        position: 'relative',
        height: 16,
        marginTop: 8,
        background: 'rgba(255,255,255,0.05)',
        borderRadius: 4,
        userSelect: 'none',
    },
    scrollbarThumb: {
        position: 'absolute',
        top: 1,
        bottom: 1,
        background: 'color-mix(in srgb, var(--accent-primary) 55%, transparent)',
        border: '1px solid color-mix(in srgb, var(--accent-primary) 80%, transparent)',
        borderRadius: 4,
        boxSizing: 'border-box',
    },
    scrollbarEdgeLeft: {
        position: 'absolute',
        top: -2,
        bottom: -2,
        left: -1,
        width: 5,
        background: 'var(--accent-primary)',
        borderRadius: 2,
        opacity: 0.9,
    },
    scrollbarEdgeRight: {
        position: 'absolute',
        top: -2,
        bottom: -2,
        right: -1,
        width: 5,
        background: 'var(--accent-primary)',
        borderRadius: 2,
        opacity: 0.9,
    },
    infoRow: {
        padding: '8px 16px',
        borderTop: '1px solid var(--border)',
    },
    timeRow: {
        display: 'flex',
        gap: 14,
        padding: '10px 16px',
        borderTop: '1px solid var(--border)',
        flexWrap: 'wrap',
    },
    timeField: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
    },
    timeLabel: {
        color: 'var(--text-muted)',
        minWidth: 46,
    },
    timeInput: {
        width: 100,
        padding: '4px 8px',
        fontSize: 12,
        fontFamily: 'var(--font-mono, monospace)',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        outline: 'none',
    },
    timeSuffix: {
        color: 'var(--text-muted)',
        fontSize: 11,
    },
    footer: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 8,
        padding: '12px 16px',
        borderTop: '1px solid var(--border)',
    },
};
