import { create } from 'zustand';
import type { ModelSummary, ModelSessionInfo } from '../api/modelEdit';
import type { SklData } from '../babylon/skeletonBuilder';
import type { AnimationList } from '../api/mesh';
import { baselineHiddenLower, namesHiddenBy } from '../editor3d/submeshBaseline';

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

    // Clips/forms/baseline from `readAnimationList` (non-fatal — a .skn with no
    // resolvable animation BIN just leaves this null). `activeForm` is an index
    // into `animationList.forms`, -1 for the base look.
    animationList: AnimationList | null;
    activeForm: number;
    // Currently-hidden submesh names (exact case), view state — never a staged
    // edit op. Starts at the `initialSubmeshToHide` baseline; a manual toggle
    // (`toggleHiddenName`) flips `hiddenOverridden` so a later baseline/form
    // re-derive doesn't stomp the user's choice. `initialSubmeshShadowHide` is
    // intentionally NOT applied here either, matching ModelPreview.
    hiddenNames: Set<string>;
    hiddenOverridden: boolean;

    setSession(info: ModelSessionInfo, skeleton: SklData | null): void;
    applySummary(summary: ModelSummary): void;
    select(selection: Selection): void;
    setClipboard(clipboard: SubmeshClipboard | null): void;
    setSaving(saving: boolean): void;
    /** New mesh loaded: resets to the base form and recomputes the baseline
     *  hidden set from `summary.submeshes` (whatever's current at call time). */
    setAnimationList(list: AnimationList | null): void;
    /** Gear-form switch: clears any manual override so the new form's baseline
     *  is what shows. The actual hidden-set recompute (which must also account
     *  for a live animation timeline) happens in the viewport's effect on this
     *  field — this setter only records the request. */
    setActiveForm(index: number): void;
    setHiddenNames(next: Set<string>): void;
    toggleHiddenName(name: string): void;
    /** Keeps a hidden submesh hidden across a live rename (no geometry
     *  reload happens for `renameSubmesh`, so nothing else would notice the
     *  hidden-set's key is stale). No-op if `oldName` wasn't hidden. */
    renameHiddenName(oldName: string, newName: string): void;
    /** Patches a joint's name in the live skeleton after a `renameJoint` op
     *  is staged — `stageModelEdit` only returns the (submesh-only)
     *  `ModelSummary`, so the outliner's bone tree would otherwise go stale
     *  since a joint rename never triggers `reloadGeometry`. */
    renameJointName(index: number, name: string): void;
    reset(): void;
}

export const useModelEditorStore = create<ModelEditorState>((set, get) => ({
    sessionId: null,
    sourcePath: null,
    skeletonPath: null,
    summary: null,
    skeleton: null,
    selection: null,
    clipboard: null,
    saving: false,

    animationList: null,
    activeForm: -1,
    hiddenNames: new Set(),
    hiddenOverridden: false,

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

    setAnimationList: (list) => {
        const names = (get().summary?.submeshes ?? []).map((s) => s.name);
        const baseline = baselineHiddenLower(list?.initial_hide, list?.forms, -1, names);
        set({
            animationList: list,
            activeForm: -1,
            hiddenOverridden: false,
            hiddenNames: namesHiddenBy(baseline, names),
        });
    },

    setActiveForm: (index) => set({ activeForm: index, hiddenOverridden: false }),

    setHiddenNames: (next) => set({ hiddenNames: next }),

    toggleHiddenName: (name) => {
        const next = new Set(get().hiddenNames);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        set({ hiddenNames: next, hiddenOverridden: true });
    },

    renameHiddenName: (oldName, newName) => {
        const current = get().hiddenNames;
        if (!current.has(oldName)) return;
        const next = new Set(current);
        next.delete(oldName);
        next.add(newName);
        set({ hiddenNames: next });
    },

    renameJointName: (index, name) => {
        const skeleton = get().skeleton;
        if (!skeleton || !skeleton.bones[index]) return;
        const bones = skeleton.bones.slice();
        bones[index] = { ...bones[index], name };
        set({ skeleton: { ...skeleton, bones } });
    },

    reset: () =>
        set({
            sessionId: null,
            sourcePath: null,
            skeletonPath: null,
            summary: null,
            skeleton: null,
            selection: null,
            saving: false,
            animationList: null,
            activeForm: -1,
            hiddenNames: new Set(),
            hiddenOverridden: false,
        }),
}));
