import { invokeCommand } from './core';

export interface OriginalFileMeta {
    /** Did we locate a chunk in the original WAD that matches this project file? */
    found: boolean;
    /** True when the matched WAD-internal path is an exact (case-insensitive)
     *  match. False when matched via the suffix-tolerant fallback. */
    exact: boolean;
    /** Did we locate the original WAD file in the League install? */
    wad_found: boolean;
    /** Absolute path of the original WAD (null if not located). */
    wad_path: string | null;
    /** Hex hash of the matched chunk — pass to `readWadChunkData` to fetch bytes. */
    matched_hash: string | null;
    /** WAD-internal path of the matched chunk. */
    matched_internal_path: string | null;
    /** Internal path we derived from the project file. */
    queried_internal_path: string;
    /** WAD folder name we derived (e.g. `Ambessa.wad.client`). */
    queried_wad_name: string;
}

/**
 * Look up the original chunk for a project file. Tolerates suffix changes
 * between patches.
 */
export async function findOriginalFile(
    leaguePath: string,
    projectPath: string,
    fileRelPath: string,
): Promise<OriginalFileMeta> {
    return invokeCommand('find_original_file', { leaguePath, projectPath, fileRelPath });
}

export async function hasFileBackup(projectPath: string, fileRelPath: string): Promise<boolean> {
    return invokeCommand('has_file_backup', { projectPath, fileRelPath });
}

export async function createFileBackup(projectPath: string, fileRelPath: string): Promise<void> {
    return invokeCommand('create_file_backup', { projectPath, fileRelPath });
}

export async function readFileBackup(projectPath: string, fileRelPath: string): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('read_file_backup', { projectPath, fileRelPath });
    return new Uint8Array(buf);
}

export async function deleteFileBackup(projectPath: string, fileRelPath: string): Promise<void> {
    return invokeCommand('delete_file_backup', { projectPath, fileRelPath });
}
