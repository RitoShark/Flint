/**
 * File Editor Store
 *
 * Holds the "currently being edited" file target for the page-based
 * file editor. This decouples the editor page from the file tree —
 * any callsite (context menu, command palette, double-click) can
 * push a target here and navigate to the page.
 *
 * Why this isn't on `navigationStore`: the page can also remember
 * dirty state (so closing the tab can prompt to save), which doesn't
 * belong on the navigation store.
 */

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
