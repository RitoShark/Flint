import { invokeCommand } from './core';
import type { RecentProject, SavedProject } from '../types';

export interface FlintSettings {
    schemaVersion: number;
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
    savedProjects: SavedProject[];
    ltkManagerModPath: string | null;
    autoSyncToLauncher: boolean;
    celestialModPath: string | null;
    preferredLauncher: 'ltk' | 'celestial' | null;
    binConverterEngine: string;
    jadePath: string | null;
    quartzPath: string | null;
    selectedTheme: string | null;
}

export async function getAppHome(): Promise<string> {
    return invokeCommand('get_app_home');
}

export async function getSettings(): Promise<FlintSettings> {
    return invokeCommand('get_settings');
}

export async function saveSettings(settings: FlintSettings): Promise<void> {
    return invokeCommand('save_settings', { settings });
}

export async function migrateFromLocalStorage(legacyJson: string): Promise<void> {
    return invokeCommand('migrate_from_localstorage', { legacyJson });
}

export interface MigrateProjectsResult {
    moved: number;
    skipped: number;
}

export async function migrateProjects(): Promise<MigrateProjectsResult> {
    return invokeCommand('migrate_projects');
}

// =============================================================================
// Themes
// =============================================================================

export interface ThemeInfo {
    id: string;
    name: string;
}

export async function listThemes(): Promise<ThemeInfo[]> {
    return invokeCommand('list_themes');
}

export async function loadTheme(themeId: string): Promise<Record<string, unknown>> {
    return invokeCommand('load_theme', { themeId });
}

export async function createDefaultTheme(): Promise<string> {
    return invokeCommand('create_default_theme');
}

/** Write the built-in preset themes to disk if missing (idempotent). */
export async function seedBuiltinThemes(): Promise<void> {
    return invokeCommand('seed_builtin_themes');
}
