/** Bound IPC waits and discard results after a preview is replaced or closed.
 * The backend may finish later; it must never mutate the replacement scene. */
export function waitForLoad<T>(work: Promise<T>, signal: AbortSignal, label: string, timeoutMs = 60_000): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => finish(() => reject(new DOMException('Loading cancelled', 'AbortError')));
        const timer = setTimeout(() => finish(() => reject(new Error(`${label} did not respond within ${Math.round(timeoutMs / 1000)} seconds. Retry loading.`))), timeoutMs);
        const finish = (settle: () => void) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            settle();
        };
        // Attach handlers even when already aborted: late rejections are consumed.
        work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
}

export async function loadBatches<T, R>(
    items: T[], size: number, signal: AbortSignal,
    fetch: (batch: T[]) => Promise<R[]>,
    apply: (batch: T[], results: R[], completed: number) => void,
    label: string,
): Promise<void> {
    for (let start = 0; start < items.length; start += size) {
        signal.throwIfAborted();
        const batch = items.slice(start, start + size);
        const results = await waitForLoad(fetch(batch), signal, label);
        signal.throwIfAborted();
        if (results.length !== batch.length) throw new Error(`${label}: incomplete texture response`);
        apply(batch, results, start + batch.length);
        // Let the progress bar and partially loaded map paint between uploads.
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
}

export interface MapLoadProgress {
    stage: string;
    done: number;
    total: number | null;
    startedAt: number;
    updatedAt: number;
}
