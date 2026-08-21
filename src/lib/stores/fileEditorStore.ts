import { create } from 'zustand';
import type { FileEditorTarget } from '../types';

/** One open standalone file-editor tab. */
export interface FileEditorTab {
    id: string;
    target: FileEditorTarget;
    dirty: boolean;
}

interface FileEditorState {
    /** All open standalone file-editor tabs. */
    tabs: FileEditorTab[];
    /** Id of the active tab, or null when none are open. */
    activeId: string | null;

    /** The active tab's target (back-compat: editors read this). */
    target: FileEditorTarget | null;
    /** The active tab's dirty flag (back-compat). */
    dirty: boolean;

    /**
     * Open a file in its OWN tab and switch to it. If a tab for the same
     * filePath already exists, activate that one instead of duplicating —
     * so each standalone file lives in an isolated tab and never renders
     * over an open project's view.
     */
    openTarget: (target: FileEditorTarget) => string;
    /** Close a specific tab; returns the new active id + remaining tabs. */
    closeTab: (tabId: string) => { newActiveId: string | null; remaining: FileEditorTab[] };
    /** Close the active tab (back-compat with the old single-target API). */
    closeTarget: () => { newActiveId: string | null; remaining: FileEditorTab[] };
    /** Activate an existing tab. */
    switchTab: (tabId: string) => void;
    /** Set the active tab's dirty flag (back-compat). */
    setDirty: (dirty: boolean) => void;
    /**
     * Point any open tab at `oldFilePath` — or at a file beneath it, when a
     * folder was renamed — to its new path, in place. The tab keeps its id,
     * position and dirty flag, so a renamed file stays open where it was
     * instead of the editor reloading a path that no longer exists.
     */
    retargetFile: (oldFilePath: string, newFilePath: string) => void;
}

let fileEditorTabCounter = 0;
function generateFileEditorTabId(): string {
    return `fileeditor-${Date.now()}-${++fileEditorTabCounter}`;
}

/* Length-preserving on purpose: callers slice the ORIGINAL path by an offset measured here. */
function comparablePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
}

/** Recompute the derived `target`/`dirty` from tabs + activeId. */
function derive(tabs: FileEditorTab[], activeId: string | null): Pick<FileEditorState, 'target' | 'dirty'> {
    const active = tabs.find((t) => t.id === activeId) ?? null;
    return { target: active?.target ?? null, dirty: active?.dirty ?? false };
}

export const useFileEditorStore = create<FileEditorState>((set, get) => ({
    tabs: [],
    activeId: null,
    target: null,
    dirty: false,

    openTarget: (target) => {
        const { tabs } = get();
        const existing = tabs.find((t) => t.target.filePath === target.filePath);
        if (existing) {
            set({ activeId: existing.id, ...derive(tabs, existing.id) });
            return existing.id;
        }
        const tab: FileEditorTab = { id: generateFileEditorTabId(), target, dirty: false };
        const newTabs = [...tabs, tab];
        set({ tabs: newTabs, activeId: tab.id, ...derive(newTabs, tab.id) });
        return tab.id;
    },

    closeTab: (tabId) => {
        const { tabs, activeId } = get();
        const remaining = tabs.filter((t) => t.id !== tabId);
        let newActiveId = activeId;
        if (activeId === tabId) {
            const closedIndex = tabs.findIndex((t) => t.id === tabId);
            newActiveId = remaining.length > 0 ? (remaining[Math.max(0, closedIndex - 1)]?.id ?? null) : null;
        }
        set({ tabs: remaining, activeId: newActiveId, ...derive(remaining, newActiveId) });
        return { newActiveId, remaining };
    },

    closeTarget: () => {
        const { activeId } = get();
        if (!activeId) return { newActiveId: null, remaining: get().tabs };
        return get().closeTab(activeId);
    },

    switchTab: (tabId) => {
        const { tabs } = get();
        if (tabs.find((t) => t.id === tabId)) {
            set({ activeId: tabId, ...derive(tabs, tabId) });
        }
    },

    setDirty: (dirty) => {
        const { tabs, activeId } = get();
        if (!activeId) {
            set({ dirty });
            return;
        }
        const newTabs = tabs.map((t) => (t.id === activeId ? { ...t, dirty } : t));
        set({ tabs: newTabs, ...derive(newTabs, activeId) });
    },

    retargetFile: (oldFilePath, newFilePath) => {
        const { tabs, activeId } = get();
        const oldKey = comparablePath(oldFilePath);
        let changed = false;

        const newTabs = tabs.map((t) => {
            const current = comparablePath(t.target.filePath);
            let retargeted: string | null = null;

            if (current === oldKey) {
                retargeted = newFilePath;
            } else if (current.startsWith(`${oldKey}/`)) {
                retargeted = newFilePath + t.target.filePath.slice(oldFilePath.length);
            }

            if (retargeted === null) return t;
            changed = true;
            return { ...t, target: { ...t.target, filePath: retargeted } };
        });

        if (!changed) return;
        set({ tabs: newTabs, ...derive(newTabs, activeId) });
    },
}));
