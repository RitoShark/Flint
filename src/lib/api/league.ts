import { invokeCommand } from './core';

export async function detectLeague(): Promise<{ path: string; source: string }> {
    return invokeCommand('detect_league');
}

interface LeagueInstallation {
    path: string;
    game_path: string;
    auto_detected: boolean;
}

export async function validateLeague(path: string): Promise<{ valid: boolean; path: string | null }> {
    try {
        const result = await invokeCommand<LeagueInstallation>('validate_league', { path });
        return { valid: true, path: result.path };
    } catch {
        return { valid: false, path: null };
    }
}
