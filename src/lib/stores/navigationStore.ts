import { create } from 'zustand';
import type { ViewType, FileEditorTarget } from '../types';
import { useFileEditorStore } from './fileEditorStore';

interface NavigationState {
  currentView: ViewType;
  /** The CDN manifest session shown when currentView === 'manifest'. */
  activeManifestId: string | null;
  /** Absolute path of the archive opened when currentView === 'archive-editor'. */
  archiveTargetPath: string | null;

  setView: (view: ViewType) => void;
  setActiveManifest: (sessionId: string | null) => void;
  navigateToWelcome: () => void;
  navigateToPreview: () => void;
  navigateToExtract: () => void;
  navigateToWadExplorer: () => void;
  navigateToFileEditor: (target: FileEditorTarget) => void;
  navigateToArchiveEditor: (path: string) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  currentView: 'welcome',
  activeManifestId: null,
  archiveTargetPath: null,

  setView: (view) => set({ currentView: view }),
  setActiveManifest: (sessionId) => set({ activeManifestId: sessionId }),
  navigateToWelcome: () => set({ currentView: 'welcome' }),
  navigateToPreview: () => set({ currentView: 'preview' }),
  navigateToExtract: () => set({ currentView: 'extract' }),
  navigateToWadExplorer: () => set({ currentView: 'wad-explorer' }),
  navigateToFileEditor: (target) => {
    useFileEditorStore.getState().openTarget(target);
    set({ currentView: 'file-editor' });
  },
  navigateToArchiveEditor: (path) => set({ currentView: 'archive-editor', archiveTargetPath: path }),
}));
