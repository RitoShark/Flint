/**
 * LoadscreenBannerModal
 * Mask editor for the Animated Loadscreen Banner preset. Shows the skin's
 * loadscreen image dimmed underneath and lets the user paint the BLUE-channel
 * mask (where painted = the animated VFX shows) with a brush/eraser. Saving
 * encodes the painted blue channel into the mask `.tex`.
 *
 * Opened two ways (both set modalOptions.projectPath):
 *  - project root → "Add Animated Loadscreen Banner" (banner already applied to
 *    the BIN by the context-menu handler before this opens)
 *  - right-click a *-mask.tex → "Edit Loadscreen Banner Mask"
 *
 * Styled with the design-lab `.dl-*` system, rendered through a body portal.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalStore, useNotificationStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { falloff, strokeDabs, compositeMaskBlue, compositeEraseBlue, maskToDisplayRgba } from '../../lib/maskPaint';

interface ModalOpts {
    projectPath?: string;
    /** When opened from a *-mask.tex, the disk path of that mask. */
    maskPath?: string;
}

type Tool = 'brush' | 'eraser';

/** Tiny localStorage persistence for the brush, namespaced under the editor. */
function loadPref<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(`flint.loadscreenbanner.${key}`);
        return raw == null ? fallback : (JSON.parse(raw) as T);
    } catch { return fallback; }
}
function savePref(key: string, value: unknown): void {
    try { localStorage.setItem(`flint.loadscreenbanner.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
}

/** Decode a .tex/.dds file to an ImageData via the base64-PNG backend path. */
async function decodeTexToImageData(path: string): Promise<{ data: ImageData; width: number; height: number }> {
    const decoded = await api.decodeDdsToPng(path);
    const img = new Image();
    img.src = `data:image/png;base64,${decoded.data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = decoded.width;
    c.height = decoded.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return { data: ctx.getImageData(0, 0, decoded.width, decoded.height), width: decoded.width, height: decoded.height };
}

export const LoadscreenBannerModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const modalOptions = useModalStore((s) => s.modalOptions) as ModalOpts | null;
    const showToast = useNotificationStore((s) => s.showToast);
    const projectPath = modalOptions?.projectPath ?? '';

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);

    const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
    const [maskPath, setMaskPath] = useState('');

    // Tool state — brush params persist across sessions (localStorage).
    const [tool, setTool] = useState<Tool>('brush');
    const [brushSize, setBrushSize] = useState(() => loadPref('brushSize', 48));
    const [hardness, setHardness] = useState(() => loadPref('hardness', 0.5));
    const [opacity, setOpacity] = useState(() => loadPref('opacity', 1));
    useEffect(() => { savePref('brushSize', brushSize); }, [brushSize]);
    useEffect(() => { savePref('hardness', hardness); }, [hardness]);
    useEffect(() => { savePref('opacity', opacity); }, [opacity]);

    // Preset sliders (sent to the backend on save / apply).
    const [shineStrength, setShineStrength] = useState(0.02);
    const [scrollSpeedX, setScrollSpeedX] = useState(0.5);
    const [glowPulse, setGlowPulse] = useState(2);
    const [tint, setTint] = useState<[number, number, number]>([1, 1, 1]);

    // Canvas refs: the displayed (composited) canvas, the dimmed backdrop image.
    const dispCanvasRef = useRef<HTMLCanvasElement>(null);
    const backdropRef = useRef<HTMLCanvasElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    // Decoded loadscreen pixels, stashed until the canvases mount.
    const backdropImageRef = useRef<ImageData | null>(null);

    // Mask pixel buffers (mask resolution). `rgba` = live; `base0` = pre-stroke
    // snapshot for idempotent compositing during a stroke.
    const rgbaRef = useRef<Uint8Array | null>(null);
    const base0Ref = useRef<Uint8Array | null>(null);
    const strokeMaskRef = useRef<Float32Array | null>(null);

    // Undo/redo stacks of full mask snapshots (bounded).
    const undoRef = useRef<Uint8Array[]>([]);
    const redoRef = useRef<Uint8Array[]>([]);

    const paintingRef = useRef(false);
    const lastPtRef = useRef<[number, number] | null>(null);
    const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

    // Displayed stage size in CSS px — the loadscreen fitted (contain) inside the
    // available wrapper box, preserving aspect ratio. Measured, not CSS-derived,
    // so a wide flex box never stretches the image.
    const [stageSize, setStageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

    // ── Load loadscreen + mask, seed the canvases ───────────────────────────
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!projectPath) { setError('No project'); setLoading(false); return; }
            setLoading(true); setError(null);
            try {
                const info = await api.getLoadscreenBannerInfo(projectPath);
                // The MASK owns the canvas resolution (it carries the R/G scroll
                // pattern + the editable blue channel). The loadscreen is just a
                // backdrop reference and may be a different size — it's scaled to
                // fit the mask's aspect, never pixel-aligned. (Previously we sized
                // the canvas to the loadscreen and discarded the mask's pixels when
                // the two differed → the R/G pattern was lost and it came out black.)
                let maskRgba: Uint8Array;
                let maskW: number;
                let maskH: number;
                if (info.mask_exists) {
                    const m = await decodeTexToImageData(info.mask_path);
                    if (cancelled) return;
                    maskRgba = new Uint8Array(m.data.data.buffer.slice(0));
                    maskW = m.width;
                    maskH = m.height;
                } else if (info.loadscreen_exists) {
                    // No mask yet (e.g. re-edit before apply) — start empty at the
                    // loadscreen size.
                    const ls0 = await decodeTexToImageData(info.loadscreen_image_path);
                    if (cancelled) return;
                    maskW = ls0.width; maskH = ls0.height;
                    maskRgba = emptyMask(maskW, maskH);
                } else {
                    throw new Error('No mask or loadscreen found for this project.');
                }

                // Backdrop = the loadscreen, decoded for the on-canvas reference.
                let backdrop: ImageData | null = null;
                if (info.loadscreen_exists) {
                    try {
                        const ls = await decodeTexToImageData(info.loadscreen_image_path);
                        if (cancelled) return;
                        backdrop = ls.data;
                    } catch { /* backdrop is optional */ }
                }

                // Stash for the seeding effect (canvases aren't mounted yet).
                backdropImageRef.current = backdrop;
                rgbaRef.current = maskRgba;
                strokeMaskRef.current = new Float32Array(maskW * maskH);
                setMaskPath(info.mask_path);
                setDims({ w: maskW, h: maskH });
                setLoading(false);
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : String(e));
                    setLoading(false);
                }
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectPath]);

    // Esc to close (when not saving).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !saving) closeModal();
            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [saving]);

    function emptyMask(w: number, h: number): Uint8Array {
        // Fresh mask = VFX everywhere (blue 255); the user paints the champion to
        // carve it OUT of the effect. Opaque alpha.
        const a = new Uint8Array(w * h * 4);
        for (let o = 0; o < a.length; o += 4) { a[o + 2] = 255; a[o + 3] = 255; }
        return a;
    }

    // Draw the composited mask overlay onto the display canvas.
    const redraw = useCallback(() => {
        const rgba = rgbaRef.current;
        const disp = dispCanvasRef.current;
        if (!rgba || !disp) return;
        const w = disp.width, h = disp.height;
        if (w === 0 || h === 0) return;
        const display = maskToDisplayRgba(rgba);
        const ctx = disp.getContext('2d')!;
        // Build via createImageData so the backing buffer is a plain ArrayBuffer
        // (constructing `new ImageData(clampedArray, ...)` trips the lib's
        // SharedArrayBuffer union typing).
        const imgData = ctx.createImageData(w, h);
        imgData.data.set(display);
        ctx.putImageData(imgData, 0, 0);
    }, []);

    // Seed both canvases once they're actually mounted (after `loading` clears
    // the spinner gate) and dims are known: size them and paint the backdrop +
    // mask overlay. Runs whenever loading/error/dims change.
    useEffect(() => {
        if (loading || error || dims.w === 0) return;
        const disp = dispCanvasRef.current;
        const bd = backdropRef.current;
        const ls = backdropImageRef.current;
        if (bd) {
            bd.width = dims.w; bd.height = dims.h;
            const ctx = bd.getContext('2d');
            if (ctx && ls) {
                // The loadscreen may differ in size from the mask — draw it
                // scaled to fill the mask canvas (putImageData can't scale, so go
                // via an offscreen canvas + drawImage).
                if (ls.width === dims.w && ls.height === dims.h) {
                    ctx.putImageData(ls, 0, 0);
                } else {
                    const off = document.createElement('canvas');
                    off.width = ls.width; off.height = ls.height;
                    off.getContext('2d')?.putImageData(ls, 0, 0);
                    ctx.drawImage(off, 0, 0, ls.width, ls.height, 0, 0, dims.w, dims.h);
                }
            }
        }
        if (disp) { disp.width = dims.w; disp.height = dims.h; redraw(); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, error, dims.w, dims.h]);

    // Fit the stage (contain) inside the wrapper, preserving the image ratio.
    // Recomputes on wrapper resize and once the image dims arrive.
    useEffect(() => {
        if (loading || error || dims.w === 0) return;
        const wrap = wrapRef.current;
        if (!wrap) return;
        const fit = () => {
            const bw = wrap.clientWidth;
            const bh = wrap.clientHeight;
            if (bw === 0 || bh === 0) return;
            const scale = Math.min(bw / dims.w, bh / dims.h);
            setStageSize({ w: Math.round(dims.w * scale), h: Math.round(dims.h * scale) });
        };
        fit();
        const ro = new ResizeObserver(fit);
        ro.observe(wrap);
        return () => ro.disconnect();
    }, [loading, error, dims.w, dims.h]);

    // ── Painting ─────────────────────────────────────────────────────────────
    const pushUndo = () => {
        const rgba = rgbaRef.current;
        if (!rgba) return;
        undoRef.current.push(new Uint8Array(rgba));
        if (undoRef.current.length > 30) undoRef.current.shift();
        redoRef.current = [];
    };

    const undo = () => {
        const rgba = rgbaRef.current;
        if (!rgba || undoRef.current.length === 0) return;
        redoRef.current.push(new Uint8Array(rgba));
        rgbaRef.current = undoRef.current.pop()!;
        redraw(); setDirty(true);
    };
    const redo = () => {
        const rgba = rgbaRef.current;
        if (!rgba || redoRef.current.length === 0) return;
        undoRef.current.push(new Uint8Array(rgba));
        rgbaRef.current = redoRef.current.pop()!;
        redraw(); setDirty(true);
    };

    /** Map a pointer event to mask-pixel coords. */
    const toMaskCoords = (e: React.PointerEvent): [number, number] => {
        const disp = dispCanvasRef.current!;
        const rect = disp.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * disp.width;
        const y = ((e.clientY - rect.top) / rect.height) * disp.height;
        return [x, y];
    };

    /** Radius in mask pixels (brushSize is in display px → scale by canvas/display ratio). */
    const maskRadius = () => {
        const disp = dispCanvasRef.current;
        if (!disp) return brushSize / 2;
        const rect = disp.getBoundingClientRect();
        const scale = rect.width > 0 ? disp.width / rect.width : 1;
        return (brushSize / 2) * scale;
    };

    const stampAt = (cx: number, cy: number) => {
        const mask = strokeMaskRef.current!;
        const w = dims.w, h = dims.h;
        const radius = maskRadius();
        // Inline round-dab stamp (matches paintEngine.stampMask, opacity ceiling, flow 1).
        const r = Math.ceil(radius);
        const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
        const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
                const f = falloff(Math.sqrt(dx * dx + dy * dy), radius, hardness);
                if (f <= 0) continue;
                const cov = Math.min(opacity, f);
                const i = y * w + x;
                if (cov > mask[i]) mask[i] = cov;
            }
        }
    };

    const compositeStroke = () => {
        const rgba = rgbaRef.current!, base0 = base0Ref.current!, mask = strokeMaskRef.current!;
        if (tool === 'brush') compositeMaskBlue(rgba, base0, mask, dims.w, dims.h);
        else compositeEraseBlue(rgba, base0, mask, dims.w, dims.h);
        redraw();
    };

    // Photoshop-style quick-adjust gestures: Alt+left-drag = brush size,
    // right-drag = hardness. The ring PINS at the press point (doesn't follow the
    // cursor), the OS cursor hides, and the ring turns red so the gesture reads as
    // "resizing", not painting. `startX` is the press X; the value scales with the
    // horizontal drag from there. (We deliberately don't use Pointer Lock — it
    // triggers the browser's unavoidable "press Esc" banner.)
    const adjustRef = useRef<{ kind: 'size' | 'hardness'; startX: number; startVal: number } | null>(null);
    const [adjusting, setAdjusting] = useState<'size' | 'hardness' | null>(null);

    const beginAdjust = (kind: 'size' | 'hardness', startX: number) => {
        adjustRef.current = { kind, startX, startVal: kind === 'size' ? brushSize : hardness };
        setAdjusting(kind);
    };

    const endAdjust = () => {
        if (!adjustRef.current) return;
        adjustRef.current = null;
        setAdjusting(null);
    };

    const onPointerDown = (e: React.PointerEvent) => {
        if (loading || error) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);

        // Pin the ring where the gesture starts (canvas-relative).
        const rect = dispCanvasRef.current?.getBoundingClientRect();
        const pin = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : cursor;

        // Right-click drag → hardness. Alt + left-click drag → size.
        if (e.button === 2) {
            e.preventDefault();
            if (pin) setCursor(pin);
            beginAdjust('hardness', e.clientX);
            return;
        }
        if (e.altKey && e.button === 0) {
            e.preventDefault();
            if (pin) setCursor(pin);
            beginAdjust('size', e.clientX);
            return;
        }

        pushUndo();
        paintingRef.current = true;
        base0Ref.current = new Uint8Array(rgbaRef.current!);
        strokeMaskRef.current = new Float32Array(dims.w * dims.h);
        const p = toMaskCoords(e);
        lastPtRef.current = p;
        stampAt(p[0], p[1]);
        compositeStroke();
        setDirty(true);
    };

    const onPointerMove = (e: React.PointerEvent) => {
        // Quick-adjust drag takes priority over painting. The ring stays pinned;
        // the value scales with horizontal drag from the press point.
        const adj = adjustRef.current;
        if (adj) {
            const dx = e.clientX - adj.startX;
            if (adj.kind === 'size') {
                setBrushSize(Math.round(Math.max(2, Math.min(300, adj.startVal + dx))));
            } else {
                setHardness(Math.max(0, Math.min(1, adj.startVal + dx / 200)));
            }
            return;
        }

        const rect = dispCanvasRef.current?.getBoundingClientRect();
        if (rect) setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });

        if (!paintingRef.current) return;
        const p = toMaskCoords(e);
        const last = lastPtRef.current ?? p;
        for (const d of strokeDabs(last, p, maskRadius())) stampAt(d[0], d[1]);
        lastPtRef.current = p;
        compositeStroke();
    };

    const onPointerUp = () => {
        endAdjust();
        if (!paintingRef.current) return;
        paintingRef.current = false;
        lastPtRef.current = null;
    };

    // ── Save ─────────────────────────────────────────────────────────────────
    const handleSave = async () => {
        const rgba = rgbaRef.current;
        if (!rgba || !maskPath) return;
        setSaving(true);
        try {
            // 1. Persist preset slider values into the BIN (params only) — do
            //    NOT rebuild the mask (we're about to save the painted one).
            await api.applyLoadscreenBanner(projectPath, {
                shineStrength,
                scrollSpeedX,
                glowPulse,
                tint,
            }, false);
            // 2. Save the mask. R/G/A are the existing texture's channels
            //    (the scroll pattern); only the BLUE channel was edited by the
            //    brush — send the buffer as-is, do NOT zero R/G.
            await api.saveBannerMask(maskPath, rgba, dims.w, dims.h);
            showToast('success', 'Loadscreen banner mask saved');
            setDirty(false);
            closeModal();
        } catch (e) {
            const fe = e as api.FlintError;
            showToast('error', fe.getUserMessage?.() || (e instanceof Error ? e.message : 'Save failed'));
        } finally {
            setSaving(false);
        }
    };

    const requestClose = () => {
        if (saving) return;
        if (dirty) {
            useModalStore.getState().openConfirmDialog({
                title: 'Discard mask changes?',
                message: 'You have unsaved mask edits. Close without saving?',
                confirmLabel: 'Discard',
                danger: true,
                onConfirm: () => { useModalStore.getState().closeConfirmDialog(); closeModal(); },
            });
        } else closeModal();
    };

    const canvasStyle: React.CSSProperties = useMemo(() => ({
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        imageRendering: 'auto', userSelect: 'none', touchAction: 'none',
    }), []);

    return createPortal(
        <div className="dl-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
            <div className="dl-modal dl-modal--large" role="dialog" aria-modal="true" style={{ maxWidth: 1000, width: '92vw' }}>
                <div className="dl-modal__head">
                    <h3 className="dl-modal__title">Animated Loadscreen Banner — Mask</h3>
                    <button className="dl-btn dl-btn--icon" onClick={requestClose} aria-label="Close">✕</button>
                </div>

                <div className="dl-modal__body" style={{ display: 'flex', gap: 16, minHeight: 420 }}>
                    {/* Canvas area — outer box just centers the stage; it must NOT
                        carry the aspect ratio (it's a flex item that stretches to
                        fill, which would override aspect-ratio and stretch the
                        image). The inner `stage` keeps the loadscreen's ratio. */}
                    <div
                        ref={wrapRef}
                        style={{
                            flex: 1, minWidth: 0, minHeight: 0, position: 'relative',
                            background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                            borderRadius: 10, overflow: 'hidden',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                    >
                        {loading && <div className="dl-spinner" style={{ color: 'var(--text-muted)' }}>Loading…</div>}
                        {error && <div style={{ color: 'var(--danger)', padding: 24, textAlign: 'center', fontSize: 13 }}>{error}</div>}
                        {!loading && !error && (
                            <div
                                style={{
                                    position: 'relative',
                                    // Measured contain-fit (px) — preserves the image ratio
                                    // regardless of the flex box's shape.
                                    width: stageSize.w > 0 ? stageSize.w : undefined,
                                    height: stageSize.h > 0 ? stageSize.h : undefined,
                                }}
                            >
                                {/* Loadscreen backdrop at full opacity for clarity. */}
                                <canvas ref={backdropRef} style={{ ...canvasStyle, opacity: 1, pointerEvents: 'none' }} />
                                {/* Mask overlay (the painting) at 40% so the
                                    loadscreen stays readable underneath. + pointer
                                    surface; hide the OS cursor while resizing so
                                    only the ring shows. */}
                                <canvas
                                    ref={dispCanvasRef}
                                    style={{ ...canvasStyle, opacity: 0.4, cursor: adjusting ? 'none' : 'crosshair' }}
                                    onPointerDown={onPointerDown}
                                    onPointerMove={onPointerMove}
                                    onPointerUp={onPointerUp}
                                    onPointerLeave={() => { onPointerUp(); if (!adjustRef.current) setCursor(null); }}
                                    onContextMenu={(e) => e.preventDefault()}
                                />
                                {/* Brush ring. Brush (mask-out) = red, eraser
                                    (restore VFX) = accent; red+fill while resizing. */}
                                {cursor && (
                                    <div style={{
                                        position: 'absolute', left: cursor.x, top: cursor.y,
                                        width: brushSize, height: brushSize, marginLeft: -brushSize / 2, marginTop: -brushSize / 2,
                                        border: `1.5px solid ${adjusting ? 'var(--danger)' : (tool === 'brush' ? 'var(--danger)' : 'var(--accent-primary)')}`,
                                        background: adjusting ? 'color-mix(in oklab, var(--danger) 28%, transparent)' : 'transparent',
                                        borderRadius: '50%', pointerEvents: 'none',
                                        boxShadow: '0 0 0 1px rgba(0,0,0,.4)',
                                        transition: adjusting ? 'none' : 'background .1s',
                                    }} />
                                )}
                                {/* Live size / hardness readout while resizing. */}
                                {cursor && adjusting && (
                                    <div style={{
                                        position: 'absolute',
                                        left: cursor.x, top: cursor.y - brushSize / 2 - 22,
                                        transform: 'translateX(-50%)', pointerEvents: 'none',
                                        background: 'var(--danger)', color: '#fff',
                                        fontSize: 11, fontWeight: 600, padding: '2px 6px',
                                        borderRadius: 5, whiteSpace: 'nowrap',
                                        boxShadow: '0 1px 4px rgba(0,0,0,.4)',
                                    }}>
                                        {adjusting === 'size' ? `${brushSize}px` : `Hardness ${Math.round(hardness * 100)}%`}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Tools panel */}
                    <div style={{ width: 240, flex: 'none', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
                        <Section title="Tool">
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button className={`dl-btn dl-btn--sm ${tool === 'brush' ? 'dl-btn--primary' : 'dl-btn--secondary'}`} style={{ flex: 1 }} onClick={() => setTool('brush')} title="Paint over what should stay clean (no VFX) — e.g. the champion">Mask out</button>
                                <button className={`dl-btn dl-btn--sm ${tool === 'eraser' ? 'dl-btn--primary' : 'dl-btn--secondary'}`} style={{ flex: 1 }} onClick={() => setTool('eraser')} title="Bring the VFX back to a masked-out area">Restore</button>
                            </div>
                        </Section>
                        <Section title="Brush">
                            <Slider label="Size" hint="Alt + drag" value={brushSize} min={2} max={300} step={1} onChange={setBrushSize} display={`${brushSize}px`} />
                            <Slider label="Hardness" hint="Right-drag" value={hardness} min={0} max={1} step={0.01} onChange={setHardness} display={`${Math.round(hardness * 100)}%`} />
                            <Slider label="Opacity" value={opacity} min={0.05} max={1} step={0.01} onChange={setOpacity} display={`${Math.round(opacity * 100)}%`} />
                        </Section>
                        <Section title="Effect">
                            <Slider label="Shine" value={shineStrength} min={0} max={0.2} step={0.005} onChange={(v) => { setShineStrength(v); setDirty(true); }} display={shineStrength.toFixed(3)} />
                            <Slider label="Scroll" value={scrollSpeedX} min={-2} max={2} step={0.05} onChange={(v) => { setScrollSpeedX(v); setDirty(true); }} display={scrollSpeedX.toFixed(2)} />
                            <Slider label="Glow pulse" value={glowPulse} min={0} max={8} step={0.1} onChange={(v) => { setGlowPulse(v); setDirty(true); }} display={glowPulse.toFixed(1)} />
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Tint</span>
                                <input
                                    type="color"
                                    value={rgbToHex(tint)}
                                    onChange={(e) => { setTint(hexToRgb(e.target.value)); setDirty(true); }}
                                    style={{ width: 40, height: 24, border: 'none', background: 'none', cursor: 'pointer' }}
                                />
                            </div>
                        </Section>
                        <Section title="History">
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button className="dl-btn dl-btn--sm dl-btn--ghost" style={{ flex: 1 }} onClick={undo} disabled={undoRef.current.length === 0}>Undo</button>
                                <button className="dl-btn dl-btn--sm dl-btn--ghost" style={{ flex: 1 }} onClick={redo} disabled={redoRef.current.length === 0}>Redo</button>
                            </div>
                        </Section>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                            The whole banner is animated by default. <strong>Paint over what should stay clean</strong> (e.g. the champion) to mask it out — the red highlight is the protected area. Use <strong>Restore</strong> to bring the effect back.
                            <br /><br />
                            <strong>Alt + drag</strong> = brush size · <strong>Right-click drag</strong> = hardness.
                        </div>
                    </div>
                </div>

                <div className="dl-modal__foot" style={{ justifyContent: 'space-between' }}>
                    <button className="dl-btn dl-btn--ghost" onClick={requestClose} disabled={saving}>Cancel</button>
                    <button className={`dl-btn dl-btn--primary${saving ? ' dl-btn--loading' : ''}`} onClick={handleSave} disabled={saving || loading || !!error}>
                        {saving ? 'Saving…' : 'Save Mask'}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};

// ── Small presentational helpers ─────────────────────────────────────────────

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="dl-card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{title}</div>
        {children}
    </div>
);

const Slider: React.FC<{ label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; display: string; hint?: string }> = ({ label, value, min, max, step, onChange, display, hint }) => (
    <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: 2, gap: 6 }}>
            <span style={{ color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                {label}
                {hint && (
                    <span style={{
                        fontSize: 9, fontWeight: 600, letterSpacing: '.02em',
                        color: 'var(--text-muted)', background: 'var(--bg-secondary)',
                        border: '1px solid var(--border)', borderRadius: 4,
                        padding: '0 4px', lineHeight: '14px', whiteSpace: 'nowrap',
                    }}>{hint}</span>
                )}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>{display}</span>
        </div>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} style={{ width: '100%' }} />
    </div>
);

function rgbToHex(rgb: [number, number, number]): string {
    const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
    return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}
function hexToRgb(hex: string): [number, number, number] {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return [1, 1, 1];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}
