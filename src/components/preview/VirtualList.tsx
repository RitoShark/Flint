import React, { useState, useRef, useCallback } from 'react';

interface VirtualListProps<T> {
    items: T[];
    rowHeight: number;
    renderRow: (item: T, index: number) => React.ReactNode;
    overscan?: number;
    className?: string;
    /** Scroll offset (px) to restore on mount — e.g. from a preserved editor session. */
    initialScrollTop?: number;
    /** Called on every scroll with the current offset, so callers can persist it. */
    onScrollChange?: (scrollTop: number) => void;
}

/** Fixed-row-height windowed list. Renders only the rows in (or near) the viewport. */
export function VirtualList<T>({ items, rowHeight, renderRow, overscan = 8, className, initialScrollTop = 0, onScrollChange }: VirtualListProps<T>) {
    const [scrollTop, setScrollTop] = useState(initialScrollTop);
    const [viewportHeight, setViewportHeight] = useState(0);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const top = e.currentTarget.scrollTop;
        setScrollTop(top);
        onScrollChange?.(top);
    }, [onScrollChange]);

    const setRef = useCallback((node: HTMLDivElement | null) => {
        containerRef.current = node;
        if (node) {
            setViewportHeight(node.clientHeight);
            if (initialScrollTop) node.scrollTop = initialScrollTop;
        }
    }, [initialScrollTop]);

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
