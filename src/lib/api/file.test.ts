import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renameFile, deleteFile, moveFile } from './file';
import { invokeCommand } from './core';
import { fireOverlayRebuild } from './hashOverlay';

// Verifies the tree-mutation call sites actually invoke the shared debounced
// rebuild trigger — the test that fails if someone removes a trigger while
// touching one of these functions. `./hashOverlay` is mocked (not the real
// implementation) so this only asserts *that* the trigger fires, not how it
// debounces — that behavior is covered by fireOverlayRebuild.test.ts.
vi.mock('./core', () => ({ invokeCommand: vi.fn() }));
vi.mock('./hashOverlay', () => ({ fireOverlayRebuild: vi.fn() }));

describe('file api overlay rebuild triggers', () => {
    beforeEach(() => {
        vi.mocked(invokeCommand).mockReset();
        vi.mocked(fireOverlayRebuild).mockReset();
    });

    it('renameFile triggers an overlay rebuild', async () => {
        vi.mocked(invokeCommand).mockResolvedValue({ old_path: 'a.dds', new_path: 'b.dds', bin_updates: 0 });

        await renameFile('C:\\p', 'a.dds', 'b.dds');

        expect(fireOverlayRebuild).toHaveBeenCalledWith('C:\\p');
    });

    it('deleteFile triggers an overlay rebuild', async () => {
        vi.mocked(invokeCommand).mockResolvedValue(undefined);

        await deleteFile('C:\\p', 'a.dds');

        expect(fireOverlayRebuild).toHaveBeenCalledWith('C:\\p');
    });

    it('moveFile triggers an overlay rebuild', async () => {
        vi.mocked(invokeCommand).mockResolvedValue('folder/a.dds');

        await moveFile('C:\\p', 'a.dds', 'folder');

        expect(fireOverlayRebuild).toHaveBeenCalledWith('C:\\p');
    });
});
