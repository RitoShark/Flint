import { describe, expect, it } from 'vitest';
import { flattenWadMatches, groupWadMatches, grepFileKey } from './wadGrepTree';
import type { WadGrepFile } from '../../../lib/api/wadGrep';

const file = (wad: string, hash: string): WadGrepFile => ({ wad_path: wad, path: `data/${hash}.bin`, hash, matches: [{ line: 42, column: 2, length: 3, preview: 'foo' }], extra: 2 });
describe('WAD result hierarchy', () => {
    it('groups by full WAD path without merging identically named archives', () => {
        const groups = groupWadMatches([file('live/Ahri.wad.client', '1'), file('pbe/Ahri.wad.client', '1'), file('live/Ahri.wad.client', '2')]);
        expect(groups.map(g => [g.files.length, g.matches])).toEqual([[2, 6], [1, 3]]);
        expect(flattenWadMatches(groups, new Set(), new Set())).toHaveLength(2);
    });
    it('only includes hits after both the WAD and file are expanded', () => {
        const source = file('Ahri.wad.client', '1');
        const groups = groupWadMatches([source]);
        const openFiles = new Set([grepFileKey(source)]);
        expect(flattenWadMatches(groups, new Set(), openFiles).map(r => r.kind)).toEqual(['wad']);
        expect(flattenWadMatches(groups, new Set(['Ahri.wad.client']), new Set()).map(r => r.kind)).toEqual(['wad', 'file']);
        expect(flattenWadMatches(groups, new Set(['Ahri.wad.client']), openFiles).map(r => r.kind)).toEqual(['wad', 'file', 'hit']);
    });
});
