import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useWadExplorerStore } from '../../../lib/stores';
import type { WadChunk, WadExplorerWad } from '../../../lib/types';
import { ICON_GRID, QUICK_ACTIONS } from './helpers';

export const WadListSkeleton: React.FC<{ count: number }> = ({ count }) => {
    return (
        <div className="wad-skel" role="presentation" aria-hidden="true">
            <div className="wad-skel__header">
                <span className="wad-skel__shimmer" style={{ width: 120, height: 14 }} />
                <span className="wad-skel__shimmer wad-skel__shimmer--soft" style={{ width: 60, height: 12 }} />
            </div>
            <div className="wad-skel__rows">
                {Array.from({ length: count }).map((_, i) => (
                    <div key={i} className="wad-skel__row" style={{ animationDelay: `${i * 60}ms` }}>
                        <span className="wad-skel__caret" />
                        <span className="wad-skel__icon" />
                        <span className="wad-skel__shimmer wad-skel__shimmer--name" style={{ width: `${42 + ((i * 17) % 38)}%` }} />
                        <span className="wad-skel__shimmer wad-skel__shimmer--meta" style={{ width: 48 }} />
                    </div>
                ))}
            </div>
        </div>
    );
};

interface QuickActionPanelProps {
    wads: WadExplorerWad[];
    onSetFilter: (query: string) => void;
    onOpenRecent: (wadPath: string) => void;
}

export const QuickActionPanel: React.FC<QuickActionPanelProps> = ({ wads, onSetFilter, onOpenRecent }) => {
    const recentWads = useWadExplorerStore((s) => s.recentWads);

    const loadedChunks = useMemo(() => {
        const all: WadChunk[] = [];
        for (const w of wads) {
            if (w.status === 'loaded') all.push(...w.chunks);
        }
        return all;
    }, [wads]);

    const counts = useMemo(() =>
        QUICK_ACTIONS.map(qa => ({
            ...qa,
            count: loadedChunks.filter(c => c.path && qa.regex.test(c.path)).length,
        })),
        [loadedChunks]
    );

    const totalLoaded = wads.filter(w => w.status === 'loaded').length;
    const totalWads = wads.length;

    // Resolve recent WAD entries against the current scan so we can show the
    // friendly name + category and skip stale entries (e.g. paths from a
    // previous game install).
    const allRecentEntries = useMemo(() => {
        const byPath = new Map(wads.map((w) => [w.path, w] as const));
        return recentWads
            .map((p) => byPath.get(p))
            .filter((w): w is WadExplorerWad => !!w);
    }, [recentWads, wads]);

    // Compute how many recent rows fit between the header and the filter
    // grid. Without this, a tall list pushes the filter cards off-screen on
    // small windows. Re-measures on resize.
    const panelRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const filtersRef = useRef<HTMLDivElement>(null);
    const recentTitleRef = useRef<HTMLDivElement>(null);
    const ROW_HEIGHT = 38; // 8px padding + ~22px content + 4px gap (.btn--ghost)
    const ROW_GAP = 4;
    const [maxRows, setMaxRows] = useState(8);

    useEffect(() => {
        const recompute = () => {
            const panel = panelRef.current;
            const header = headerRef.current;
            const filters = filtersRef.current;
            if (!panel || !header || !filters) return;
            // 28px gap × 2 (header→recent, recent→filters) + 32px panel padding × 2
            const fixed = header.offsetHeight + filters.offsetHeight + (recentTitleRef.current?.offsetHeight ?? 24) + 28 * 2 + 32 * 2;
            const available = panel.clientHeight - fixed;
            const fit = Math.max(1, Math.floor((available + ROW_GAP) / (ROW_HEIGHT + ROW_GAP)));
            setMaxRows(Math.min(fit, 20));
        };

        recompute();
        const panel = panelRef.current;
        if (!panel) return;
        const ro = new ResizeObserver(recompute);
        ro.observe(panel);
        return () => ro.disconnect();
    }, []);

    const recentEntries = allRecentEntries.slice(0, maxRows);
    const hidden = allRecentEntries.length - recentEntries.length;

    return (
        <div ref={panelRef} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '28px', padding: '32px', overflow: 'hidden' }}>
            <div ref={headerRef} style={{ textAlign: 'center' }}>
                <div style={{ opacity: 0.4, marginBottom: '8px' }} dangerouslySetInnerHTML={{ __html: ICON_GRID }} />
                <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '6px' }}>WAD Explorer</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {totalWads === 0
                        ? 'Scanning game directory…'
                        : totalLoaded < totalWads
                            ? `Loading WADs… ${totalLoaded} / ${totalWads}`
                            : `${totalWads} WADs loaded — select a file to preview`}
                </div>
            </div>

            {recentEntries.length > 0 && (
                <div style={{ width: '100%', maxWidth: '480px' }}>
                    <div ref={recentTitleRef} style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '8px', paddingLeft: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <span>Recent WADs</span>
                        {hidden > 0 && (
                            <span style={{ textTransform: 'none', letterSpacing: 0, fontSize: '10px' }}>
                                +{hidden} more (resize to see)
                            </span>
                        )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: `${ROW_GAP}px` }}>
                        {recentEntries.map((wad) => (
                            <button
                                key={wad.path}
                                className="btn btn--ghost"
                                onClick={() => onOpenRecent(wad.path)}
                                title={wad.path}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: '12px',
                                    padding: '8px 12px',
                                    height: `${ROW_HEIGHT}px`,
                                    width: '100%',
                                    textAlign: 'left',
                                }}
                            >
                                <span style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {wad.name}
                                </span>
                                <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>
                                    {wad.category}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div ref={filtersRef} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', width: '100%', maxWidth: '480px' }}>
                {counts.map(qa => (
                    <button
                        key={qa.label}
                        className="btn btn--secondary"
                        onClick={() => onSetFilter(qa.regex.source)}
                        title={`Filter to ${qa.label} (${qa.count.toLocaleString()} in loaded WADs)`}
                        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '20px 12px', height: 'auto' }}
                    >
                        <span dangerouslySetInnerHTML={{ __html: qa.iconHtml }} />
                        <span style={{ fontSize: '13px', fontWeight: 500 }}>{qa.label}</span>
                        {qa.count > 0 && (
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                {qa.count.toLocaleString()}
                            </span>
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
};
