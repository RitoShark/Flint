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
