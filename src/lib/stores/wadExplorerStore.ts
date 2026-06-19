import { create } from 'zustand';
import type { WadExplorerWad, WadChunk, GameWadInfo } from '../types';

const RECENT_WADS_KEY = 'flint.wadExplorer.recentWads';
const RECENT_WADS_MAX = 10;

function loadRecentWads(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_WADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string').slice(0, RECENT_WADS_MAX);
  } catch {
    return [];
  }
}

function saveRecentWads(list: string[]) {
  try {
    localStorage.setItem(RECENT_WADS_KEY, JSON.stringify(list));
  } catch {
    /* non-fatal */
  }
}

interface WadExplorerState {
  isOpen: boolean;
  wads: WadExplorerWad[];
  scanStatus: 'idle' | 'scanning' | 'ready' | 'error';
  scanError: string | null;
  selected: { wadPath: string; hash: string } | null;
  expandedWads: Set<string>;
  expandedFolders: Set<string>;
  searchQuery: string;
  checkedFiles: Set<string>;
  checkedCountPerWad: Map<string, number>;
  /** Most-recently-opened WAD paths (front = newest). */
  recentWads: string[];

  open: () => void;
  close: () => void;
  setScan: (status: WadExplorerState['scanStatus'], wads?: GameWadInfo[], error?: string) => void;
  setWadStatus: (wadPath: string, status: WadExplorerWad['status'], chunks?: WadChunk[], error?: string) => void;
  batchSetWadStatuses: (updates: Array<{ wadPath: string; status: WadExplorerWad['status']; chunks?: WadChunk[]; error?: string }>) => void;
  setSelected: (wadPath: string | null, hash: string | null) => void;
  toggleWad: (wadPath: string) => void;
  toggleFolder: (key: string) => void;
  bulkSetFolders: (keys: string[], expand: boolean) => void;
  setSearch: (query: string) => void;
  toggleCheck: (keys: string[], checked: boolean) => void;
  clearChecks: () => void;
  pushRecentWad: (wadPath: string) => void;
}

export const useWadExplorerStore = create<WadExplorerState>((set) => ({
  isOpen: false,
  wads: [],
  scanStatus: 'idle',
  scanError: null,
  selected: null,
  expandedWads: new Set<string>(),
  expandedFolders: new Set<string>(),
  searchQuery: '',
  checkedFiles: new Set<string>(),
  checkedCountPerWad: new Map<string, number>(),
  recentWads: loadRecentWads(),

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),

  setScan: (status, wads, error) => {
    const newWads: WadExplorerWad[] = wads
      ? wads.map(w => ({ ...w, status: 'idle' as const, chunks: [] }))
      : [];
    set((state) => ({
      scanStatus: status,
      scanError: error ?? null,
      wads: wads ? newWads : state.wads,
      checkedFiles: new Set<string>(),
      checkedCountPerWad: new Map<string, number>(),
    }));
  },

  setWadStatus: (wadPath, status, chunks, error) => {
    set((state) => ({
      wads: state.wads.map(w =>
        w.path === wadPath
          ? { ...w, status, chunks: chunks ?? w.chunks, error }
          : w
      ),
    }));
  },

  batchSetWadStatuses: (updates) => {
    const updateMap = new Map(updates.map(u => [u.wadPath, u]));
    set((state) => ({
      wads: state.wads.map(w => {
        const u = updateMap.get(w.path);
        return u ? { ...w, status: u.status, chunks: u.chunks ?? w.chunks, error: u.error } : w;
      }),
    }));
  },

  setSelected: (wadPath, hash) => {
    set({
      selected: wadPath && hash ? { wadPath, hash } : null,
    });
  },

  toggleWad: (wadPath) => {
    set((state) => {
      const newExpanded = new Set(state.expandedWads);
      if (newExpanded.has(wadPath)) {
        newExpanded.delete(wadPath);
      } else {
        newExpanded.add(wadPath);
      }
      return { expandedWads: newExpanded };
    });
  },

  toggleFolder: (key) => {
    set((state) => {
      const newExpanded = new Set(state.expandedFolders);
      if (newExpanded.has(key)) {
        newExpanded.delete(key);
      } else {
        newExpanded.add(key);
      }
      return { expandedFolders: newExpanded };
    });
  },

  bulkSetFolders: (keys, expand) => {
    set((state) => {
      const newExpanded = new Set(state.expandedFolders);
      for (const k of keys) {
        if (expand) newExpanded.add(k);
        else newExpanded.delete(k);
      }
      return { expandedFolders: newExpanded };
    });
  },

  setSearch: (query) => set({ searchQuery: query }),

  toggleCheck: (keys, checked) => {
    set((state) => {
      const next = new Set(state.checkedFiles);
      const counts = new Map(state.checkedCountPerWad);
      const deltas = new Map<string, number>();
      for (const k of keys) {
        if (checked) {
          if (next.has(k)) continue;
          next.add(k);
          const sep = k.indexOf('::');
          if (sep > 0) {
            const wadPath = k.slice(0, sep);
            deltas.set(wadPath, (deltas.get(wadPath) ?? 0) + 1);
          }
        } else {
          if (!next.has(k)) continue;
          next.delete(k);
          const sep = k.indexOf('::');
          if (sep > 0) {
            const wadPath = k.slice(0, sep);
            deltas.set(wadPath, (deltas.get(wadPath) ?? 0) - 1);
          }
        }
      }
      for (const [wadPath, delta] of deltas) {
        const newCount = (counts.get(wadPath) ?? 0) + delta;
        if (newCount <= 0) counts.delete(wadPath);
        else counts.set(wadPath, newCount);
      }
      return { checkedFiles: next, checkedCountPerWad: counts };
    });
  },

  clearChecks: () => set({
    checkedFiles: new Set<string>(),
    checkedCountPerWad: new Map<string, number>(),
  }),

  pushRecentWad: (wadPath) => {
    set((state) => {
      const filtered = state.recentWads.filter((p) => p !== wadPath);
      const next = [wadPath, ...filtered].slice(0, RECENT_WADS_MAX);
      saveRecentWads(next);
      return { recentWads: next };
    });
  },
}));
