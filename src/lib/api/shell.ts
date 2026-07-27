import { invokeCommand } from './core';

/** Mirrors `ShellAction` in `src-tauri/src/shell_args.rs` (serde camelCase). */
export type ShellAction =
    | 'open'
    | 'extractWad'
    | 'packWad'
    | 'importMod'
    | 'openProject';

export interface PendingFileOpen {
    action: ShellAction;
    path: string;
}

/**
 * Drain the action Explorer launched us with, if any.
 *
 * On a cold start the webview boots long after the backend emits
 * `file-open-request`, so that event is lost. Pulling here once the listener
 * is mounted is what makes the handoff race-free.
 */
export async function takePendingFileOpen(): Promise<PendingFileOpen | null> {
    return invokeCommand<PendingFileOpen | null>('take_pending_file_open', undefined);
}
