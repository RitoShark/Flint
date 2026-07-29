import { create } from 'zustand';
import type { ExtractSession, WadChunk } from '../types';
import type { Vfs } from '../vfs/types';
import { mountWad, mountWadSession, type WadMount } from '../vfs/wadMount';
import { useConfigStore } from './configStore';
import * as api from '../api';

interface WadExtractState {
  extractSessions: ExtractSession[];
  activeExtractId: string | null;

  /**
   * `mountBacked` marks a non-WAD archive: skip opening a WAD edit session for it.
   * `embedded` marks a session owned by another surface (the archive editor):
   * it is not a user-facing tab and must not steal the global active id.
   */
  openSession: (id: string, wadPath: string, editSessionId?: string, opts?: { mountBacked?: boolean; embedded?: boolean }) => void;
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
  /** Attach the VFS mount a non-WAD archive (e.g. a modpkg) reads and writes through. */
  setSessionMount: (sessionId: string, mount: Vfs) => void;
}

/**
 * Point a mount at a new chunk set. WAD mounts index their chunks up front and
 * expose `reindex`; a modpkg mount reloads from its own session instead, so it
 * has none and is left alone.
 */
function reindexMount(mount: Vfs, chunks: readonly { hash: string; path: string | null; size?: number }[]): void {
  const reindex = (mount as Partial<WadMount>).reindex;
  if (typeof reindex === 'function') reindex.call(mount, chunks);
}

export const useWadExtractStore = create<WadExtractState>((set, get) => ({
  extractSessions: [],
  activeExtractId: null,

  openSession: (id, wadPath, editSessionId, opts) => {
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
      // When a backend edit session was opened by the caller (e.g. the archive
      // editor's inner WAD), seed it directly so chunk ops route to it and we
      // don't open a second redundant session below.
      editSessionId,
      embedded: opts?.embedded,
    };
    set({
      extractSessions: [...get().extractSessions, newSession],
      // An embedded session belongs to the surface that opened it; taking the
      // global active id would blank that surface's sibling panels and add a
      // phantom tab.
      activeExtractId: opts?.embedded ? get().activeExtractId : id,
    });

    // `mountBacked` sessions are not WADs (a modpkg), so there is no WAD edit
    // session to open — attempting one just fails and logs noise.
    if (!readOnly && !editSessionId && !opts?.mountBacked) {
      api.openWadEditSession(wadPath).then((res) => {
        set((state) => ({
          extractSessions: state.extractSessions.map((s) => {
            if (s.id !== id) return s;
            // The edit session arrives after the chunks usually have, so any
            // mount built in the meantime is the read-only on-disk one. Rebuild
            // it against the session now that writes are possible — otherwise
            // the browser would report the WAD as uneditable.
            return {
              ...s,
              editSessionId: res.session_id,
              mount: mountWadSession(res.session_id, s.wadName, s.chunks),
            };
          }),
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
      // Only a user-facing session can become the active tab; an embedded one
      // lives inside another surface and has no tab to fall back to.
      const userFacing = newSessions.filter(s => !s.embedded);
      newActiveId = userFacing.length > 0 ? userFacing[userFacing.length - 1].id : null;
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
      extractSessions: state.extractSessions.map(s => {
        if (s.id !== sessionId) return s;
        // Every WAD session reads and writes through a mount, so the browser and
        // preview panels go through one interface for WADs, packages and CDN
        // archives alike. A session that already carries a mount (a modpkg) keeps
        // it — its chunks are keyed by path, not hash.
        const mount = s.mount ?? (s.editSessionId
          ? mountWadSession(s.editSessionId, s.wadName, chunks)
          : mountWad(s.wadPath, chunks));
        // A mount indexes the chunk list at construction, so re-index in place
        // rather than rebuilding it on every staged edit.
        reindexMount(mount, chunks);
        return { ...s, chunks, loading: false, mount };
      }),
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

  setSessionMount: (sessionId, mount) => {
    set((state) => ({
      extractSessions: state.extractSessions.map(s =>
        s.id === sessionId ? { ...s, mount } : s
      ),
    }));
  },
}));
