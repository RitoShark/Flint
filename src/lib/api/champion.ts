import { invokeCommand } from './core';
import type { Champion } from '../types';

export async function discoverChampions(leaguePath: string): Promise<Champion[]> {
    return invokeCommand('discover_champions', { leaguePath });
}

export async function getChampionSkins(
    leaguePath: string,
    championId: string
): Promise<Array<{ id: number; name: string }>> {
    return invokeCommand('get_champion_skins', { leaguePath, championId });
}

