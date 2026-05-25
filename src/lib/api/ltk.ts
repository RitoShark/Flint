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

/** Start watching a project directory for changes (auto-sync). */
export async function startProjectWatcher(projectPath: string, ltkStoragePath: string): Promise<void> {
    return invokeCommand('start_project_watcher', { projectPath, ltkStoragePath });
}

/** Stop the active project watcher. */
export async function stopProjectWatcher(): Promise<void> {
    return invokeCommand('stop_project_watcher', {});
}

/** Start preview file watcher for hot reload. */
export async function startPreviewWatcher(projectPath: string): Promise<void> {
    return invokeCommand('start_preview_watcher', { projectPath });
}

/** Stop the active preview watcher. */
export async function stopPreviewWatcher(): Promise<void> {
    return invokeCommand('stop_preview_watcher', {});
}
