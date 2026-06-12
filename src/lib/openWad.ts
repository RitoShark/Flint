/**
 * Open a WAD archive (`.wad` / `.wad.client` / `.client`) in the WAD extract
 * view. WADs are NOT previewable inline and must never reach the BIN editor —
 * the WAD reader handles the format and reads the table of contents instead of
 * loading the whole (often huge) archive into one allocation.
 */
import * as api from './api';
import { useWadExtractStore, useNavigationStore } from './stores';

/** True if the path is a WAD archive file. */
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
