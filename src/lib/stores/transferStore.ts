import { create } from 'zustand';
import type { TreeDragPayload } from '../dnd';

export interface PendingTransfer {
    payload: TreeDragPayload;
    destProjectPath: string;
    destProjectName: string;
    /** Project-relative folder the item was dropped into; "." for project root. */
    destFolder: string;
}

interface TransferState {
    pending: PendingTransfer | null;
    openTransfer: (transfer: PendingTransfer) => void;
    closeTransfer: () => void;
}

export const useTransferStore = create<TransferState>((set) => ({
    pending: null,
    openTransfer: (pending) => set({ pending }),
    closeTransfer: () => set({ pending: null }),
}));
