import React from 'react';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'dangerouslySetInnerHTML'> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    layout?: 'inline' | 'stacked' | 'tile';
    icon?: IconName;
    iconRight?: IconName;
    iconOnly?: boolean;
    active?: boolean;
    loading?: boolean;
    fullWidth?: boolean;
    children?: React.ReactNode;
}

const variantClass: Record<ButtonVariant, string> = {
    primary: 'btn--primary',
    secondary: 'btn--secondary',
    ghost: 'btn--ghost',
    danger: 'btn--danger',
    success: 'btn--success',
};

const sizeClass: Record<ButtonSize, string> = {
    sm: 'btn--sm',
    md: '',
    lg: 'btn--lg',
    xl: 'btn--xl',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    (
        {
            variant = 'secondary',
            size = 'md',
            layout = 'inline',
            icon,
            iconRight,
            iconOnly = false,
            active,
            loading = false,
            fullWidth = false,
            className = '',
            style,
            children,
            type = 'button',
            disabled,
            ...rest
        },
        ref,
    ) => {
        const classes = [
            'btn',
            variantClass[variant],
            sizeClass[size],
            layout === 'stacked' ? 'btn--stacked' : layout === 'tile' ? 'btn--tile' : '',
            iconOnly ? 'btn--icon' : '',
            active ? 'btn--active' : '',
            loading ? 'btn--loading' : '',
            fullWidth ? 'btn--full-width' : '',
            className,
        ]
            .filter(Boolean)
            .join(' ');

        return (
            <button
                ref={ref}
                type={type}
                className={classes}
                style={style}
                disabled={disabled || loading}
                aria-busy={loading || undefined}
                aria-pressed={active}
                {...rest}
            >
                {icon && <Icon name={icon} className="btn__icon" aria-hidden="true" />}
                {children}
                {iconRight && <Icon name={iconRight} className="btn__icon" aria-hidden="true" />}
                {loading && <span className="btn__spinner" aria-hidden="true" />}
            </button>
        );
    },
);
Button.displayName = 'Button';

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'iconRight' | 'iconOnly'> {
    icon: IconName;
    title: string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
    ({ title, ...props }, ref) => (
        <Button ref={ref} title={title} aria-label={title} {...props} iconOnly />
    ),
);
IconButton.displayName = 'IconButton';
