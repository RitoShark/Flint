import { invokeCommand } from './core';

// `OverlayStats` on the Rust side (src-tauri/src/commands/project/hash_overlay.rs)
// has no `#[serde(rename_all = "camelCase")]`, so it serializes with its literal
// field names — snake_case, matching this codebase's convention for un-renamed
// structs (see `HashStatus.loaded_count` in src/lib/types.ts).
export interface OverlayStats {
    wad_entries: number;
    bin_entries: number;
}

/**
 * Build (or reload from cache) the project's local hash overlay and make it
 * active. Cheap to call repeatedly — an unchanged project short-circuits to a
 * fingerprint check plus a cache read.
 */
export async function buildProjectHashOverlay(projectPath: string): Promise<OverlayStats> {
    return invokeCommand<OverlayStats>('build_project_hash_overlay', { projectPath });
}

/** Drop the active overlay. Call when a project closes. */
export async function clearProjectHashOverlay(): Promise<void> {
    return invokeCommand<void>('clear_project_hash_overlay', undefined);
}
