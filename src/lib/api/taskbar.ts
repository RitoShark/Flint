import { invokeCommand } from './core';

/** Taskbar progress states mirrored from the Rust `set_taskbar_progress` command. */
export type TaskbarState = 'no_progress' | 'indeterminate' | 'normal' | 'paused' | 'error';

/**
 * Drive the Windows taskbar icon's progress indicator. No-op on non-Windows.
 *
 * `completed` / `total` only apply to the counted states (`normal` / `paused`
 * / `error`); pass `0, 0` for `indeterminate` / `no_progress`.
 */
export async function setTaskbarProgress(
    state: TaskbarState,
    completed = 0,
    total = 0,
): Promise<void> {
    // Best-effort: a taskbar hiccup must never break the operation it's
    // decorating, so swallow errors here rather than propagating them.
    try {
        await invokeCommand('set_taskbar_progress', { state, completed, total });
    } catch {
        /* ignore — taskbar progress is cosmetic */
    }
}
