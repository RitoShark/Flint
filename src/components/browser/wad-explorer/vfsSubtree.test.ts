import { describe, it, expect } from 'vitest';
import { buildVFSSubtree, type VFSFolder, type VFSNode } from './helpers';
import type { WadChunk } from '../../../lib/types';

const chunk = (hash: string, path: string | null, size = 1): WadChunk => ({ hash, path, size });

function folder(nodes: VFSNode[], name: string): VFSFolder {
    const found = nodes.find(n => n.type === 'folder' && n.name.startsWith(name));
    if (!found || found.type !== 'folder') throw new Error(`no folder ${name} in ${nodes.map(n => n.name)}`);
    return found;
}

/**
 * The explorer materialises the whole subtree because it feeds a virtualised
 * list, but the ARRANGEMENT comes from the shared PathIndex so it matches the
 * WAD browser rather than ordering things its own way.
 */
describe('buildVFSSubtree', () => {
    it('nests chunks by path and keys rows per WAD', () => {
        const nodes = buildVFSSubtree([
            chunk('a', 'data/characters/kayn/skin0.bin'),
        ], 'C:/wads/kayn.wad.client');

        const data = folder(nodes, 'data');
        expect(data.key).toBe('C:/wads/kayn.wad.client::data');

        const characters = folder(data.children, 'characters');
        const kayn = folder(characters.children, 'kayn');
        expect(kayn.children).toHaveLength(1);
        expect(kayn.children[0]).toMatchObject({ type: 'file', name: 'skin0.bin' });
    });

    it('orders folders before files, each alphabetically', () => {
        const nodes = buildVFSSubtree([
            chunk('a', 'zeta.txt'),
            chunk('b', 'alpha.txt'),
            chunk('c', 'zfolder/inner.txt'),
            chunk('d', 'afolder/inner.txt'),
        ], 'w');

        expect(nodes.map(n => n.name)).toEqual(['afolder', 'zfolder', 'alpha.txt', 'zeta.txt']);
    });

    it('collects unresolved chunks under one folder, labelled with the count', () => {
        const nodes = buildVFSSubtree([
            chunk('deadbeef', null),
            chunk('feedface', null),
            chunk('c', 'data/real.bin'),
        ], 'w');

        const unknown = folder(nodes, '[Unknown Hashes]');
        expect(unknown.name).toBe('[Unknown Hashes] (2)');
        expect(unknown.key).toBe('w::__unknown__');
        // Nothing to name them by but their hash.
        expect(unknown.children.map(n => n.name).sort()).toEqual(['deadbeef', 'feedface']);
    });

    it('carries the owning WAD on every file so a merged tree stays traceable', () => {
        const nodes = buildVFSSubtree([chunk('a', 'x/y.bin')], 'C:/wads/one.wad.client');
        const x = folder(nodes, 'x');
        expect(x.children[0]).toMatchObject({ type: 'file', wadPath: 'C:/wads/one.wad.client' });
    });

    it('returns nothing for an empty WAD', () => {
        expect(buildVFSSubtree([], 'w')).toEqual([]);
    });
});
