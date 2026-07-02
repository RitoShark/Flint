import { invokeCommand } from './core';

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
