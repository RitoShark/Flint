import { create } from 'zustand';
import type { ModalType, ConfirmDialogState, ContextMenuState, ContextMenuOption } from '../types';

interface ModalState {
  activeModal: ModalType;
  modalOptions: Record<string, unknown> | null;
  confirmDialog: ConfirmDialogState | null;
  contextMenu: ContextMenuState | null;

  openModal: (modal: ModalType, options?: Record<string, unknown>) => void;
  closeModal: () => void;
  openConfirmDialog: (dialog: ConfirmDialogState) => void;
  closeConfirmDialog: () => void;
  openContextMenu: (x: number, y: number, options: ContextMenuOption[]) => void;
  closeContextMenu: () => void;
}

export const useModalStore = create<ModalState>((set) => ({
  activeModal: null,
  modalOptions: null,
  confirmDialog: null,
  contextMenu: null,

  openModal: (modal, options) => set({ activeModal: modal, modalOptions: options || null }),
  closeModal: () => set({ activeModal: null, modalOptions: null }),
  openConfirmDialog: (dialog) => set({ confirmDialog: dialog }),
  closeConfirmDialog: () => set({ confirmDialog: null }),
  openContextMenu: (x, y, options) => set({ contextMenu: { x, y, options } }),
  closeContextMenu: () => set({ contextMenu: null }),
}));
