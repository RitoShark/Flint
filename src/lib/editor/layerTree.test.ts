import { describe, it, expect } from 'vitest';
import type { LayerFile } from '../api';
import { buildLayerTree, selectionPrefix, rangeState, indexState } from './layerTree';

function file(path: string, size = 1, category: LayerFile['category'] = 'other'): LayerFile {
    return { path, size, category };
}

describe('buildLayerTree', () => {
    it('gives every directory a contiguous range over its own files', () => {
        const tree = buildLayerTree([
            file('wad/assets/a.tex'),
            file('wad/data/b.bin'),
            file('wad/assets/deep/c.tex'),
            file('root.txt'),
        ]);

        const assets = tree.rows.find((r) => r.path === 'wad/assets')!;
        const covered = tree.files.slice(assets.start, assets.end).map((f) => f.path);
        expect(covered.sort()).toEqual(['wad/assets/a.tex', 'wad/assets/deep/c.tex']);

        const wad = tree.rows.find((r) => r.path === 'wad')!;
        expect(wad.end - wad.start).toBe(3);
    });

    it('sums directory bytes from its descendants', () => {
        const tree = buildLayerTree([
            file('wad/a.tex', 100),
            file('wad/deep/b.tex', 250),
            file('loose.txt', 7),
        ]);
        expect(tree.rows.find((r) => r.path === 'wad')!.bytes).toBe(350);
        expect(tree.rows.find((r) => r.path === 'wad/deep')!.bytes).toBe(250);
    });

    it('lists directories before the files that sit beside them', () => {
        const tree = buildLayerTree([file('wad/z.tex'), file('wad/sub/a.tex')]);
        const inWad = tree.rows.filter((r) => r.depth === 1).map((r) => r.name);
        expect(inWad).toEqual(['sub', 'z.tex']);
    });

    it('indexes files by category', () => {
        const tree = buildLayerTree([
            file('a.anm', 1, 'animation'),
            file('b.skn', 1, 'model'),
            file('c.anm', 1, 'animation'),
        ]);
        expect(tree.byCategory.animation).toHaveLength(2);
        expect(tree.byCategory.model).toHaveLength(1);
        expect(tree.byCategory.audio).toEqual([]);
    });
});

describe('check states', () => {
    it('reads off, partial and on from a range', () => {
        const prefix = selectionPrefix(Uint8Array.from([1, 1, 0, 0]));
        expect(rangeState(prefix, 0, 2)).toBe('on');
        expect(rangeState(prefix, 2, 4)).toBe('off');
        expect(rangeState(prefix, 0, 4)).toBe('partial');
    });

    it('treats an empty range as off', () => {
        const prefix = selectionPrefix(new Uint8Array(4));
        expect(rangeState(prefix, 2, 2)).toBe('off');
    });

    it('reads the same states from a scattered index list', () => {
        const prefix = selectionPrefix(Uint8Array.from([1, 0, 1, 0]));
        expect(indexState(prefix, [0, 2])).toBe('on');
        expect(indexState(prefix, [1, 3])).toBe('off');
        expect(indexState(prefix, [0, 1])).toBe('partial');
        expect(indexState(prefix, [])).toBe('off');
    });
});
