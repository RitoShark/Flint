import * as api from './api';
import { useWadExtractStore, useNavigationStore } from './stores';

export function isWadPath(path: string): boolean {
    const p = path.toLowerCase();
    return p.endsWith('.wad') || p.endsWith('.wad.client') || p.endsWith('.client');
}

/** Open `fullFilePath` (absolute) in a new WAD extract session. Throws on failure. */
export async function openWadInExtract(fullFilePath: string): Promise<void> {
    const chunks = await api.getWadChunks(fullFilePath);
    const sessionId = `extract-${Date.now()}`;
    useWadExtractStore.getState().openSession(sessionId, fullFilePath);
    useNavigationStore.getState().setView('extract');
    useWadExtractStore.getState().setChunks(sessionId, chunks);
}
