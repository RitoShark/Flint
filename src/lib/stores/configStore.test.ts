import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FlintSettings } from '../api';

// configStore touches localStorage at module scope, so the stub has to be in
// place before the import is evaluated — hence vi.hoisted rather than a stub in
// beforeEach. Pre-marking migrations done keeps hydrate() off the migrate path.
const mem = vi.hoisted(() => {
    const map = new Map<string, string>();
    map.set('flint_migrations_done_v1', '1');
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => { map.set(k, v); },
        removeItem: (k: string) => { map.delete(k); },
        clear: () => map.clear(),
    };
    return map;
});

const getSettings = vi.hoisted(() => vi.fn());
const saveSettings = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../api', () => ({
    getSettings,
    saveSettings,
    migrateFromLocalStorage: vi.fn(),
    migrateProjects: vi.fn().mockResolvedValue({ moved: 0, skipped: 0 }),
    loadTheme: vi.fn(),
    seedBuiltinThemes: vi.fn().mockResolvedValue(undefined),
}));

import { hydrationPatch, useConfigStore } from './configStore';

/** The payload of the most recent saveSettings call. */
const lastSaved = (): FlintSettings =>
    saveSettings.mock.calls[saveSettings.mock.calls.length - 1][0] as FlintSettings;

const DISK: FlintSettings = {
    schemaVersion: 1,
    leaguePath: 'C:/Riot Games/League of Legends',
    leaguePathPbe: null,
    defaultProjectPath: 'C:\\Users\\me\\AppData\\Roaming\\Flint\\projects',
    creatorName: 'DAKA',
    creatorDescription: null,
    creatorHome: null,
    creatorTip: null,
    autoUpdateEnabled: true,
    skippedUpdateVersion: null,
    recentProjects: [],
    savedProjects: [],
    ltkManagerModPath: null,
    autoSyncToLauncher: false,
    celestialModPath: null,
    preferredLauncher: null,
    jadePath: null,
    quartzPath: null,
    selectedTheme: null,
    binConverterEngine: 'ltk',
};

describe('hydrationPatch', () => {
    it('applies every disk value when nothing is dirty', () => {
        expect(hydrationPatch({ a: 1, b: 2 }, new Set())).toEqual({ a: 1, b: 2 });
    });

    it('withholds keys the user already changed', () => {
        expect(hydrationPatch({ a: 1, b: 2 }, new Set(['a']))).toEqual({ b: 2 });
    });
});

describe('configStore persistence', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        saveSettings.mockClear();
        getSettings.mockReset();
    });
    afterEach(() => {
        vi.useRealTimers();
        mem.delete('flint_settings_cache_v1');
    });

    it('keeps a setting changed while hydrate() is still reading disk', async () => {
        let release!: (s: FlintSettings) => void;
        getSettings.mockReturnValue(new Promise<FlintSettings>((r) => { release = r; }));

        const hydrating = useConfigStore.getState().hydrate();

        // The user picks a project folder before the disk read comes back.
        useConfigStore.getState().setDefaultProjectPath('D:/MyProjects');

        release(DISK);
        await hydrating;

        // The in-flight disk read must not revert the edit...
        expect(useConfigStore.getState().defaultProjectPath).toBe('D:/MyProjects');
        // ...while untouched fields still take their on-disk values.
        expect(useConfigStore.getState().creatorName).toBe('DAKA');

        // And the edit must actually reach disk rather than being dropped as
        // "not hydrated yet".
        await vi.advanceTimersByTimeAsync(100);
        expect(saveSettings).toHaveBeenCalled();
        const saved = lastSaved();
        expect(saved.defaultProjectPath).toBe('D:/MyProjects');
    });

    it('round-trips fields the store does not model', async () => {
        getSettings.mockResolvedValue(DISK);
        await useConfigStore.getState().hydrate();

        useConfigStore.getState().setCreatorName('someone');
        await vi.advanceTimersByTimeAsync(100);

        const saved = lastSaved();
        // Omitting this used to reset it to the Rust-side serde default on
        // every write; null would fail to deserialize, so it must be a string.
        expect(saved.binConverterEngine).toBe('ltk');
    });

    it('persists the snapshot taken when the write was scheduled', async () => {
        getSettings.mockResolvedValue(DISK);
        await useConfigStore.getState().hydrate();
        saveSettings.mockClear();

        useConfigStore.getState().setDefaultProjectPath('D:/First');
        // A late arrival inside the debounce window must not decide what is
        // written for its own scheduled flush.
        await vi.advanceTimersByTimeAsync(100);

        const saved = lastSaved();
        expect(saved.defaultProjectPath).toBe('D:/First');
    });
});
