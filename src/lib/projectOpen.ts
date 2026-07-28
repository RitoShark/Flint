/**
 * Opening and importing projects by path.
 *
 * Three entry points need the same "put this project on screen" sequence —
 * the welcome screen, the project list modal, and the folder drop/import
 * handlers — so it lives here rather than being copied per call site.
 *
 * These are plain functions, not hooks: drop handlers fire from a Tauri event
 * listener rather than a React render, so they reach the stores through
 * `getState()`.
 */

import { useConfigStore, useProjectTabStore, useNavigationStore, useAppMetadataStore } from './stores';
import * as api from './api';
import type { Project } from './types';

/** Fallback projects directory, matching the legacy hardcoded import path. */
async function fallbackProjectsDir(): Promise<string> {
    const { appDataDir } = await import('@tauri-apps/api/path');
    const appData = await appDataDir();
    const parts = appData.replace(/\\/g, '/').split('/');
    parts.pop();
    return `${parts.join('/')}/RitoShark/Flint/Projects`;
}

/** Configured projects root, falling back to the default Flint home. */
export async function resolveProjectsDir(): Promise<string> {
    const configured = useConfigStore.getState().defaultProjectPath;
    if (configured && configured.trim()) return configured.replace(/\\/g, '/');
    return fallbackProjectsDir();
}

/** Strip a trailing project file so callers may pass either a dir or its config. */
export function toProjectDir(path: string): string {
    return path.endsWith('.json')
        ? path.replace(/[\\/](mod\.config|flint|project)\.json$/, '')
        : path;
}

/**
 * Canonical key for comparing two project paths.
 *
 * The same project reaches us spelled several ways: `resolveProjectsDir`
 * forward-slashes the configured root before joining a `\`-separated name
 * (producing mixed `C:/Users/…/projects\my-mod`), while `discover_projects`
 * returns all-backslash paths from Rust. A raw `===` between those two
 * spellings is false, which is why a deleted project used to survive in
 * Recent Folders. Windows paths are also case-insensitive, so fold case too.
 */
export function projectPathKey(path: string): string {
    return toProjectDir(path)
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}

/** True when both paths point at the same project, whatever their spelling. */
export function isSameProjectPath(a: string, b: string): boolean {
    return projectPathKey(a) === projectPathKey(b);
}

/** Register an opened/imported project across tabs, saved list and recents. */
function registerOpenedProject(project: Project, projectDir: string) {
    useProjectTabStore.getState().addTab(project, projectDir);
    useNavigationStore.getState().setView('preview');
    useConfigStore.getState().addSavedProject({
        id: `proj-${Date.now()}`,
        name: project.display_name || project.name,
        kind: project.kind ?? 'skin',
        champion: project.champion,
        mapId: project.map_id ?? null,
        path: projectDir,
        lastOpened: new Date().toISOString(),
    });

    const recents = useConfigStore.getState().recentProjects
        .filter((p) => !isSameProjectPath(p.path, projectDir));
    recents.unshift({
        name: project.display_name || project.name,
        champion: project.champion,
        skin: project.skin_id,
        path: projectDir,
        lastOpened: new Date().toISOString(),
    });
    useConfigStore.getState().setRecentProjects(recents.slice(0, 10));
}

/** Open an existing Flint project and focus it. Throws on failure. */
export async function openProjectAt(path: string): Promise<Project> {
    const projectDir = toProjectDir(path);
    const { project, fileTree } = await api.openProjectWithTree(projectDir);
    registerOpenedProject(project, projectDir);
    const tabId = useProjectTabStore.getState().activeTabId;
    if (tabId) useProjectTabStore.getState().setFileTree(tabId, fileTree);
    return project;
}

/**
 * Import a raw extracted WAD folder as a new project and focus it.
 *
 * The destination name is derived from the detected champion/skin so imports
 * sort next to their equivalents from Fantome; the backend de-duplicates it if
 * taken, so the project's own `project_path` is authoritative afterwards.
 */
export async function importFolderAt(
    folderPath: string,
    analysis: api.ExtractedFolderAnalysis,
): Promise<Project> {
    const projectsDir = await resolveProjectsDir();
    const champion = analysis.champion || 'Unknown';
    const safeName = analysis.suggested_name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dirName = `${champion}_Skin${analysis.skin_id}_${safeName}`;

    const options: api.ImportOptions = {
        refather: false,
        creator_name: useConfigStore.getState().creatorName || 'Unknown',
        project_name: analysis.suggested_name,
        champion: analysis.champion,
        target_skin_id: analysis.skin_id,
        cleanup_unused: false,
        match_from_league: false,
        league_path: useConfigStore.getState().leaguePath || null,
    };

    const project = await api.importExtractedFolder(folderPath, `${projectsDir}/${dirName}`, options);
    // The backend may have suffixed the directory to avoid a collision.
    const actualDir = project.project_path || `${projectsDir}/${dirName}`;
    registerOpenedProject(project, actualDir);

    try {
        const files = await api.listProjectFiles(actualDir);
        const tabId = useProjectTabStore.getState().activeTabId;
        if (tabId) useProjectTabStore.getState().setFileTree(tabId, files);
    } catch (err) {
        console.error('[Import] Failed to load imported project files:', err);
    }
    return project;
}

export type DropOutcome =
    | { kind: 'opened'; project: Project }
    | { kind: 'imported'; project: Project }
    | { kind: 'rejected'; reason: string };

/**
 * Route a dropped or picked folder: open it if it is already a Flint project,
 * import it if it is a raw WAD extract, otherwise reject with a reason worth
 * showing the user.
 *
 * Drives the status bar itself so every call site reports progress the same way.
 */
export async function openOrImportFolder(path: string): Promise<DropOutcome> {
    const meta = useAppMetadataStore.getState();
    try {
        meta.setWorking('Inspecting folder…');
        const analysis = await api.analyzeExtractedFolder(path);

        if (analysis.is_flint_project) {
            meta.setWorking('Opening project…');
            const project = await openProjectAt(path);
            meta.setReady();
            return { kind: 'opened', project };
        }

        if (!analysis.is_valid) {
            meta.setReady();
            return {
                kind: 'rejected',
                reason: 'That folder is neither a Flint project nor an extracted WAD (no assets/ or data/ inside).',
            };
        }

        if (!analysis.champion) {
            meta.setReady();
            return {
                kind: 'rejected',
                reason: 'Could not work out which champion this extract is for — expected data/characters/<champion>/.',
            };
        }

        meta.setWorking(`Importing ${analysis.file_count} files…`);
        const project = await importFolderAt(path, analysis);
        meta.setReady();
        return { kind: 'imported', project };
    } catch (error) {
        console.error('[openOrImportFolder] failed for', path, error);
        const flintError = error as api.FlintError;
        const reason = flintError?.getUserMessage?.()
            || (error instanceof Error ? error.message : String(error));
        meta.setError(reason);
        return { kind: 'rejected', reason };
    }
}
