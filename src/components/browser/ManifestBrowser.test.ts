// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManifestBrowser } from './ManifestBrowser';
import { useCdnManifestStore } from '../../lib/stores/cdnManifestStore';

const mocks = vi.hoisted(() => ({
    begin: vi.fn(), abort: vi.fn(), unpack: vi.fn(), raw: vi.fn(), toast: vi.fn(),
    menu: vi.fn(), listen: vi.fn(), unlisten: vi.fn(), inner: vi.fn(), saveBytes: vi.fn(),
}));
vi.mock('../../lib/api', () => ({
    cdnBeginDownload: mocks.begin, cdnAbortDownload: mocks.abort,
    cdnExtractWadUnpacked: mocks.unpack, cdnDownloadWadRaw: mocks.raw,
    cdnReadInner: mocks.inner, saveFileBytes: mocks.saveBytes,
}));
vi.mock('../../lib/api/dialog', () => ({ open: async () => 'output', save: async () => 'output/map.wad.client' }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../../lib/stores', () => ({
    useNavigationStore: (select: Function) => select({ activeManifestId: 'session' }),
    useNotificationStore: (select: Function) => select({ showToast: mocks.toast }),
    useModalStore: (select: Function) => select({ openContextMenu: mocks.menu }),
}));
vi.mock('./wad-explorer/ChunkPreview', () => ({ ChunkPreview: () => null }));
vi.mock('./wad-explorer/dataSource', () => ({ cdnWadSource: vi.fn() }));
vi.mock('../../lib/ui-helpers/fileIcons', () => ({ getIcon: () => '' }));

function pending<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

beforeEach(() => {
    vi.resetAllMocks();
    mocks.begin.mockResolvedValue('download-1');
    mocks.abort.mockResolvedValue(undefined);
    mocks.listen.mockResolvedValue(mocks.unlisten);
    useCdnManifestStore.setState({ sessions: {} });
    useCdnManifestStore.getState().addSession({
        sessionId: 'session', label: 'Map files', region: 'EUW1', fileCount: 1,
        tree: { name: '', path: '', size: 0, is_dir: true, file_index: null, children: [
            { name: 'map.wad.client', path: 'map.wad.client', size: 123, is_dir: false, file_index: 0, children: [] },
        ] },
        expandedFolders: new Set(), expandedWads: new Set(), searchQuery: '',
        checkedFiles: new Set(), selected: null, wadInner: new Map(),
    });
});
afterEach(cleanup);

it('aborts unpacking, waits for cleanup and allows a new download', async () => {
    const work = pending<{ files: number; errors: number }>();
    mocks.unpack.mockReturnValue(work.promise);
    render(React.createElement(ManifestBrowser));
    fireEvent.click(screen.getByText('Extract'));
    await waitFor(() => expect(mocks.unpack).toHaveBeenCalledWith('session', 0, 'output', 'download-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Abort' }));
    await waitFor(() => expect(mocks.abort).toHaveBeenCalledWith('download-1'));
    expect((screen.getByRole('button', { name: 'Aborting…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { work.reject('CDN error: Download aborted'); });
    expect(screen.queryByRole('button', { name: 'Abort' })).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith('info', 'Download aborted');
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    mocks.begin.mockResolvedValue('download-2');
    mocks.unpack.mockResolvedValue({ files: 2, errors: 0 });
    fireEvent.click(screen.getByText('Extract'));
    await waitFor(() => expect(mocks.unpack).toHaveBeenCalledWith('session', 0, 'output', 'download-2'));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('success', 'Unpacked 2 files from map.wad.client'));
});

it('handles Abort before download registration finishes', async () => {
    const registration = pending<string>();
    mocks.begin.mockReturnValue(registration.promise);
    render(React.createElement(ManifestBrowser));
    fireEvent.click(screen.getByText('Extract'));
    fireEvent.click(await screen.findByRole('button', { name: 'Abort' }));
    await act(async () => { registration.resolve('late-download'); });
    expect(mocks.abort).toHaveBeenCalledWith('late-download');
    expect(mocks.unpack).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Aborting…' })).toBeNull();
});

it('aborts raw downloads when the browser unmounts', async () => {
    const work = pending<number>();
    mocks.raw.mockReturnValue(work.promise);
    const view = render(React.createElement(ManifestBrowser));
    fireEvent.contextMenu(screen.getByText('map.wad.client'));
    const items = mocks.menu.mock.calls[0][2];
    await act(async () => { void items.find((item: { label: string }) => item.label.startsWith('Download WAD')).onClick(); });
    await waitFor(() => expect(mocks.raw).toHaveBeenCalledWith('session', 0, 'output/map.wad.client', 'download-1'));
    view.unmount();
    expect(mocks.abort).toHaveBeenCalledWith('download-1');
    await act(async () => { work.reject('Download aborted'); });
    expect(mocks.toast).not.toHaveBeenCalledWith('success', expect.anything());
});

it('does not save inner-file bytes arriving after Abort', async () => {
    useCdnManifestStore.getState().update('session', {
        expandedWads: new Set(['map.wad.client']),
        wadInner: new Map([[0, [{ hash: '0x01', path: 'asset.bin', size: 4 }]]]),
    });
    const work = pending<ArrayBuffer>();
    mocks.inner.mockReturnValue(work.promise);
    render(React.createElement(ManifestBrowser));
    fireEvent.click(screen.getByTitle('Extract this file'));
    await waitFor(() => expect(mocks.inner).toHaveBeenCalledWith('session', 0, '0x01', 'download-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Abort' }));
    await act(async () => { work.resolve(new ArrayBuffer(4)); });
    expect(mocks.saveBytes).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('info', 'Download aborted');
});
