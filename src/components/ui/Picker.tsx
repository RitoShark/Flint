import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface PickerOption<V extends string = string> {
    value: V;
    label: React.ReactNode;
    hint?: React.ReactNode;
    icon?: React.ReactNode;
    disabled?: boolean;
}

export interface PickerProps<V extends string = string> {
    value: V;
    onChange: (value: V) => void;
    options: PickerOption<V>[];
    placeholder?: string;
    disabled?: boolean;
    fullWidth?: boolean;
    /** Width of the trigger in px (or 'auto'). Defaults to 'auto'. */
    width?: number | 'auto';
    /** Cap the dropdown's visible height in px. Overrides the default 320px. */
    menuMaxHeight?: number;
    className?: string;
    'aria-label'?: string;
}

export function Picker<V extends string = string>({
    value,
    onChange,
    options,
    placeholder = 'Select…',
    disabled,
    fullWidth,
    width = 'auto',
    menuMaxHeight,
    className = '',
    'aria-label': ariaLabel,
}: PickerProps<V>) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

    const selected = options.find((o) => o.value === value);

    useLayoutEffect(() => {
        if (!open || !triggerRef.current) { setPos(null); return; }
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
            if (triggerRef.current?.contains(t)) return;
            if (menuRef.current?.contains(t)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const triggerStyle: React.CSSProperties = {};
    if (fullWidth) triggerStyle.width = '100%';
    else if (typeof width === 'number') triggerStyle.width = width;

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                disabled={disabled}
                className={`pkr ${open ? 'pkr--open' : ''} ${className}`.trim()}
                onClick={() => !disabled && setOpen((v) => !v)}
                style={triggerStyle}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={ariaLabel}
            >
                {selected?.icon && <span className="pkr__icon">{selected.icon}</span>}
                <span className={`pkr__value ${selected ? '' : 'pkr__value--placeholder'}`}>
                    {selected?.label ?? placeholder}
                </span>
                <svg className="pkr__chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 6l4 4 4-4" />
                </svg>
            </button>

            {open && pos && createPortal(
                <div
                    ref={menuRef}
                    className="pkr-menu"
                    style={{
                        position: 'fixed',
                        top: pos.top,
                        left: pos.left,
                        minWidth: pos.width,
                        ...(menuMaxHeight ? { maxHeight: menuMaxHeight } : {}),
                    }}
                    role="listbox"
                >
                    {options.map((opt) => {
                        const isSelected = opt.value === value;
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                className={`pkr-item ${isSelected ? 'pkr-item--selected' : ''} ${opt.disabled ? 'pkr-item--disabled' : ''}`}
                                onClick={() => {
                                    if (opt.disabled) return;
                                    onChange(opt.value);
                                    setOpen(false);
                                }}
                                role="option"
                                aria-selected={isSelected}
                                disabled={opt.disabled}
                            >
                                {opt.icon && <span className="pkr-item__icon">{opt.icon}</span>}
                                <span className="pkr-item__body">
                                    <span className="pkr-item__label">{opt.label}</span>
                                    {opt.hint && <span className="pkr-item__hint">{opt.hint}</span>}
                                </span>
                                {isSelected && (
                                    <svg className="pkr-item__check" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M2 6l3 3 5-6" />
                                    </svg>
                                )}
                            </button>
                        );
                    })}
                </div>,
                document.body,
            )}
        </>
    );
}
