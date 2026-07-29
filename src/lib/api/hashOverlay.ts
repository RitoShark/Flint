import { invokeCommand } from './core';

// `OverlayStats` on the Rust side (src-tauri/src/commands/project/hash_overlay.rs)
// has no `#[serde(rename_all = "camelCase")]`, so it serializes with its literal
// field names — snake_case, matching this codebase's convention for un-renamed
// structs (see `HashStatus.loaded_count` in src/lib/types.ts).
export interface OverlayStats {
    wad_entries: number;
}

/**
 * Build (or reload from cache) the project's local hash overlay and make it
 * active. Cheap to call repeatedly — an unchanged project short-circuits to a
 * fingerprint check plus a cache read.
 */
export async function buildProjectHashOverlay(projectPath: string): Promise<OverlayStats> {
    return invokeCommand<OverlayStats>('build_project_hash_overlay', { projectPath });
}

/**
 * Drop the active overlay. Called (from `App.tsx`) when the last open project
 * tab closes — the backend holds a single overlay slot for "the active
 * project," so that's the only point at which "no project is active" is
 * unambiguous in a multi-tab UI.
 */
export async function clearProjectHashOverlay(): Promise<void> {
    return invokeCommand<void>('clear_project_hash_overlay', undefined);
}

// =============================================================================
// Debounced rebuild trigger
// =============================================================================

const REBUILD_DEBOUNCE_MS = 200;

interface RebuildState {
    timer: ReturnType<typeof setTimeout> | null;
    inFlight: boolean;
    /** A call arrived while a build for this path was in flight; run one more
     *  build as soon as the in-flight one finishes. */
    pending: boolean;
}

/** One debounce/in-flight state per project path — bursts across different
 *  projects (rare, but possible with multiple open tabs) don't interfere. */
const rebuildStates = new Map<string, RebuildState>();

function getRebuildState(projectPath: string): RebuildState {
    let state = rebuildStates.get(projectPath);
    if (!state) {
        state = { timer: null, inFlight: false, pending: false };
        rebuildStates.set(projectPath, state);
    }
    return state;
}

function runBuild(projectPath: string, state: RebuildState): void {
    state.inFlight = true;
    void buildProjectHashOverlay(projectPath)
        .catch((e) => {
            console.warn('hash overlay build failed', e);
        })
        .finally(() => {
            state.inFlight = false;
            if (state.pending) {
                state.pending = false;
                runBuild(projectPath, state);
            }
        });
}

/**
 * Fire-and-forget overlay rebuild trigger shared by every tree mutation call
 * site (rename, delete, move, duplicate, import). Debounces trailing-edge:
 * calls for the same `projectPath` arriving within 200ms of each other
 * collapse into a single rebuild, so a 50-file multi-select delete fires one
 * rebuild instead of 50. A call that arrives while a build for that path is
 * already running doesn't start a second, overlapping one — it's coalesced
 * into exactly one trailing rebuild once the in-flight build finishes.
 *
 * Never throws and never rejects to the caller — the overlay only improves
 * hash display, so a failure here must stay invisible to whoever triggered it.
 */
export function fireOverlayRebuild(projectPath: string): void {
    const state = getRebuildState(projectPath);

    if (state.timer !== null) {
        clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
        state.timer = null;
        if (state.inFlight) {
            state.pending = true;
            return;
        }
        runBuild(projectPath, state);
    }, REBUILD_DEBOUNCE_MS);
}
