import { invokeCommand } from './core';

export interface SchemaStats {
    wads_scanned: number;
    bins_parsed: number;
    bins_failed: number;
    classes_found: number;
    total_fields: number;
    output_path: string;
}

export async function aggregateBinSchema(leaguePath: string): Promise<SchemaStats> {
    return invokeCommand('aggregate_bin_schema', { leaguePath });
}

export interface ChampionSchemaStats {
    wads_scanned: number;
    bins_parsed: number;
    bins_failed: number;
    classes_found: number;
    total_fields: number;
    output_path: string;
}

export async function aggregateChampionBinSchema(leaguePath: string): Promise<ChampionSchemaStats> {
    return invokeCommand('aggregate_champion_bin_schema', { leaguePath });
}

export interface AnimationSchemaStats {
    wads_scanned: number;
    bins_parsed: number;
    bins_failed: number;
    classes_found: number;
    total_fields: number;
    output_path: string;
}

export async function aggregateAnimationBinSchema(leaguePath: string): Promise<AnimationSchemaStats> {
    return invokeCommand('aggregate_animation_bin_schema', { leaguePath });
}

export interface TftSchemaStats {
    wads_scanned: number;
    bins_parsed: number;
    bins_failed: number;
    classes_found: number;
    total_fields: number;
    output_path: string;
}

export async function aggregateTftBinSchema(leaguePath: string): Promise<TftSchemaStats> {
    return invokeCommand('aggregate_tft_bin_schema', { leaguePath });
}

export interface TroybinSchemaStats {
    wads_scanned: number;
    bins_parsed: number;
    bins_failed: number;
    classes_found: number;
    total_fields: number;
    output_path: string;
}

export async function aggregateTroybinSchema(leaguePath: string): Promise<TroybinSchemaStats> {
    return invokeCommand('aggregate_troybin_schema', { leaguePath });
}


export interface LuabinExtractStats {
    wads_scanned: number;
    bins_parsed: number;
    bins_failed: number;
    classes_found: number;
    total_fields: number;
    output_path: string;
}

export async function extractAllLuabins(leaguePath: string): Promise<LuabinExtractStats> {
    return invokeCommand('extract_all_luabins', { leaguePath });
}
