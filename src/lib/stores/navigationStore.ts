import { create } from 'zustand';
import type { ViewType, FileEditorTarget } from '../types';
import { useFileEditorStore } from './fileEditorStore';

interface NavigationState {
  currentView: ViewType;
  /** The CDN manifest session shown when currentView === 'manifest'. */
  activeManifestId: string | null;

  setView: (view: ViewType) => void;
  setActiveManifest: (sessionId: string | null) => void;
  navigateToWelcome: () => void;
  navigateToPreview: () => void;
  navigateToExtract: () => void;
  navigateToWadExplorer: () => void;
  navigateToFileEditor: (target: FileEditorTarget) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  currentView: 'welcome',
  activeManifestId: null,

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
}));
