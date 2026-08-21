import { create } from 'zustand';
import type { LogEntry } from '../types';
import { setVerboseCapture, VERBOSE_STORAGE_KEY } from '../util/logger';

const fileVersionsMap = new Map<string, number>();
const fileStatusesMap = new Map<string, 'new' | 'modified'>();

interface AppMetadataState {
  status: 'ready' | 'working' | 'error';
  statusMessage: string;
  hashesLoaded: boolean;
  hashCount: number;
  verboseLogging: boolean;
  logs: LogEntry[];
  logPanelExpanded: boolean;
  fileVersionsRev: number;
  fileTreeVersion: number;
  fileStatusesRev: number;

  setStatus: (status: AppMetadataState['status'], message: string) => void;
  setWorking: (message?: string) => void;
  setReady: (message?: string) => void;
  setError: (message: string) => void;
  setHashInfo: (loaded: boolean, count: number) => void;
  setVerboseLogging: (enabled: boolean) => void;
  addLog: (level: LogEntry['level'], message: string) => void;
  addLogsBatch: (entries: Array<{ level: LogEntry['level']; message: string }>) => void;
  clearLogs: () => void;
  toggleLogPanel: () => void;
  incrementFileVersion: (filePath: string) => void;
  getFileVersion: (filePath: string) => number;
  renameFilePath: (oldPath: string, newPath: string) => void;
  incrementFileTreeVersion: () => void;
  setFileStatus: (filePath: string, status: 'new' | 'modified' | null) => void;
  getFileStatus: (filePath: string) => 'new' | 'modified' | undefined;
  getFileStatusKeys: () => string[];
  clearFileStatuses: () => void;
  applyFileEvent: (input: {
    versionBumps?: string[];
    statusSets?: Array<{ key: string; status: 'new' | 'modified' }>;
    statusDeletes?: string[];
    bumpFileTree?: boolean;
  }) => void;
}

let logIdCounter = 0;

const normPath = (p: string) => p.replaceAll('\\', '/');

// Verbose logging persists across restarts (localStorage, key shared with
// the logger) so a user who enabled it to diagnose an issue doesn't silently
// lose it on relaunch.
function readVerbosePref(): boolean {
  try {
    return localStorage.getItem(VERBOSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export const useAppMetadataStore = create<AppMetadataState>((set) => ({
  status: 'ready',
  statusMessage: 'Ready',
  hashesLoaded: false,
  hashCount: 0,
  verboseLogging: readVerbosePref(),
  logs: [],
  logPanelExpanded: false,
  fileVersionsRev: 0,
  fileTreeVersion: 0,
  fileStatusesRev: 0,

  setStatus: (status, message) => set({ status, statusMessage: message }),
  setWorking: (message = 'Working...') => set({ status: 'working', statusMessage: message }),
  setReady: (message = 'Ready') => set({ status: 'ready', statusMessage: message }),
  setError: (message) => set({ status: 'error', statusMessage: message }),
  setHashInfo: (loaded, count) => set({ hashesLoaded: loaded, hashCount: count }),
  setVerboseLogging: (enabled) => {
    try {
      localStorage.setItem(VERBOSE_STORAGE_KEY, enabled ? '1' : '0');
    } catch { /* non-fatal */ }
    setVerboseCapture(enabled);
    set({ verboseLogging: enabled });
  },
  addLog: (level, message) => set((state) => ({
    logs: [...state.logs, {
      id: ++logIdCounter,
      timestamp: Date.now(),
      level,
      message,
    }],
  })),
  addLogsBatch: (entries) => set((state) => {
    const now = Date.now();
    const newEntries = entries.map(e => ({
      id: ++logIdCounter,
      timestamp: now,
      level: e.level,
      message: e.message,
    }));
    return { logs: [...state.logs, ...newEntries] };
  }),
  clearLogs: () => set({ logs: [] }),
  toggleLogPanel: () => set((state) => ({ logPanelExpanded: !state.logPanelExpanded })),

  incrementFileVersion: (filePath) => {
    const key = normPath(filePath);
    fileVersionsMap.set(key, (fileVersionsMap.get(key) || 0) + 1);
    set((state) => ({ fileVersionsRev: state.fileVersionsRev + 1 }));
  },
  getFileVersion: (filePath) => fileVersionsMap.get(normPath(filePath)) || 0,

  renameFilePath: (oldPath, newPath) => {
    const oldKey = normPath(oldPath);
    const newKey = normPath(newPath);
    let movedVersions = false;
    let movedStatuses = false;

    const move = <T>(map: Map<string, T>): boolean => {
      let moved = false;
      for (const [key, value] of [...map.entries()]) {
        if (key === oldKey) {
          map.delete(key);
          map.set(newKey, value);
          moved = true;
        } else if (key.startsWith(`${oldKey}/`)) {
          map.delete(key);
          map.set(newKey + key.slice(oldKey.length), value);
          moved = true;
        }
      }
      return moved;
    };

    movedVersions = move(fileVersionsMap);
    movedStatuses = move(fileStatusesMap);

    if (!movedVersions && !movedStatuses) return;
    set((state) => {
      const patch: Partial<AppMetadataState> = {};
      if (movedVersions) patch.fileVersionsRev = state.fileVersionsRev + 1;
      if (movedStatuses) patch.fileStatusesRev = state.fileStatusesRev + 1;
      return patch;
    });
  },
  incrementFileTreeVersion: () => set((state) => ({ fileTreeVersion: state.fileTreeVersion + 1 })),

  setFileStatus: (filePath, status) => {
    const key = normPath(filePath);
    if (status === null) {
      if (!fileStatusesMap.has(key)) return;
      fileStatusesMap.delete(key);
    } else {
      if (fileStatusesMap.get(key) === status) return;
      fileStatusesMap.set(key, status);
    }
    set((state) => ({ fileStatusesRev: state.fileStatusesRev + 1 }));
  },
  getFileStatus: (filePath) => fileStatusesMap.get(normPath(filePath)),
  getFileStatusKeys: () => Array.from(fileStatusesMap.keys()),
  clearFileStatuses: () => {
    if (fileStatusesMap.size === 0) return;
    fileStatusesMap.clear();
    set((state) => ({ fileStatusesRev: state.fileStatusesRev + 1 }));
  },

  applyFileEvent: ({ versionBumps, statusSets, statusDeletes, bumpFileTree }) => {
    let changedVersions = false;
    let changedStatuses = false;

    if (versionBumps && versionBumps.length > 0) {
      for (const raw of versionBumps) {
        const key = normPath(raw);
        fileVersionsMap.set(key, (fileVersionsMap.get(key) || 0) + 1);
      }
      changedVersions = true;
    }

    if (statusSets && statusSets.length > 0) {
      for (const { key, status } of statusSets) {
        const k = normPath(key);
        if (fileStatusesMap.get(k) !== status) {
          fileStatusesMap.set(k, status);
          changedStatuses = true;
        }
      }
    }

    if (statusDeletes && statusDeletes.length > 0) {
      for (const raw of statusDeletes) {
        const k = normPath(raw);
        if (fileStatusesMap.delete(k)) changedStatuses = true;
      }
    }

    if (!changedVersions && !changedStatuses && !bumpFileTree) return;

    set((state) => {
      const patch: Partial<AppMetadataState> = {};
      if (changedVersions) patch.fileVersionsRev = state.fileVersionsRev + 1;
      if (changedStatuses) patch.fileStatusesRev = state.fileStatusesRev + 1;
      if (bumpFileTree) patch.fileTreeVersion = state.fileTreeVersion + 1;
      return patch;
    });
  },
}));
