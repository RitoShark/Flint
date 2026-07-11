import React from 'react';
import { DlIcon, type DlIconName } from './DlIcon';

export type DlButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type DlButtonSize = 'sm' | 'md' | 'lg';

export interface DlButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
    variant?: DlButtonVariant;
    size?: DlButtonSize;
    icon?: DlIconName;
    iconRight?: DlIconName;
    active?: boolean;
    loading?: boolean;
    children?: React.ReactNode;
}

const VARIANT: Record<DlButtonVariant, string> = {
    primary: 'dl-btn--primary',
    secondary: 'dl-btn--secondary',
    ghost: 'dl-btn--ghost',
    danger: 'dl-btn--danger',
};

const SIZE: Record<DlButtonSize, string> = {
    sm: 'dl-btn--sm',
    md: '',
    lg: 'dl-btn--lg',
};

/**
 * Design-lab button (`.dl-btn`). Use instead of hand-rolled `<button className="dl-btn …">`
 * so variant/size/icon/active/loading state is consistent everywhere.
 */
export const DlButton = React.forwardRef<HTMLButtonElement, DlButtonProps>(
    (
        { variant = 'secondary', size = 'md', icon, iconRight, active, loading, className = '', type = 'button', children, disabled, ...rest },
        ref,
    ) => {
        const cls = [
            'dl-btn',
            VARIANT[variant],
            SIZE[size],
            active ? 'dl-btn--active' : '',
            loading ? 'dl-btn--loading' : '',
            className,
        ]
            .filter(Boolean)
            .join(' ');
        return (
            <button ref={ref} type={type} className={cls} disabled={disabled || loading} {...rest}>
                {icon && <DlIcon name={icon} />}
                {children != null && <span>{children}</span>}
                {iconRight && <DlIcon name={iconRight} />}
            </button>
        );
    },
);
DlButton.displayName = 'DlButton';

export interface DlIconButtonProps extends Omit<DlButtonProps, 'children' | 'iconRight'> {
    icon: DlIconName;
    /** Accessible label + native tooltip (icon-only buttons have no visible text). */
    title: string;
}

/**
 * Icon-only design-lab button (`.dl-btn .dl-btn--icon`). For toolbar actions
 * that read clearly as a glyph — undo, redo, save, export, delete, lock.
 */
export const DlIconButton = React.forwardRef<HTMLButtonElement, DlIconButtonProps>(
    ({ icon, className = '', ...rest }, ref) => (
        <DlButton ref={ref} icon={icon} className={`dl-btn--icon ${className}`.trim()} {...rest} />
    ),
);
DlIconButton.displayName = 'DlIconButton';
