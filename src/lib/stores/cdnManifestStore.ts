import { create } from 'zustand';
import type { CdnTreeNode, CdnWadChunk } from '../api/cdn';

export type ArtifactFilter = 'game' | 'client' | 'all';

/** Pure filter over any kind-tagged manifest list by artifact kind. */
export function filterManifests<T extends { kind: string }>(list: T[], filter: ArtifactFilter): T[] {
    if (filter === 'all') return list;
    return list.filter(e => e.kind === filter);
}

/** Per-open-manifest browse state, mirroring wadExplorerStore so the same UI binds. */
export interface CdnManifestSession {
    sessionId: string;
    label: string;            // e.g. "16.12.7869679 · NA1"
    region: string;
    tree: CdnTreeNode;
    fileCount: number;
    expandedFolders: Set<string>;
    expandedWads: Set<string>;
    searchQuery: string;
    checkedFiles: Set<string>;
    selected: { wadFileIndex: number; hash: string } | null;
    /** Inner-WAD listings already fetched, keyed by the WAD's manifest file_index. */
    wadInner: Map<number, CdnWadChunk[]>;
}

interface CdnManifestState {
    sessions: Record<string, CdnManifestSession>;
    addSession: (s: CdnManifestSession) => void;
    removeSession: (sessionId: string) => void;
    update: (sessionId: string, patch: Partial<CdnManifestSession>) => void;
}

export const useCdnManifestStore = create<CdnManifestState>((set) => ({
    sessions: {},
    addSession: (s) => set((st) => ({ sessions: { ...st.sessions, [s.sessionId]: s } })),
    removeSession: (sessionId) => set((st) => {
        const next = { ...st.sessions };
        delete next[sessionId];
        return { sessions: next };
    }),
    update: (sessionId, patch) => set((st) => {
        const cur = st.sessions[sessionId];
        if (!cur) return {};
        return { sessions: { ...st.sessions, [sessionId]: { ...cur, ...patch } } };
    }),
}));
