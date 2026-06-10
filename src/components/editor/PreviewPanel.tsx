/**
 * Flint - Preview Panel Component
 * Main preview container with toolbar and content routing
 */

import React, { useState, useEffect, useRef } from 'react';
import { useConfigStore, useProjectTabStore, useModalStore, useNotificationStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { ImagePreview } from '../preview/ImagePreview';
import { TextPreview } from '../preview/TextPreview';
import { BinEditor } from '../preview/BinEditor';
import { ModelPreview } from '../preview/ModelPreview';
import { UnknownPreview } from '../preview/UnknownPreview';
import { HUDEditor } from '../preview/HUDEditor';
import { BnkPreview } from '../preview/BnkPreview';
import { FolderGridView } from '../preview/FolderGridView';
import { LuabinViewer } from '../preview/LuabinViewer';
import { TroybinViewer } from '../preview/TroybinViewer';
import { InibinEditor } from '../preview/InibinEditor';
import { StringTableEditor } from '../preview/StringTableEditor';
import { ManifestViewer } from '../preview/ManifestViewer';
import { JadeIcon } from '../icons/JadeIcon';
import { QuartzIcon } from '../icons/QuartzIcon';

interface FileInfo {
    path: string;
    size: number;
    file_type: string;
    extension: string;
    dimensions: [number, number] | null;
}

const EmptyState: React.FC = () => (
    <div className="preview-panel__empty">
        <div
            className="preview-panel__empty-icon"
            dangerouslySetInnerHTML={{ __html: getIcon('document') }}
        />
        <div className="preview-panel__empty-text">Select a file to preview</div>
    </div>
);

const ErrorState: React.FC<{ message: string }> = ({ message }) => (
    <div className="preview-panel__error">
        <span
            className="error-icon"
            dangerouslySetInnerHTML={{ __html: getIcon('warning') }}
        />
        <span>{message}</span>
    </div>
);

const getTypeLabel = (fileType: string, filePath?: string): string => {
    // Special check for HUD files (dev only)
    if (import.meta.env.DEV && filePath && filePath.endsWith('.ritobin') &&
        (filePath.includes('uibase') || filePath.includes('loadingscreen'))) {
        return 'HUD Configuration';
    }

    const labels: Record<string, string> = {
        'image/dds': 'DDS Texture',
        'image/tex': 'TEX Texture',
        'image/png': 'PNG Image',
        'image/jpeg': 'JPEG Image',
        'application/x-bin': 'BIN Property File',
        'text/x-python': 'Python Script',
        'application/json': 'JSON',
        'text/plain': 'Plain Text',
        'audio': 'Audio',
        'audio/x-wwise-bnk': 'Wwise Sound Bank',
        'audio/x-wwise-wpk': 'Wwise Audio Package',
        'model': '3D Model',
        'model/x-lol-skn': 'SKN Skinned Mesh',
        'model/x-lol-skl': 'SKL Skeleton',
        'model/x-lol-scb': 'SCB Static Mesh',
        'model/x-lol-sco': 'SCO Static Mesh',
        'application/octet-stream': 'Binary File',
        'application/x-inibin': 'INIBIN File',
    };
    return labels[fileType] || fileType;
};

const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

class PreviewErrorBoundary extends React.Component<
    { children: React.ReactNode; fileKey: string },
    { hasError: boolean }
> {
    state = { hasError: false };

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidUpdate(prevProps: { fileKey: string }) {
        if (prevProps.fileKey !== this.props.fileKey && this.state.hasError) {
            this.setState({ hasError: false });
        }
    }

    render() {
        if (this.state.hasError) {
            return <ErrorState message="Preview crashed. Select another file to continue." />;
        }
        return this.props.children;
    }
}

/** Check if a file type is a 3D model that uses WebGL */
const is3DType = (info: FileInfo | null): boolean => {
    if (!info) return false;
    return info.extension === 'skn' || info.extension === 'scb' || info.extension === 'sco' ||
        info.file_type === 'model/x-lol-skn' || info.file_type === 'model/x-lol-scb' ||
        info.file_type === 'model/x-lol-sco';
};

export const PreviewPanel: React.FC = () => {
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const openModal = useModalStore((s) => s.openModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const jadePath = useConfigStore((state) => state.jadePath);
    const quartzPath = useConfigStore((state) => state.quartzPath);
    const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [imageZoom, setImageZoom] = useState<'fit' | number>('fit');
    /**
     * When the active selection is a folder, this drops the file-preview
     * pipeline and routes to the folder grid view instead. Set in the
     * effect below after a cheap `is_directory` IPC.
     */
    const [isFolderSelection, setIsFolderSelection] = useState(false);

    // Track previous file type to detect 3D→non-3D transitions
    // When leaving a 3D preview, we add a brief cooldown to let R3F
    // fully dispose the WebGL context before mounting the next component
    const [webglCooldown, setWebglCooldown] = useState(false);
    const prevFileInfoRef = useRef<FileInfo | null>(null);

    // Get selected file and project path from active tab
    const activeTab = activeTabId
        ? openTabs.find(t => t.id === activeTabId)
        : null;
    const selectedFile = activeTab?.selectedFile || null;
    const projectPath = activeTab?.projectPath || null;

    useEffect(() => {
        if (!selectedFile || !projectPath) {
            setFileInfo(null);
            setIsFolderSelection(false);
            setLoading(false);
            return;
        }

        // Detect if we're leaving a 3D preview — need cooldown for WebGL cleanup
        const was3D = is3DType(prevFileInfoRef.current);

        // Clear stale info IMMEDIATELY to prevent wrong preview routing
        // (e.g. old SKN file info causing JSON file to be sent to ModelPreview)
        setFileInfo(null);
        setIsFolderSelection(false);
        setLoading(true);
        setError(null);

        // If leaving a 3D preview, add a brief cooldown to let R3F dispose the
        // WebGL context fully before we mount the next component
        if (was3D) {
            setWebglCooldown(true);
        }

        const filePath = `${projectPath}/${selectedFile}`;
        let cancelled = false;

        const loadFileInfo = async () => {
            // If transitioning from 3D, wait a frame for WebGL cleanup
            if (was3D) {
                await new Promise<void>(resolve => {
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            if (!cancelled) setWebglCooldown(false);
                            resolve();
                        });
                    });
                });
            }

            try {
                // One IPC call: returns { is_directory, info? } — folders
                // skip the file pipeline, files get their FileInfo back in
                // the same round-trip.
                const inspection = await api.inspectPath(filePath);
                if (cancelled) return;
                if (inspection.is_directory) {
                    setIsFolderSelection(true);
                    setLoading(false);
                    prevFileInfoRef.current = null;
                    return;
                }
                if (!inspection.info) {
                    throw new Error('File not found');
                }
                setFileInfo(inspection.info as unknown as FileInfo);
                prevFileInfoRef.current = inspection.info as unknown as FileInfo;
            } catch (err) {
                if (cancelled) return;
                console.error('[PreviewPanel] Error:', err);
                setError((err as Error).message || 'Failed to load file');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        loadFileInfo();
        return () => { cancelled = true; };
    }, [selectedFile, projectPath]);

    if (!selectedFile || !projectPath) {
        return (
            <div className="preview-panel">
                <EmptyState />
            </div>
        );
    }

    const filePath = `${projectPath}/${selectedFile}`;
    const fileName = filePath.split('\\').pop() || filePath.split('/').pop() || filePath;
    const isImage = fileInfo?.file_type?.startsWith('image/');

    // Folder selection short-circuits the entire file-preview pipeline.
    // The grid view owns its own header and reads the folder contents
    // directly via Rust; we just give it the absolute path and it handles
    // the rest, including the "up" button.
    if (isFolderSelection) {
        return (
            <div className="preview-panel">
                <FolderGridView
                    folderAbsPath={filePath}
                    projectPath={projectPath}
                    folderRelPath={selectedFile}
                />
            </div>
        );
    }

    const renderPreview = () => {
        if (loading || webglCooldown) {
            return (
                <div className="preview-panel__loading">
                    <div className="spinner" />
                    <span>Loading...</span>
                </div>
            );
        }

        if (error) {
            return <ErrorState message={error} />;
        }

        if (!fileInfo) {
            return <EmptyState />;
        }

        // Guard: if fileInfo is stale (from a previous file), show loading.
        // Prevents wrong routing during the render between selectedFile
        // changing and useEffect clearing fileInfo.
        if (fileInfo.path !== filePath) {
            return (
                <div className="preview-panel__loading">
                    <div className="spinner" />
                    <span>Loading...</span>
                </div>
            );
        }

        // Choose preview component based on file type
        // IMPORTANT: Use filePath as key to force full unmount/remount when switching files
        // This ensures proper cleanup of WebGL contexts and other resources
        if (fileInfo.file_type.startsWith('image/')) {
            return <ImagePreview key={filePath} filePath={filePath} zoom={imageZoom} onZoomChange={setImageZoom} />;
        }

        // HUD editor for ritobin files in HUD paths (dev only)
        // Check for uibase.ritobin or any .ritobin in the HUD directory structure
        const isHudFile = (fileInfo.extension === 'ritobin' || selectedFile.endsWith('.ritobin')) &&
            (selectedFile.includes('uibase') || selectedFile.includes('loadingscreen'));

        if (isHudFile && import.meta.env.DEV) {
            return <HUDEditor key={filePath} filePath={filePath} />;
        }

        if (fileInfo.extension === 'bin' || fileInfo.file_type === 'application/x-bin') {
            return <BinEditor key={filePath} filePath={filePath} />;
        }

        if (fileInfo.extension === 'luabin64' || fileInfo.extension === 'luabin' || fileInfo.file_type === 'application/x-luabin') {
            return <LuabinViewer key={filePath} filePath={filePath} />;
        }

        if (fileInfo.extension === 'troybin' || fileInfo.file_type === 'application/x-troybin') {
            return <TroybinViewer key={filePath} filePath={filePath} />;
        }

        if (fileInfo.extension === 'inibin' || fileInfo.extension === 'cfgbin' || fileInfo.file_type === 'application/x-inibin') {
            return <InibinEditor key={filePath} filePath={filePath} />;
        }

        if (fileInfo.extension === 'stringtable' || fileInfo.extension === 'rst' || fileInfo.file_type === 'application/x-stringtable') {
            return <StringTableEditor key={filePath} filePath={filePath} />;
        }

        if (fileInfo.extension === 'manifest' || fileInfo.extension === 'rman' || fileInfo.file_type === 'application/x-manifest') {
            return <ManifestViewer key={filePath} filePath={filePath} />;
        }

        if (
            fileInfo.file_type.startsWith('text/') ||
            fileInfo.extension === 'json' ||
            fileInfo.extension === 'py' ||
            fileInfo.extension === 'ini' ||
            fileInfo.extension === 'preload'
        ) {
            return <TextPreview key={filePath} filePath={filePath} />;
        }

        // Wwise audio banks (BNK / WPK)
        if (
            fileInfo.extension === 'bnk' || fileInfo.extension === 'wpk' ||
            fileInfo.file_type === 'audio/x-wwise-bnk' || fileInfo.file_type === 'audio/x-wwise-wpk'
        ) {
            return <BnkPreview key={filePath} filePath={filePath} />;
        }

        // 3D model preview for SKN files — no `key` here so swapping files
        // reuses the same Babylon engine + WebGL context instead of paying
        // 50–200ms to allocate a new one.
        if (fileInfo.extension === 'skn' || fileInfo.file_type === 'model/x-lol-skn') {
            return <ModelPreview filePath={filePath} meshType="skinned" />;
        }

        // 3D model preview for SCB/SCO static mesh files
        if (
            fileInfo.extension === 'scb' || fileInfo.extension === 'sco' ||
            fileInfo.file_type === 'model/x-lol-scb' || fileInfo.file_type === 'model/x-lol-sco'
        ) {
            return <ModelPreview filePath={filePath} meshType="static" />;
        }

        // TODO: Add SKL skeleton preview once ltk_mesh supports it
        // if (fileInfo.extension === 'skl' || fileInfo.file_type === 'model/x-lol-skl') {
        //     return <SkeletonPreview key={filePath} filePath={filePath} />;
        // }

        return <UnknownPreview key={filePath} filePath={filePath} />;
    };

    return (
        <div className="preview-panel">
            {/* Toolbar */}
            <div className="preview-panel__toolbar">
                {isImage && (
                    <div className="preview-panel__zoom-controls">
                        <button
                            className={`btn btn--sm ${imageZoom === 'fit' ? 'btn--active' : ''}`}
                            onClick={() => setImageZoom('fit')}
                        >
                            Fit
                        </button>
                        <button
                            className={`btn btn--sm ${imageZoom === 1 ? 'btn--active' : ''}`}
                            onClick={() => setImageZoom(1)}
                        >
                            100%
                        </button>
                        <button
                            className={`btn btn--sm ${imageZoom === 2 ? 'btn--active' : ''}`}
                            onClick={() => setImageZoom(2)}
                        >
                            200%
                        </button>
                        <div className="preview-panel__divider" style={{ width: '1px', height: '16px', background: 'var(--border)', margin: '0 8px' }} />
                        <button
                            className="btn btn--sm"
                            onClick={() => openModal('recolor', { filePath: selectedFile })}
                        >
                            <span dangerouslySetInnerHTML={{ __html: getIcon('texture') }} />
                            <span>Recolor</span>
                        </button>
                    </div>
                )}
                <span className="preview-panel__filename">{fileName}</span>
            </div>

            {/* Content */}
            <div className="preview-panel__content">
                <PreviewErrorBoundary fileKey={filePath}>
                    {renderPreview()}
                </PreviewErrorBoundary>
            </div>

            {/* Info bar */}
            {fileInfo && (
                <div className="preview-panel__info-bar">
                    <div className="preview-panel__info-left">
                        <span className="preview-panel__info-item">
                            <span className="preview-panel__info-label">Type: </span>
                            {getTypeLabel(fileInfo.file_type, selectedFile)}
                        </span>
                        {fileInfo.dimensions && (
                            <span className="preview-panel__info-item">
                                <span className="preview-panel__info-label">Dimensions: </span>
                                {fileInfo.dimensions[0]}×{fileInfo.dimensions[1]}
                            </span>
                        )}
                        <span className="preview-panel__info-item">
                            <span className="preview-panel__info-label">Size: </span>
                            {formatFileSize(fileInfo.size)}
                        </span>
                    </div>
                    {/* Conditional buttons for BIN files */}
                    {((fileInfo.extension === 'bin' || fileInfo.file_type === 'application/x-bin') && ((jadePath && jadePath.trim() !== '') || (quartzPath && quartzPath.trim() !== ''))) ? (
                        <div style={{ display: 'flex', gap: '8px' }}>
                            {jadePath && jadePath.trim() !== '' && (
                                <button
                                    className="preview-panel__open-btn"
                                    onClick={async () => {
                                        try {
                                            const normalizedPath = filePath.replace(/\//g, '\\');
                                            await api.launchJade(normalizedPath, jadePath);
                                        } catch (err) {
                                            const message = (err as Error).message || String(err);
                                            console.error('[PreviewPanel] Failed to launch Jade:', message);
                                            showToast('error', `Failed to launch Jade: ${message}`);
                                        }
                                    }}
                                    title="Open with Jade League Bin Editor"
                                >
                                    <JadeIcon size={14} />
                                    <span>Jade</span>
                                </button>
                            )}
                            {quartzPath && quartzPath.trim() !== '' && (
                                <button
                                    className="preview-panel__open-btn"
                                    onClick={async () => {
                                        try {
                                            const normalizedPath = filePath.replace(/\//g, '\\');
                                            await api.launchQuartz(normalizedPath, quartzPath);
                                        } catch (err) {
                                            const message = (err as Error).message || String(err);
                                            console.error('[PreviewPanel] Failed to launch Quartz:', message);
                                            showToast('error', `Failed to launch Quartz: ${message}`);
                                        }
                                    }}
                                    title="Open with Quartz VFX Editor"
                                >
                                    <QuartzIcon size={14} />
                                    <span>Quartz</span>
                                </button>
                            )}
                        </div>
                    ) : (
                        <button
                            className="preview-panel__open-btn"
                            onClick={async () => {
                                try {
                                    // Normalize path: ensure consistent backslashes for Windows
                                    const normalizedPath = filePath.replace(/\//g, '\\');
                                    await api.openWithDefaultApp(normalizedPath);
                                } catch (err) {
                                    const message = (err as Error).message || String(err);
                                    console.error('[PreviewPanel] Failed to open file:', message);
                                    alert(`Failed to open file:\n${message}`);
                                }
                            }}
                            title="Open with default application"
                        >
                            <span dangerouslySetInnerHTML={{ __html: getIcon('folderOpen2') }} />
                            <span>Open</span>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};
