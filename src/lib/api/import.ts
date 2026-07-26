import { invokeCommand } from './core';
import { buildProjectHashOverlay } from './hashOverlay';
import type { Project } from '../types';

/**
 * Fire-and-forget overlay rebuild after an import that refathered — refathering
 * rewrites every asset path, so any previous overlay is entirely stale. A
 * failure here must never surface to the caller; the overlay only improves
 * hash display.
 */
function rebuildOverlayAfterRefather(projectDir: string, options: ImportOptions): void {
    if (!options.refather) return;
    void buildProjectHashOverlay(projectDir).catch((e) => {
        console.warn('hash overlay build failed', e);
    });
}

export interface FantomeMetadata {
    author: string | null;
    name: string | null;
    description: string | null;
    version: string | null;
}

export interface FantomeAnalysis {
    champion: string | null;
    skin_ids: number[];
    is_champion_mod: boolean;
    file_count: number;
    file_paths: string[];
    metadata: FantomeMetadata | null;
}

export interface ImportOptions {
    refather: boolean;
    creator_name: string | null;
    project_name: string | null;
    champion: string | null;
    target_skin_id: number | null;
    cleanup_unused: boolean;
    match_from_league: boolean;
    league_path: string | null;
}

export async function analyzeFantome(wadPath: string): Promise<FantomeAnalysis> {
    return invokeCommand('analyze_fantome', { wadPath });
}

export async function importFantomeWad(
    wadPath: string,
    projectDir: string,
    options: ImportOptions
): Promise<Project> {
    const project = await invokeCommand<Project>('import_fantome_wad', { wadPath, projectDir, options });
    rebuildOverlayAfterRefather(projectDir, options);
    return project;
}

// =============================================================================
// ModPkg
// =============================================================================

export interface ModpkgAnalysis {
    champion: string | null;
    skin_ids: number[];
    is_champion_mod: boolean;
    file_count: number;
    file_paths: string[];
    name: string | null;
    display_name: string | null;
    description: string | null;
    version: string | null;
    authors: string[];
    has_thumbnail: boolean;
}

export async function analyzeModpkg(modpkgPath: string): Promise<ModpkgAnalysis> {
    return invokeCommand('analyze_modpkg', { modpkgPath });
}

export async function importModpkg(
    modpkgPath: string,
    projectDir: string,
    options: ImportOptions
): Promise<Project> {
    const project = await invokeCommand<Project>('import_modpkg', { modpkgPath, projectDir, options });
    rebuildOverlayAfterRefather(projectDir, options);
    return project;
}

// =============================================================================
// Extracted folder (raw `assets/` + `data/` WAD extract)
// =============================================================================

export interface ExtractedFolderAnalysis {
    /** Already a Flint project — open it instead of importing. */
    is_flint_project: boolean;
    /** Has `assets/` and/or `data/`, so it can be imported. */
    is_valid: boolean;
    champion: string | null;
    skin_id: number;
    suggested_name: string;
    file_count: number;
}

/** Classify a folder as a Flint project, an importable WAD extract, or neither. */
export async function analyzeExtractedFolder(folderPath: string): Promise<ExtractedFolderAnalysis> {
    return invokeCommand('analyze_extracted_folder', { folderPath });
}

/**
 * Copy an extracted WAD folder into a new project at `projectDir`. If that
 * directory is taken, the backend appends a numeric suffix — read the real
 * location off the returned project's `project_path`.
 */
export async function importExtractedFolder(
    folderPath: string,
    projectDir: string,
    options: ImportOptions
): Promise<Project> {
    return invokeCommand('import_extracted_folder', { folderPath, projectDir, options });
}
