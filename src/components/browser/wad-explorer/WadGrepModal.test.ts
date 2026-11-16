// @vitest-environment happy-dom
import React from 'react';
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ begin: vi.fn(), cancel: vi.fn(), search: vi.fn() }));
vi.mock('../../../lib/api/wadGrep', () => ({ beginWadGrep: api.begin, cancelWadGrep: api.cancel, grepGameWads: api.search }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../../../lib/stores', () => ({ useUxStore: (select: (s: unknown) => unknown) => select({ binEditorSyntaxTheme: 'default' }) }));
vi.mock('../WorkspaceSearch', () => ({ HitRow: ({ onOpen }: { onOpen: () => void }) => React.createElement('button', { onClick: onOpen }, 'Hit') }));
vi.mock('../../ui', () => ({
    Button: ({ children, variant: _variant, size: _size, active: _active, icon: _icon, ...props }: any) => React.createElement('button', props, children),
    Icon: () => React.createElement('span'),
    Checkbox: ({ label, ...props }: any) => React.createElement('label', {}, label, React.createElement('input', { ...props, type: 'checkbox' })),
}));
import { WadGrepModal } from './WadGrepModal';

const empty = { files: [], scanned: 0, failed: 0, unresolved: 0, cancelled: false, truncated: false };
const wads = [{ path: 'Ahri.wad.client', category: 'Champions' }, { path: 'Map11.wad.client', category: 'Maps' }] as any;
const mount = (onOpen = vi.fn(async () => {})) => render(React.createElement(WadGrepModal, { request: { wadPath: 'Ahri.wad.client', query: 'foo' }, wads, onClose: vi.fn(), onOpen }));
beforeEach(() => { vi.clearAllMocks(); api.begin.mockResolvedValue('id'); api.cancel.mockResolvedValue(undefined); api.search.mockResolvedValue(empty); });
afterEach(cleanup);

describe('WAD search lifecycle', () => {
    it('uses the selected scope and searches both Lua formats through one filter', async () => {
        mount();
        fireEvent.change(screen.getByLabelText('Search scope'), { target: { value: 'champions' } });
        fireEvent.click(screen.getByText('Search'));
        await waitFor(() => expect(api.search).toHaveBeenCalledWith('id', ['Ahri.wad.client'], 'foo', { caseSensitive: false, wholeWord: false, regex: false }, ['bin', 'troybin', 'luabin'], false));
        await screen.findByText(/0 matching files/);
    });
    it('cancels a registration that finishes after the modal unmounts', async () => {
        let resolve!: (id: string) => void;
        api.begin.mockReturnValue(new Promise<string>(done => { resolve = done; }));
        const view = mount();
        fireEvent.click(screen.getByText('Search'));
        view.unmount();
        resolve('late-id');
        await waitFor(() => expect(api.cancel).toHaveBeenCalledWith('late-id'));
        expect(api.search).not.toHaveBeenCalled();
    });
    it('stops a running request and reports partial results', async () => {
        let resolve!: (result: typeof empty) => void;
        api.search.mockReturnValue(new Promise<typeof empty>(done => { resolve = done; }));
        mount();
        fireEvent.click(screen.getByText('Search'));
        await waitFor(() => expect(api.search).toHaveBeenCalled());
        fireEvent.click(screen.getByText('Stop'));
        expect(api.cancel).toHaveBeenCalledWith('id');
        resolve({ ...empty, cancelled: true });
        await screen.findByText(/Stopped; partial results/);
    });
});

it('opens the matching WAD chunk at its result line', async () => {
    const file = { wad_path: 'Ahri.wad.client', path: 'data/skin.bin', hash: '01', matches: [{ line: 42, column: 1, length: 3, preview: 'foo' }], extra: 0 };
    api.search.mockResolvedValue({ ...empty, files: [file] });
    const open = vi.fn(async () => {});
    mount(open);
    fireEvent.click(screen.getByText('Search'));
    fireEvent.click(await screen.findByRole('button', { name: /Ahri.wad.client/ }));
    fireEvent.click(await screen.findByRole('button', { name: /data\/skin.bin/ }));
    fireEvent.click(await screen.findByText('Hit'));
    await waitFor(() => expect(open).toHaveBeenCalledWith(file, 42));
});

it('starts large results collapsed and mounts only visible files after opening a WAD', async () => {
    const files = Array.from({ length: 1000 }, (_, index) => ({ wad_path: 'Ahri.wad.client', path: `data/skin${index}.bin`, hash: String(index), matches: [{ line: 1, column: 1, length: 3, preview: 'foo' }], extra: 0 }));
    api.search.mockResolvedValue({ ...empty, files });
    mount();
    fireEvent.click(screen.getByText('Search'));
    const folder = await screen.findByRole('button', { name: /Ahri.wad.client/ });
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('data/skin0.bin')).toBeNull();
    expect(screen.queryByText('Hit')).toBeNull();
    fireEvent.click(folder);
    expect(await screen.findByText('data/skin0.bin')).toBeTruthy();
    expect(screen.queryByText('data/skin999.bin')).toBeNull();
    expect(screen.queryByText('Hit')).toBeNull();
    expect(document.querySelectorAll('.wad-grep__tree-row').length).toBeLessThan(50);
});
