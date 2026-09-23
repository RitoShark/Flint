import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import type { MapLoadProgress } from '../../lib/babylon/mapLoading';

export function MapLoadingBar({ busy, progress, error, status, onRetry }: {
    busy: boolean; progress: MapLoadProgress; error: string | null;
    status: string; onRetry: () => void;
}) {
    const [expanded, setExpanded] = useState(true);
    const [now, setNow] = useState(Date.now());
    useEffect(() => { setExpanded(busy || !!error); }, [busy, error]);
    useEffect(() => {
        if (!busy) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [busy]);
    const stalled = busy && now - progress.updatedAt > 15_000;
    const elapsed = Math.max(0, Math.floor((now - progress.startedAt) / 1000));
    const percent = progress.total ? Math.round(100 * progress.done / progress.total) : null;
    const label = error ? 'Loading failed' : busy ? progress.stage : status || 'Map ready';
    const color = error ? '#ef8787' : '#8bc9b0';
    return (
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 20, color: '#ddd', font: '12px system-ui' }}>
            {expanded && (busy || error) && (
                <div style={{ margin: '0 12px 8px auto', padding: 14, width: 360, maxWidth: 'calc(100% - 24px)', boxSizing: 'border-box', background: '#23272b', border: '1px solid #454a50', borderRadius: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                        <strong>{error ? 'Map loading stopped' : progress.stage}</strong>
                        <span>{elapsed}s</span>
                    </div>
                    <progress aria-label={progress.stage} max={progress.total || 1} value={progress.total === null ? undefined : progress.done}
                        style={{ width: '100%', height: 8, accentColor: color }} />
                    <div role={error ? 'alert' : 'status'} style={{ marginTop: 8, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                        {error || (progress.total === null ? 'Reading map geometry and materials…' : `${progress.done} / ${progress.total} · ${percent ?? 0}% of this stage`)}
                        {stalled && !error && <div>Still waiting for this batch. You can retry without closing the preview.</div>}
                    </div>
                    {(error || stalled) && <Button size="sm" style={{ marginTop: 10 }} onClick={onRetry}>Retry loading</Button>}
                </div>
            )}
            <progress aria-label="Map loading progress" max={progress.total || 1}
                value={!busy ? progress.total || 1 : progress.total === null ? undefined : progress.done}
                style={{ display: 'block', width: '100%', height: 4, accentColor: color }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 30, padding: '2px 10px', boxSizing: 'border-box', background: '#1f2226', borderTop: '1px solid #363b40' }}>
                <span role="status" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                {busy && <span>{percent === null ? `${elapsed}s` : `${progress.done}/${progress.total}`}</span>}
                {error && <Button size="sm" onClick={onRetry}>Retry</Button>}
                {(busy || error) && <Button size="sm" onClick={() => setExpanded(v => !v)}>{expanded ? 'Hide details' : 'Show details'}</Button>}
            </div>
        </div>
    );
}
