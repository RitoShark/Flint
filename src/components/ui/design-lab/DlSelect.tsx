import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DlIcon, type DlIconName } from './DlIcon';

export interface DlSelectOption<T extends string = string> {
    value: T;
    label: React.ReactNode;
    icon?: DlIconName;
}

export interface DlSelectProps<T extends string = string> {
    value: T | null;
    onChange: (value: T) => void;
    options: DlSelectOption<T>[];
    placeholder?: string;
    width?: number | string;
    disabled?: boolean;
    title?: string;
    /** Reset to placeholder after each pick — for action menus like "apply preset". */
    resetAfterSelect?: boolean;
}

/**
 * Design-lab custom select (`.dl-select-trigger` + portal `.dl-dd-portal`).
 * Replaces the native `<select>` so the menu is theme-styled, portal-rendered
 * (never clipped), and the chevron/selection use SVG icons. Extracted from the
 * private Select in `DesignLab.tsx` so real UI can reuse it.
 */
export function DlSelect<T extends string = string>({
    value,
    onChange,
    options,
    placeholder = 'Select…',
    width = 180,
    disabled,
    title,
    resetAfterSelect,
}: DlSelectProps<T>) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
    const selected = options.find((o) => o.value === value) ?? null;

    useLayoutEffect(() => {
        if (!open || !triggerRef.current) {
            setPos(null);
            return;
        }
        const update = () => {
            const r = triggerRef.current!.getBoundingClientRect();
            setPos({ top: r.bottom + 6, left: r.left, width: r.width });
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

    const pick = (v: T) => {
        onChange(v);
        setOpen(false);
    };

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                title={title}
                disabled={disabled}
                className={`dl-select-trigger ${open ? 'dl-select-trigger--open' : ''}`}
                onClick={() => setOpen((v) => !v)}
                style={{ width }}
            >
                <span className={selected && !resetAfterSelect ? 'dl-select-trigger__value' : 'dl-select-trigger__placeholder'}>
                    {resetAfterSelect ? placeholder : selected?.label ?? placeholder}
                </span>
                <DlIcon name="chevronDown" />
            </button>
            {open && pos && createPortal(
                <div
                    ref={menuRef}
                    className="dl-dd-portal"
                    style={{ position: 'fixed', top: pos.top, left: pos.left, minWidth: pos.width }}
                    role="listbox"
                >
                    {options.map((o) => (
                        <button
                            key={o.value}
                            type="button"
                            role="option"
                            aria-selected={o.value === value}
                            className={`dl-dd__item ${!resetAfterSelect && o.value === value ? 'dl-dd__item--selected' : ''}`}
                            onClick={() => pick(o.value)}
                        >
                            {o.icon && <DlIcon name={o.icon} />}
                            <span>{o.label}</span>
                        </button>
                    ))}
                </div>,
                document.body,
            )}
        </>
    );
}
