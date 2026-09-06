import { Button } from '../ui/Button';
import React, { useState } from 'react';
import { HexViewer } from './HexViewer';
import { TextPreview } from './TextPreview';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { useUxStore } from '../../lib/stores/uxStore';

interface UnknownPreviewProps {
    filePath: string;
}

type ViewMode = 'unknown' | 'hex' | 'text';

/** Lowercased extension of the file, or null when it has none. */
function extOf(filePath: string): string | null {
    const base = filePath.split(/[\\/]/).pop() ?? '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return null;
    return base.slice(dot + 1).toLowerCase();
}

export const UnknownPreview: React.FC<UnknownPreviewProps> = ({ filePath }) => {
    const [viewMode, setViewMode] = useState<ViewMode>('unknown');
    const [remember, setRemember] = useState(false);

    const ext = extOf(filePath);
    const rememberedMode = useUxStore(s => (ext ? s.unknownPreviewByExt[ext] : undefined));
    const setUnknownPreviewForExt = useUxStore(s => s.setUnknownPreviewForExt);

    // An explicit in-session choice wins; otherwise fall back to the
    // remembered per-extension viewer so known-unknown types open directly.
    const effectiveMode: ViewMode = viewMode !== 'unknown' ? viewMode : (rememberedMode ?? 'unknown');

    const openWith = (mode: 'hex' | 'text') => {
        setViewMode(mode);
        if (remember && ext) setUnknownPreviewForExt(ext, mode);
    };

    if (effectiveMode !== 'unknown') {
        const viaMemory = viewMode === 'unknown' && rememberedMode !== undefined;
        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                {viaMemory && ext && (
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 10px',
                        fontSize: '11px', color: 'var(--text-secondary)',
                        borderBottom: '1px solid var(--border)', flexShrink: 0,
                    }}>
                        <span>
                            Opening <code>.{ext}</code> files in {rememberedMode === 'hex' ? 'Hex View' : 'Text Editor'}
                        </span>
                        <Button
                            size="sm" variant="ghost"
                            style={{ marginLeft: 'auto' }}
                            title="Stop opening this file type automatically"
                            onClick={() => setUnknownPreviewForExt(ext, null)}
                        >
                            Forget
                        </Button>
                    </div>
                )}
                <div style={{ flex: 1, minHeight: 0 }}>
                    {effectiveMode === 'hex'
                        ? <HexViewer filePath={filePath} />
                        : <TextPreview filePath={filePath} />}
                </div>
            </div>
        );
    }

    return (
        <div className="unknown-preview">
            <div className="unknown-preview__content">
                <div
                    className="unknown-preview__icon"
                    dangerouslySetInnerHTML={{ __html: getIcon('file') }}
                />
                <h2>Unknown File Format</h2>
                <p>This file type does not have a dedicated viewer. How would you like to open it?</p>

                <div className="unknown-preview__options">
                    <Button
                        className="unknown-preview__btn" variant="primary"
                        onClick={() => openWith('text')}
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('document') }} />
                        Open in Text Editor
                    </Button>
                    <Button
                        className="unknown-preview__btn" variant="secondary"
                        onClick={() => openWith('hex')}
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('code') }} />
                        Open in Hex View
                    </Button>
                </div>

                {ext && (
                    <label style={{
                        display: 'inline-flex', alignItems: 'center', gap: '6px',
                        marginTop: '14px', fontSize: '12px', color: 'var(--text-secondary)',
                        cursor: 'pointer', userSelect: 'none',
                    }}>
                        <input
                            type="checkbox"
                            checked={remember}
                            onChange={(e) => setRemember(e.target.checked)}
                        />
                        Remember my choice for <code>.{ext}</code> files
                    </label>
                )}
            </div>
        </div>
    );
};
