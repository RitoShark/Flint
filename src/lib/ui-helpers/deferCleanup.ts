/**
 * Defer expensive cleanup work to idle time.
 *
 * Monaco editor dispose() and Babylon engine dispose() are synchronous and
 * easily take a few hundred ms — when a preview component unmounts during
 * a project/tab close, that blocks the render commit and the UI feels
 * "stuck" before the next view appears. Wrapping the heavy cleanup in
 * `deferCleanup` returns the UI immediately and lets the GPU/worker
 * teardown happen on the next idle slot.
 */
export function deferCleanup(fn: () => void): void {
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => fn(), { timeout: 500 });
    } else {
        setTimeout(fn, 0);
    }
}
