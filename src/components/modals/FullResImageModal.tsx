import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useModalStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { getCachedImage, cacheImage } from '../../lib/ui-helpers/imageCache';
import { Button, Modal, ModalHeader } from '../ui';

interface FullResImageOptions {
    absPath: string;
    fileName: string;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.15;

export const FullResImageModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);
    const isVisible = activeModal === 'fullResImage';
    const options = modalOptions as FullResImageOptions | null;

    const [src, setSrc] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);

    /** 1.0 = native pixel size. */
    const [zoom, setZoom] = useState(1);
    /** Pan offset in CSS px. */
    const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

    const dragStateRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
    const viewportRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isVisible || !options?.absPath) {
            setSrc(null);
            setError(null);
            setNaturalSize(null);
            return;
        }

        setError(null);
        setNaturalSize(null);
        setZoom(1);
        setPan({ x: 0, y: 0 });

        let cancelled = false;
        const cached = getCachedImage(options.absPath);
        if (cached) {
            setSrc(cached as string);
            return;
        }
        setSrc(null);

        (async () => {
            try {
                let url: string;
                const ext = options.absPath.split('.').pop()?.toLowerCase() ?? '';
                if (ext === 'dds' || ext === 'tex') {
                    const decoded = await api.decodeDdsToPng(options.absPath);
                    url = `data:image/png;base64,${decoded.data}`;
                } else {
                    const bytes = await api.readFileBytes(options.absPath);
                    const blob = new Blob([bytes as BlobPart]);
                    url = URL.createObjectURL(blob);
                }
                if (cancelled) return;
                cacheImage(options.absPath, url);
                setSrc(url);
            } catch (e) {
                if (cancelled) return;
                setError((e as { message?: string })?.message ?? String(e));
            }
        })();

        return () => { cancelled = true; };
    }, [isVisible, options?.absPath]);

    // Wheel-zoom: keep the cursor anchored to the same image pixel as the
    // zoom changes. Without this, zooming feels like the image runs away.
    const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
        if (!viewportRef.current || !naturalSize) return;
        e.preventDefault();
        const rect = viewportRef.current.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;

        const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
        if (nextZoom === zoom) return;

        // Image pixel under the cursor before zoom. The image origin in
        // viewport space is (rect.w/2 + pan.x, rect.h/2 + pan.y); subtract
        // and divide by zoom to land in image-local coords.
        const originX = rect.width / 2 + pan.x;
        const originY = rect.height / 2 + pan.y;
        const imgX = (cx - originX) / zoom;
        const imgY = (cy - originY) / zoom;

        // After zoom, that same image pixel should still be under the
        // cursor → solve for new pan.
        const nextPanX = cx - rect.width / 2 - imgX * nextZoom;
        const nextPanY = cy - rect.height / 2 - imgY * nextZoom;

        setZoom(nextZoom);
        setPan({ x: nextPanX, y: nextPanY });
    }, [zoom, pan, naturalSize]);

    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        dragStateRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            panX: pan.x,
            panY: pan.y,
        };
    }, [pan]);

    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const ds = dragStateRef.current;
        if (!ds) return;
        setPan({
            x: ds.panX + (e.clientX - ds.startX),
            y: ds.panY + (e.clientY - ds.startY),
        });
    }, []);

    const handleMouseUp = useCallback(() => {
        dragStateRef.current = null;
    }, []);

    const resetView = useCallback(() => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
    }, []);

    const fitToWindow = useCallback(() => {
        if (!viewportRef.current || !naturalSize) return;
        const rect = viewportRef.current.getBoundingClientRect();
        const fit = Math.min(rect.width / naturalSize.w, rect.height / naturalSize.h, 1);
        setZoom(fit);
        setPan({ x: 0, y: 0 });
    }, [naturalSize]);

    return (
        <Modal open={isVisible} onClose={closeModal} size="large" modifier="modal--full-res-image">
                <ModalHeader title={options?.fileName ?? 'Image'} onClose={closeModal}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 120, textAlign: 'right' }}>
                            {naturalSize ? `${naturalSize.w} × ${naturalSize.h}` : ''}
                            {' · '}
                            {Math.round(zoom * 100)}%
                        </span>
                        <Button variant="ghost" size="sm" onClick={fitToWindow} style={{ padding: '4px 10px' }}>Fit</Button>
                        <Button variant="ghost" size="sm" onClick={resetView} style={{ padding: '4px 10px' }}>1:1</Button>
                    </div>
                </ModalHeader>

                <div
                    ref={viewportRef}
                    onWheel={handleWheel}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    style={{
                        flex: 1,
                        overflow: 'hidden',
                        position: 'relative',
                        background:
                            'repeating-conic-gradient(rgba(255,255,255,0.04) 0% 25%, transparent 0% 50%) 50% / 24px 24px',
                        cursor: dragStateRef.current ? 'grabbing' : 'grab',
                        userSelect: 'none',
                    }}
                >
                    {error && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-danger)' }}>
                            {error}
                        </div>
                    )}
                    {!src && !error && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                            Decoding…
                        </div>
                    )}
                    {src && (
                        <img
                            src={src}
                            alt={options?.fileName ?? ''}
                            draggable={false}
                            onLoad={(e) => {
                                const img = e.currentTarget;
                                setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
                            }}
                            style={{
                                position: 'absolute',
                                left: '50%',
                                top: '50%',
                                transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                                transformOrigin: 'center center',
                                imageRendering: zoom >= 2 ? 'pixelated' : 'auto',
                                pointerEvents: 'none',
                            }}
                        />
                    )}
                </div>
        </Modal>
    );
};
