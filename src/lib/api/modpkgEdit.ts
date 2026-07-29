import { invokeCommand, invokeRaw } from './core';

/** A live ModPkg editing session opened from disk. Mirrors the WAD edit-session pattern. */
export interface ModpkgSession {
    session_id: string;
    source_path: string;
    name: string;
    display_name: string;
    description: string | null;
    version: string;
    authors: string[];
    file_paths: string[];
    /** Base64 data URL (WebP) for the thumbnail, or null if the package has none. */
    thumbnail: string | null;
    /**
     * True when the package uses more than the base layer. Flint's rebuild writes
     * everything to `base`, so chunk editing is refused for these rather than
     * silently flattening them.
     */
    multi_layer: boolean;
}

/** One content chunk inside a package. */
export interface ModpkgChunkInfo {
    path: string;
    /** Decompressed size in bytes. */
    size: number;
    /** True when an unsaved edit is staged against this path. */
    dirty: boolean;
}

/** Editable metadata payload sent back when saving a session. */
export interface ModpkgMetadataInput {
    name: string;
    display_name: string;
    description: string | null;
    version: string;
    authors: string[];
}

/** Open a `.modpkg` for editing — returns metadata, file list and thumbnail. */
export async function openModpkgSession(path: string): Promise<ModpkgSession> {
    return invokeCommand('open_modpkg_session', { path });
}

/** Re-save the package (in place when `outputPath === source_path`) with updated metadata. */
export async function saveModpkgSession(
    sessionId: string,
    metadata: ModpkgMetadataInput,
    outputPath: string,
): Promise<void> {
    return invokeCommand('save_modpkg_session', { sessionId, metadata, outputPath });
}

/** Release the session and free its in-memory state. */
export async function closeModpkgSession(sessionId: string): Promise<void> {
    return invokeCommand('close_modpkg_session', { sessionId });
}

/** Content chunks with sizes, reflecting any staged edits. */
export async function listModpkgChunks(sessionId: string): Promise<ModpkgChunkInfo[]> {
    return invokeCommand('list_modpkg_chunks', { sessionId });
}

/** Decompressed bytes for one chunk, honouring a staged edit. */
export async function readModpkgChunk(sessionId: string, path: string): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('read_modpkg_chunk', { sessionId, path });
    return new Uint8Array(buf);
}

/** Stage replacement bytes for a chunk (adds it when the path is new). */
export async function writeModpkgChunk(
    sessionId: string,
    path: string,
    data: Uint8Array,
): Promise<void> {
    return invokeRaw('write_modpkg_chunk', data, { 'session-id': sessionId, 'chunk-path': path });
}

/** Stage removal of a chunk. */
export async function removeModpkgChunk(sessionId: string, path: string): Promise<void> {
    return invokeCommand('remove_modpkg_chunk', { sessionId, path });
}

/** Stage a move of a chunk to a new path inside the package. */
export async function renameModpkgChunk(
    sessionId: string,
    oldPath: string,
    newPath: string,
): Promise<void> {
    return invokeCommand('rename_modpkg_chunk', { sessionId, oldPath, newPath });
}

/** Paths with unsaved edits staged against them. */
export async function modpkgDirtyChunks(sessionId: string): Promise<string[]> {
    return invokeCommand('modpkg_dirty_chunks', { sessionId });
}

/** Drop every staged edit, returning the session to what is on disk. */
export async function discardModpkgChanges(sessionId: string): Promise<void> {
    return invokeCommand('discard_modpkg_changes', { sessionId });
}
