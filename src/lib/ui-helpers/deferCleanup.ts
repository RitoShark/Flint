/** Defer expensive cleanup work to idle time. */
export function deferCleanup(fn: () => void): void {
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => fn(), { timeout: 500 });
    } else {
        setTimeout(fn, 0);
    }
}
