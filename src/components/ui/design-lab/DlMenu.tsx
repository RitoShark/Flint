import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DlIcon, type DlIconName } from './DlIcon';

export interface DlMenuItem {
    label: React.ReactNode;
    icon?: DlIconName;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
    divider?: boolean;
}

export interface DlMenuProps {
    items: DlMenuItem[];
    /** The trigger button's icon (defaults to the three-dot "more" glyph). */
    triggerIcon?: DlIconName;
    title?: string;
    align?: 'left' | 'right';
    menuWidth?: number;
}

/**
 * Design-lab overflow menu — a `.dl-btn--icon` trigger that opens a portal
 * `.dl-dd-portal` list of actions. Used for the thumbnail toolbar's
 * Save / Export / Import group (collapsed into one three-dot menu). Portal'd
 * so it's never clipped by the toolbar's overflow.
 */
export const DlMenu: React.FC<DlMenuProps> = ({ items, triggerIcon = 'more', title, align = 'right', menuWidth = 200 }) => {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number; right: number } | null>(null);

    useLayoutEffect(() => {
        if (!open || !triggerRef.current) {
            setPos(null);
            return;
        }
        const update = () => {
            const r = triggerRef.current!.getBoundingClientRect();
            setPos({ top: r.bottom + 6, left: r.left, right: window.innerWidth - r.right });
        };
        update();
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            const t = e.target as Node;
            if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                title={title}
                className={`dl-btn dl-btn--secondary dl-btn--icon ${open ? 'dl-btn--active' : ''}`}
                onClick={() => setOpen((v) => !v)}
            >
                <DlIcon name={triggerIcon} />
            </button>
            {open && pos && createPortal(
                <div
                    ref={menuRef}
                    className={`dl-dd-portal ${align === 'left' ? 'dl-dd--left' : ''}`}
                    style={{
                        position: 'fixed',
                        top: pos.top,
                        left: align === 'left' ? pos.left : undefined,
                        right: align === 'right' ? pos.right : undefined,
                        minWidth: menuWidth,
                    }}
                    role="menu"
                >
                    {items.map((item, i) =>
                        item.divider ? (
                            <div key={`d-${i}`} className="dl-dd__divider" />
                        ) : (
                            <button
                                key={i}
                                type="button"
                                role="menuitem"
                                disabled={item.disabled}
                                className={`dl-dd__item ${item.danger ? 'dl-dd__item--danger' : ''}`}
                                onClick={() => {
                                    item.onClick();
                                    setOpen(false);
                                }}
                            >
                                {item.icon && <DlIcon name={item.icon} />}
                                <span>{item.label}</span>
                            </button>
                        ),
                    )}
                </div>,
                document.body,
            )}
        </>
    );
};
