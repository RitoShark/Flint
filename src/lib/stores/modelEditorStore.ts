import { create } from 'zustand';
import type { ModelSummary, ModelSessionInfo } from '../api/modelEdit';
import type { SklData } from '../babylon/skeletonBuilder';
import type { AnimationList } from '../api/mesh';
import { baselineHiddenLower, namesHiddenBy } from '../editor3d/submeshBaseline';
import type { BrushSettings, Influence } from '../editor3d/weightPaint';
import type { SkeletonOverlayMode } from '../babylon/sknScene';

export type Selection =
    | { kind: 'submesh'; name: string }
    | { kind: 'joint'; id: number }
    | null;

export type EditorMode = 'object' | 'weights';

export interface SampledVertex {
    vertex: number;
    influences: Influence[];
}

const DEFAULT_BRUSH: BrushSettings = { mode: 'add', radius: 1, strength: 0.4, falloff: 2 };

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

    animationList: AnimationList | null;
    activeForm: number;
    hiddenNames: Set<string>;
    hiddenOverridden: boolean;

    mode: EditorMode;
    skeletonOverlay: SkeletonOverlayMode;
    skeletonXray: boolean;
    activeJointId: number | null;
    brush: BrushSettings;
    sampledVertex: SampledVertex | null;

    setMode(mode: EditorMode): void;
    setSkeletonOverlay(mode: SkeletonOverlayMode): void;
    setSkeletonXray(on: boolean): void;
    setActiveJointId(id: number | null): void;
    setBrush(patch: Partial<BrushSettings>): void;
    setSampledVertex(sample: SampledVertex | null): void;

    setSession(info: ModelSessionInfo, skeleton: SklData | null): void;
    applySummary(summary: ModelSummary): void;
    select(selection: Selection): void;
    setClipboard(clipboard: SubmeshClipboard | null): void;
    setSaving(saving: boolean): void;
    setAnimationList(list: AnimationList | null): void;
    // Only records the active form — the hidden-set recompute for it happens in EditorViewport's effect on this field.
    setActiveForm(index: number): void;
    setHiddenNames(next: Set<string>): void;
    toggleHiddenName(name: string): void;
    // Keeps a hidden submesh hidden across a rename — renameSubmesh never reloads geometry, so nothing else would refresh this key.
    renameHiddenName(oldName: string, newName: string): void;
    // Patches the live skeleton after renameJoint is staged — stageModelEdit's ModelSummary is submesh-only, so the outliner's bone tree would otherwise go stale.
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

    mode: 'object',
    skeletonOverlay: 'off',
    skeletonXray: true,
    activeJointId: null,
    brush: DEFAULT_BRUSH,
    sampledVertex: null,

    setMode: (mode) => {
        const next: Partial<ModelEditorState> = { mode, sampledVertex: null };
        // Weight mode is useless without the rig on screen, and Maya turns X-ray on with it.
        if (mode === 'weights' && get().skeletonOverlay === 'off') next.skeletonOverlay = 'bones';
        set(next);
    },
    setSkeletonOverlay: (skeletonOverlay) => set({ skeletonOverlay }),
    setSkeletonXray: (skeletonXray) => set({ skeletonXray }),
    setActiveJointId: (activeJointId) => set({ activeJointId }),
    setBrush: (patch) => set({ brush: { ...get().brush, ...patch } }),
    setSampledVertex: (sampledVertex) => set({ sampledVertex }),

    setSession: (info, skeleton) =>
        set({
            sessionId: info.sessionId,
            sourcePath: info.sourcePath,
            skeletonPath: info.skeletonPath,
            summary: info.summary,
            skeleton,
            selection: null,
        }),

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
            mode: 'object',
            skeletonOverlay: 'off',
            skeletonXray: true,
            activeJointId: null,
            brush: DEFAULT_BRUSH,
            sampledVertex: null,
        }),
}));
