/**
 * Project Tab Store
 * Manages multi-tab workspace, file trees, and folder expansion state
 */

import { create } from 'zustand';
import type { ProjectTab, Project, FileTreeNode } from '../types';

interface ProjectTabState {
  openTabs: ProjectTab[];
  activeTabId: string | null;

  // Actions
  addTab: (project: Project, path: string) => void;
  removeTab: (tabId: string) => { newActiveId: string | null; remainingTabs: ProjectTab[] };
  switchTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<ProjectTab>) => void;
  setFileTree: (tabId: string, tree: FileTreeNode | null) => void;
  toggleFolder: (tabId: string, folderPath: string) => void;
  bulkSetFolders: (tabId: string, paths: string[], expand: boolean) => void;
  setSelectedFile: (tabId: string, filePath: string | null) => void;
}

// Helper to generate unique tab IDs
let tabIdCounter = 0;
function generateTabId(): string {
  return `tab-${Date.now()}-${++tabIdCounter}`;
}

/**
 * Walk the project file tree and return every folder path that should be
 * expanded by default on first open: the project root, `content/`, every
 * `content/<layer>/` folder, and every `content/<layer>/<name>.wad.client/`
 * folder. The set is small (O(layers × wads)) — typically 3-4 entries.
 */
function collectAutoExpandPaths(root: FileTreeNode): string[] {
  const paths: string[] = ['.'];
  const content = root.children?.find(c => c.isDirectory && c.name === 'content');
  if (!content) return paths;
  paths.push(content.path);
  for (const layer of content.children ?? []) {
    if (!layer.isDirectory) continue;
    paths.push(layer.path);
    for (const wad of layer.children ?? []) {
      if (wad.isDirectory && wad.name.toLowerCase().endsWith('.wad.client')) {
        paths.push(wad.path);
      }
    }
  }
  return paths;
}

export const useProjectTabStore = create<ProjectTabState>((set, get) => ({
  openTabs: [],
  activeTabId: null,

  addTab: (project, path) => {
    const { openTabs } = get();
    // Check if this project is already open
    const existingTab = openTabs.find(t => t.projectPath === path);
    if (existingTab) {
      // Switch to existing tab
      set({ activeTabId: existingTab.id });
      return;
    }
    // Create new tab
    const newTab: ProjectTab = {
      id: generateTabId(),
      project,
      projectPath: path,
      selectedFile: null,
      fileTree: null,
      expandedFolders: new Set(),
      hasAutoExpanded: false,
    };
    set({
      openTabs: [...openTabs, newTab],
      activeTabId: newTab.id,
    });
  },

  removeTab: (tabId) => {
    const { openTabs, activeTabId } = get();
    const newTabs = openTabs.filter(t => t.id !== tabId);
    let newActiveId = activeTabId;

    // If we closed the active tab, switch to another
    if (activeTabId === tabId) {
      const closedIndex = openTabs.findIndex(t => t.id === tabId);
      if (newTabs.length > 0) {
        // Switch to previous tab, or first if we closed the first
        const newIndex = Math.max(0, closedIndex - 1);
        newActiveId = newTabs[newIndex]?.id || null;
      } else {
        newActiveId = null;
      }
    }

    set({
      openTabs: newTabs,
      activeTabId: newActiveId,
    });

    return { newActiveId, remainingTabs: newTabs };
  },

  switchTab: (tabId) => {
    const { openTabs } = get();
    const tab = openTabs.find(t => t.id === tabId);
    if (tab) {
      set({ activeTabId: tabId });
    }
  },

  updateTab: (tabId, updates) => {
    set((state) => ({
      openTabs: state.openTabs.map(t =>
        t.id === tabId ? { ...t, ...updates } : t
      ),
    }));
  },

  setFileTree: (tabId, tree) => {
    set((state) => ({
      openTabs: state.openTabs.map(t => {
        if (t.id !== tabId) return t;
        // First time we see a tree for this tab → auto-expand the path down
        // to the wad.client folders so users land directly on their assets
        // instead of clicking through `Project > content > base > foo.wad.client`.
        // Subsequent calls (file-watcher refreshes, renames, imports) skip this.
        if (tree && !t.hasAutoExpanded) {
          const autoPaths = collectAutoExpandPaths(tree);
          const newExpanded = new Set(t.expandedFolders);
          for (const p of autoPaths) newExpanded.add(p);
          return { ...t, fileTree: tree, expandedFolders: newExpanded, hasAutoExpanded: true };
        }
        return { ...t, fileTree: tree };
      }),
    }));
  },

  toggleFolder: (tabId, folderPath) => {
    set((state) => ({
      openTabs: state.openTabs.map(t => {
        if (t.id !== tabId) return t;
        const newExpanded = new Set(t.expandedFolders);
        if (newExpanded.has(folderPath)) {
          newExpanded.delete(folderPath);
        } else {
          newExpanded.add(folderPath);
        }
        return { ...t, expandedFolders: newExpanded };
      }),
    }));
  },

  bulkSetFolders: (tabId, paths, expand) => {
    set((state) => ({
      openTabs: state.openTabs.map(t => {
        if (t.id !== tabId) return t;
        const newExpanded = new Set(t.expandedFolders);
        for (const p of paths) {
          if (expand) newExpanded.add(p);
          else newExpanded.delete(p);
        }
        return { ...t, expandedFolders: newExpanded };
      }),
    }));
  },

  setSelectedFile: (tabId, filePath) => {
    set((state) => ({
      openTabs: state.openTabs.map(t =>
        t.id === tabId ? { ...t, selectedFile: filePath } : t
      ),
    }));
  },
}));
