/**
 * Context-menu primitives used by BnkPreview's row right-click menu.
 */
import React, { useState } from 'react';

// ---------------------------------------------------------------------------
// Context menu item components
// ---------------------------------------------------------------------------

export const CtxItem: React.FC<{
    label: string;
    icon?: string;
    danger?: boolean;
    onClick: () => void;
    disabled?: boolean;
}> = ({ label, icon, danger, onClick, disabled }) => {
    const [hover, setHover] = useState(false);
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 12px',
                cursor: disabled ? 'default' : 'pointer',
                color: disabled
                    ? 'var(--text-muted)'
                    : danger
                    ? '#f87171'
                    : 'var(--text-primary)',
                background: hover && !disabled ? 'var(--bg-hover, #2a2d35)' : 'transparent',
                fontSize: 12,
                opacity: disabled ? 0.5 : 1,
                userSelect: 'none',
            }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            onClick={disabled ? undefined : onClick}
        >
            <span
                style={{ display: 'inline-flex', width: 14, justifyContent: 'center' }}
                dangerouslySetInnerHTML={icon ? { __html: icon } : undefined}
            />
            <span>{label}</span>
        </div>
    );
};

export const CtxDivider: React.FC = () => (
    <div style={{ height: 1, margin: '4px 0', background: 'var(--border)' }} />
);
