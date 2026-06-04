import React, { useState, useRef, useCallback } from 'react';

interface VirtualListProps<T> {
    items: T[];
    rowHeight: number;
    renderRow: (item: T, index: number) => React.ReactNode;
    overscan?: number;
    className?: string;
}

/** Fixed-row-height windowed list. Renders only the rows in (or near) the viewport. */
export function VirtualList<T>({ items, rowHeight, renderRow, overscan = 8, className }: VirtualListProps<T>) {
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        setScrollTop(e.currentTarget.scrollTop);
    }, []);

    const setRef = useCallback((node: HTMLDivElement | null) => {
        containerRef.current = node;
        if (node) setViewportHeight(node.clientHeight);
    }, []);

    const total = items.length;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visibleCount = Math.ceil((viewportHeight || 600) / rowHeight) + overscan * 2;
    const end = Math.min(total, start + visibleCount);
    const slice = items.slice(start, end);

    return (
        <div
            ref={setRef}
            onScroll={onScroll}
            className={className}
            style={{ overflowY: 'auto', height: '100%', position: 'relative' }}
        >
            <div style={{ height: total * rowHeight, position: 'relative' }}>
                <div style={{ position: 'absolute', top: start * rowHeight, left: 0, right: 0 }}>
                    {slice.map((item, i) => (
                        <div key={start + i} style={{ height: rowHeight }}>
                            {renderRow(item, start + i)}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
