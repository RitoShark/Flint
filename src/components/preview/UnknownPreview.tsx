import React, { useState } from 'react';
import { HexViewer } from './HexViewer';
import { TextPreview } from './TextPreview';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import './UnknownPreview.css';

interface UnknownPreviewProps {
    filePath: string;
}

type ViewMode = 'unknown' | 'hex' | 'text';

export const UnknownPreview: React.FC<UnknownPreviewProps> = ({ filePath }) => {
    const [viewMode, setViewMode] = useState<ViewMode>('unknown');

    if (viewMode === 'hex') {
        return <HexViewer filePath={filePath} />;
    }

    if (viewMode === 'text') {
        return <TextPreview filePath={filePath} />;
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
                    <button 
                        className="btn btn--primary unknown-preview__btn"
                        onClick={() => setViewMode('text')}
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('document') }} />
                        Open in Text Editor
                    </button>
                    <button 
                        className="btn btn--secondary unknown-preview__btn"
                        onClick={() => setViewMode('hex')}
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('code') }} />
                        Open in Hex View
                    </button>
                </div>
            </div>
        </div>
    );
};
