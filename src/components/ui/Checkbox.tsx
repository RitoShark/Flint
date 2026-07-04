import React from 'react';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
    label?: React.ReactNode;
    description?: React.ReactNode;
    /** Renders as a toggle-switch using `.settings-toggle` styling. */
    toggle?: boolean;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
    ({ label, description, toggle = false, className = '', id, ...rest }, ref) => {
        if (toggle) {
            return (
                <label className={`settings-toggle ${className}`.trim()}>
                    <input ref={ref} type="checkbox" id={id} {...rest} />
                    {(label || description) && (
                        <div className="settings-toggle__content">
                            {label && <div className="settings-toggle__label">{label}</div>}
                            {description && <div className="settings-toggle__description">{description}</div>}
                        </div>
                    )}
                </label>
            );
        }

        return (
            <label className={`checkbox-label ${className}`.trim()}>
                <input ref={ref} type="checkbox" id={id} {...rest} />
                {(label || description) && (
                    <span className="checkbox-label__content">
                        {label && <span className="checkbox-label__label">{label}</span>}
                        {description && <span className="checkbox-label__description">{description}</span>}
                    </span>
                )}
            </label>
        );
    },
);
Checkbox.displayName = 'Checkbox';
