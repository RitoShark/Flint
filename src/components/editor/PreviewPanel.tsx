import React, { useState, useEffect, useRef } from 'react';
import { useConfigStore, useProjectTabStore, useModalStore, useNotificationStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { Icon } from '../ui/Icon';
import { requestUnhash } from '../../lib/editor/binEditorEvents';
import { openWadInExtract, isWadPath } from '../../lib/openWad';
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

/**
 * The skinned-model viewer, serving BOTH `.skn` and `.anm` selections.
 *
 * A `.skn` renders directly; a `.anm` is first resolved to the `.skn` its skin BIN references
 * (`simpleSkin`) and then handed to the same `ModelPreview` as `initialAnimation`. Because both
 * selections render this one component at the same spot in the tree, clicking clip after clip —
 * or jumping from the model to one of its clips — keeps ONE viewer, engine and camera alive and
 * only swaps the animation. `ModelPreview` is keyed by the resolved `.skn`, so it only remounts
 * when the model genuinely changes.
 */
const SkinnedPreview: React.FC<{ filePath: string }> = ({ filePath }) => {
    type Resolved = { sknPath: string; anmAssetPath?: string };
    const [state, setState] = useState<
        { status: 'loading' } |
        { status: 'ok'; res: Resolved } |
        { status: 'error'; message: string }
    >({ status: 'loading' });
    // Set for one frame when the MODEL changes, so the outgoing engine's WebGL context is
    // released before the next one is created. PreviewPanel does the same for .skn → .skn; it
    // has to happen here for switches that pass through an .anm resolve.
    const [swapping, setSwapping] = useState(false);
    const mountedSknRef = useRef<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        // Keep whatever is on screen while resolving — blanking would unmount the very viewer
        // we're trying to reuse.
        setState(prev => (prev.status === 'ok' ? prev : { status: 'loading' }));

        const apply = (res: Resolved) => {
            if (cancelled) return;
            // Nothing mounted (first open, or we're already inside a gap) → mount straight away.
            if (mountedSknRef.current !== null && mountedSknRef.current !== res.sknPath) {
                setSwapping(true);
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    // A superseding selection leaves `swapping` set; its own apply/catch clears
                    // it, so the gap can never strand the pane on a spinner.
                    if (cancelled) return;
                    setSwapping(false);
                    setState({ status: 'ok', res });
                }));
                return;
            }
            setSwapping(false);
            setState({ status: 'ok', res });
        };

        const fail = (err: unknown) => {
            if (cancelled) return;
            setSwapping(false);
            setState({ status: 'error', message: (err as Error)?.message ?? String(err) });
        };

        if (!isAnmPath(filePath)) {
            apply({ sknPath: filePath });
            return () => { cancelled = true; };
        }
        api.resolveAnmSkin(filePath)
            .then(res => apply({ sknPath: res.skn_path, anmAssetPath: res.anm_asset_path }))
            .catch(fail);
        return () => { cancelled = true; };
    }, [filePath]);

    const mounted = state.status === 'ok' && !swapping ? state.res.sknPath : null;
    useEffect(() => { mountedSknRef.current = mounted; }, [mounted]);

    if (swapping || state.status === 'loading') {
        return (
            <div className="model-preview__overlay model-preview__overlay--loading">
                <div className="spinner" />
                <span>{isAnmPath(filePath) ? 'Resolving skin for animation...' : 'Loading model...'}</span>
            </div>
        );
    }
    if (state.status === 'error') {
        return <UnknownPreview key={filePath} filePath={filePath} />;
    }
    return (
        <ModelPreview
            key={state.res.sknPath}
            filePath={state.res.sknPath}
            meshType="skinned"
            initialAnimation={state.res.anmAssetPath}
            autoPlay={!!state.res.anmAssetPath}
        />
    );
};

const WadArchiveNotice: React.FC<{ filePath: string }> = ({ filePath }) => (
    <div className="preview-panel__empty">
        <div className="preview-panel__empty-icon" dangerouslySetInnerHTML={{ __html: getIcon('wad') }} />
        <div className="preview-panel__empty-text">This is a WAD archive.</div>
        <button
            className="dl-btn dl-btn--primary"
            style={{ marginTop: 12 }}
            onClick={() => { openWadInExtract(filePath).catch(() => {}); }}
        >
            Open in WAD viewer
        </button>
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

const is3DType = (info: FileInfo | null): boolean => {
    if (!info) return false;
    return info.extension === 'skn' || info.extension === 'scb' || info.extension === 'sco' ||
        info.file_type === 'model/x-lol-skn' || info.file_type === 'model/x-lol-scb' ||
        info.file_type === 'model/x-lol-sco';
};

// Extensions straight off the path — known before `inspectPath` comes back.
const isAnmPath = (path: string): boolean => /\.anm$/i.test(path);
/** Both are served by `SkinnedPreview`, so switching between them reuses one viewer. */
const isSkinnedPath = (path: string): boolean => isAnmPath(path) || /\.skn$/i.test(path);

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
    // The selectedFile value the folder decision was made FOR (via inspectPath).
    // Keyed by path instead of a boolean so a stale `true` from the previous
    // folder can never render FolderGridView with a freshly-selected FILE path
    // (which fired `list_folder_contents` on a file → "Not a folder" error).
    const [folderSelPath, setFolderSelPath] = useState<string | null>(null);

    const [webglCooldown, setWebglCooldown] = useState(false);
    const prevFileInfoRef = useRef<FileInfo | null>(null);

    const activeTab = activeTabId
        ? openTabs.find(t => t.id === activeTabId)
        : null;
    const selectedFile = activeTab?.selectedFile || null;
    const projectPath = activeTab?.projectPath || null;

    useEffect(() => {
        if (!selectedFile || !projectPath) {
            setFileInfo(null);
            setFolderSelPath(null);
            setLoading(false);
            return;
        }

        const was3D = is3DType(prevFileInfoRef.current);
        // Moving between .skn/.anm keeps the SAME SkinnedPreview (and its engine and camera)
        // mounted — it just swaps the clip. Blanking the pane for the inspect round-trip, or
        // cycling the WebGL context, would tear down the very viewer we're reusing;
        // SkinnedPreview owns the context gap for the case where the model really does change.
        const prevExt = prevFileInfoRef.current?.extension;
        const keepSkinnedViewer =
            (prevExt === 'skn' || prevExt === 'anm') && isSkinnedPath(selectedFile);

        if (!keepSkinnedViewer) {
            setFileInfo(null);
            setFolderSelPath(null);
            setLoading(true);
        }
        setError(null);

        if (was3D && !keepSkinnedViewer) {
            setWebglCooldown(true);
        }

        const filePath = `${projectPath}/${selectedFile}`;
        let cancelled = false;

        const loadFileInfo = async () => {
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
                const inspection = await api.inspectPath(filePath);
                if (cancelled) return;
                if (inspection.is_directory) {
                    setFolderSelPath(selectedFile);
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
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    const isImage = fileInfo?.file_type?.startsWith('image/');

    /* The BIN editor renders its own toolbar with the filename, line count and
       actions all on ONE row. Showing the panel's header above it would add a
       second, near-empty bar carrying nothing but the same name. */
    const isBinEditor =
        fileInfo?.extension === 'bin' || fileInfo?.file_type === 'application/x-bin';

    // Only render the folder view when the folder decision matches the CURRENT
    // selection — during the one render where selectedFile already changed but
    // the inspect effect hasn't run yet, this mismatches and we fall through to
    // the loading state instead of listing a file path as a folder.
    if (folderSelPath === selectedFile) {
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

        // Routed off the PATH, above the mismatch guard below: on a .skn/.anm switch the
        // fileInfo in hand is still the previous selection's, and falling through to the
        // spinner would tear the live viewer down. SkinnedPreview resolves the path itself and
        // is deliberately NOT keyed by it, so it swaps the clip in place.
        if (isSkinnedPath(filePath) && (fileInfo.extension === 'skn' || fileInfo.extension === 'anm' ||
            fileInfo.file_type === 'model/x-lol-skn' || fileInfo.file_type === 'model/x-lol-anm')) {
            return <SkinnedPreview filePath={filePath} />;
        }

        if (fileInfo.path !== filePath) {
            return (
                <div className="preview-panel__loading">
                    <div className="spinner" />
                    <span>Loading...</span>
                </div>
            );
        }

        if (isWadPath(selectedFile || filePath || '') || fileInfo.extension === 'wad' || fileInfo.extension === 'client') {
            return <WadArchiveNotice filePath={filePath} />;
        }

        if (fileInfo.file_type.startsWith('image/')) {
            return <ImagePreview key={filePath} filePath={filePath} zoom={imageZoom} onZoomChange={setImageZoom} />;
        }

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

        if (
            fileInfo.extension === 'bnk' || fileInfo.extension === 'wpk' ||
            fileInfo.file_type === 'audio/x-wwise-bnk' || fileInfo.file_type === 'audio/x-wwise-wpk'
        ) {
            return <BnkPreview key={filePath} filePath={filePath} />;
        }


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
            {!isBinEditor && (
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
            )}

            <div className="preview-panel__content">
                <PreviewErrorBoundary fileKey={filePath}>
                    {renderPreview()}
                </PreviewErrorBoundary>
            </div>

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
                    {(fileInfo.extension === 'bin' || fileInfo.file_type === 'application/x-bin') ? (
                        <div className="preview-panel__info-actions">
                            {/* Unhash lives here rather than in the editor's top
                                toolbar — it's a one-shot document action, so it
                                belongs beside the other file-level actions. */}
                            <button
                                className="preview-panel__open-btn"
                                onClick={() => requestUnhash(filePath)}
                                title="Unhash: re-resolve any 0x… hash tokens against the known BIN hash dictionary"
                            >
                                <Icon name="search" className="preview-panel__btn-icon" />
                                <span>Unhash</span>
                            </button>
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
                                    <img
                                        className="preview-panel__app-logo"
                                        src="/jade-logo.webp"
                                        alt=""
                                        draggable={false}
                                    />
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
                                    <img
                                        className="preview-panel__app-logo"
                                        src="/quartz-logo.webp"
                                        alt=""
                                        draggable={false}
                                    />
                                    <span>Quartz</span>
                                </button>
                            )}
                        </div>
                    ) : (
                        <button
                            className="preview-panel__open-btn"
                            onClick={async () => {
                                try {
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
