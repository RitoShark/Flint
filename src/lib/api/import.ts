import { invokeCommand } from './core';
import type { Project } from '../types';

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
    return invokeCommand('import_fantome_wad', { wadPath, projectDir, options });
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
    return invokeCommand('import_modpkg', { modpkgPath, projectDir, options });
}
