import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readAnimationMasks, saveAnimationMasks } from './animask';
import { invokeCommand } from './core';

vi.mock('./core', () => ({ invokeCommand: vi.fn() }));

describe('animask api', () => {
    beforeEach(() => vi.mocked(invokeCommand).mockReset());

    it('reads masks for a bin and its skeleton', async () => {
        vi.mocked(invokeCommand).mockResolvedValue({
            masks: [], jointCountMismatch: false, skeletonJointCount: 0,
        });

        await readAnimationMasks('a.bin', 'a.skl');

        expect(invokeCommand).toHaveBeenCalledWith('read_animation_masks', {
            binPath: 'a.bin', sklPath: 'a.skl',
        });
    });

    it('saves masks back to the bin', async () => {
        vi.mocked(invokeCommand).mockResolvedValue(2);
        const masks = [{ key: 1, joints: [] }];

        await expect(saveAnimationMasks('a.bin', masks)).resolves.toBe(2);
        expect(invokeCommand).toHaveBeenCalledWith('save_animation_masks', {
            binPath: 'a.bin', masks,
        });
    });
});
