import { create } from 'zustand';
import type { ModelSummary, ModelSessionInfo } from '../api/modelEdit';
import type { SklData } from '../babylon/skeletonBuilder';

export type Selection =
    | { kind: 'submesh'; name: string }
    | { kind: 'joint'; id: number }
    | null;

/** A submesh copied for pasting. In-window only — no OS clipboard in Phase 1. */
export interface SubmeshClipboard {
    sourceSkn: string;
    sourceIndex: number;
    name: string;
}

interface ModelEditorState {
    sessionId: string | null;
    sourcePath: string | null;
    skeletonPath: string | null;
    summary: ModelSummary | null;
    skeleton: SklData | null;
    selection: Selection;
    clipboard: SubmeshClipboard | null;
    saving: boolean;

    setSession(info: ModelSessionInfo, skeleton: SklData | null): void;
    applySummary(summary: ModelSummary): void;
    select(selection: Selection): void;
    setClipboard(clipboard: SubmeshClipboard | null): void;
    setSaving(saving: boolean): void;
    reset(): void;
}

export const useModelEditorStore = create<ModelEditorState>((set) => ({
    sessionId: null,
    sourcePath: null,
    skeletonPath: null,
    summary: null,
    skeleton: null,
    selection: null,
    clipboard: null,
    saving: false,

    setSession: (info, skeleton) =>
        set({
            sessionId: info.sessionId,
            sourcePath: info.sourcePath,
            skeletonPath: info.skeletonPath,
            summary: info.summary,
            skeleton,
            selection: null,
        }),

    // The backend summary is authoritative — it comes from the same fold that
    // produced the geometry, so the UI can never drift from what would be saved.
    applySummary: (summary) => set({ summary }),

    select: (selection) => set({ selection }),
    setClipboard: (clipboard) => set({ clipboard }),
    setSaving: (saving) => set({ saving }),

    reset: () =>
        set({
            sessionId: null,
            sourcePath: null,
            skeletonPath: null,
            summary: null,
            skeleton: null,
            selection: null,
            saving: false,
        }),
}));
