/**
 * Virtualized list — renders only the rows visible in the scroll viewport.
 * Used by WadExplorer for both the main category/WAD/VFS tree and the
 * search-results view.
 *
 * The `renderEpoch` prop bumps whenever state that affects row visuals
 * (selection, checkboxes, expanded sets, highlights, …) changes. The memo'd
 * outer wrapper uses it as a cache-buster so visible rows re-render in
 * place — without this, `renderRow` is held in a ref and props look
 * identical, so React skips the update until a scroll mutates the list's
 * own state.
 */

import React from 'react';

export interface VirtualizedListProps {
    totalRows: number;
    rowHeight: number;
    overscan: number;
    renderRow: (index: number) => React.ReactNode;
    renderEpoch: number;
}

export interface VirtualizedListHandle {
    scrollToIndex: (index: number) => void;
}

const VirtualizedListInner = React.forwardRef<VirtualizedListHandle, VirtualizedListProps>(
    ({ totalRows, rowHeight, overscan, renderRow /* , renderEpoch — only here as a memo cache-buster */ }, ref) => {
    const [scrollTop, setScrollTop] = React.useState(0);
    const [containerHeight, setContainerHeight] = React.useState(600);
    const containerRef = React.useRef<HTMLDivElement>(null);
    const rafRef = React.useRef<number | null>(null);

    React.useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const ro = new ResizeObserver(entries => {
            for (const entry of entries) {
                setContainerHeight(entry.contentRect.height);
            }
        });
        ro.observe(el);
        setContainerHeight(el.clientHeight);
        return () => ro.disconnect();
    }, []);

    React.useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

    React.useImperativeHandle(ref, () => ({
        scrollToIndex: (index: number) => {
            const el = containerRef.current;
            if (!el) return;
            const top = index * rowHeight;
            if (top < el.scrollTop || top + rowHeight > el.scrollTop + el.clientHeight) {
                el.scrollTop = Math.max(0, top - Math.floor(el.clientHeight / 3));
            }
        },
    }), [rowHeight]);

    const handleScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const target = e.target as HTMLDivElement;
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
            setScrollTop(target.scrollTop);
            rafRef.current = null;
        });
    }, []);

    const totalHeight = totalRows * rowHeight;
    const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const endIndex = Math.min(totalRows - 1, Math.ceil((scrollTop + containerHeight) / rowHeight) + overscan);

    const visibleRows: React.ReactNode[] = [];
    for (let i = startIndex; i <= endIndex; i++) {
        visibleRows.push(
            <div
                key={i}
                style={{
                    position: 'absolute',
                    top: i * rowHeight,
                    left: 0,
                    right: 0,
                    height: rowHeight,
                    overflow: 'hidden',
                }}
            >
                {renderRow(i)}
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
            onScroll={handleScroll}
        >
            <div style={{ position: 'relative', height: totalHeight, minHeight: '100%' }}>
                {visibleRows}
            </div>
        </div>
    );
});

export const VirtualizedList = React.memo(VirtualizedListInner);
VirtualizedList.displayName = 'VirtualizedList';
