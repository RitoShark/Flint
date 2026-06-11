/**
 * Config Store
 * Manages League paths, creator settings, and user preferences
 * Persists to %APPDATA%/Flint/settings.json via Tauri IPC
 */

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
  binConverterEngine: 'ltk' | 'jade';
  jadePath: string | null;
  quartzPath: string | null;
  selectedTheme: string | null;

  /** Whether the store has finished loading from disk */
  _hydrated: boolean;

  // Actions
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
  setBinConverterEngine: (engine: 'ltk' | 'jade') => void;
  setJadePath: (path: string | null) => void;
  setQuartzPath: (path: string | null) => void;
  setSelectedTheme: (themeId: string | null) => void;

  /** Load settings from disk (called once at startup) */
  hydrate: () => Promise<void>;
}

// localStorage cache key for the settings snapshot. Lets us hydrate the store
// SYNCHRONOUSLY at module-eval time so the UI gets real values on first render
// instead of waiting for the migrate→getSettings IPC chain. Disk is still the
// source of truth (settings.json on %APPDATA%) — this is just a hot cache.
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

// Debounce settings writes. Multiple synchronous mutations (e.g. project
// creation: addSavedProject → setRecentProjects fires within milliseconds)
// previously emitted one full save_settings IPC each. With ~16 fields per
// payload and a 25-70ms IPC tail, that adds up. The debounce coalesces a
// burst into one write while still hitting disk inside the same UI frame.
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
    binConverterEngine: s.binConverterEngine,
    jadePath: s.jadePath,
    quartzPath: s.quartzPath,
    selectedTheme: s.selectedTheme,
  };
}

/** Persist current state to disk (debounced, fire-and-forget) */
function persistToDisk() {
  if (!useConfigStore.getState()._hydrated) return;

  // Update the localStorage cache immediately so a reload picks up the
  // latest values even if the debounce hasn't fired yet. This is cheap.
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

/** Clear all theme overrides (revert to CSS defaults). Re-applies user UX
 *  prefs (accent override, glass blur/opacity) afterwards so theme switching
 *  doesn't accidentally wipe unrelated personalisation. */
export function clearThemeOverrides() {
  const root = document.documentElement;
  // Remove inline style properties — the CSS :root declarations take over
  root.removeAttribute('style');
  // Re-stamp the user's UX prefs (accent / glass / fps) — applyUxPrefs uses
  // setProperty so it only touches the keys it owns.
  // Imported lazily to avoid a circular dep at module-eval time.
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

// Read the cached settings synchronously at module-eval time so the store
// starts with real values, not blank defaults. This is what makes startup
// feel instant: the UI renders with the user's last-known config instead of
// waiting for the migrate→getSettings IPC chain to finish (~500ms+ before).
// On first run with no cache, falls back to the same defaults as before.
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
  // RitoShark (the `ltk` engine — ltk_bridge wraps ritoshark's rs_bin) is the
  // only engine now. The custom Jade writer is broken on some bins ("Missing
  // 'type' section"), so old 'jade' values are pinned back to ritoshark.
  binConverterEngine: 'ltk' as 'ltk' | 'jade',
  jadePath: __cached?.jadePath ?? null,
  quartzPath: __cached?.quartzPath ?? null,
  selectedTheme: __cached?.selectedTheme ?? null,
  // If we had a cache, treat the store as already hydrated for first-paint
  // purposes (matches 1.7.1's localStorage-first behavior). The disk-load
  // below still runs to pick up any settings written by another window/tool,
  // but the user sees real values immediately.
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
  setBinConverterEngine: (engine) => { set({ binConverterEngine: engine }); persistToDisk(); },
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
    // Migrations run AT MOST ONCE per install. The flag in localStorage means
    // we skip the two migration IPCs on every subsequent launch — they were
    // running unconditionally before, costing ~150ms each at every startup
    // even when there was nothing to migrate.
    const migrationsDone = localStorage.getItem(MIGRATIONS_DONE_KEY) === '1';

    if (!migrationsDone) {
      // 1. Check if there's old localStorage data to migrate
      const legacyRaw = localStorage.getItem('flint_settings');
      if (legacyRaw) {
        try {
          await migrateFromLocalStorage(legacyRaw);
          localStorage.removeItem('flint_settings');
        } catch (err) {
          console.warn('[Config] localStorage migration failed:', err);
        }
      }

      // 2. Migrate projects from old RitoShark/Flint/Projects to Flint/projects/
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

    // 3. Load settings from disk. If we already populated the store from the
    // localStorage cache, this just refreshes from disk in the background —
    // the UI is already rendered with real values, so this isn't on the
    // first-paint critical path anymore.
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
        // Pinned to 'ltk' (RitoShark) regardless of disk value — see default.
        binConverterEngine: 'ltk' as 'ltk' | 'jade',
        jadePath: s.jadePath,
        quartzPath: s.quartzPath,
        selectedTheme: s.selectedTheme ?? null,
        _hydrated: true,
      });

      // Refresh the cache so next startup gets latest disk state synchronously.
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
        binConverterEngine: s.binConverterEngine,
        jadePath: s.jadePath,
        quartzPath: s.quartzPath,
        selectedTheme: s.selectedTheme ?? null,
      });

      // 4. Refresh built-in preset themes on disk (idempotent — overwrites
      // shipped presets so users get color tweaks across updates), then
      // apply the saved theme. Seed runs before apply so the apply reads
      // the latest JSON.
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
      set({ _hydrated: true }); // still mark hydrated so the app can function with defaults
    }
  },
}));
