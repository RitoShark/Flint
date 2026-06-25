import { create } from 'zustand';

export interface ArchiveTab {
  id: string;
  filePath: string;
  name: string;
  kind: 'fantome' | 'modpkg';
  isDirty?: boolean;
}

interface ArchiveTabState {
  openArchiveTabs: ArchiveTab[];
  activeArchiveTabId: string | null;

  /** Open (or activate, if already open) an archive tab for the given path. Returns its id. */
  openArchiveTab: (filePath: string) => string;
  /** Remove a tab; picks a neighbor as the new active tab. */
  removeArchiveTab: (tabId: string) => { newActiveId: string | null; remaining: ArchiveTab[] };
  switchArchiveTab: (tabId: string) => void;
  setArchiveTabDirty: (tabId: string, dirty: boolean) => void;
}

let archiveTabIdCounter = 0;
function generateArchiveTabId(): string {
  return `archive-${Date.now()}-${++archiveTabIdCounter}`;
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function kindFromPath(filePath: string): 'fantome' | 'modpkg' {
  return filePath.toLowerCase().endsWith('.modpkg') ? 'modpkg' : 'fantome';
}

export const useArchiveTabStore = create<ArchiveTabState>((set, get) => ({
  openArchiveTabs: [],
  activeArchiveTabId: null,

  openArchiveTab: (filePath) => {
    const { openArchiveTabs } = get();
    const existing = openArchiveTabs.find((t) => t.filePath === filePath);
    if (existing) {
      set({ activeArchiveTabId: existing.id });
      return existing.id;
    }
    const newTab: ArchiveTab = {
      id: generateArchiveTabId(),
      filePath,
      name: basename(filePath),
      kind: kindFromPath(filePath),
    };
    set({
      openArchiveTabs: [...openArchiveTabs, newTab],
      activeArchiveTabId: newTab.id,
    });
    return newTab.id;
  },

  removeArchiveTab: (tabId) => {
    const { openArchiveTabs, activeArchiveTabId } = get();
    const remaining = openArchiveTabs.filter((t) => t.id !== tabId);
    let newActiveId = activeArchiveTabId;

    if (activeArchiveTabId === tabId) {
      const closedIndex = openArchiveTabs.findIndex((t) => t.id === tabId);
      if (remaining.length > 0) {
        const newIndex = Math.max(0, closedIndex - 1);
        newActiveId = remaining[newIndex]?.id || null;
      } else {
        newActiveId = null;
      }
    }

    set({ openArchiveTabs: remaining, activeArchiveTabId: newActiveId });
    return { newActiveId, remaining };
  },

  switchArchiveTab: (tabId) => {
    const { openArchiveTabs } = get();
    if (openArchiveTabs.find((t) => t.id === tabId)) {
      set({ activeArchiveTabId: tabId });
    }
  },

  setArchiveTabDirty: (tabId, dirty) => {
    set((state) => ({
      openArchiveTabs: state.openArchiveTabs.map((t) =>
        t.id === tabId ? { ...t, isDirty: dirty } : t
      ),
    }));
  },
}));
