import { invokeCommand } from './core';

/**
 * Get the LTK Manager mod storage path.
 * Returns null if LTK Manager is not installed or settings cannot be found.
 */
export async function getLtkManagerModPath(): Promise<string | null> {
    return invokeCommand('get_ltk_manager_mod_path', {});
}

/**
 * Get the Celestial launcher's mod storage path. Returns null if Celestial
 * isn't installed.
 */
export async function getCelestialModPath(): Promise<string | null> {
    return invokeCommand('get_celestial_mod_path', {});
}

/**
 * Sync a Flint project to LTK Manager.
 * Packages the project as .modpkg and installs it to the launcher.
 *
 * @returns The installed mod ID in LTK Manager
 */
export async function syncProjectToLauncher(projectPath: string, ltkStoragePath: string): Promise<string> {
    return invokeCommand('sync_project_to_launcher', { projectPath, ltkStoragePath });
}

/**
 * Sync a Flint project to the Celestial launcher.
 *
 * Celestial reads the raw project folder directly (keyed on flint.json), so
 * this just hands it the project path via a `celestial://import-flint` deep
 * link — no packaging. Returns the absolute project path handed over.
 */
export async function syncProjectToCelestial(projectPath: string): Promise<string> {
    return invokeCommand('sync_project_to_celestial', { projectPath });
}

/**
 * Start watching a project directory for changes (auto-sync).
 *
 * `launcherKind` selects the sync path on change: 'celestial' fires a
 * `celestial://import-flint` deep link; 'ltk' (default) packages and installs a
 * fantome into LTK Manager. `ltkStoragePath` is only used by the LTK path.
 */
export async function startProjectWatcher(
    projectPath: string,
    ltkStoragePath: string,
    launcherKind: 'ltk' | 'celestial' = 'ltk',
): Promise<void> {
    return invokeCommand('start_project_watcher', { projectPath, ltkStoragePath, launcherKind });
}

export async function stopProjectWatcher(): Promise<void> {
    return invokeCommand('stop_project_watcher', {});
}

export async function startPreviewWatcher(projectPath: string): Promise<void> {
    return invokeCommand('start_preview_watcher', { projectPath });
}

export async function stopPreviewWatcher(): Promise<void> {
    return invokeCommand('stop_preview_watcher', {});
}
