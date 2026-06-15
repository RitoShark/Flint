import { create } from 'zustand';
import type { Toast } from '../types';

interface NotificationState {
  toasts: Toast[];

  showToast: (type: Toast['type'], message: string, options?: { suggestion?: string; duration?: number }) => number;
  dismissToast: (id: number) => void;
}

let toastIdCounter = 0;

export const useNotificationStore = create<NotificationState>((set) => ({
  toasts: [],

  showToast: (type, message, options = {}) => {
    const id = ++toastIdCounter;
    const toast: Toast = {
      id,
      type,
      message,
      suggestion: options.suggestion || null,
      timestamp: Date.now(),
    };

    set((state) => ({ toasts: [...state.toasts, toast] }));

    const defaultDuration = type === 'error' ? 12000 : type === 'warning' ? 8000 : 5000;
    const duration = options.duration !== undefined ? options.duration : defaultDuration;
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) }));
      }, duration);
    }

    return id;
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) }));
  },
}));
