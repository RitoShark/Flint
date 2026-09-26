import { describe, expect, it } from 'vitest';
import type { CdnTreeNode, CdnWadChunk } from '../../lib/api/cdn';
import { searchManifestTree } from './manifestSearch';

const wad: CdnTreeNode = { name: 'Map11.wad.client', path: 'DATA/FINAL/Maps/Map11.wad.client', size: 100, is_dir: false, file_index: 0, children: [] };
const other: CdnTreeNode = { ...wad, name: 'Aatrox.wad.client', path: 'DATA/FINAL/Champions/Aatrox.wad.client', file_index: 1 };
const root: CdnTreeNode = { name: '', path: '', size: 200, is_dir: true, file_index: null, children: [wad, other] };
const entries: CdnWadChunk[] = [
    { hash: '0xabc', path: 'assets/sounds/bloom_audio.bnk', size: 10 },
    { hash: '0xdef', path: 'assets/maps/ground.tex', size: 20 },
];

describe('manifest tree search', () => {
    it('finds loaded inner files and preserves their WAD and ancestor rows', () => {
        const result = searchManifestTree(root, new Map([[0, entries]]), 'BLOOM_AUDIO');
        expect([...result.paths]).toEqual([wad.path, '']);
        expect(result.wadChunks.get(0)).toEqual([entries[0]]);
    });
    it('finds WAD paths before their contents have loaded', () => {
        expect(searchManifestTree(root, new Map(), 'final\\maps').paths.has(wad.path)).toBe(true);
    });
    it('keeps all contents when the archive path matches', () => {
        expect(searchManifestTree(root, new Map([[0, entries]]), 'map11').wadChunks.get(0)).toEqual(entries);
    });
    it('matches unresolved hashes and restores all rows when cleared', () => {
        const loaded = new Map([[0, [{ ...entries[0], path: null }]]]);
        expect(searchManifestTree(root, loaded, 'ABC').wadChunks.get(0)).toHaveLength(1);
        expect(searchManifestTree(root, loaded, '').paths.size).toBe(3);
        expect(searchManifestTree(root, loaded, 'missing').paths.size).toBe(0);
    });
});
