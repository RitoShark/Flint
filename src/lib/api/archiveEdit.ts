import { invokeCommand } from './core';
import type { WadEditSessionInfo } from './wadEdit';

export interface ArchiveWadInfo {
    name: string;
    chunk_count: number;
}

export interface ArchiveLayout {
    session_id: string;
    source_path: string;
    kind: 'fantome' | 'modpkg';
    meta_json: string;
    wads: ArchiveWadInfo[];
}

/** Open a `.fantome`/`.modpkg` as an editable archive session (META + inner WADs). */
export async function openArchiveSession(path: string): Promise<ArchiveLayout> {
    return invokeCommand('open_archive_session', { path });
}

/** Stage an edit to the archive's meta (info.json for fantome, metadata JSON for modpkg). */
export async function writeArchiveMeta(sessionId: string, metaJson: string): Promise<void> {
    return invokeCommand('write_archive_meta', { sessionId, metaJson });
}

/** One chunk of a folder-backed inner WAD, with its real (known) path. */
export interface FolderWadChunk {
    hash: string;
    path: string;
    size: number;
}

/**
 * Result of opening an inner WAD. `is_folder` is true when the WAD came in as a
 * loose FOLDER tree (edited in place, real paths preserved — no packing); then
 * `folder_chunks` carries the real path list. A packed WAD leaves both unset and
 * the caller uses the normal `getWadChunks` path.
 */
export interface InnerWadOpen extends WadEditSessionInfo {
    is_folder: boolean;
    folder_chunks: FolderWadChunk[] | null;
}

/** Open an inner WAD live (packed → WAD session; folder tree → folder-backed session). */
export async function openInnerWad(sessionId: string, wadName: string): Promise<InnerWadOpen> {
    return invokeCommand('open_inner_wad', { sessionId, wadName });
}

/** Real path list for a folder-backed inner WAD session (reflects pending edits). */
export async function folderWadChunks(sessionId: string): Promise<FolderWadChunk[]> {
    return invokeCommand('folder_wad_chunks', { sessionId });
}

/** Rebuild the archive at `outputPath`, embedding any edited inner WADs + new meta. */
export async function saveArchiveSession(sessionId: string, outputPath: string): Promise<void> {
    return invokeCommand('save_archive_session', { sessionId, outputPath });
}

export async function closeArchiveSession(sessionId: string): Promise<void> {
    return invokeCommand('close_archive_session', { sessionId });
}
