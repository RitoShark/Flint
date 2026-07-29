import { create } from 'zustand';
import type { ModalType, ConfirmDialogState, ContextMenuState, ContextMenuOption } from '../types';

interface ModalState {
  activeModal: ModalType;
  modalOptions: Record<string, unknown> | null;
  confirmDialog: ConfirmDialogState | null;
  contextMenu: ContextMenuState | null;

  /**
   * Set by a modal that must intercept its own close (e.g. unsaved edits).
   * Returning `true` means the guard has taken over — the modal stays open until
   * it calls `closeModal` again. Registered here rather than on the modal's
   * `onClose` because Escape also reaches `closeModal` directly via the
   * `modal.close` shortcut, which would otherwise bypass the guard.
   */
  closeGuard: (() => boolean) | null;

  openModal: (modal: ModalType, options?: Record<string, unknown>) => void;
  closeModal: () => void;
  setCloseGuard: (guard: (() => boolean) | null) => void;
  openConfirmDialog: (dialog: ConfirmDialogState) => void;
  closeConfirmDialog: () => void;
  openContextMenu: (x: number, y: number, options: ContextMenuOption[]) => void;
  closeContextMenu: () => void;
}

export const useModalStore = create<ModalState>((set, get) => ({
  activeModal: null,
  modalOptions: null,
  confirmDialog: null,
  contextMenu: null,
  closeGuard: null,

  openModal: (modal, options) => set({ activeModal: modal, modalOptions: options || null, closeGuard: null }),
  closeModal: () => {
    const guard = get().closeGuard;
    if (guard && guard()) return;
    set({ activeModal: null, modalOptions: null, closeGuard: null });
  },
  setCloseGuard: (guard) => set({ closeGuard: guard }),
  openConfirmDialog: (dialog) => set({ confirmDialog: dialog }),
  closeConfirmDialog: () => set({ confirmDialog: null }),
  openContextMenu: (x, y, options) => set({ contextMenu: { x, y, options } }),
  closeContextMenu: () => set({ contextMenu: null }),
}));
