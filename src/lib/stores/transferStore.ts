/**
 * Transfer Store
 * Holds the pending cross-project file transfer (copy/move) opened when the
 * user drags a file-tree item onto another project's tab. The TransferModal
 * subscribes to this and performs the copy/move once the user picks a
 * destination folder and an operation.
 */

import { create } from 'zustand';
import type { TreeDragPayload } from '../dnd';

export interface PendingTransfer {
    /** The dragged source item (its own project path + relative path). */
    payload: TreeDragPayload;
    /** Absolute path of the destination project (the tab that was dropped on). */
    destProjectPath: string;
    /** Display name of the destination project. */
    destProjectName: string;
    /** Destination folder to pre-select (project-relative). When the item was
     *  dropped directly onto a folder row, this is that folder; otherwise the
     *  modal defaults to `content`. */
    initialFolder?: string;
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
