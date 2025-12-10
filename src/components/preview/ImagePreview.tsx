/**
 * Flint - Image Preview Component
 */

import React, { useState, useEffect } from 'react';
import * as api from '../../lib/api';
import { getCachedImage, cacheImage } from '../../lib/state';
import { getIcon } from '../../lib/fileIcons';

interface ImagePreviewProps {
    filePath: string;
}

export const ImagePreview: React.FC<ImagePreviewProps> = ({ filePath }) => {
    const [imageData, setImageData] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const loadImage = async () => {
            setLoading(true);
            setError(null);

            // Check cache
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
                    // Regular image - read bytes and create data URL
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
    }, [filePath]);

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

    return (
        <div className="image-preview">
            <div className="image-preview__container">
                {imageData && (
                    <img
                        className="image-preview__image"
                        src={imageData}
                        alt="Preview"
                        draggable={false}
                    />
                )}
            </div>
        </div>
    );
};
