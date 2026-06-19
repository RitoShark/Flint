import { invokeCommand } from './core';

export interface OriginalFileMeta {
    found: boolean;
    /** True when the matched WAD-internal path is an exact (case-insensitive)
     *  match. False when matched via the suffix-tolerant fallback. */
    exact: boolean;
    wad_found: boolean;
    wad_path: string | null;
    /** Hex hash of the matched chunk — pass to `readWadChunkData` to fetch bytes. */
    matched_hash: string | null;
    matched_internal_path: string | null;
    queried_internal_path: string;
    queried_wad_name: string;
}

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
