// @vitest-environment happy-dom
import React from 'react';
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ discover: vi.fn(), layers: vi.fn(), read: vi.fn(), extract: vi.fn(), tree: vi.fn(), setTree: vi.fn(), toast: vi.fn() }));
vi.mock('../../../lib/api', () => ({ discoverProjects: mock.discover, listProjectLayers: mock.layers, readTextFile: mock.read, extractWad: mock.extract, listProjectFiles: mock.tree }));
vi.mock('../../../lib/stores', () => {
    const projects = { openTabs: [{ id: 'tab', projectPath: 'D:/Mods/A', project: { name: 'A' } }], setFileTree: mock.setTree };
    return {
        useProjectTabStore: Object.assign((select: any) => select(projects), { getState: () => projects }),
        useConfigStore: (select: any) => select({ recentProjects: [{ path: 'd:/mods/a', name: 'Duplicate' }], defaultProjectPath: 'D:/Mods' }),
        useNotificationStore: (select: any) => select({ showToast: mock.toast }),
    };
});
vi.mock('../../ui', () => ({ Button: ({ children, variant: _variant, ...props }: any) => React.createElement('button', props, children) }));
import { SendToProjectModal } from './SendToProjectModal';

beforeEach(() => {
    vi.clearAllMocks(); mock.discover.mockResolvedValue([]); mock.read.mockResolvedValue('{}');
    mock.layers.mockResolvedValue([{ name: 'base' }, { name: 'red' }]); mock.extract.mockResolvedValue({ extracted: 2, failed: 0 }); mock.tree.mockResolvedValue({ name: 'Project' });
});
afterEach(cleanup);
const mount = () => render(React.createElement(SendToProjectModal, { request: { wadPath: 'D:/Game/Ahri.wad.client', hashes: ['01', '02'], label: 'particles' }, onClose: vi.fn() }));

it('deduplicates project paths, extracts to the chosen layer, and refreshes open tabs', async () => {
    mount();
    await screen.findByRole('option', { name: 'red' });
    expect(screen.queryByText(/Duplicate/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Target layer'), { target: { value: 'red' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to Project' }));
    await waitFor(() => expect(mock.extract).toHaveBeenCalledWith('D:/Game/Ahri.wad.client', 'D:/Mods/A/content/red/Ahri.wad.client', ['01', '02']));
    await waitFor(() => expect(mock.setTree).toHaveBeenCalledWith('tab', { name: 'Project' }));
});
it('does not extract into a missing recent project', async () => {
    mock.read.mockRejectedValue(new Error('Missing mod.config.json'));
    mount();
    await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: 'Add to Project' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mock.extract).not.toHaveBeenCalled();
});
