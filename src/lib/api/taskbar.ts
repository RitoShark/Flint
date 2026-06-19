import { invokeCommand } from './core';

export type TaskbarState = 'no_progress' | 'indeterminate' | 'normal' | 'paused' | 'error';

/**
 * `completed` / `total` only apply to the counted states (`normal` / `paused`
 * / `error`); pass `0, 0` for `indeterminate` / `no_progress`.
 */
export async function setTaskbarProgress(
    state: TaskbarState,
    completed = 0,
    total = 0,
): Promise<void> {
    try {
        await invokeCommand('set_taskbar_progress', { state, completed, total });
    } catch {
        /* ignore */
    }
}
