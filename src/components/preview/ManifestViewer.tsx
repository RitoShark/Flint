import React, { useState, useEffect, useMemo } from 'react';
import * as api from '../../lib/api';
import type { ManifestData, ManifestFile } from '../../lib/api/legacyFormats';
import { VirtualList } from './VirtualList';

interface ManifestViewerProps {
    filePath: string;
}

const ROW_HEIGHT = 26;

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const ManifestViewer: React.FC<ManifestViewerProps> = ({ filePath }) => {
    const [data, setData] = useState<ManifestData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        api.readManifest(filePath)
            .then((d) => { if (!cancelled) setData(d); })
            .catch((err) => { if (!cancelled) setError((err as Error).message || 'Failed to load manifest'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [filePath]);

    const filtered = useMemo(() => {
        if (!data) return [];
        const q = search.trim().toLowerCase();
        if (!q) return data.files;
        return data.files.filter((f) => f.path.toLowerCase().includes(q));
    }, [data, search]);

    if (loading) return <div className="preview-panel__loading"><div className="spinner" /><span>Parsing manifest…</span></div>;
    if (error) return <div className="preview-panel__loading"><span>{error}</span></div>;
    if (!data) return null;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-color, #333)', fontSize: 12 }}>
                <strong>Manifest {data.manifestId}</strong> · v{data.version[0]}.{data.version[1]} · {data.fileCount.toLocaleString()} files · {formatBytes(data.totalSize)}
            </div>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-color, #333)' }}>
                <input
                    placeholder="Search path…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{ width: '100%', padding: '4px 8px' }}
                />
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <VirtualList
                    items={filtered}
                    rowHeight={ROW_HEIGHT}
                    renderRow={(f: ManifestFile) => (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: ROW_HEIGHT, padding: '0 10px', borderBottom: '1px solid var(--border-subtle, #222)', fontSize: 12 }}>
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                            {f.flags.length > 0 && <span style={{ opacity: 0.6 }}>{f.flags.join(', ')}</span>}
                            <span style={{ width: 80, textAlign: 'right', opacity: 0.7 }}>{formatBytes(f.size)}</span>
                        </div>
                    )}
                />
            </div>
        </div>
    );
};
