import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import * as api from '../../lib/api';
import type { StringTableData, StringTableRow } from '../../lib/api/legacyFormats';
import { VirtualList } from './VirtualList';
import { useAppMetadataStore, useNotificationStore } from '../../lib/stores';
import { editorSessionStore } from '../../lib/stores/editorSessionStore';

interface StringTableEditorProps {
    filePath: string;
}

const ROW_HEIGHT = 30;

export const StringTableEditor: React.FC<StringTableEditorProps> = ({ filePath }) => {
    const [data, setData] = useState<StringTableData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);
    const [search, setSearch] = useState('');
    const [initialScrollTop, setInitialScrollTop] = useState(0);
    const showToast = useNotificationStore((s) => s.showToast);

    const fileVersion = useAppMetadataStore((state) => {
        void state.fileVersionsRev;
        return state.getFileVersion(filePath);
    });

    const originalJsonRef = useRef('');
    const scrollRef = useRef(0);
    const dataRef = useRef<StringTableData | null>(null);
    dataRef.current = data;

    useEffect(() => {
        const cached = editorSessionStore.get(filePath);
        if (cached && cached.fileVersion === fileVersion) {
            originalJsonRef.current = cached.originalContent;
            scrollRef.current = cached.scrollOffset ?? 0;
            setData(JSON.parse(cached.content) as StringTableData);
            setDirty(cached.content !== cached.originalContent);
            setInitialScrollTop(cached.scrollOffset ?? 0);
            setError(null);
            setLoading(false);
            return;
        }

        let cancelled = false;
        setLoading(true);
        setError(null);
        api.readStringTable(filePath)
            .then((d) => {
                if (cancelled) return;
                const json = JSON.stringify(d);
                originalJsonRef.current = json;
                scrollRef.current = 0;
                editorSessionStore.save(filePath, { fileVersion, content: json, originalContent: json, scrollOffset: 0 });
                setData(d);
                setDirty(false);
                setInitialScrollTop(0);
            })
            .catch((err) => { if (!cancelled) setError((err as Error).message || 'Failed to load string table'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [filePath, fileVersion]);

    useEffect(() => {
        return () => {
            const d = dataRef.current;
            if (!d) return;
            editorSessionStore.save(filePath, {
                fileVersion,
                content: JSON.stringify(d),
                originalContent: originalJsonRef.current,
                scrollOffset: scrollRef.current,
            });
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filePath, fileVersion]);

    const filtered = useMemo(() => {
        if (!data) return [];
        const q = search.trim().toLowerCase();
        if (!q) return data.rows;
        return data.rows.filter((r) => r.value.toLowerCase().includes(q) || r.hash.includes(q));
    }, [data, search]);

    const updateValue = useCallback((row: StringTableRow, newValue: string) => {
        setData((prev) => {
            if (!prev) return prev;
            const rows = prev.rows.map((r) => (r === row ? { ...r, value: newValue } : r));
            return { ...prev, rows };
        });
        setDirty(true);
    }, []);

    const deleteRow = useCallback((row: StringTableRow) => {
        setData((prev) => prev ? { ...prev, rows: prev.rows.filter((r) => r !== row) } : prev);
        setDirty(true);
    }, []);

    const addRow = useCallback(() => {
        const key = window.prompt('New entry key (will be hashed):');
        if (!key) return;
        setData((prev) => prev ? { ...prev, rows: [{ hash: '', key, value: '', encrypted: false }, ...prev.rows] } : prev);
        setDirty(true);
    }, []);

    const handleSave = useCallback(async () => {
        if (!data) return;
        try {
            await api.saveStringTable(filePath, data);
            originalJsonRef.current = JSON.stringify(data);
            setDirty(false);
            showToast('success', 'String table saved');
        } catch (err) {
            showToast('error', (err as Error).message || 'Failed to save');
        }
    }, [data, filePath, showToast]);

    if (loading) return <div className="preview-panel__loading"><div className="spinner" /><span>Loading…</span></div>;
    if (error) return <div className="preview-panel__loading"><span>{error}</span></div>;
    if (!data) return null;

    const readOnly = data.readOnly;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--border-color, #333)' }}>
                <input
                    placeholder="Search value or hash…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{ flex: 1, padding: '4px 8px' }}
                />
                <span style={{ fontSize: 12, opacity: 0.7 }}>{filtered.length} / {data.rows.length}</span>
                {!readOnly && <button className="btn btn--sm" onClick={addRow}>+ Row</button>}
                {!readOnly && <button className="btn btn--primary btn--sm" disabled={!dirty} onClick={handleSave}>Save</button>}
                {readOnly && <span style={{ fontSize: 12, color: 'var(--warning, #e0a030)' }}>Encrypted — read-only</span>}
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <VirtualList
                    items={filtered}
                    rowHeight={ROW_HEIGHT}
                    initialScrollTop={initialScrollTop}
                    onScrollChange={(top) => { scrollRef.current = top; }}
                    renderRow={(row: StringTableRow) => (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: ROW_HEIGHT, padding: '0 10px', borderBottom: '1px solid var(--border-subtle, #222)' }}>
                            <code style={{ width: 180, fontSize: 11, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {row.key ? `"${row.key}"` : row.hash}
                            </code>
                            <input
                                value={row.value}
                                readOnly={readOnly || row.encrypted}
                                onChange={(e) => updateValue(row, e.target.value)}
                                style={{ flex: 1, padding: '2px 6px' }}
                            />
                            {!readOnly && !row.encrypted && (
                                <button className="btn btn--ghost btn--sm" onClick={() => deleteRow(row)} title="Delete row">✕</button>
                            )}
                        </div>
                    )}
                />
            </div>
        </div>
    );
};
