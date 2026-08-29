import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useModalStore } from '../../lib/stores';
import { Button, Checkbox } from '../ui';

const DangerIcon = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path d="M12 9v4m0 4h.01" stroke="#F85149" strokeWidth="2" strokeLinecap="round" />
        <path
            d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
            stroke="#F85149"
            strokeWidth="1.5"
            fill="none"
        />
    </svg>
);

const InfoIcon = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="var(--accent-secondary)" strokeWidth="1.5" />
        <path d="M12 8v5m0 3h.01" stroke="var(--accent-secondary)" strokeWidth="2" strokeLinecap="round" />
    </svg>
);

export const ConfirmDialog: React.FC = () => {
    const dialog = useModalStore((s) => s.confirmDialog);
    const closeConfirmDialog = useModalStore((s) => s.closeConfirmDialog);
    const confirmBtnRef = useRef<HTMLButtonElement>(null);
    const [checked, setChecked] = React.useState(false);

    useEffect(() => {
        if (!dialog) return;
        setChecked(false);
        const focusTimer = setTimeout(() => confirmBtnRef.current?.focus(), 50);
        // Capture phase + stopPropagation: the confirm sits on top of whatever
        // opened it, so Escape must dismiss only the confirm — never also reach
        // the host modal's own document-level Escape handler underneath.
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            closeConfirmDialog();
        };
        document.addEventListener('keydown', onKey, true);
        return () => {
            clearTimeout(focusTimer);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [dialog, closeConfirmDialog]);

    if (!dialog) return null;

    const handleConfirm = () => {
        dialog.onConfirm(checked);
        closeConfirmDialog();
    };

    const handleOverlayClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) closeConfirmDialog();
    };

    // LANDMINE: this MUST be portalled to <body>. `body > *` is given
    // `position: relative; z-index: 1`, so every body child is its own stacking
    // context — a confirm rendered inside the React root can never paint above a
    // modal that portals itself into <body> later, whatever z-index it carries.
    return createPortal(
        <div className="confirm-overlay" onClick={handleOverlayClick}>
            <div className="confirm-dialog">
                <div className="confirm-dialog__icon">{dialog.danger ? <DangerIcon /> : <InfoIcon />}</div>
                <div className="confirm-dialog__content">
                    <h3 className="confirm-dialog__title">{dialog.title}</h3>
                    <p className="confirm-dialog__message">{dialog.message}</p>
                    {dialog.showCheckbox && (
                        <Checkbox
                            className="confirm-dialog__checkbox"
                            checked={checked}
                            onChange={(e) => setChecked(e.target.checked)}
                            label={dialog.checkboxLabel || "Don't show again"}
                        />
                    )}
                </div>
                <div className="confirm-dialog__actions">
                    {!dialog.hideCancel && (
                        <Button variant="secondary" onClick={closeConfirmDialog}>
                            {dialog.cancelLabel || 'Cancel'}
                        </Button>
                    )}
                    <Button
                        ref={confirmBtnRef}
                        variant={dialog.danger ? 'danger' : 'primary'}
                        onClick={handleConfirm}
                        style={{ marginLeft: dialog.hideCancel ? 0 : undefined }}
                    >
                        {dialog.confirmLabel || 'Confirm'}
                    </Button>
                </div>
            </div>
        </div>,
        document.body,
    );
};
