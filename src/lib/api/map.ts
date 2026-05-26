import { invokeCommand } from './core';
import type { Project } from '../types';

export interface MapEntry {
    id: string;
    displayName: string;
    hasLevels: boolean;
}

export interface MapVariant {
    name: string;
    mapgeo: string;
    materials: string;
}

export async function listAvailableMaps(leaguePath: string): Promise<MapEntry[]> {
    return invokeCommand('list_available_maps', { leaguePath });
}

export async function listMapVariants(leaguePath: string, mapId: string): Promise<MapVariant[]> {
    return invokeCommand('list_map_variants', { leaguePath, mapId });
}

export interface CreateMapProjectParams {
    name: string;
    mapId: string;
    includeLevels: boolean;
    projectPath: string;
    leaguePath: string;
    creatorName?: string;
    /** 'variant' (default) extracts only the chosen variant + its referenced
     *  kit-piece assets + matching LEVELS lightmaps. 'full' dumps the whole
     *  WAD (legacy behaviour). */
    extractMode?: 'variant' | 'full';
    /** Required when extractMode is 'variant'. Variant base name from
     *  `listMapVariants`. */
    variantName?: string;
}

export async function createMapProject(params: CreateMapProjectParams): Promise<Project> {
    return invokeCommand('create_map_project', {
        name: params.name,
        mapId: params.mapId,
        includeLevels: params.includeLevels,
        outputPath: params.projectPath,
        leaguePath: params.leaguePath,
        creatorName: params.creatorName,
        extractMode: params.extractMode ?? 'variant',
        variantName: params.variantName,
    });
}
