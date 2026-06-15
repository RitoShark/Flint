import React from 'react';
import { Button } from './Button';

export interface FormGroupProps {
    children: React.ReactNode;
    half?: boolean;
    className?: string;
}

export const FormGroup: React.FC<FormGroupProps> = ({ children, half = false, className = '' }) => (
    <div className={`form-group ${half ? 'form-group--half' : ''} ${className}`.trim()}>{children}</div>
);

export const FormRow: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
    <div className={`form-row ${className}`.trim()}>{children}</div>
);

export interface FormLabelProps {
    children: React.ReactNode;
    htmlFor?: string;
    required?: boolean;
}

export const FormLabel: React.FC<FormLabelProps> = ({ children, htmlFor, required }) => (
    <label className="form-label" htmlFor={htmlFor}>
        {children}
        {required && <span style={{ color: 'var(--accent-danger, #f85149)' }}> *</span>}
    </label>
);

export const FormHint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <small className="form-hint">{children}</small>
);

export const FormError: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="form-error">{children}</div>
);

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    invalid?: boolean;
    sizeVariant?: 'sm' | 'md';
    /** When set, renders the input wrapped with a button on the right. */
    buttonLabel?: string;
    onButtonClick?: () => void;
    buttonDisabled?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
    (
        { invalid, sizeVariant = 'md', buttonLabel, onButtonClick, buttonDisabled, className = '', type = 'text', ...rest },
        ref,
    ) => {
        const classes = [
            'form-input',
            sizeVariant === 'sm' ? 'form-input--sm' : '',
            invalid ? 'form-input--invalid' : '',
            className,
        ]
            .filter(Boolean)
            .join(' ');

        const input = <input ref={ref} type={type} className={classes} {...rest} />;

        if (buttonLabel) {
            return (
                <div className="form-input--with-button">
                    {input}
                    <Button variant="secondary" onClick={onButtonClick} disabled={buttonDisabled}>
                        {buttonLabel}
                    </Button>
                </div>
            );
        }

        return input;
    },
);
Input.displayName = 'Input';

export const SearchInput = React.forwardRef<HTMLInputElement, InputProps>((props, ref) => (
    <Input ref={ref} {...props} className={`form-input--search ${props.className ?? ''}`.trim()} />
));
SearchInput.displayName = 'SearchInput';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
    ({ invalid, className = '', ...rest }, ref) => (
        <textarea
            ref={ref}
            className={`form-textarea ${invalid ? 'form-textarea--invalid' : ''} ${className}`.trim()}
            {...rest}
        />
    ),
);
Textarea.displayName = 'Textarea';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
    children: React.ReactNode;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(({ className = '', children, ...rest }, ref) => (
    <select ref={ref} className={`form-select ${className}`.trim()} {...rest}>
        {children}
    </select>
));
Select.displayName = 'Select';

export interface RangeProps extends React.InputHTMLAttributes<HTMLInputElement> {
    hue?: boolean;
}

export const Range: React.FC<RangeProps> = ({ hue = false, className = '', ...rest }) => (
    <input
        type="range"
        className={`form-range ${hue ? 'form-range--hue' : ''} ${className}`.trim()}
        {...rest}
    />
);

export interface FieldProps extends Omit<InputProps, 'id'> {
    id?: string;
    label?: React.ReactNode;
    hint?: React.ReactNode;
    error?: React.ReactNode;
    required?: boolean;
    half?: boolean;
}

let fieldIdCounter = 0;
const useFieldId = (override?: string) => {
    const idRef = React.useRef<string | undefined>(override);
    if (!idRef.current) idRef.current = `field-${++fieldIdCounter}`;
    return idRef.current;
};

export const Field: React.FC<FieldProps> = ({ id, label, hint, error, required, half, ...inputProps }) => {
    const fieldId = useFieldId(id);
    return (
        <FormGroup half={half}>
            {label && (
                <FormLabel htmlFor={fieldId} required={required}>
                    {label}
                </FormLabel>
            )}
            <Input id={fieldId} invalid={!!error} {...inputProps} />
            {hint && !error && <FormHint>{hint}</FormHint>}
            {error && <FormError>{error}</FormError>}
        </FormGroup>
    );
};
