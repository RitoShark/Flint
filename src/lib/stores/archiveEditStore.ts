import { create } from 'zustand';
import type { ArchiveLayout } from '../api/archiveEdit';

interface ArchiveEditState {
    layout: ArchiveLayout | null;
    metaJson: string;
    dirty: boolean;
    /** wad name currently open in the embedded WAD editor. */
    openWadName: string | null;
    /** the inner WAD's backend edit-session id (for chunk ops + save). */
    openWadSessionId: string | null;
    setLayout: (l: ArchiveLayout) => void;
    setMetaJson: (s: string) => void;
    openWad: (name: string, sessionId: string) => void;
    closeWad: () => void;
    markDirty: () => void;
    reset: () => void;
}

export const useArchiveEditStore = create<ArchiveEditState>((set) => ({
    layout: null,
    metaJson: '',
    dirty: false,
    openWadName: null,
    openWadSessionId: null,
    setLayout: (l) => set({ layout: l, metaJson: l.meta_json, dirty: false, openWadName: null, openWadSessionId: null }),
    setMetaJson: (s) => set({ metaJson: s, dirty: true }),
    openWad: (name, sessionId) => set({ openWadName: name, openWadSessionId: sessionId }),
    closeWad: () => set({ openWadName: null, openWadSessionId: null }),
    markDirty: () => set({ dirty: true }),
    reset: () => set({ layout: null, metaJson: '', dirty: false, openWadName: null, openWadSessionId: null }),
}));
