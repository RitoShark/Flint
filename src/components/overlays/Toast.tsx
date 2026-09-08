import { Button } from '../ui/Button';
import React from 'react';
import { useNotificationStore } from '../../lib/stores';
import { Icon } from '../ui/Icon';
import { getToastIcon } from '../../lib/ui-helpers/fileIcons';

const ToastIcon: React.FC<{ type: string }> = ({ type }) => {
    const iconHtml = getToastIcon(type as 'info' | 'success' | 'warning' | 'error');
    return <span className="toast-icon__glyph" dangerouslySetInnerHTML={{ __html: iconHtml }} />;
};

export const ToastContainer: React.FC = () => {
    const toasts = useNotificationStore((s) => s.toasts);
    const dismissToast = useNotificationStore((s) => s.dismissToast);

    if (toasts.length === 0) {
        return null;
    }

    return (
        <div className="toast-container">
            {toasts.map(toast => (
                <div
                    key={toast.id}
                    className={`toast toast-${toast.type}${toast.suggestion ? ' toast--stacked' : ''}`}
                >
                    <div className="toast-icon">
                        <ToastIcon type={toast.type} />
                    </div>
                    <div className="toast-content">
                        <div className="toast-message">{toast.message}</div>
                        {toast.suggestion && (
                            <div className="toast-suggestion">{toast.suggestion}</div>
                        )}
                    </div>
                    <Button
                        className="toast-dismiss" variant="ghost" size="sm" iconOnly
                        onClick={() => dismissToast(toast.id)}
                        aria-label="Dismiss"
                    >
                        <Icon name="close" />
                    </Button>
                </div>
            ))}
        </div>
    );
};
