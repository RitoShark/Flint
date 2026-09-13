import { invokeCommand } from './core';

export interface BloatFile {
    path: string;
    size: number;
}

/** One crash-risk finding from the texture / animation checks. */
/** A retype the editor can apply itself: swap `from` for `to` on each of `lines`. */
export interface TypeFix {
    /** Class the flagged field belongs to, named or `0x` hex. */
    class: string;
    field: string;
    from: string;
    to: string;
    /** 1-based lines in the saved file's ritobin text, every declaration of the pair. */
    lines: number[];
}

export interface CheckIssue {
    severity: 'critical' | 'warning';
    /** Stable rule id, e.g. `texture.block-misaligned`. */
    code: string;
    file: string;
    /** One line, for a list row or a tree tooltip. */
    message: string;
    /** 1-based line in the bin's ritobin text, when the finding sits on one. */
    line?: number;
    /** The form the client actually reads, e.g. `texturePath: file`. */
    expected?: string;
    /** Why it matters and what to do, for a surface with room to say it. */
    detail?: string;
    /** Present only when swapping the declared type leaves a value the client still reads. */
    fix?: TypeFix;
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

/** Re-checks one file (`<wad>/<path>`) after an edit. */
export async function recheckProjectFile(projectPath: string, rel: string): Promise<CheckIssue[]> {
    return invokeCommand('recheck_project_file', { projectPath, rel });
}

/** One declaration retype an audit finding says is safe to apply. */
export interface RetypeRequest {
    /** Folder-relative path, exactly as `CheckIssue.file` carries it. */
    file: string;
    field: string;
    from: string;
    to: string;
    lines: number[];
}

export interface RetypeReport {
    files_changed: number;
    declarations_changed: number;
    /** Lines that no longer declared what the finding saw, as `<file>:<line>`. */
    stale: string[];
    errors: string[];
    /** Restore point taken before anything was written, when the folder is in a project. */
    checkpoint?: string;
}

/** Applies retypes to the bins under a WAD folder, one restore point before the batch. */
export async function fixBinRetypes(
    folderPath: string,
    fixes: RetypeRequest[],
): Promise<RetypeReport> {
    return invokeCommand('fix_bin_retypes', { folderPath, fixes });
}
