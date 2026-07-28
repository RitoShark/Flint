import { create } from 'zustand';
import { getSettings, saveSettings, migrateFromLocalStorage, migrateProjects, loadTheme, seedBuiltinThemes } from '../api';
import type { FlintSettings } from '../api';
import type { RecentProject, SavedProject } from '../types';

interface ConfigState {
  leaguePath: string | null;
  leaguePathPbe: string | null;
  defaultProjectPath: string | null;
  creatorName: string | null;
  creatorDescription: string | null;
  creatorHome: string | null;
  creatorTip: string | null;
  autoUpdateEnabled: boolean;
  skippedUpdateVersion: string | null;
  recentProjects: RecentProject[];
  ltkManagerModPath: string | null;
  autoSyncToLauncher: boolean;
  celestialModPath: string | null;
  preferredLauncher: 'ltk' | 'celestial' | null;
  savedProjects: SavedProject[];
  jadePath: string | null;
  quartzPath: string | null;
  selectedTheme: string | null;

  /** Whether the store has finished loading from disk */
  _hydrated: boolean;

  setLeaguePath: (path: string | null) => void;
  setLeaguePathPbe: (path: string | null) => void;
  setDefaultProjectPath: (path: string | null) => void;
  setCreatorName: (name: string | null) => void;
  setCreatorDescription: (description: string | null) => void;
  setCreatorHome: (url: string | null) => void;
  setCreatorTip: (url: string | null) => void;
  setAutoUpdateEnabled: (enabled: boolean) => void;
  setSkippedUpdateVersion: (version: string | null) => void;
  setRecentProjects: (projects: RecentProject[]) => void;
  setLtkManagerModPath: (path: string | null) => void;
  setAutoSyncToLauncher: (enabled: boolean) => void;
  setCelestialModPath: (path: string | null) => void;
  setPreferredLauncher: (l: 'ltk' | 'celestial' | null) => void;
  setSavedProjects: (projects: SavedProject[]) => void;
  addSavedProject: (project: SavedProject) => void;
  removeSavedProject: (projectId: string) => void;
  setJadePath: (path: string | null) => void;
  setQuartzPath: (path: string | null) => void;
  setSelectedTheme: (themeId: string | null) => void;

  /** Load settings from disk (called once at startup) */
  hydrate: () => Promise<void>;
}

const SETTINGS_CACHE_KEY = 'flint_settings_cache_v1';
const MIGRATIONS_DONE_KEY = 'flint_migrations_done_v1';

function readCache(): Partial<FlintSettings> | null {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<FlintSettings>;
  } catch {
    return null;
  }
}

function writeCache(settings: FlintSettings) {
  try {
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage full or disabled — disk write below is still authoritative
  }
}

function normalizeLauncher(value: unknown): 'ltk' | 'celestial' | null {
  return value === 'celestial' ? 'celestial' : value === 'ltk' ? 'ltk' : null;
}

/**
 * Repair recent-project paths written by older builds.
 *
 * Those joined a forward-slashed projects root to a `\`-separated folder name,
 * saving mixed paths like `C:/Users/…/projects\my-mod`. The backend rejects
 * that spelling ("Project file not found"), and it never string-matched the
 * all-backslash paths from `discover_projects`, so deletes left the entry
 * behind. Settling on one separator makes old entries open again and lets
 * de-duplication work; also drops entries that collapse to the same project.
 */
function normalizeRecentPaths(recents: RecentProject[]): RecentProject[] {
  const seen = new Set<string>();
  const out: RecentProject[] = [];
  for (const entry of recents) {
    if (typeof entry?.path !== 'string') continue;
    const path = entry.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path === entry.path ? entry : { ...entry, path });
  }
  return out;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 50;

/** Settings keys this store owns and can mark dirty. */
type PersistedKey = Exclude<keyof FlintSettings, 'schemaVersion' | 'binConverterEngine'>;

/**
 * Keys the user has explicitly changed since boot.
 *
 * `hydrate()` reads disk asynchronously and then writes the result into the
 * store. Without this set, a setting changed while that read is in flight gets
 * silently reverted to the stale on-disk value.
 */
const dirtyKeys = new Set<PersistedKey>();

/** Snapshot captured when a write was requested, flushed when the timer fires. */
let pendingSnapshot: FlintSettings | null = null;

/** True when an edit arrived before `hydrate()` finished reading disk. */
let deferredUntilHydrated = false;

/**
 * Fields Flint persists but doesn't model in the store. Captured on hydrate so a
 * save round-trips them instead of resetting them to their serde defaults.
 */
let passthroughFields: Pick<FlintSettings, 'binConverterEngine'> = {};

/**
 * Disk values to apply during hydrate, minus any key the user already changed.
 *
 * Pure and exported so the precedence rule is testable without a live store.
 */
export function hydrationPatch<T extends object>(
  disk: T,
  dirty: ReadonlySet<string>,
): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(disk) as (keyof T & string)[]) {
    if (!dirty.has(key)) patch[key] = disk[key];
  }
  return patch;
}

function snapshotSettings(): FlintSettings {
  const s = useConfigStore.getState();
  return {
    ...passthroughFields,
    schemaVersion: 1,
    leaguePath: s.leaguePath,
    leaguePathPbe: s.leaguePathPbe,
    defaultProjectPath: s.defaultProjectPath,
    creatorName: s.creatorName,
    creatorDescription: s.creatorDescription,
    creatorHome: s.creatorHome,
    creatorTip: s.creatorTip,
    autoUpdateEnabled: s.autoUpdateEnabled,
    skippedUpdateVersion: s.skippedUpdateVersion,
    recentProjects: s.recentProjects,
    savedProjects: s.savedProjects,
    ltkManagerModPath: s.ltkManagerModPath,
    autoSyncToLauncher: s.autoSyncToLauncher,
    celestialModPath: s.celestialModPath,
    preferredLauncher: s.preferredLauncher,
    jadePath: s.jadePath,
    quartzPath: s.quartzPath,
    selectedTheme: s.selectedTheme,
  };
}

function flushPendingWrite() {
  persistTimer = null;
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  if (!snapshot) return;
  saveSettings(snapshot).catch((err) => {
    console.error('[Config] Failed to persist settings:', err);
  });
}

/** Persist current state to disk (debounced, fire-and-forget) */
function persistToDisk(key?: PersistedKey) {
  if (key) dirtyKeys.add(key);

  // Snapshot now, not when the timer fires — otherwise any store write landing
  // inside the debounce window (notably hydrate's) is what actually gets saved.
  const snapshot = snapshotSettings();
  writeCache(snapshot);
  pendingSnapshot = snapshot;

  // Before hydrate() has merged disk in, the store still holds cached/default
  // values for every field the user hasn't touched; flushing that whole snapshot
  // would clobber disk. Hold the write until hydrate() lands rather than drop it.
  if (!useConfigStore.getState()._hydrated) {
    deferredUntilHydrated = true;
    return;
  }

  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushPendingWrite, PERSIST_DEBOUNCE_MS);
}

/** Apply a theme's CSS variables to :root */
export function applyThemeColors(colors: Record<string, string>) {
  const root = document.documentElement;
  for (const [variable, value] of Object.entries(colors)) {
    root.style.setProperty(variable, value);
  }
}

/** Clear all theme overrides (revert to CSS defaults), then re-apply user UX prefs. */
export function clearThemeOverrides() {
  const root = document.documentElement;
  root.removeAttribute('style');
  import('./uxStore').then(({ applyUxPrefs, useUxStore }) => {
    applyUxPrefs(useUxStore.getState());
  }).catch(() => { /* non-fatal */ });
}

/** Load and apply a theme by ID. Returns true if applied. */
export async function applyThemeById(themeId: string | null): Promise<boolean> {
  // 'custom' keeps the default dark base and swaps only the accent, which the
  // ux store applies separately (accentPrimary). Treat it like the default so
  // we don't try to load a non-existent theme file (and its clearThemeOverrides
  // won't wipe the accent — the ux store re-applies it on load).
  if (!themeId || themeId === 'custom') {
    clearThemeOverrides();
    return true;
  }
  try {
    const theme = await loadTheme(themeId);
    const colors = (theme as { colors?: Record<string, string> }).colors;
    if (colors && typeof colors === 'object') {
      clearThemeOverrides();
      applyThemeColors(colors);
      return true;
    }
  } catch (err) {
    console.warn(`[Theme] Failed to load theme '${themeId}':`, err);
  }
  return false;
}

const __cached = readCache();
if (__cached?.binConverterEngine) {
  passthroughFields = { binConverterEngine: __cached.binConverterEngine };
}

export const useConfigStore = create<ConfigState>()((set) => ({
  leaguePath: __cached?.leaguePath ?? null,
  leaguePathPbe: __cached?.leaguePathPbe ?? null,
  defaultProjectPath: __cached?.defaultProjectPath ?? null,
  creatorName: __cached?.creatorName ?? null,
  creatorDescription: __cached?.creatorDescription ?? null,
  creatorHome: __cached?.creatorHome ?? null,
  creatorTip: __cached?.creatorTip ?? null,
  autoUpdateEnabled: __cached?.autoUpdateEnabled ?? true,
  skippedUpdateVersion: __cached?.skippedUpdateVersion ?? null,
  recentProjects: (__cached?.recentProjects as RecentProject[] | undefined) ?? [],
  ltkManagerModPath: __cached?.ltkManagerModPath ?? null,
  autoSyncToLauncher: __cached?.autoSyncToLauncher ?? false,
  celestialModPath: __cached?.celestialModPath ?? null,
  preferredLauncher: normalizeLauncher(__cached?.preferredLauncher),
  savedProjects: (__cached?.savedProjects as SavedProject[] | undefined) ?? [],
  jadePath: __cached?.jadePath ?? null,
  quartzPath: __cached?.quartzPath ?? null,
  selectedTheme: __cached?.selectedTheme ?? null,
  _hydrated: __cached !== null,

  setLeaguePath: (path) => { set({ leaguePath: path }); persistToDisk('leaguePath'); },
  setLeaguePathPbe: (path) => { set({ leaguePathPbe: path }); persistToDisk('leaguePathPbe'); },
  setDefaultProjectPath: (path) => { set({ defaultProjectPath: path }); persistToDisk('defaultProjectPath'); },
  setCreatorName: (name) => { set({ creatorName: name }); persistToDisk('creatorName'); },
  setCreatorDescription: (description) => { set({ creatorDescription: description }); persistToDisk('creatorDescription'); },
  setCreatorHome: (url) => { set({ creatorHome: url }); persistToDisk('creatorHome'); },
  setCreatorTip: (url) => { set({ creatorTip: url }); persistToDisk('creatorTip'); },
  setAutoUpdateEnabled: (enabled) => { set({ autoUpdateEnabled: enabled }); persistToDisk('autoUpdateEnabled'); },
  setSkippedUpdateVersion: (version) => { set({ skippedUpdateVersion: version }); persistToDisk('skippedUpdateVersion'); },
  setRecentProjects: (projects) => { set({ recentProjects: projects }); persistToDisk('recentProjects'); },
  setLtkManagerModPath: (path) => { set({ ltkManagerModPath: path }); persistToDisk('ltkManagerModPath'); },
  setAutoSyncToLauncher: (enabled) => { set({ autoSyncToLauncher: enabled }); persistToDisk('autoSyncToLauncher'); },
  setCelestialModPath: (path) => { set({ celestialModPath: path }); persistToDisk('celestialModPath'); },
  setPreferredLauncher: (l) => { set({ preferredLauncher: l }); persistToDisk('preferredLauncher'); },
  setJadePath: (path) => { set({ jadePath: path }); persistToDisk('jadePath'); },
  setQuartzPath: (path) => { set({ quartzPath: path }); persistToDisk('quartzPath'); },
  setSavedProjects: (projects) => { set({ savedProjects: projects }); persistToDisk('savedProjects'); },
  addSavedProject: (project) => {
    set((state) => {
      const filtered = state.savedProjects.filter(p => p.path !== project.path);
      return { savedProjects: [project, ...filtered] };
    });
    persistToDisk('savedProjects');
  },
  removeSavedProject: (projectId) => {
    set((state) => ({
      savedProjects: state.savedProjects.filter(p => p.id !== projectId),
    }));
    persistToDisk('savedProjects');
  },
  setSelectedTheme: (themeId) => {
    set({ selectedTheme: themeId });
    persistToDisk('selectedTheme');
    applyThemeById(themeId);
  },

  hydrate: async () => {
    const migrationsDone = localStorage.getItem(MIGRATIONS_DONE_KEY) === '1';

    if (!migrationsDone) {
      const legacyRaw = localStorage.getItem('flint_settings');
      if (legacyRaw) {
        try {
          await migrateFromLocalStorage(legacyRaw);
          localStorage.removeItem('flint_settings');
        } catch (err) {
          console.warn('[Config] localStorage migration failed:', err);
        }
      }

      try {
        const result = await migrateProjects();
        if (result.moved > 0) {
          console.log(`[Config] Migrated ${result.moved} projects to Flint home`);
        }
      } catch (err) {
        console.warn('[Config] Project migration failed:', err);
      }

      try { localStorage.setItem(MIGRATIONS_DONE_KEY, '1'); } catch { /* ignore */ }
    }

    try {
      const s = await getSettings();

      passthroughFields = s.binConverterEngine
        ? { binConverterEngine: s.binConverterEngine }
        : {};

      const diskState = {
        leaguePath: s.leaguePath,
        leaguePathPbe: s.leaguePathPbe,
        defaultProjectPath: s.defaultProjectPath,
        creatorName: s.creatorName,
        creatorDescription: s.creatorDescription,
        creatorHome: s.creatorHome,
        creatorTip: s.creatorTip,
        autoUpdateEnabled: s.autoUpdateEnabled,
        skippedUpdateVersion: s.skippedUpdateVersion,
        recentProjects: normalizeRecentPaths((s.recentProjects ?? []) as RecentProject[]),
        savedProjects: (s.savedProjects ?? []) as SavedProject[],
        ltkManagerModPath: s.ltkManagerModPath,
        autoSyncToLauncher: s.autoSyncToLauncher,
        celestialModPath: s.celestialModPath ?? null,
        preferredLauncher: normalizeLauncher(s.preferredLauncher),
        jadePath: s.jadePath,
        quartzPath: s.quartzPath,
        selectedTheme: s.selectedTheme ?? null,
      };

      // Anything the user changed while this read was in flight outranks disk.
      set({ ...hydrationPatch(diskState, dirtyKeys), _hydrated: true });
      writeCache(snapshotSettings());

      // Edits made before hydrate landed were held back rather than dropped —
      // flush them now that the store reflects disk for every untouched field.
      if (deferredUntilHydrated) {
        deferredUntilHydrated = false;
        persistToDisk();
      }

      try {
        await seedBuiltinThemes();
      } catch (err) {
        console.warn('[Config] Failed to seed built-in themes:', err);
      }
      const theme = useConfigStore.getState().selectedTheme;
      if (theme) {
        applyThemeById(theme);
      }
    } catch (err) {
      console.error('[Config] Failed to load settings from disk:', err);
      set({ _hydrated: true });
    }
  },
}));
