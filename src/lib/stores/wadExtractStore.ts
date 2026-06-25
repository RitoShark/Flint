import { create } from 'zustand';
import type { ExtractSession, WadChunk } from '../types';
import { useConfigStore } from './configStore';
import * as api from '../api';

interface WadExtractState {
  extractSessions: ExtractSession[];
  activeExtractId: string | null;

  openSession: (id: string, wadPath: string) => void;
  closeSession: (sessionId: string) => { newActiveId: string | null; remainingSessions: ExtractSession[] };
  switchSession: (sessionId: string) => void;
  setChunks: (sessionId: string, chunks: WadChunk[]) => void;
  setPreview: (sessionId: string, hash: string | null) => void;
  toggleFolder: (sessionId: string, folderPath: string) => void;
  toggleChunk: (sessionId: string, hash: string) => void;
  setSearch: (sessionId: string, query: string) => void;
  setLoading: (sessionId: string, loading: boolean) => void;
  setCurrentDir: (sessionId: string, dir: string) => void;
  navigateHistory: (sessionId: string, direction: 'back' | 'forward' | 'up') => void;
  stageChunkEdit: (sessionId: string, hash: string, newSize: number) => void;
  stageChunkDelete: (sessionId: string, hash: string) => void;
  stageChunkRename: (sessionId: string, oldHash: string, newHash: string, newPath: string) => void;
  setSessionDirty: (sessionId: string, isDirty: boolean) => void;
}

export const useWadExtractStore = create<WadExtractState>((set, get) => ({
  extractSessions: [],
  activeExtractId: null,

  openSession: (id, wadPath) => {
    const wadName = wadPath.split(/[\\/]/).pop() || wadPath;

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
      currentDir: '',
      history: [''],
      historyIndex: 0,
      isDirty: false,
    };
    set({
      extractSessions: [...get().extractSessions, newSession],
      activeExtractId: id,
    });

    if (!readOnly) {
      api.openWadEditSession(wadPath).then((res) => {
        set((state) => ({
          extractSessions: state.extractSessions.map((s) =>
            s.id === id ? { ...s, editSessionId: res.session_id } : s
          ),
        }));
        console.log(`[WAD Edit] Opened edit session ${res.session_id} for WAD:`, wadPath);
      }).catch((err) => {
        console.error('[WAD Edit] Failed to open edit session:', err);
      });
    }
  },

  closeSession: (sessionId) => {
    const { extractSessions, activeExtractId } = get();
    const sessionToClose = extractSessions.find(s => s.id === sessionId);
    const newSessions = extractSessions.filter(s => s.id !== sessionId);
    let newActiveId = activeExtractId;

    if (activeExtractId === sessionId) {
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

    if (sessionToClose?.editSessionId) {
      api.closeWadEditSession(sessionToClose.editSessionId).then(() => {
        console.log(`[WAD Edit] Closed edit session ${sessionToClose.editSessionId}`);
      }).catch((err) => {
        console.error('[WAD Edit] Failed to close edit session:', err);
      });
    }

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

  setCurrentDir: (sessionId, dir) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s => {
        if (s.id !== sessionId) return s;
        const newHistory = s.history.slice(0, s.historyIndex + 1);
        if (newHistory[newHistory.length - 1] !== dir) {
          newHistory.push(dir);
        }
        return {
          ...s,
          currentDir: dir,
          history: newHistory,
          historyIndex: newHistory.length - 1,
        };
      }),
    }));
  },

  navigateHistory: (sessionId, direction) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s => {
        if (s.id !== sessionId) return s;
        let newIndex = s.historyIndex;
        if (direction === 'back' && s.historyIndex > 0) {
          newIndex = s.historyIndex - 1;
        } else if (direction === 'forward' && s.historyIndex < s.history.length - 1) {
          newIndex = s.historyIndex + 1;
        } else if (direction === 'up' && s.currentDir) {
          const idx = s.currentDir.lastIndexOf('/');
          const parentDir = idx === -1 ? '' : s.currentDir.slice(0, idx);
          const newHistory = s.history.slice(0, s.historyIndex + 1);
          if (newHistory[newHistory.length - 1] !== parentDir) {
            newHistory.push(parentDir);
          }
          return {
            ...s,
            currentDir: parentDir,
            history: newHistory,
            historyIndex: newHistory.length - 1,
          };
        }
        return {
          ...s,
          currentDir: s.history[newIndex],
          historyIndex: newIndex,
        };
      }),
    }));
  },

  stageChunkEdit: (sessionId, hash, newSize) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s => {
        if (s.id !== sessionId) return s;
        const newChunks = s.chunks.map(c =>
          c.hash === hash ? { ...c, size: newSize } : c
        );
        return {
          ...s,
          chunks: newChunks,
          isDirty: true,
        };
      }),
    }));
  },

  stageChunkDelete: (sessionId, hash) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s => {
        if (s.id !== sessionId) return s;
        const newSelected = new Set(s.selectedHashes);
        newSelected.delete(hash);
        return {
          ...s,
          chunks: s.chunks.filter(c => c.hash !== hash),
          selectedHashes: newSelected,
          previewHash: s.previewHash === hash ? null : s.previewHash,
          isDirty: true,
        };
      }),
    }));
  },

  stageChunkRename: (sessionId, oldHash, newHash, newPath) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s => {
        if (s.id !== sessionId) return s;
        const newSelected = new Set(s.selectedHashes);
        if (newSelected.delete(oldHash)) newSelected.add(newHash);
        return {
          ...s,
          chunks: s.chunks.map(c =>
            c.hash === oldHash ? { ...c, hash: newHash, path: newPath } : c
          ),
          selectedHashes: newSelected,
          previewHash: s.previewHash === oldHash ? newHash : s.previewHash,
          isDirty: true,
        };
      }),
    }));
  },

  setSessionDirty: (sessionId, isDirty) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s =>
        s.id === sessionId ? { ...s, isDirty } : s
      ),
    }));
  },
}));
