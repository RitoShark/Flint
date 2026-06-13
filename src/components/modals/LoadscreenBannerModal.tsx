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
import { falloff, strokeDabs, compositeMaskBlue, compositeEraseBlue, normalizeMaskRgba, maskToDisplayRgba } from '../../lib/maskPaint';

interface ModalOpts {
    projectPath?: string;
    /** When opened from a *-mask.tex, the disk path of that mask. */
    maskPath?: string;
}

type Tool = 'brush' | 'eraser';

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

    // Tool state
    const [tool, setTool] = useState<Tool>('brush');
    const [brushSize, setBrushSize] = useState(48);
    const [hardness, setHardness] = useState(0.5);
    const [opacity, setOpacity] = useState(1);

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
                if (!info.loadscreen_exists) {
                    throw new Error('Loadscreen image not found on disk for this project.');
                }
                // Backdrop = the loadscreen.
                const ls = await decodeTexToImageData(info.loadscreen_image_path);
                if (cancelled) return;

                // Mask: decode existing if present, else start empty (black).
                let maskRgba: Uint8Array;
                if (info.mask_exists) {
                    const m = await decodeTexToImageData(info.mask_path);
                    // Resize-tolerant: if mask dims differ, just take its raw buffer
                    // when sizes match; otherwise start fresh at loadscreen size.
                    if (m.width === ls.width && m.height === ls.height) {
                        maskRgba = new Uint8Array(m.data.data.buffer.slice(0));
                    } else {
                        maskRgba = emptyMask(ls.width, ls.height);
                    }
                } else {
                    maskRgba = emptyMask(ls.width, ls.height);
                }
                if (cancelled) return;

                // Stash the decoded loadscreen; a separate effect seeds the
                // canvases once they're actually mounted (they're hidden behind
                // the `loading` gate, so their refs are null right now).
                backdropImageRef.current = ls.data;
                rgbaRef.current = maskRgba;
                strokeMaskRef.current = new Float32Array(ls.width * ls.height);
                setMaskPath(info.mask_path);
                setDims({ w: ls.width, h: ls.height });
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
        const a = new Uint8Array(w * h * 4);
        for (let o = 3; o < a.length; o += 4) a[o] = 255; // opaque, blue=0
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
        if (bd && ls) {
            bd.width = dims.w; bd.height = dims.h;
            bd.getContext('2d')?.putImageData(ls, 0, 0);
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

    const onPointerDown = (e: React.PointerEvent) => {
        if (loading || error) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
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
            // 1. Persist preset slider values into the BIN (params only).
            await api.applyLoadscreenBanner(projectPath, {
                shineStrength,
                scrollSpeedX,
                glowPulse,
                tint,
            });
            // 2. Save the painted mask (blue-only).
            const clean = normalizeMaskRgba(rgba);
            await api.saveBannerMask(maskPath, clean, dims.w, dims.h);
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
                                {/* Dimmed loadscreen backdrop */}
                                <canvas ref={backdropRef} style={{ ...canvasStyle, opacity: 0.35, pointerEvents: 'none' }} />
                                {/* Mask overlay + pointer surface */}
                                <canvas
                                    ref={dispCanvasRef}
                                    style={{ ...canvasStyle, cursor: 'crosshair' }}
                                    onPointerDown={onPointerDown}
                                    onPointerMove={onPointerMove}
                                    onPointerUp={onPointerUp}
                                    onPointerLeave={() => { onPointerUp(); setCursor(null); }}
                                />
                                {/* Brush ring */}
                                {cursor && (
                                    <div style={{
                                        position: 'absolute', left: cursor.x, top: cursor.y,
                                        width: brushSize, height: brushSize, marginLeft: -brushSize / 2, marginTop: -brushSize / 2,
                                        border: `1.5px solid ${tool === 'eraser' ? 'var(--danger)' : 'var(--accent-primary)'}`,
                                        borderRadius: '50%', pointerEvents: 'none',
                                        boxShadow: '0 0 0 1px rgba(0,0,0,.4)',
                                    }} />
                                )}
                            </div>
                        )}
                    </div>

                    {/* Tools panel */}
                    <div style={{ width: 240, flex: 'none', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
                        <Section title="Tool">
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button className={`dl-btn dl-btn--sm ${tool === 'brush' ? 'dl-btn--primary' : 'dl-btn--secondary'}`} style={{ flex: 1 }} onClick={() => setTool('brush')}>Brush</button>
                                <button className={`dl-btn dl-btn--sm ${tool === 'eraser' ? 'dl-btn--primary' : 'dl-btn--secondary'}`} style={{ flex: 1 }} onClick={() => setTool('eraser')}>Eraser</button>
                            </div>
                        </Section>
                        <Section title="Brush">
                            <Slider label="Size" value={brushSize} min={2} max={300} step={1} onChange={setBrushSize} display={`${brushSize}px`} />
                            <Slider label="Hardness" value={hardness} min={0} max={1} step={0.01} onChange={setHardness} display={`${Math.round(hardness * 100)}%`} />
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
                            Paint where the animated VFX should show. The brush writes the blue-channel mask.
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

const Slider: React.FC<{ label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; display: string }> = ({ label, value, min, max, step, onChange, display }) => (
    <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
            <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
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
