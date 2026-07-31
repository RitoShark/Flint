import React, { useEffect, useMemo, useRef, useState } from 'react';

export interface SubmeshPickerRequest {
    /** Editor line the picker was opened from. */
    line: number;
    /** Submesh name currently on that line. */
    current: string;
    /** Material-range names read off the SKN; empty when it could not be read. */
    names: string[];
    /** Why `names` is empty, shown instead of the list. */
    note: string | null;
}

interface Props {
    request: SubmeshPickerRequest;
    onPick: (line: number, name: string) => void;
    onClose: () => void;
}

/* Picks a submesh name for a `Submesh: string = "..."` line. Meshes routinely
   carry a dozen-plus ranges whose names differ by one word, so the list is
   filterable and fully keyboard-driven. */
export const SubmeshPicker: React.FC<Props> = ({ request, onPick, onClose }) => {
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    const matches = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return request.names;
        return request.names.filter((n) => n.toLowerCase().includes(q));
    }, [query, request.names]);

    // Keep the highlight in range as the filter narrows the list.
    useEffect(() => { setActiveIndex(0); }, [query]);

    // Follow the highlight when it moves past the visible rows.
    useEffect(() => {
        listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
        if (matches.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex((i) => (i + 1) % matches.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            onPick(request.line, matches[activeIndex]);
        }
    };

    return (
        <div className="submesh-picker__scrim" onClick={onClose}>
            <div className="submesh-picker" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
                {request.names.length > 0 ? (
                    <>
                        <input
                            className="submesh-picker__search"
                            autoFocus
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={`Filter ${request.names.length} submeshes…`}
                            spellCheck={false}
                        />
                        <div className="submesh-picker__list" ref={listRef}>
                            {matches.map((name, i) => (
                                <button
                                    key={name}
                                    data-active={i === activeIndex}
                                    className={[
                                        'submesh-picker__item',
                                        i === activeIndex ? 'submesh-picker__item--active' : '',
                                        name === request.current ? 'submesh-picker__item--current' : '',
                                    ].filter(Boolean).join(' ')}
                                    onMouseEnter={() => setActiveIndex(i)}
                                    onClick={() => onPick(request.line, name)}
                                    title={name}
                                >
                                    {name}
                                </button>
                            ))}
                            {matches.length === 0 && (
                                <div className="submesh-picker__empty">No submesh matches “{query}”.</div>
                            )}
                        </div>
                    </>
                ) : (
                    <div className="submesh-picker__note">
                        {request.note}
                        <br />
                        Type the name directly on the line instead.
                    </div>
                )}
            </div>
        </div>
    );
};
