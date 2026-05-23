/**
 * Navigation Store
 * Manages the current view/route in the application
 */

import { create } from 'zustand';
import type { ViewType, FileEditorTarget } from '../types';
import { useFileEditorStore } from './fileEditorStore';

interface NavigationState {
  currentView: ViewType;

  // Actions
  setView: (view: ViewType) => void;
  navigateToWelcome: () => void;
  navigateToPreview: () => void;
  navigateToExtract: () => void;
  navigateToWadExplorer: () => void;
  /** Open the dedicated file editor page with a target. */
  navigateToFileEditor: (target: FileEditorTarget) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  currentView: 'welcome',

  setView: (view) => set({ currentView: view }),
  navigateToWelcome: () => set({ currentView: 'welcome' }),
  navigateToPreview: () => set({ currentView: 'preview' }),
  navigateToExtract: () => set({ currentView: 'extract' }),
  navigateToWadExplorer: () => set({ currentView: 'wad-explorer' }),
  navigateToFileEditor: (target) => {
    useFileEditorStore.getState().openTarget(target);
    set({ currentView: 'file-editor' });
  },
}));
