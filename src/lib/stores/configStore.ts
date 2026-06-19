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

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 50;

function snapshotSettings(): FlintSettings {
  const s = useConfigStore.getState();
  return {
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

/** Persist current state to disk (debounced, fire-and-forget) */
function persistToDisk() {
  if (!useConfigStore.getState()._hydrated) return;

  writeCache(snapshotSettings());

  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    saveSettings(snapshotSettings()).catch((err) => {
      console.error('[Config] Failed to persist settings:', err);
    });
  }, PERSIST_DEBOUNCE_MS);
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
  if (!themeId) {
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
  preferredLauncher: (__cached?.preferredLauncher === 'celestial' ? 'celestial' : __cached?.preferredLauncher === 'ltk' ? 'ltk' : null) as 'ltk' | 'celestial' | null,
  savedProjects: (__cached?.savedProjects as SavedProject[] | undefined) ?? [],
  jadePath: __cached?.jadePath ?? null,
  quartzPath: __cached?.quartzPath ?? null,
  selectedTheme: __cached?.selectedTheme ?? null,
  _hydrated: __cached !== null,

  setLeaguePath: (path) => { set({ leaguePath: path }); persistToDisk(); },
  setLeaguePathPbe: (path) => { set({ leaguePathPbe: path }); persistToDisk(); },
  setDefaultProjectPath: (path) => { set({ defaultProjectPath: path }); persistToDisk(); },
  setCreatorName: (name) => { set({ creatorName: name }); persistToDisk(); },
  setCreatorDescription: (description) => { set({ creatorDescription: description }); persistToDisk(); },
  setCreatorHome: (url) => { set({ creatorHome: url }); persistToDisk(); },
  setCreatorTip: (url) => { set({ creatorTip: url }); persistToDisk(); },
  setAutoUpdateEnabled: (enabled) => { set({ autoUpdateEnabled: enabled }); persistToDisk(); },
  setSkippedUpdateVersion: (version) => { set({ skippedUpdateVersion: version }); persistToDisk(); },
  setRecentProjects: (projects) => { set({ recentProjects: projects }); persistToDisk(); },
  setLtkManagerModPath: (path) => { set({ ltkManagerModPath: path }); persistToDisk(); },
  setAutoSyncToLauncher: (enabled) => { set({ autoSyncToLauncher: enabled }); persistToDisk(); },
  setCelestialModPath: (path) => { set({ celestialModPath: path }); persistToDisk(); },
  setPreferredLauncher: (l) => { set({ preferredLauncher: l }); persistToDisk(); },
  setJadePath: (path) => { set({ jadePath: path }); persistToDisk(); },
  setQuartzPath: (path) => { set({ quartzPath: path }); persistToDisk(); },
  setSavedProjects: (projects) => { set({ savedProjects: projects }); persistToDisk(); },
  addSavedProject: (project) => {
    set((state) => {
      const filtered = state.savedProjects.filter(p => p.path !== project.path);
      return { savedProjects: [project, ...filtered] };
    });
    persistToDisk();
  },
  removeSavedProject: (projectId) => {
    set((state) => ({
      savedProjects: state.savedProjects.filter(p => p.id !== projectId),
    }));
    persistToDisk();
  },
  setSelectedTheme: (themeId) => {
    set({ selectedTheme: themeId });
    persistToDisk();
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
      set({
        leaguePath: s.leaguePath,
        leaguePathPbe: s.leaguePathPbe,
        defaultProjectPath: s.defaultProjectPath,
        creatorName: s.creatorName,
        creatorDescription: s.creatorDescription,
        creatorHome: s.creatorHome,
        creatorTip: s.creatorTip,
        autoUpdateEnabled: s.autoUpdateEnabled,
        skippedUpdateVersion: s.skippedUpdateVersion,
        recentProjects: (s.recentProjects ?? []) as RecentProject[],
        savedProjects: (s.savedProjects ?? []) as SavedProject[],
        ltkManagerModPath: s.ltkManagerModPath,
        autoSyncToLauncher: s.autoSyncToLauncher,
        celestialModPath: s.celestialModPath ?? null,
        preferredLauncher: (s.preferredLauncher === 'celestial' ? 'celestial' : s.preferredLauncher === 'ltk' ? 'ltk' : null) as 'ltk' | 'celestial' | null,
        jadePath: s.jadePath,
        quartzPath: s.quartzPath,
        selectedTheme: s.selectedTheme ?? null,
        _hydrated: true,
      });

      writeCache({
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
        recentProjects: s.recentProjects ?? [],
        savedProjects: s.savedProjects ?? [],
        ltkManagerModPath: s.ltkManagerModPath,
        autoSyncToLauncher: s.autoSyncToLauncher,
        celestialModPath: s.celestialModPath ?? null,
        preferredLauncher: (s.preferredLauncher === 'celestial' ? 'celestial' : s.preferredLauncher === 'ltk' ? 'ltk' : null) as 'ltk' | 'celestial' | null,
        jadePath: s.jadePath,
        quartzPath: s.quartzPath,
        selectedTheme: s.selectedTheme ?? null,
      });

      try {
        await seedBuiltinThemes();
      } catch (err) {
        console.warn('[Config] Failed to seed built-in themes:', err);
      }
      if (s.selectedTheme) {
        applyThemeById(s.selectedTheme);
      }
    } catch (err) {
      console.error('[Config] Failed to load settings from disk:', err);
      set({ _hydrated: true });
    }
  },
}));
