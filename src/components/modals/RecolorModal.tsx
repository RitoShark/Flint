/**
 * Flint - Recolor Modal Component
 * Supports multiple recoloring modes: Hue Shift, Colorize, and Grayscale+Tint.
 */

import React, { useState, useEffect } from 'react';
import { useModalStore, useNotificationStore, useAppMetadataStore, useProjectTabStore } from '../../lib/stores';
import * as api from '../../lib/api';
import {
    Button,
    Checkbox,
    FormGroup,
    FormHint,
    FormLabel,
    Icon,
    type IconName,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Range,
    Spinner,
} from '../ui';

interface RecolorModalOptions {
    filePath: string;
    isFolder?: boolean;
}

type RecolorMode = 'hueShift' | 'colorize' | 'grayscale';

const COLOR_PRESETS = [
    { name: 'Red', hue: 0, color: '#ff4444' },
    { name: 'Orange', hue: 30, color: '#ff8844' },
    { name: 'Gold', hue: 45, color: '#ffcc44' },
    { name: 'Green', hue: 120, color: '#44ff44' },
    { name: 'Cyan', hue: 180, color: '#44ffff' },
    { name: 'Blue', hue: 220, color: '#4488ff' },
    { name: 'Purple', hue: 280, color: '#aa44ff' },
    { name: 'Pink', hue: 320, color: '#ff44aa' },
];

const MODE_TABS: { id: RecolorMode; label: string; icon: IconName }[] = [
    { id: 'hueShift', label: 'Hue Shift', icon: 'color-palette' as IconName },
    { id: 'colorize', label: 'Colorize', icon: 'paint-bucket' as IconName },
    { id: 'grayscale', label: 'Grayscale + Tint', icon: 'contrast' as IconName },
];

interface RangeFieldProps {
    label: string;
    value: number;
    formatValue?: (v: number) => string;
    onReset?: () => void;
    min: number;
    max: number;
    step?: number;
    className?: string;
    style?: React.CSSProperties;
    onChange: (v: number) => void;
    hue?: boolean;
}

const RangeField: React.FC<RangeFieldProps> = ({
    label,
    value,
    formatValue,
    onReset,
    min,
    max,
    step = 1,
    className,
    style,
    onChange,
    hue,
}) => (
    <FormGroup>
        <FormLabel>
            {label}: {formatValue ? formatValue(value) : value}
            {onReset && (
                <Button variant="ghost" size="sm" onClick={onReset} style={{ marginLeft: 8 }}>
                    Reset
                </Button>
            )}
        </FormLabel>
        <Range
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            hue={hue}
            className={className}
            style={style}
        />
    </FormGroup>
);

export const RecolorModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);
    const showToast = useNotificationStore((s) => s.showToast);
    const setWorking = useAppMetadataStore((s) => s.setWorking);
    const setReady = useAppMetadataStore((s) => s.setReady);
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);

    const activeTab = activeTabId
        ? openTabs.find((t) => t.id === activeTabId)
        : null;
    const currentProjectPath = activeTab?.projectPath || null;
    const fileTree = activeTab?.fileTree || null;

    const [mode, setMode] = useState<RecolorMode>('colorize');

    const [hue, setHue] = useState(0);
    const [saturation, setSaturation] = useState(1);
    const [brightness, setBrightness] = useState(1);

    const [targetHue, setTargetHue] = useState(0);
    const [preserveSaturation, setPreserveSaturation] = useState(true);

    const [imageData, setImageData] = useState<string | null>(null);
    const [imageData2, setImageData2] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [showOriginal, setShowOriginal] = useState(false);

    const [createCheckpoint, setCreateCheckpoint] = useState(true);
    const [skipDistortion, setSkipDistortion] = useState(true);
    const [folderImagePaths, setFolderImagePaths] = useState<string[]>([]);

    const isVisible = activeModal === 'recolor';
    const options = modalOptions as RecolorModalOptions | null;
    const isFolder = options?.isFolder || false;

    useEffect(() => {
        if (isVisible && options?.filePath) {
            if (isFolder) loadFolderPreviews();
            else loadImage();
        } else {
            setHue(0);
            setSaturation(1);
            setBrightness(1);
            setTargetHue(0);
            setImageData(null);
            setImageData2(null);
            setFolderImagePaths([]);
            setShowOriginal(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVisible, options?.filePath, isFolder]);

    const loadFolderPreviews = async () => {
        if (!options?.filePath || !fileTree) return;

        setLoading(true);
        try {
            const normalize = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase().replace(/\/$/, '');
            const targetPath = normalize(options.filePath);

            const findNode = (node: any): any => {
                const nodePath = normalize(node.path);
                if (nodePath === targetPath) return node;
                if (node.children) {
                    for (const child of node.children) {
                        const found = findNode(child);
                        if (found) return found;
                    }
                }
                return null;
            };

            const folderNode = findNode(fileTree);
            if (!folderNode || !folderNode.children) {
                setLoading(false);
                return;
            }

            const textures: string[] = [];
            const findTextures = (node: any) => {
                if (textures.length >= 2) return;
                if (!node.isDirectory) {
                    const name = node.name.toLowerCase();
                    if (name.endsWith('.dds') || name.endsWith('.tex')) {
                        textures.push(node.path);
                    }
                }
                if (node.children) {
                    for (const child of node.children) findTextures(child);
                }
            };

            findTextures(folderNode);
            setFolderImagePaths(textures);

            if (textures.length > 0) {
                const loadImageData = async (path: string) => {
                    const absPath = currentProjectPath ? `${currentProjectPath}/${path}` : path;
                    const result = await api.decodeDdsToPng(absPath);
                    return `data:image/png;base64,${result.data}`;
                };

                const data1 = await loadImageData(textures[0]);
                setImageData(data1);

                if (textures.length > 1) {
                    const data2 = await loadImageData(textures[1]);
                    setImageData2(data2);
                }
            }
        } catch (err) {
            console.error('[RecolorModal] Failed to load folder previews:', err);
        } finally {
            setLoading(false);
        }
    };

    const loadImage = async () => {
        if (!options?.filePath) return;
        setLoading(true);
        try {
            const absPath = currentProjectPath ? `${currentProjectPath}/${options.filePath}` : options.filePath;
            const result = await api.decodeDdsToPng(absPath);
            setImageData(`data:image/png;base64,${result.data}`);
        } catch (err) {
            console.error('[RecolorModal] Failed to load image:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        if (!options?.filePath) return;

        try {
            const absPath = currentProjectPath ? `${currentProjectPath}/${options.filePath}` : options.filePath;

            if (createCheckpoint && currentProjectPath) {
                setWorking('Creating checkpoint...');
                try {
                    await api.createCheckpoint(
                        currentProjectPath,
                        `Before recolor: ${options.filePath.split('/').pop()}`,
                        ['auto', 'recolor'],
                    );
                } catch (err) {
                    console.warn('[RecolorModal] Failed to create checkpoint:', err);
                }
            }

            setWorking(isFolder ? 'Recoloring folder...' : 'Recoloring image...');

            if (mode === 'hueShift') {
                if (isFolder) {
                    const result = await api.recolorFolder(absPath, hue, saturation, brightness, skipDistortion);
                    showToast('success', `Recolored ${result.processed} files. (${result.processed + result.failed} total)`);
                } else {
                    await api.recolorImage(absPath, hue, saturation, brightness);
                    showToast('success', 'Image recolored successfully');
                }
            } else if (mode === 'colorize') {
                if (isFolder) {
                    const result = await api.colorizeFolder(absPath, targetHue, preserveSaturation, skipDistortion);
                    showToast('success', `Colorized ${result.processed} files to ${getHueName(targetHue)}`);
                } else {
                    await api.colorizeImage(absPath, targetHue, preserveSaturation);
                    showToast('success', `Image colorized to ${getHueName(targetHue)}`);
                }
            } else if (mode === 'grayscale') {
                if (isFolder) {
                    const result = await api.colorizeFolder(absPath, targetHue, false);
                    showToast('success', `Applied grayscale + tint to ${result.processed} files`);
                } else {
                    await api.colorizeImage(absPath, targetHue, false);
                    showToast('success', 'Applied grayscale + tint');
                }
            }

            closeModal();
            setReady();
        } catch (err) {
            console.error('[RecolorModal] Error:', err);
            showToast('error', `Failed to recolor: ${(err as Error).message}`);
            setReady();
        }
    };

    const getHueName = (h: number): string => {
        const preset = COLOR_PRESETS.find((p) => Math.abs(p.hue - h) < 15);
        return preset?.name || `Hue ${h}°`;
    };

    const getPreviewStyle = (): React.CSSProperties => {
        const base: React.CSSProperties = {
            maxWidth: '100%',
            maxHeight: 450,
            objectFit: 'contain',
            borderRadius: 4,
            backgroundColor: '#1a1a1a',
            display: imageData ? 'block' : 'none',
        };

        if (showOriginal) return base;

        if (mode === 'hueShift') {
            return { ...base, filter: `hue-rotate(${hue}deg) saturate(${saturation}) brightness(${brightness})` };
        }

        const satValue = mode === 'grayscale' ? 0.7 : preserveSaturation ? 1 : 0.8;
        return {
            ...base,
            filter: `grayscale(100%) sepia(100%) saturate(${satValue * 100}%) hue-rotate(${targetHue - 50}deg)`,
        };
    };

    return (
        <Modal open={isVisible} onClose={closeModal} size="large" modifier="recolor-modal">
            <ModalHeader title={isFolder ? 'Batch Recolor Folder' : 'Recolor Texture'} onClose={closeModal} />

            <ModalBody>
                <div className="recolor-modal__tabs">
                    {MODE_TABS.map((tab) => (
                        <button
                            key={tab.id}
                            className={`recolor-modal__tab ${mode === tab.id ? 'recolor-modal__tab--active' : ''}`}
                            onClick={() => setMode(tab.id)}
                        >
                            <Icon name={tab.icon} />
                            {tab.label}
                        </button>
                    ))}
                </div>

                <div className="recolor-modal__top">
                    <div
                        className="recolor-modal__preview"
                        onClick={() => setShowOriginal(!showOriginal)}
                        title="Click to toggle original/preview"
                    >
                        {loading && <Spinner />}

                        {imageData || imageData2 ? (
                            <div className="recolor-modal__image-container">
                                <div className={`recolor-modal__previews ${imageData2 ? 'recolor-modal__previews--dual' : ''}`}>
                                    {imageData && <img src={imageData} style={getPreviewStyle()} alt="Preview 1" />}
                                    {imageData2 && <img src={imageData2} style={getPreviewStyle()} alt="Preview 2" />}
                                </div>
                                <div className="recolor-modal__preview-badge">
                                    {showOriginal ? 'Original' : 'Preview'}
                                    <span className="text-muted"> — Click to toggle</span>
                                </div>
                                {isFolder && folderImagePaths.length > 0 && (
                                    <p className="recolor-modal__preview-hint">
                                        Batch Preview: {folderImagePaths.length} textures found in folder
                                    </p>
                                )}
                            </div>
                        ) : !isFolder ? (
                            <div className="recolor-modal__placeholder">Loading preview...</div>
                        ) : (
                            <div className="recolor-modal__placeholder">
                                <Icon name="folder" />
                                <p>No textures found in this folder</p>
                            </div>
                        )}
                    </div>

                    <div className="recolor-modal__controls">
                        {mode === 'hueShift' && (
                            <>
                                <RangeField
                                    label="Hue"
                                    value={hue}
                                    formatValue={(v) => `${v}°`}
                                    onReset={() => setHue(0)}
                                    min={-180}
                                    max={180}
                                    onChange={setHue}
                                    hue
                                />
                                <RangeField
                                    label="Saturation"
                                    value={saturation}
                                    formatValue={(v) => `${v.toFixed(1)}x`}
                                    onReset={() => setSaturation(1)}
                                    min={0}
                                    max={2}
                                    step={0.01}
                                    className="form-range--saturation"
                                    style={{ background: 'linear-gradient(to right, #808080, var(--accent-primary))' }}
                                    onChange={setSaturation}
                                />
                                <RangeField
                                    label="Brightness"
                                    value={brightness}
                                    formatValue={(v) => `${v.toFixed(1)}x`}
                                    onReset={() => setBrightness(1)}
                                    min={0}
                                    max={2}
                                    step={0.01}
                                    className="form-range--brightness"
                                    style={{ background: 'linear-gradient(to right, #000, #fff)' }}
                                    onChange={setBrightness}
                                />
                            </>
                        )}

                        {(mode === 'colorize' || mode === 'grayscale') && (
                            <>
                                <FormGroup>
                                    <FormLabel>Target Color</FormLabel>
                                    <div className="recolor-modal__color-presets">
                                        {COLOR_PRESETS.map((preset) => (
                                            <button
                                                key={preset.hue}
                                                className={`recolor-modal__color-btn ${Math.abs(targetHue - preset.hue) < 10 ? 'recolor-modal__color-btn--active' : ''}`}
                                                style={{ backgroundColor: preset.color }}
                                                onClick={() => setTargetHue(preset.hue)}
                                                title={preset.name}
                                            />
                                        ))}
                                    </div>
                                </FormGroup>

                                <RangeField
                                    label="Hue"
                                    value={targetHue}
                                    formatValue={(v) => `${v}° (${getHueName(v)})`}
                                    min={0}
                                    max={360}
                                    onChange={setTargetHue}
                                    hue
                                />

                                {mode === 'colorize' && (
                                    <FormGroup>
                                        <Checkbox
                                            checked={preserveSaturation}
                                            onChange={(e) => setPreserveSaturation(e.target.checked)}
                                            label="Preserve original color intensity"
                                        />
                                    </FormGroup>
                                )}

                                <div className="recolor-modal__mode-hint">
                                    {mode === 'colorize' ? (
                                        <p>Colorize replaces all hues with a single color while keeping the original shading and detail.</p>
                                    ) : (
                                        <p>Grayscale + Tint converts to monochrome and applies a subtle color overlay.</p>
                                    )}
                                </div>
                            </>
                        )}

                        <FormGroup className="recolor-modal__checkpoint">
                            <Checkbox
                                checked={createCheckpoint}
                                onChange={(e) => setCreateCheckpoint(e.target.checked)}
                                label="Create checkpoint before recoloring"
                            />
                        </FormGroup>

                        {isFolder && (
                            <FormGroup>
                                <Checkbox
                                    checked={skipDistortion}
                                    onChange={(e) => setSkipDistortion(e.target.checked)}
                                    label="Skip distortion textures"
                                />
                                <FormHint>Distortion textures use UV effects and should not be recolored</FormHint>
                            </FormGroup>
                        )}
                    </div>
                </div>

                <div className="recolor-modal__info">
                    <Icon name="warning" />
                    <span>Warning: This will overwrite the original file(s). Mipmaps will be regenerated.</span>
                </div>
            </ModalBody>

            <ModalFooter>
                <Button variant="secondary" onClick={closeModal}>
                    Cancel
                </Button>
                <Button variant="primary" onClick={handleSave}>
                    {isFolder ? 'Recolor All Files' : 'Apply Changes'}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
