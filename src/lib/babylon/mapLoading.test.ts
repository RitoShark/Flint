import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBatches, waitForLoad } from './mapLoading';

afterEach(() => vi.useRealTimers());
describe('map loading lifecycle', () => {
    it('applies bounded batches in order with actual completed counts', async () => {
        const applied: number[] = [], counts: number[] = [], sizes: number[] = [];
        await loadBatches([1, 2, 3, 4, 5], 2, new AbortController().signal,
            async batch => { sizes.push(batch.length); return batch.map(n => n * 10); },
            (_batch, entries, done) => { applied.push(...entries); counts.push(done); }, 'Textures');
        expect(applied).toEqual([10, 20, 30, 40, 50]);
        expect(counts).toEqual([2, 4, 5]);
        expect(sizes).toEqual([2, 2, 1]);
    });
    it('rejects a hung request with a useful timeout and consumes late completion', async () => {
        vi.useFakeTimers();
        let finish!: (value: number) => void;
        const waiting = waitForLoad(new Promise<number>(resolve => { finish = resolve; }), new AbortController().signal, 'Map geometry', 1000);
        const assertion = expect(waiting).rejects.toThrow('Map geometry did not respond');
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
        finish(123);
        await Promise.resolve();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('never applies a stale batch after retry/unmount', async () => {
        const controller = new AbortController();
        let finish!: (value: number[]) => void;
        const apply = vi.fn(), fetch = vi.fn(() => new Promise<number[]>(resolve => { finish = resolve; }));
        const loading = loadBatches([1, 2], 1, controller.signal, fetch, apply, 'Textures');
        const assertion = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort();
        finish([10]);
        await assertion;
        expect(apply).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('rejects incomplete data before applying a batch', async () => {
        const apply = vi.fn();
        await expect(loadBatches([1, 2], 2, new AbortController().signal, async () => [1], apply, 'Textures'))
            .rejects.toThrow('incomplete texture response');
        expect(apply).not.toHaveBeenCalled();
    });
    it('clears timeout resources on success or cancellation', async () => {
        vi.useFakeTimers();
        await expect(waitForLoad(Promise.resolve(42), new AbortController().signal, 'Map')).resolves.toBe(42);
        const controller = new AbortController(); controller.abort();
        await expect(waitForLoad(Promise.reject(new Error('Late error')), controller.signal, 'Map')).rejects.toMatchObject({ name: 'AbortError' });
        expect(vi.getTimerCount()).toBe(0);
    });
});
