import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildProjectHashOverlay, clearProjectHashOverlay } from './hashOverlay';
import { invokeCommand } from './core';

vi.mock('./core', () => ({ invokeCommand: vi.fn() }));

describe('hashOverlay api', () => {
    beforeEach(() => vi.mocked(invokeCommand).mockReset());

    it('builds the overlay for a project path', async () => {
        vi.mocked(invokeCommand).mockResolvedValue({ wad_entries: 12 });

        const stats = await buildProjectHashOverlay('C:\\p');

        expect(invokeCommand).toHaveBeenCalledWith('build_project_hash_overlay', {
            projectPath: 'C:\\p',
        });
        expect(stats.wad_entries).toBe(12);
    });

    it('clears the overlay', async () => {
        vi.mocked(invokeCommand).mockResolvedValue(undefined);

        await clearProjectHashOverlay();

        expect(invokeCommand).toHaveBeenCalledWith('clear_project_hash_overlay', undefined);
    });
});
