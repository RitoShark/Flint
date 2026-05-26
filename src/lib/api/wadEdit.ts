import { invokeCommand, invokeRaw } from './core';

export interface WadEditSessionInfo {
    /** Stable session ID (uuid v4). Used by all subsequent calls. */
    session_id: string;
    /** Absolute path the session was opened from. */
    source_path: string;
    /** Chunk count after the initial TOC parse — does not include adds yet. */
    initial_chunk_count: number;
}

export interface WadDirtyChunk {
    path_hash: string;
    size: number;
    deleted: boolean;
}

/** Open a WAD into an in-memory edit session. The on-disk file is not modified. */
export async function openWadEditSession(wadPath: string): Promise<WadEditSessionInfo> {
    return invokeCommand('open_wad_edit_session', { wadPath });
}

/** Drop the session. Any unsaved changes are lost. */
export async function closeWadEditSession(sessionId: string): Promise<void> {
    return invokeCommand('close_wad_edit_session', { sessionId });
}

/** List active WAD edit sessions (debugging / UI restore). */
export async function listWadEditSessions(): Promise<WadEditSessionInfo[]> {
    return invokeCommand('list_wad_edit_sessions', {});
}

/** Read decompressed bytes for a chunk inside a session (honors pending edits). */
export async function readSessionChunk(sessionId: string, pathHash: string): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('read_session_chunk', { sessionId, pathHash });
    return new Uint8Array(buf);
}

/** Stage new bytes for a chunk. Adds if the hash is new. Raw-body transport. */
export async function writeSessionChunk(
    sessionId: string,
    pathHash: string,
    data: Uint8Array,
): Promise<void> {
    return invokeRaw('write_session_chunk', data, { 'session-id': sessionId, 'path-hash': pathHash });
}

/** Stage a chunk deletion. Lives in the session until save. */
export async function removeSessionChunk(sessionId: string, pathHash: string): Promise<void> {
    return invokeCommand('remove_session_chunk', { sessionId, pathHash });
}

/** Enumerate the chunks that have pending edits in the session. */
export async function sessionDirtyChunks(sessionId: string): Promise<WadDirtyChunk[]> {
    return invokeCommand('session_dirty_chunks', { sessionId });
}

/** Drop all pending edits but keep the session open. */
export async function discardSessionChanges(sessionId: string): Promise<void> {
    return invokeCommand('discard_session_changes', { sessionId });
}

/**
 * Serialize the session to a WAD and write it to `outputPath`. The session
 * stays open after save so further edits can be made. Pass `outputPath === source_path`
 * to overwrite the original.
 */
export async function saveWadEditSession(
    sessionId: string,
    outputPath: string,
): Promise<{ wrote_bytes: number; chunk_count: number }> {
    return invokeCommand('save_session_to_path', { sessionId, outputPath });
}
