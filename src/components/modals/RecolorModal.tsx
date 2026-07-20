import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useModalStore, useNotificationStore, useAppMetadataStore, useProjectTabStore } from '../../lib/stores';
import * as api from '../../lib/api';
import {
    Button,
    Checkbox,
    FormGroup,
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
import { SettingsRow } from './settings/SettingsRow';
import { applyHueShift, applyColorize, applyGrayscaleTint, hslToRgb } from '../../lib/recolor/previewPixels';

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

const MODE_TABS: { id: RecolorMode; label: string; icon: IconName; hint: string }[] = [
    {
        id: 'hueShift',
        label: 'Hue Shift',
        icon: 'color-palette' as IconName,
        hint: 'Rotate every colour around the wheel by a fixed amount, keeping the existing palette relationships — reds become greens, greens become blues, and so on. Also adjusts saturation and brightness.',
    },
    {
        id: 'colorize',
        label: 'Colorize',
        icon: 'paint-bucket' as IconName,
        hint: 'Replace every hue in the texture with one single target colour, while keeping the original brightness/shading so the detail and shape survive. Great for a clean one-colour reskin (e.g. turn a red skin fully blue).',
    },
    {
        id: 'grayscale',
        label: 'Grayscale + Tint',
        icon: 'contrast' as IconName,
        hint: 'Strip the texture to greyscale (luminance only), then lay a subtle wash of the target colour over it — a muted, monochrome tint rather than a full recolour.',
    },
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

const fileName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/* A vivid, fully-saturated swatch colour for a hue — the live "target colour". */
const hueToHex = (h: number): string => {
    const [r, g, b] = hslToRgb(h, 0.85, 0.55);
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
};

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
    const [presetsOpen, setPresetsOpen] = useState(false);

    const [imageData, setImageData] = useState<string | null>(null);
    const [imgLoaded, setImgLoaded] = useState(false);
    const [loading, setLoading] = useState(false);
    const [showOriginal, setShowOriginal] = useState(false);

    const [createCheckpoint, setCreateCheckpoint] = useState(true);
    const [skipDistortion, setSkipDistortion] = useState(true);

    // Folder mode: every texture path in the folder + which one we're viewing.
    const [texturePaths, setTexturePaths] = useState<string[]>([]);
    const [previewIndex, setPreviewIndex] = useState(0);

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const imgElRef = useRef<HTMLImageElement | null>(null);
    // Decode cache so cycling back to an already-seen texture is instant.
    const decodeCacheRef = useRef<Map<string, string>>(new Map());

    // The <img> must reload whenever the source changes before we can redraw.
    useEffect(() => { setImgLoaded(false); }, [imageData]);

    const isVisible = activeModal === 'recolor';
    const options = modalOptions as RecolorModalOptions | null;
    const isFolder = options?.filePath ? (options?.isFolder || false) : false;

    const decodeToDataUrl = useCallback(async (relPath: string): Promise<string> => {
        const cached = decodeCacheRef.current.get(relPath);
        if (cached) return cached;
        const absPath = currentProjectPath ? `${currentProjectPath}/${relPath}` : relPath;
        const result = await api.decodeDdsToPng(absPath);
        const url = `data:image/png;base64,${result.data}`;
        decodeCacheRef.current.set(relPath, url);
        return url;
    }, [currentProjectPath]);

    useEffect(() => {
        if (isVisible && options?.filePath) {
            if (isFolder) loadFolderTextures();
            else loadImage();
        } else {
            setHue(0);
            setSaturation(1);
            setBrightness(1);
            setTargetHue(0);
            setImageData(null);
            setTexturePaths([]);
            setPreviewIndex(0);
            setShowOriginal(false);
            setPresetsOpen(false);
            decodeCacheRef.current.clear();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVisible, options?.filePath, isFolder]);

    // Decode the currently-selected folder texture on demand.
    useEffect(() => {
        if (!isFolder || texturePaths.length === 0) return;
        let cancelled = false;
        setLoading(true);
        decodeToDataUrl(texturePaths[previewIndex])
            .then((url) => { if (!cancelled) setImageData(url); })
            .catch((err) => console.error('[RecolorModal] decode failed:', err))
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isFolder, texturePaths, previewIndex]);

    const loadFolderTextures = async () => {
        if (!options?.filePath || !fileTree) return;
        setLoading(true);
        try {
            const normalize = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase().replace(/\/$/, '');
            const targetPath = normalize(options.filePath);

            const findNode = (node: any): any => {
                if (normalize(node.path) === targetPath) return node;
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
                setTexturePaths([]);
                setLoading(false);
                return;
            }

            const textures: string[] = [];
            const collect = (node: any) => {
                if (!node.isDirectory) {
                    const name = node.name.toLowerCase();
                    if (name.endsWith('.dds') || name.endsWith('.tex')) textures.push(node.path);
                }
                if (node.children) for (const child of node.children) collect(child);
            };
            collect(folderNode);
            textures.sort((a, b) => a.localeCompare(b));

            setPreviewIndex(0);
            setTexturePaths(textures);
            if (textures.length === 0) setLoading(false);
            // the decode effect picks up the first texture
        } catch (err) {
            console.error('[RecolorModal] Failed to load folder textures:', err);
            setLoading(false);
        }
    };

    const loadImage = async () => {
        if (!options?.filePath) return;
        setLoading(true);
        try {
            setImageData(await decodeToDataUrl(options.filePath));
        } catch (err) {
            console.error('[RecolorModal] Failed to load image:', err);
        } finally {
            setLoading(false);
        }
    };

    /* Render the current image to the canvas, applying the active recolor op
       (unless showing the original). Runs live on any control change. */
    useEffect(() => {
        const canvas = canvasRef.current;
        const img = imgElRef.current;
        if (!canvas || !img || !imageData || !imgLoaded || img.naturalWidth === 0) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);

        if (showOriginal) return;

        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (mode === 'hueShift') {
            applyHueShift(frame.data, hue, saturation, brightness);
        } else if (mode === 'colorize') {
            applyColorize(frame.data, targetHue, preserveSaturation);
        } else {
            applyGrayscaleTint(frame.data, targetHue);
        }
        ctx.putImageData(frame, 0, 0);
    }, [imageData, imgLoaded, mode, hue, saturation, brightness, targetHue, preserveSaturation, showOriginal]);

    const handleSave = async () => {
        if (!options?.filePath) return;

        try {
            const absPath = currentProjectPath ? `${currentProjectPath}/${options.filePath}` : options.filePath;

            if (createCheckpoint && currentProjectPath) {
                setWorking('Creating checkpoint...');
                try {
                    await api.createCheckpoint(
                        currentProjectPath,
                        `Before recolor: ${fileName(options.filePath)}`,
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

    const step = (delta: number) => {
        if (texturePaths.length < 2) return;
        setPreviewIndex((i) => (i + delta + texturePaths.length) % texturePaths.length);
    };

    const hasSwap = isFolder && texturePaths.length > 1;
    const currentTexName = isFolder && texturePaths.length > 0
        ? fileName(texturePaths[previewIndex])
        : options ? fileName(options.filePath) : '';

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
                            title={tab.hint}
                        >
                            <Icon name={tab.icon} />
                            {tab.label}
                        </button>
                    ))}
                </div>

                <div className="recolor-modal__top">
                    <div className="recolor-modal__preview-wrap">
                        <div
                            className="recolor-modal__preview"
                            onClick={() => imageData && setShowOriginal((v) => !v)}
                            title="Click to toggle original / preview"
                        >
                            {loading && <Spinner />}

                            {/* Hidden source image feeding the canvas. */}
                            {imageData && (
                                <img
                                    ref={imgElRef}
                                    src={imageData}
                                    alt=""
                                    style={{ display: 'none' }}
                                    onLoad={() => setImgLoaded(true)}
                                />
                            )}

                            {imageData ? (
                                <>
                                    <canvas ref={canvasRef} className="recolor-modal__canvas" />
                                    <div className="recolor-modal__preview-badge">
                                        {showOriginal ? 'Original' : 'Preview'}
                                        <span className="text-muted"> — Click to toggle</span>
                                    </div>
                                </>
                            ) : !isFolder ? (
                                <div className="recolor-modal__placeholder">Loading preview…</div>
                            ) : (
                                <div className="recolor-modal__placeholder">
                                    <Icon name="folder" />
                                    <p>No textures found in this folder</p>
                                </div>
                            )}
                        </div>

                        {isFolder && texturePaths.length > 0 && (
                            <div className="recolor-modal__swap">
                                <button
                                    type="button"
                                    className="dl-btn dl-btn--ghost dl-btn--sm dl-btn--icon"
                                    onClick={() => step(-1)}
                                    disabled={!hasSwap}
                                    aria-label="Previous texture"
                                >
                                    <Icon name="chevronLeft" />
                                </button>
                                <span className="recolor-modal__swap-label" title={texturePaths[previewIndex]}>
                                    {currentTexName}
                                    <span className="recolor-modal__swap-count"> {previewIndex + 1} / {texturePaths.length}</span>
                                </span>
                                <button
                                    type="button"
                                    className="dl-btn dl-btn--ghost dl-btn--sm dl-btn--icon"
                                    onClick={() => step(1)}
                                    disabled={!hasSwap}
                                    aria-label="Next texture"
                                >
                                    <Icon name="chevronRight" />
                                </button>
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
                                    <FormLabel>
                                        Target Color: {targetHue}° ({getHueName(targetHue)})
                                    </FormLabel>
                                    <div className="recolor-modal__hue-row">
                                        <Range
                                            min={0}
                                            max={360}
                                            step={1}
                                            value={targetHue}
                                            onChange={(e) => setTargetHue(parseFloat(e.target.value))}
                                            hue
                                        />
                                        <div className="recolor-modal__swatch-pop">
                                            <button
                                                type="button"
                                                className="recolor-modal__swatch"
                                                style={{ backgroundColor: hueToHex(targetHue) }}
                                                onClick={() => setPresetsOpen((v) => !v)}
                                                title="Pick a preset colour"
                                                aria-label="Pick a preset colour"
                                                aria-expanded={presetsOpen}
                                            />
                                            {presetsOpen && (
                                                <>
                                                    <div
                                                        className="recolor-modal__swatch-scrim"
                                                        onClick={() => setPresetsOpen(false)}
                                                    />
                                                    <div className="recolor-modal__presets-popover" role="menu">
                                                        {COLOR_PRESETS.map((preset) => (
                                                            <button
                                                                key={preset.hue}
                                                                type="button"
                                                                className={`recolor-modal__color-btn ${Math.abs(targetHue - preset.hue) < 10 ? 'recolor-modal__color-btn--active' : ''}`}
                                                                style={{ backgroundColor: preset.color }}
                                                                onClick={() => { setTargetHue(preset.hue); setPresetsOpen(false); }}
                                                                title={preset.name}
                                                                aria-label={preset.name}
                                                            />
                                                        ))}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </FormGroup>

                                {mode === 'colorize' && (
                                    <SettingsRow
                                        icon={<Icon name="contrast" />}
                                        title="Preserve original color intensity"
                                        sub={<span className="settings-row__sub">Keep each pixel's saturation instead of flattening it to a uniform tint</span>}
                                        onActivate={() => setPreserveSaturation((v) => !v)}
                                        actions={<Checkbox toggle checked={preserveSaturation} onChange={(e) => setPreserveSaturation(e.target.checked)} />}
                                    />
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

                        <SettingsRow
                            icon={<Icon name="history" />}
                            title="Create checkpoint before recoloring"
                            sub={<span className="settings-row__sub">Snapshot the project so you can revert this change</span>}
                            onActivate={() => setCreateCheckpoint((v) => !v)}
                            actions={<Checkbox toggle checked={createCheckpoint} onChange={(e) => setCreateCheckpoint(e.target.checked)} />}
                        />

                        {isFolder && (
                            <SettingsRow
                                icon={<Icon name="warning" />}
                                title="Skip distortion textures"
                                sub={<span className="settings-row__sub">Distortion textures use UV effects and should not be recolored</span>}
                                onActivate={() => setSkipDistortion((v) => !v)}
                                actions={<Checkbox toggle checked={skipDistortion} onChange={(e) => setSkipDistortion(e.target.checked)} />}
                            />
                        )}
                    </div>
                </div>

                <div className="recolor-modal__info">
                    <Icon name="warning" />
                    <span>This will overwrite the original file(s). Mipmaps will be regenerated.</span>
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
