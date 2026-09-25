import { describe, expect, it, vi } from 'vitest';
import { invokeCommand } from '../api/core';
import { loadPose, resolveTexturePath } from './native/assets';
import { elfHash } from '../babylon/skeletonBuilder';

vi.mock('../api/core', () => ({ invokeCommand: vi.fn() }));
describe('VFX texture references', () => {
    it('connects native skeleton IDs and animation tracks to the particle pose', async () => {
        vi.mocked(invokeCommand).mockImplementation(async (command, args) => {
            if (command === 'resolve_asset_path') return (args as {assetPath: string}).assetPath;
            if (command === 'read_skl_skeleton') return { bones: [{id: 7, parent_id: -1, name: 'Root', local_translation: [0,0,0], local_rotation: [0,0,0,1], local_scale: [1,1,1], inverse_bind_matrix: [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]}], influences: [7] };
            if (command === 'read_animation') return { fps: 1, frame_count: 2, tracks: [{joint_hash: elfHash('Root'), frames: [{translation: [0,0,0], rotation: [0,0,0,1], scale: [1,1,1]}, {translation: [10,0,0], rotation: [0,0,0,1], scale: [1,1,1]}]}] };
            throw new Error(command);
        });
        const named = (path: string) => ({path, asset: {kind: 'file' as const, path}});
        const pose = await loadPose(named('particle.skl'), named('particle.anm'), 'skin.skn');
        expect([...pose!.influences]).toEqual([0]);
        expect(pose!.worldInto(0, 0.5, new Float32Array(16))[12]).toBe(5);
        expect(pose!.worldInto(0, 1.5, new Float32Array(16))[12]).toBe(5);
    });
    it('resolves a BIN DDS reference against its extracted TEX file', async () => {
        vi.mocked(invokeCommand).mockRejectedValueOnce(new Error('missing DDS')).mockResolvedValueOnce('C:/skin/particle.tex');
        expect(await resolveTexturePath('ASSETS/particle.DDS', 'C:/skin/model.skn')).toBe('C:/skin/particle.tex');
        expect(invokeCommand).toHaveBeenLastCalledWith('resolve_asset_path',{assetPath:'ASSETS/particle.tex',binPath:'C:/skin/model.skn'},{silent:true});
    });
});
