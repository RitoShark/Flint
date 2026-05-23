/**
 * WAD Extract Store
 * Manages individual WAD file browsing sessions
 */

import { create } from 'zustand';
import type { ExtractSession, WadChunk } from '../types';
import { useConfigStore } from './configStore';

interface WadExtractState {
  extractSessions: ExtractSession[];
  activeExtractId: string | null;

  // Actions
  openSession: (id: string, wadPath: string) => void;
  closeSession: (sessionId: string) => { newActiveId: string | null; remainingSessions: ExtractSession[] };
  switchSession: (sessionId: string) => void;
  setChunks: (sessionId: string, chunks: WadChunk[]) => void;
  setPreview: (sessionId: string, hash: string | null) => void;
  toggleFolder: (sessionId: string, folderPath: string) => void;
  toggleChunk: (sessionId: string, hash: string) => void;
  setSearch: (sessionId: string, query: string) => void;
  setLoading: (sessionId: string, loading: boolean) => void;
}

export const useWadExtractStore = create<WadExtractState>((set, get) => ({
  extractSessions: [],
  activeExtractId: null,

  openSession: (id, wadPath) => {
    const wadName = wadPath.split(/[\\/]/).pop() || wadPath;

    // Check if the WAD path is within League's game directory
    const config = useConfigStore.getState();
    const leaguePath = config.leaguePath;
    const leaguePathPbe = config.leaguePathPbe;

    let readOnly = false;
    const normalizedWad = wadPath.toLowerCase().replace(/\\/g, '/');
    if (leaguePath) {
      const normalizedLp = leaguePath.toLowerCase().replace(/\\/g, '/');
      if (normalizedLp && normalizedWad.startsWith(normalizedLp)) {
        readOnly = true;
      }
    }
    if (leaguePathPbe) {
      const normalizedLpPbe = leaguePathPbe.toLowerCase().replace(/\\/g, '/');
      if (normalizedLpPbe && normalizedWad.startsWith(normalizedLpPbe)) {
        readOnly = true;
      }
    }

    if (readOnly && localStorage.getItem('flint.hideGameWadWarning') !== 'true') {
      import('./modalStore').then(({ useModalStore }) => {
        useModalStore.getState().openConfirmDialog({
          title: 'Game WAD Archive',
          message: 'This is a game WAD archive. It is read-only and cannot be modified to prevent corrupting your League of Legends installation.',
          confirmLabel: 'OK',
          hideCancel: true,
          showCheckbox: true,
          checkboxLabel: "Don't show this warning again",
          onConfirm: (dontShowAgain) => {
            if (dontShowAgain) {
              localStorage.setItem('flint.hideGameWadWarning', 'true');
            }
          },
        });
      }).catch(err => console.error('Failed to show game WAD warning:', err));
    }

    const newSession: ExtractSession = {
      id,
      wadPath,
      wadName,
      chunks: [],
      selectedHashes: new Set(),
      previewHash: null,
      expandedFolders: new Set(),
      searchQuery: '',
      loading: true,
      readOnly,
    };
    set({
      extractSessions: [...get().extractSessions, newSession],
      activeExtractId: id,
    });
  },

  closeSession: (sessionId) => {
    const { extractSessions, activeExtractId } = get();
    const newSessions = extractSessions.filter(s => s.id !== sessionId);
    let newActiveId = activeExtractId;

    if (activeExtractId === sessionId) {
      // Switch to last remaining extract session
      if (newSessions.length > 0) {
        newActiveId = newSessions[newSessions.length - 1].id;
      } else {
        newActiveId = null;
      }
    }

    set({
      extractSessions: newSessions,
      activeExtractId: newActiveId,
    });

    return { newActiveId, remainingSessions: newSessions };
  },

  switchSession: (sessionId) => {
    const { extractSessions } = get();
    if (extractSessions.find(s => s.id === sessionId)) {
      set({ activeExtractId: sessionId });
    }
  },

  setChunks: (sessionId, chunks) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s =>
        s.id === sessionId ? { ...s, chunks, loading: false } : s
      ),
    }));
  },

  setPreview: (sessionId, hash) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s =>
        s.id === sessionId ? { ...s, previewHash: hash } : s
      ),
    }));
  },

  toggleFolder: (sessionId, folderPath) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s => {
        if (s.id !== sessionId) return s;
        const newExpanded = new Set(s.expandedFolders);
        if (newExpanded.has(folderPath)) {
          newExpanded.delete(folderPath);
        } else {
          newExpanded.add(folderPath);
        }
        return { ...s, expandedFolders: newExpanded };
      }),
    }));
  },

  toggleChunk: (sessionId, hash) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s => {
        if (s.id !== sessionId) return s;
        const newSelected = new Set(s.selectedHashes);
        if (newSelected.has(hash)) {
          newSelected.delete(hash);
        } else {
          newSelected.add(hash);
        }
        return { ...s, selectedHashes: newSelected };
      }),
    }));
  },

  setSearch: (sessionId, query) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s =>
        s.id === sessionId ? { ...s, searchQuery: query } : s
      ),
    }));
  },

  setLoading: (sessionId, loading) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s =>
        s.id === sessionId ? { ...s, loading } : s
      ),
    }));
  },
}));
