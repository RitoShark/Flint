import { invokeCommand } from './core';

export interface BloatFile {
    path: string;
    size: number;
}

/** One crash-risk finding from the texture / animation checks. */
export interface CheckIssue {
    severity: 'critical' | 'warning';
    /** Stable rule id, e.g. `texture.block-misaligned`. */
    code: string;
    file: string;
    message: string;
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
    /** Files present but shaped in a way the client cannot load. */
    issues: CheckIssue[];
}

export interface WadMissingRefs {
    wad: string;
    missing: string[];
}

export interface ProjectMissingReport {
    /** Only WADs that actually have missing references. */
    wads: WadMissingRefs[];
    total_missing: number;
    bins_scanned: number;
    bins_failed: number;
    /** Crash-risk findings across every WAD, criticals first. */
    issues: CheckIssue[];
    total_critical: number;
}

/** Audits an unpacked `.wad.client` folder for missing references and unreferenced files. */
export async function auditWadFolder(folderPath: string): Promise<AuditReport> {
    return invokeCommand('audit_wad_folder', { folderPath });
}

/** Missing references across every WAD folder an export would ship. */
export async function auditProjectMissingRefs(projectPath: string): Promise<ProjectMissingReport> {
    return invokeCommand('audit_project_missing_refs', { projectPath });
}
