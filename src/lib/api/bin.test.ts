import { beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceInBins } from './bin';
import { invokeCommand } from './core';
import { useAppMetadataStore } from '../stores/appMetadataStore';

vi.mock('./core', () => ({ invokeCommand: vi.fn() }));

const options = { caseSensitive: false, wholeWord: false, regex: false };

describe('Replace All refresh', () => {
    beforeEach(() => vi.mocked(invokeCommand).mockReset());

    it('invalidates the open BIN without a watcher event', async () => {
        const path = 'C:/project/content/open.bin';
        const store = useAppMetadataStore.getState();
        const before = store.getFileVersion(path);
        const result = { files_changed: 1, changed_paths: [path], replacements: 2, failed: [] };
        vi.mocked(invokeCommand).mockResolvedValue(result);

        await expect(replaceInBins([path], 'old', 'new', options)).resolves.toEqual(result);

        expect(store.getFileVersion('C:\\project\\content\\open.bin')).toBe(before + 1);
        expect(store.getFileStatus(path)).toBe('modified');
    });

    it('refreshes successful linked BINs but leaves failed and unmatched files alone', async () => {
        const paths = ['C:/linked/new.bin', 'C:/project/failed.bin', 'C:/project/no-match.bin'];
        const store = useAppMetadataStore.getState();
        const before = paths.map((path) => store.getFileVersion(path));
        store.setFileStatus(paths[0], 'new');
        vi.mocked(invokeCommand).mockResolvedValue({
            files_changed: 1, changed_paths: [paths[0]], replacements: 1,
            failed: [`${paths[1]}: invalid BIN`],
        });

        await replaceInBins(paths, 'old', 'new', options);

        expect(paths.map((path) => store.getFileVersion(path))).toEqual([before[0] + 1, before[1], before[2]]);
        expect(store.getFileStatus(paths[0])).toBe('new');
    });

    it('does not invalidate files when nothing was replaced', async () => {
        const before = useAppMetadataStore.getState().fileVersionsRev;
        vi.mocked(invokeCommand).mockResolvedValue({
            files_changed: 0, changed_paths: [], replacements: 0, failed: [],
        });

        await replaceInBins(['C:/project/unchanged.bin'], 'old', 'new', options);

        expect(useAppMetadataStore.getState().fileVersionsRev).toBe(before);
    });
});
