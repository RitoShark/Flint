import { create } from 'zustand';
import type { FileEditorTarget } from '../types';

interface FileEditorState {
    /** Active file being edited, or null if the editor page isn't open. */
    target: FileEditorTarget | null;
    /** Set true by editors when their form has unsaved changes. */
    dirty: boolean;

    openTarget: (target: FileEditorTarget) => void;
    closeTarget: () => void;
    setDirty: (dirty: boolean) => void;
}

export const useFileEditorStore = create<FileEditorState>((set) => ({
    target: null,
    dirty: false,

    openTarget: (target) => set({ target, dirty: false }),
    closeTarget: () => set({ target: null, dirty: false }),
    setDirty: (dirty) => set({ dirty }),
}));
