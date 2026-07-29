import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireOverlayRebuild } from './hashOverlay';
import { invokeCommand } from './core';

vi.mock('./core', () => ({ invokeCommand: vi.fn() }));

describe('fireOverlayRebuild', () => {
    beforeEach(() => vi.mocked(invokeCommand).mockReset());

    it('coalesces rapid rebuild requests into one', async () => {
        vi.useFakeTimers();
        vi.mocked(invokeCommand).mockResolvedValue({ wad_entries: 1 });

        fireOverlayRebuild('C:\\p');
        fireOverlayRebuild('C:\\p');
        fireOverlayRebuild('C:\\p');
        await vi.runAllTimersAsync();

        expect(invokeCommand).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('a call arriving during an in-flight build coalesces into one trailing rebuild, not a stacked concurrent one', async () => {
        vi.useFakeTimers();
        let resolveFirst!: (value: { wad_entries: number }) => void;
        const firstBuild = new Promise<{ wad_entries: number }>((resolve) => {
            resolveFirst = resolve;
        });
        vi.mocked(invokeCommand)
            .mockImplementationOnce(() => firstBuild)
            .mockResolvedValue({ wad_entries: 1 });

        fireOverlayRebuild('C:\\p-inflight');
        await vi.advanceTimersByTimeAsync(200);
        expect(invokeCommand).toHaveBeenCalledTimes(1); // first build kicked off, still in flight

        fireOverlayRebuild('C:\\p-inflight'); // arrives while the first build is running
        await vi.advanceTimersByTimeAsync(200); // its debounce window elapses...
        expect(invokeCommand).toHaveBeenCalledTimes(1); // ...but must NOT start a second, overlapping build

        resolveFirst({ wad_entries: 1 });
        await vi.runAllTimersAsync();

        expect(invokeCommand).toHaveBeenCalledTimes(2); // exactly one trailing rebuild follows

        vi.useRealTimers();
    });
});
