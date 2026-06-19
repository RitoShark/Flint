import React, { useState, useEffect } from 'react';
import * as api from '../../lib/api';
import { ReadOnlyMonaco } from './ReadOnlyMonaco';

interface TroybinViewerProps {
    filePath: string;
}

export const TroybinViewer: React.FC<TroybinViewerProps> = ({ filePath }) => {
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        api.readTroybinText(filePath)
            .then((text) => { if (!cancelled) setContent(text); })
            .catch((err) => { if (!cancelled) setError((err as Error).message || 'Failed to parse troybin'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [filePath]);

    if (loading) return <div className="preview-panel__loading"><div className="spinner" /><span>Parsing…</span></div>;
    if (error) return <div className="preview-panel__loading"><span>{error}</span></div>;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ padding: '4px 10px', fontSize: 12, opacity: 0.7, borderBottom: '1px solid var(--border-color, #333)' }}>
                Troybin (read-only — editing arrives with the rs_troybin writer)
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <ReadOnlyMonaco value={content} language="ini" />
            </div>
        </div>
    );
};
