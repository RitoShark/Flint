import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../../lib/api';
import { getCachedImage, cacheImage } from '../../lib/ui-helpers/imageCache';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { useAppMetadataStore } from '../../lib/stores';

interface ImagePreviewProps {
    filePath: string;
    zoom: 'fit' | number;
    onZoomChange: (zoom: 'fit' | number) => void;
}

export const ImagePreview: React.FC<ImagePreviewProps> = ({ filePath, zoom, onZoomChange }) => {
    const [imageData, setImageData] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const imageRef = useRef<HTMLImageElement>(null);

    const fileVersion = useAppMetadataStore((state) => {
        void state.fileVersionsRev;
        return state.getFileVersion(filePath);
    });

    useEffect(() => {
        const loadImage = async () => {
            setLoading(true);
            setError(null);

            const cached = getCachedImage(filePath);
            if (cached) {
                setImageData(cached as string);
                setLoading(false);
                return;
            }

            try {
                const ext = filePath.split('.').pop()?.toLowerCase();
                let result;

                if (ext === 'dds' || ext === 'tex') {
                    result = await api.decodeDdsToPng(filePath);
                    const dataUrl = `data:image/png;base64,${result.data}`;
                    cacheImage(filePath, dataUrl);
                    setImageData(dataUrl);
                } else {
                    const bytes = await api.readFileBytes(filePath);
                    const blob = new Blob([bytes as BlobPart]);
                    const dataUrl = URL.createObjectURL(blob);
                    cacheImage(filePath, dataUrl);
                    setImageData(dataUrl);
                }
            } catch (err) {
                console.error('[ImagePreview] Error:', err);
                setError((err as Error).message || 'Failed to load image');
            } finally {
                setLoading(false);
            }
        };

        loadImage();
    }, [filePath, fileVersion]);

    const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget;
        setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
    }, []);

    const handleWheel = useCallback((e: React.WheelEvent) => {
        e.preventDefault();

        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const currentZoom = zoom === 'fit' ? 1 : zoom;
        const newZoom = Math.max(0.1, Math.min(5, currentZoom + delta));

        onZoomChange(newZoom);
    }, [zoom, onZoomChange]);

    const getImageStyle = useCallback((): React.CSSProperties => {
        if (!naturalSize || !containerRef.current) {
            return {};
        }

        const container = containerRef.current;
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;

        if (zoom === 'fit') {
            const scaleX = containerWidth / naturalSize.width;
            const scaleY = containerHeight / naturalSize.height;
            const scale = Math.min(scaleX, scaleY, 1);

            return {
                width: naturalSize.width * scale,
                height: naturalSize.height * scale,
            };
        } else {
            return {
                width: naturalSize.width * zoom,
                height: naturalSize.height * zoom,
            };
        }
    }, [zoom, naturalSize]);

    if (loading) {
        return (
            <div className="image-preview__loading">
                <div className="spinner" />
                <span>Decoding texture...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="image-preview__error">
                <span dangerouslySetInnerHTML={{ __html: getIcon('warning') }} />
                <span>{error}</span>
            </div>
        );
    }

    const imageStyle = getImageStyle();

    return (
        <div
            className="image-preview"
            ref={containerRef}
            onWheel={handleWheel}
        >
            <div className="image-preview__container">
                {imageData && (
                    <img
                        ref={imageRef}
                        className="image-preview__image"
                        src={imageData}
                        alt="Preview"
                        draggable={false}
                        onLoad={handleImageLoad}
                        style={imageStyle}
                    />
                )}
            </div>
        </div>
    );
};
