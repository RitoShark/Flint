import { describe, it, expect, vi, beforeEach } from 'vitest';
import { takePendingFileOpen } from './shell';
import { invokeCommand } from './core';

vi.mock('./core', () => ({ invokeCommand: vi.fn() }));

describe('shell api', () => {
    beforeEach(() => vi.mocked(invokeCommand).mockReset());

    it('returns the pending action and path', async () => {
        vi.mocked(invokeCommand).mockResolvedValue({
            action: 'packWad',
            path: 'C:\\mods\\aatrox',
        });

        const pending = await takePendingFileOpen();

        expect(pending).toEqual({ action: 'packWad', path: 'C:\\mods\\aatrox' });
    });

    it('returns null when nothing is pending', async () => {
        vi.mocked(invokeCommand).mockResolvedValue(null);
        await expect(takePendingFileOpen()).resolves.toBeNull();
    });
});
