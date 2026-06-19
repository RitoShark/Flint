import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useModalStore } from '../../lib/stores';
import type { ContextMenuOption } from '../../lib/types';

/** Width is approximate — the panel snaps to its content but we need a guess
 *  for off-screen flipping before measure happens. */
const APPROX_PANEL_WIDTH = 220;
/** Match the longest entrance animation (see context-menu.css). */
const EXIT_MS = 140;

const CHEVRON = (
    <svg className="context-menu__chevron" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
);

interface PanelProps {
    options: ContextMenuOption[];
    x: number;
    y: number;
    /** Depth from the root panel — only used to stagger entrance animation. */
    depth: number;
    /** When this panel is the root and `closing` flips true, run the exit
     *  animation before unmounting. Submenus animate independently. */
    closing?: boolean;
    /** When the user clicks a leaf item, the whole tree closes via this. */
    onCloseAll: () => void;
}

const ContextMenuPanel: React.FC<PanelProps> = ({ options, x, y, depth, closing, onCloseAll }) => {
    const panelRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    const [submenuPos, setSubmenuPos] = useState<{ x: number; y: number } | null>(null);
    const [adjusted, setAdjusted] = useState<{ x: number; y: number }>({ x, y });

    useLayoutEffect(() => {
        const el = panelRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let nx = x;
        let ny = y;
        if (nx + rect.width > vw - 6) nx = Math.max(6, vw - rect.width - 6);
        if (ny + rect.height > vh - 6) ny = Math.max(6, vh - rect.height - 6);
        if (nx !== adjusted.x || ny !== adjusted.y) setAdjusted({ x: nx, y: ny });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [x, y, options.length]);

    const handleEnterParent = (i: number, opt: ContextMenuOption) => {
        if (!opt.submenu || opt.disabled) {
            setOpenIndex(null);
            setSubmenuPos(null);
            return;
        }
        const item = itemRefs.current[i];
        if (!item) return;
        const itemRect = item.getBoundingClientRect();
        const vw = window.innerWidth;
        let sx = itemRect.right - 2;
        const wouldOverflow = sx + APPROX_PANEL_WIDTH > vw - 6;
        if (wouldOverflow) sx = itemRect.left - APPROX_PANEL_WIDTH + 2;
        setOpenIndex(i);
        setSubmenuPos({ x: sx, y: itemRect.top - 4 });
    };

    const handleLeavePanel = () => {
    };

    const handleItemClick = (opt: ContextMenuOption) => {
        if (opt.disabled || opt.submenu) return;
        if (opt.onClick) opt.onClick();
        onCloseAll();
    };

    const panelClass = `context-menu${closing ? ' context-menu--closing' : ''}`;
    const style: React.CSSProperties = {
        position: 'fixed',
        top: adjusted.y,
        left: adjusted.x,
        zIndex: 2000 + depth,
        animationDelay: `${depth * 30}ms`,
    };

    return (
        <>
            <div
                ref={panelRef}
                className={panelClass}
                style={style}
                onClick={(e) => e.stopPropagation()}
                onMouseLeave={handleLeavePanel}
                role="menu"
            >
                {options.map((option, index) => {
                    if (option.separator && index > 0) {
                        return (
                            <React.Fragment key={`sep-${index}`}>
                                <div className="context-menu__separator" />
                                {renderItem(option, index)}
                            </React.Fragment>
                        );
                    }
                    return <React.Fragment key={index}>{renderItem(option, index)}</React.Fragment>;
                })}
            </div>
            {openIndex !== null && submenuPos && options[openIndex]?.submenu && (
                <ContextMenuPanel
                    options={options[openIndex].submenu!}
                    x={submenuPos.x}
                    y={submenuPos.y}
                    depth={depth + 1}
                    onCloseAll={onCloseAll}
                />
            )}
        </>
    );

    function renderItem(option: ContextMenuOption, index: number) {
        const cls = [
            'context-menu__item',
            option.danger && 'context-menu__item--danger',
            option.disabled && 'context-menu__item--disabled',
            option.submenu && 'context-menu__item--parent',
            openIndex === index && 'context-menu__item--open',
        ].filter(Boolean).join(' ');
        return (
            <div
                ref={(el) => { itemRefs.current[index] = el; }}
                className={cls}
                onMouseEnter={() => handleEnterParent(index, option)}
                onClick={() => handleItemClick(option)}
                role="menuitem"
                aria-haspopup={!!option.submenu}
                aria-expanded={option.submenu ? openIndex === index : undefined}
                aria-disabled={option.disabled || undefined}
            >
                {option.icon ? (
                    <span
                        className="context-menu__icon"
                        dangerouslySetInnerHTML={{ __html: option.icon }}
                    />
                ) : (
                    <span className="context-menu__icon context-menu__icon--empty" aria-hidden="true" />
                )}
                <span className="context-menu__label">{option.label}</span>
                {option.shortcut && <span className="context-menu__shortcut">{option.shortcut}</span>}
                {option.submenu && CHEVRON}
            </div>
        );
    }
};

export const ContextMenu: React.FC = () => {
    const menu = useModalStore((s) => s.contextMenu);
    const closeContextMenu = useModalStore((s) => s.closeContextMenu);
    const [closing, setClosing] = useState(false);
    const [snapshot, setSnapshot] = useState(menu);

    useEffect(() => {
        if (menu) {
            setSnapshot(menu);
            setClosing(false);
            return;
        }
        if (!snapshot) return;
        setClosing(true);
        const t = setTimeout(() => {
            setSnapshot(null);
            setClosing(false);
        }, EXIT_MS);
        return () => clearTimeout(t);
    }, [menu]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!menu) return;
        const handleMouseDown = (e: MouseEvent) => {
            const t = e.target as HTMLElement | null;
            if (t && t.closest('.context-menu')) return;
            closeContextMenu();
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeContextMenu();
        };
        document.addEventListener('mousedown', handleMouseDown);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleMouseDown);
            document.removeEventListener('keydown', handleKey);
        };
    }, [menu, closeContextMenu]);

    if (!snapshot) return null;
    return (
        <ContextMenuPanel
            options={snapshot.options}
            x={snapshot.x}
            y={snapshot.y}
            depth={0}
            closing={closing}
            onCloseAll={closeContextMenu}
        />
    );
};
