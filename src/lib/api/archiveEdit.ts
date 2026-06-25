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

/** Extract an inner WAD to a temp file and open a live WAD edit session against it. */
export async function openInnerWad(sessionId: string, wadName: string): Promise<WadEditSessionInfo> {
    return invokeCommand('open_inner_wad', { sessionId, wadName });
}

/** Rebuild the archive at `outputPath`, embedding any edited inner WADs + new meta. */
export async function saveArchiveSession(sessionId: string, outputPath: string): Promise<void> {
    return invokeCommand('save_archive_session', { sessionId, outputPath });
}

export async function closeArchiveSession(sessionId: string): Promise<void> {
    return invokeCommand('close_archive_session', { sessionId });
}
