import { invokeCommand } from './core';

/** One entry in the fix catalog (from Hematite's config). */
export interface FixEntry {
    id: string;
    name: string;
    description: string;
    severity: 'low' | 'medium' | 'high' | 'critical' | string;
    enabled: boolean;
    wad_level: boolean;
}

/** A single fix that fired (detected on scan, or applied on run). */
export interface FixOutcome {
    fix_id: string;
    fix_name: string;
    changes: number;
    file_path: string;
}

/** Per-project result of a scan or run. */
export interface ProjectFixReport {
    project: string;
    outcomes: FixOutcome[];
    fixes_applied: number;
    fixes_failed: number;
    files_removed: number;
    errors: string[];
    champion: string | null;
    skin_number: number | null;
    /** Set when the whole project failed (e.g. missing hashes). */
    error: string | null;
}

/** Progress event payload (`hematite-fix-progress`). */
export interface FixProgress {
    project: string;
    stage?: string;
    fix?: string;
    count?: number;
    note?: string;
}

/** The full fix catalog. */
export function hematiteListFixes(): Promise<FixEntry[]> {
    return invokeCommand<FixEntry[]>('hematite_list_fixes');
}

/** Detect-only scan of each project — reports which selected fixes fire, writes nothing. */
export function hematiteScanProjects(
    projectPaths: string[],
    fixIds: string[],
): Promise<ProjectFixReport[]> {
    return invokeCommand<ProjectFixReport[]>('hematite_scan_projects', { projectPaths, fixIds });
}

/** Apply the selected fixes; streams progress via the `hematite-fix-progress` event. */
export function hematiteRunFixes(
    projectPaths: string[],
    fixIds: string[],
    useLive: boolean,
): Promise<ProjectFixReport[]> {
    return invokeCommand<ProjectFixReport[]>('hematite_run_fixes', { projectPaths, fixIds, useLive });
}
