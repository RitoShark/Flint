import { usePresence } from '../../lib/ui-helpers/usePresence';
import { Button } from './Button';
import React, { useEffect } from 'react';
import { Spinner } from './Spinner';
import { Icon } from './Icon';


export type ModalSize = 'default' | 'wide' | 'large';

export interface ModalProps {
    open: boolean;
    onClose?: () => void;
    size?: ModalSize;
    /** Extra modifier classes for the .modal element (e.g. 'modal--export'). */
    modifier?: string;
    closeOnOverlay?: boolean;
    closeOnEscape?: boolean;
    children: React.ReactNode;
}

const sizeClass: Record<ModalSize, string> = {
    default: '',
    wide: 'modal--wide',
    large: 'modal--large',
};

export const Modal: React.FC<ModalProps> = ({
    open,
    onClose,
    size = 'default',
    modifier = '',
    closeOnOverlay = true,
    closeOnEscape = true,
    children,
}) => {
    const { present: mounted, exiting: closing } = usePresence(open, 240);

    useEffect(() => {
        if (!open || !closeOnEscape || !onClose) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [open, closeOnEscape, onClose]);

    if (!mounted) return null;

    const handleOverlayClick = (e: React.MouseEvent) => {
        if (!closeOnOverlay || !onClose) return;
        if (e.target === e.currentTarget) onClose();
    };

    const overlayClass = `modal-overlay modal-overlay--visible ${closing ? 'modal-overlay--closing' : ''}`.trim();
    const modalClass = ['modal', sizeClass[size], modifier, closing ? 'modal--closing' : ''].filter(Boolean).join(' ');

    return (
        <div className={overlayClass} onClick={handleOverlayClick}>
            <div className={modalClass}>{children}</div>
        </div>
    );
};

export interface ModalHeaderProps {
    title: React.ReactNode;
    onClose?: () => void;
    children?: React.ReactNode;
}

export const ModalHeader: React.FC<ModalHeaderProps> = ({ title, onClose, children }) => (
    <div className="modal__header">
        <h2 className="modal__title">{title}</h2>
        {children}
        {onClose && (
            <Button className="modal__close" variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Close">
                <Icon name="close" />
            </Button>
        )}
    </div>
);

export const ModalBody: React.FC<{
    children: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
}> = ({ children, className = '', style }) => (
    <div className={`modal__body ${className}`.trim()} style={style}>
        {children}
    </div>
);

export interface ModalFooterProps {
    children: React.ReactNode;
    /** Renders the split layout with .modal__footer-actions on the right. */
    split?: boolean;
    /** Stack footer rows vertically (e.g. an input row above the action buttons). */
    stacked?: boolean;
    className?: string;
    style?: React.CSSProperties;
}

export const ModalFooter: React.FC<ModalFooterProps> = ({
    children,
    split = false,
    stacked = false,
    className = '',
    style,
}) => {
    const stackedStyle: React.CSSProperties | undefined = stacked
        ? { flexDirection: 'column', alignItems: 'stretch', gap: 12, ...style }
        : style;
    return (
        <div
            className={`modal__footer ${split ? 'modal__footer--split' : ''} ${className}`.trim()}
            style={stackedStyle}
        >
            {children}
        </div>
    );
};

export interface ModalLoadingProps {
    text: string;
    progress?: string;
}

export const ModalLoading: React.FC<ModalLoadingProps> = ({ text, progress }) => (
    <div className="modal__loading-overlay">
        <div className="modal__loading-content">
            <Spinner size="lg" />
            <div className="modal__loading-text">{text}</div>
            {progress && <div className="modal__loading-progress">{progress}</div>}
        </div>
    </div>
);
