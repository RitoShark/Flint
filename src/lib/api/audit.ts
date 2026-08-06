import { invokeCommand } from './core';

export interface BloatFile {
    path: string;
    size: number;
}

export interface AuditReport {
    /** Referenced assets/ or data/ paths with no matching file in the folder. */
    missing: string[];
    /** Present files no BIN references. */
    bloat: BloatFile[];
    files_scanned: number;
    bins_scanned: number;
    bins_failed: number;
    bloat_bytes: number;
}

/** Audits an unpacked `.wad.client` folder for missing references and unreferenced files. */
export async function auditWadFolder(folderPath: string): Promise<AuditReport> {
    return invokeCommand('audit_wad_folder', { folderPath });
}
