/**
 * Flint - Thumbnail Crop Modal
 * Allows users to select an image, crop it to 16:9, and save as thumbnail.webp
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useModalStore, useNotificationStore } from '../../lib/stores';
import { open } from '@tauri-apps/plugin-dialog';
import * as api from '../../lib/api';
import { Button, Modal, ModalBody, ModalFooter, ModalHeader, Range } from '../ui';

// Output: 1280x720 (16:9 HD)
const THUMB_W = 1280;
const THUMB_H = 720;
const ASPECT = 16 / 9;

export const ThumbnailCropModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);
    const showToast = useNotificationStore((s) => s.showToast);

    const isVisible = activeModal === 'thumbnail';
    const options = modalOptions as { projectPath: string } | null;

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);

    const [imageSrc, setImageSrc] = useState<string | null>(null);
    // Crop region in image-space pixels (16:9 rectangle)
    const [cropX, setCropX] = useState(0);
    const [cropY, setCropY] = useState(0);
    const [cropW, setCropW] = useState(100);
    const [cropH, setCropH] = useState(100);
    const [dragging, setDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0, cropX: 0, cropY: 0 });
    const [zoom, setZoom] = useState(1);

    // Canvas display dimensions
    const CANVAS_W = 320;
    const CANVAS_H = 240;

    // Reset state when modal closes
    useEffect(() => {
        if (!isVisible) {
            setImageSrc(null);
            setCropX(0);
            setCropY(0);
            setCropW(100);
            setCropH(100);
            setZoom(1);
        }
    }, [isVisible]);

    // Pick an image file
    const handlePickImage = useCallback(async () => {
        const selected = await open({
            title: 'Select Thumbnail Image',
            filters: [
                { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] },
                { name: 'All Files', extensions: ['*'] },
            ],
            multiple: false,
            directory: false,
        });

        if (!selected) return;

        try {
            const bytes = await api.readFileBytes(selected as string);
            const blob = new Blob([new Uint8Array(bytes)]);
            const url = URL.createObjectURL(blob);
            setImageSrc(url);
        } catch {
            showToast('error', 'Failed to load image');
        }
    }, [showToast]);

    // Load image when src changes
    useEffect(() => {
        if (!imageSrc) return;

        const img = new Image();
        img.onload = () => {
            imageRef.current = img;
            // Initialize crop: largest 16:9 rectangle that fits
            const fitW = img.width;
            const fitH = fitW / ASPECT;
            if (fitH <= img.height) {
                setCropW(fitW);
                setCropH(fitH);
                setCropX(0);
                setCropY((img.height - fitH) / 2);
            } else {
                const h = img.height;
                const w = h * ASPECT;
                setCropW(w);
                setCropH(h);
                setCropX((img.width - w) / 2);
                setCropY(0);
            }
            setZoom(1);
        };
        img.src = imageSrc;

        return () => {
            URL.revokeObjectURL(imageSrc);
        };
    }, [imageSrc]);

    // Draw canvas
    useEffect(() => {
        const canvas = canvasRef.current;
        const preview = previewCanvasRef.current;
        const img = imageRef.current;
        if (!canvas || !img) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

        // Scale to fit image in canvas
        const scale = Math.min(CANVAS_W / img.width, CANVAS_H / img.height) * zoom;
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        const drawX = (CANVAS_W - drawW) / 2;
        const drawY = (CANVAS_H - drawH) / 2;

        // Draw dimmed image
        ctx.globalAlpha = 0.3;
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        ctx.globalAlpha = 1;

        // Draw crop area (bright)
        const cDrawX = drawX + (cropX / img.width) * drawW;
        const cDrawY = drawY + (cropY / img.height) * drawH;
        const cDrawW = (cropW / img.width) * drawW;
        const cDrawH = (cropH / img.height) * drawH;

        ctx.save();
        ctx.beginPath();
        ctx.rect(cDrawX, cDrawY, cDrawW, cDrawH);
        ctx.clip();
        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        ctx.restore();

        // Crop border
        ctx.strokeStyle = '#dc5050';
        ctx.lineWidth = 2;
        ctx.strokeRect(cDrawX, cDrawY, cDrawW, cDrawH);

        // Rule-of-thirds grid
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        for (let i = 1; i <= 2; i++) {
            ctx.beginPath();
            ctx.moveTo(cDrawX + (cDrawW * i) / 3, cDrawY);
            ctx.lineTo(cDrawX + (cDrawW * i) / 3, cDrawY + cDrawH);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(cDrawX, cDrawY + (cDrawH * i) / 3);
            ctx.lineTo(cDrawX + cDrawW, cDrawY + (cDrawH * i) / 3);
            ctx.stroke();
        }

        // Corner handles
        const hs = 8;
        ctx.fillStyle = '#dc5050';
        ctx.fillRect(cDrawX - hs / 2, cDrawY - hs / 2, hs, hs);
        ctx.fillRect(cDrawX + cDrawW - hs / 2, cDrawY - hs / 2, hs, hs);
        ctx.fillRect(cDrawX - hs / 2, cDrawY + cDrawH - hs / 2, hs, hs);
        ctx.fillRect(cDrawX + cDrawW - hs / 2, cDrawY + cDrawH - hs / 2, hs, hs);

        // 16:9 label
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(cDrawX + cDrawW - 38, cDrawY + 4, 34, 16);
        ctx.fillStyle = '#ccc';
        ctx.font = '10px sans-serif';
        ctx.fillText('16:9', cDrawX + cDrawW - 34, cDrawY + 15);

        // Preview
        if (preview) {
            const pctx = preview.getContext('2d');
            if (pctx) {
                pctx.clearRect(0, 0, THUMB_W, THUMB_H);
                pctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, THUMB_W, THUMB_H);
            }
        }
    }, [imageSrc, cropX, cropY, cropW, cropH, zoom]);

    // Drag to move crop
    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!imageRef.current || !canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        setDragging(true);
        setDragStart({ x: e.clientX - rect.left, y: e.clientY - rect.top, cropX, cropY });
    }, [cropX, cropY]);

    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        if (!dragging) return;
        const img = imageRef.current;
        const canvas = canvasRef.current;
        if (!img || !canvas) return;

        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const scale = Math.min(CANVAS_W / img.width, CANVAS_H / img.height) * zoom;
        const dx = (mx - dragStart.x) / scale;
        const dy = (my - dragStart.y) / scale;

        setCropX(Math.max(0, Math.min(img.width - cropW, dragStart.cropX + dx)));
        setCropY(Math.max(0, Math.min(img.height - cropH, dragStart.cropY + dy)));
    }, [dragging, dragStart, cropW, cropH, zoom]);

    const handleMouseUp = useCallback(() => setDragging(false), []);

    // Scroll to resize crop (maintain 16:9)
    const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
        e.preventDefault();
        const img = imageRef.current;
        if (!img) return;

        const delta = e.deltaY > 0 ? 20 : -20;
        const minW = 64;
        // Max width: fit within image at 16:9 aspect
        const maxW = Math.min(img.width, img.height * ASPECT);
        const newW = Math.max(minW, Math.min(maxW, cropW + delta));
        const newH = newW / ASPECT;

        // Keep centered
        const cx = cropX + cropW / 2;
        const cy = cropY + cropH / 2;
        const newX = Math.max(0, Math.min(img.width - newW, cx - newW / 2));
        const newY = Math.max(0, Math.min(img.height - newH, cy - newH / 2));

        setCropW(newW);
        setCropH(newH);
        setCropX(newX);
        setCropY(newY);
    }, [cropX, cropY, cropW, cropH]);

    // Save thumbnail
    const handleSave = useCallback(async () => {
        const img = imageRef.current;
        if (!img || !options?.projectPath) return;

        const offscreen = document.createElement('canvas');
        offscreen.width = THUMB_W;
        offscreen.height = THUMB_H;
        const octx = offscreen.getContext('2d');
        if (!octx) return;

        octx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, THUMB_W, THUMB_H);

        const blob = await new Promise<Blob | null>((resolve) => {
            offscreen.toBlob((b) => resolve(b), 'image/webp', 0.9);
        });

        if (!blob) {
            showToast('error', 'Failed to generate thumbnail');
            return;
        }

        const arrayBuffer = await blob.arrayBuffer();
        const bytes = Array.from(new Uint8Array(arrayBuffer));

        const thumbPath = `${options.projectPath.replace(/\\/g, '/')}/thumbnail.webp`;
        try {
            await api.saveFileBytes(thumbPath, bytes);
            showToast('success', 'Thumbnail saved (1280x720)');
            closeModal();
        } catch {
            showToast('error', 'Failed to save thumbnail');
        }
    }, [cropX, cropY, cropW, cropH, options, showToast, closeModal]);

    return (
        <Modal open={isVisible} onClose={closeModal} size="wide" modifier="modal--thumbnail">
                <ModalHeader title="Set Project Thumbnail" onClose={closeModal} />

                <ModalBody style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
                    {!imageSrc ? (
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '12px',
                            padding: '40px 20px',
                            border: '2px dashed var(--border)',
                            borderRadius: 'var(--radius-md)',
                            width: '100%',
                            cursor: 'pointer',
                        }} onClick={handlePickImage}>
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.5">
                                <rect x="3" y="3" width="18" height="18" rx="2" />
                                <circle cx="8.5" cy="8.5" r="1.5" />
                                <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                            </svg>
                            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
                                Click to select an image
                            </span>
                            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                                PNG, JPG, WebP supported — cropped to 16:9
                            </span>
                        </div>
                    ) : (
                        <>
                            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                                {/* Crop canvas */}
                                <div style={{ position: 'relative' }}>
                                    <canvas
                                        ref={canvasRef}
                                        width={CANVAS_W}
                                        height={CANVAS_H}
                                        style={{
                                            background: '#1a1a2e',
                                            borderRadius: 'var(--radius-sm)',
                                            cursor: dragging ? 'grabbing' : 'grab',
                                        }}
                                        onMouseDown={handleMouseDown}
                                        onMouseMove={handleMouseMove}
                                        onMouseUp={handleMouseUp}
                                        onMouseLeave={handleMouseUp}
                                        onWheel={handleWheel}
                                    />
                                    <div style={{
                                        position: 'absolute',
                                        bottom: '8px',
                                        left: '8px',
                                        fontSize: 'var(--text-xs)',
                                        color: 'var(--text-muted)',
                                        background: 'rgba(0,0,0,0.6)',
                                        padding: '2px 6px',
                                        borderRadius: '3px',
                                    }}>
                                        Drag to move, scroll to resize
                                    </div>
                                </div>

                                {/* Preview */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' }}>
                                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>Preview</span>
                                    <canvas
                                        ref={previewCanvasRef}
                                        width={THUMB_W}
                                        height={THUMB_H}
                                        style={{
                                            width: '128px',
                                            height: '72px',
                                            background: '#1a1a2e',
                                            borderRadius: 'var(--radius-sm)',
                                            border: '1px solid var(--border)',
                                        }}
                                    />
                                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                                        {THUMB_W}x{THUMB_H}
                                    </span>
                                </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', maxWidth: CANVAS_W + 'px' }}>
                                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Zoom</span>
                                <Range
                                    min={0.5}
                                    max={3}
                                    step={0.1}
                                    value={zoom}
                                    onChange={(e) => setZoom(parseFloat(e.target.value))}
                                    style={{ flex: 1 }}
                                />
                                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', width: 40, textAlign: 'right' }}>
                                    {Math.round(zoom * 100)}%
                                </span>
                            </div>

                            <Button size="sm" onClick={handlePickImage}>
                                Choose Different Image
                            </Button>
                        </>
                    )}
                </ModalBody>

                <ModalFooter>
                    <Button variant="secondary" onClick={closeModal}>Cancel</Button>
                    <Button variant="primary" onClick={handleSave} disabled={!imageSrc}>
                        Save Thumbnail
                    </Button>
                </ModalFooter>
        </Modal>
    );
};
