import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAllWadChunks, type WadChunkBatch } from '../../../lib/api/wad';
import { useWadExplorerStore } from '../../../lib/stores/wadExplorerStore';
import { startWadIndexing } from './indexWads';

vi.mock('../../../lib/api/wad', () => ({ loadAllWadChunks: vi.fn() }));

const load = vi.mocked(loadAllWadChunks);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const results = (paths: string[]): WadChunkBatch[] => paths.map(path => ({ path, chunks: [], error: null }));

describe('WAD background indexing', () => {
    beforeEach(() => {
        load.mockReset();
        useWadExplorerStore.getState().setScan('ready', Array.from({ length: 130 }, (_, i) => ({
            path: `${i}.wad.client`, name: `${i}`, category: 'Champions',
        })));
    });

    it('waits for each batch before starting another', async () => {
        let finish!: (value: WadChunkBatch[]) => void;
        load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        load.mockImplementation(async paths => results(paths));
        const cancel = startWadIndexing();
        expect(load).toHaveBeenCalledTimes(1);
        expect(load.mock.calls[0][0]).toHaveLength(64);
        finish(results(load.mock.calls[0][0]));
        await flush();
        await flush();
        expect(load).toHaveBeenCalledTimes(3);
        expect(useWadExplorerStore.getState().wads.every(w => w.status === 'loaded')).toBe(true);
        cancel();
    });

    it('stops after a read error and retains successful results', async () => {
        load.mockImplementation(async paths => results(paths).map((r, i) => i === 0 ? { ...r, error: 'Device unavailable' } : r));
        const cancel = startWadIndexing();
        await flush();
        expect(load).toHaveBeenCalledTimes(1);
        const state = useWadExplorerStore.getState();
        expect(state.scanStatus).toBe('error');
        expect(state.scanError).toContain('0.wad.client: Device unavailable');
        expect(state.wads[1].status).toBe('loaded');
        expect(state.wads[64].status).toBe('idle');
        cancel();
    });

    it('handles rejected requests without scheduling retries', async () => {
        load.mockRejectedValue('I/O failure');
        const cancel = startWadIndexing();
        await flush();
        expect(load).toHaveBeenCalledTimes(1);
        expect(useWadExplorerStore.getState().wads[0].error).toBe('I/O failure');
        expect(useWadExplorerStore.getState().scanError).toContain('I/O failure');
        cancel();
    });

    it.each([false, true])('discards late completion after cancellation (reject: %s)', async reject => {
        let finish!: (value: WadChunkBatch[]) => void;
        let fail!: (error: Error) => void;
        load.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
        const cancel = startWadIndexing();
        cancel();
        if (reject) fail(new Error('Device unavailable'));
        else finish(results(load.mock.calls[0][0]));
        await flush();
        expect(load).toHaveBeenCalledTimes(1);
        expect(useWadExplorerStore.getState().wads.every(w => w.status === 'idle')).toBe(true);
        expect(useWadExplorerStore.getState().scanStatus).toBe('ready');
    });
});
