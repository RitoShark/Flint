/**
 * Flint - Confirm Dialog Component
 * Custom in-app confirmation dialog (replaces window.confirm).
 * Uses the dedicated `.confirm-*` styles, not the generic modal shell.
 */

import React, { useEffect, useRef } from 'react';
import { useModalStore } from '../lib/stores';
import { Button } from './ui';

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
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeConfirmDialog();
        };
        document.addEventListener('keydown', onKey);
        return () => {
            clearTimeout(focusTimer);
            document.removeEventListener('keydown', onKey);
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

    return (
        <div className="confirm-overlay" onClick={handleOverlayClick}>
            <div className="confirm-dialog">
                <div className="confirm-dialog__icon">{dialog.danger ? <DangerIcon /> : <InfoIcon />}</div>
                <div className="confirm-dialog__content">
                    <h3 className="confirm-dialog__title">{dialog.title}</h3>
                    <p className="confirm-dialog__message">{dialog.message}</p>
                    {dialog.showCheckbox && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', fontSize: '13px', cursor: 'pointer', userSelect: 'none' }}>
                            <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => setChecked(e.target.checked)}
                                style={{ width: '14px', height: '14px', margin: 0 }}
                            />
                            <span>{dialog.checkboxLabel || "Don't show again"}</span>
                        </label>
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
        </div>
    );
};
