import { describe, it, expect } from 'vitest';
import {
    indexOfPath,
    stepFocus,
    edgeFocus,
    rangeBetween,
    arrowRight,
    arrowLeft,
    typeToFind,
    type NavRow,
} from './treeNav';

function row(path: string, over: Partial<NavRow> = {}): NavRow {
    return {
        path,
        name: path.split('/').pop() ?? path,
        isDirectory: false,
        isExpanded: false,
        depth: path === '.' ? 0 : path.split('/').length,
        ...over,
    };
}

/**
 *  .                       depth 0  (expanded dir)
 *  ├── assets              depth 1  (expanded dir)
 *  │   ├── icon.dds        depth 2
 *  │   └── sprite.dds      depth 2
 *  ├── data                depth 1  (collapsed dir)
 *  └── readme.txt          depth 1
 */
const tree: NavRow[] = [
    row('.', { isDirectory: true, isExpanded: true, depth: 0 }),
    row('assets', { isDirectory: true, isExpanded: true, depth: 1 }),
    row('assets/icon.dds', { depth: 2 }),
    row('assets/sprite.dds', { depth: 2 }),
    row('data', { isDirectory: true, isExpanded: false, depth: 1 }),
    row('readme.txt', { depth: 1 }),
];

describe('indexOfPath', () => {
    it('finds a row', () => {
        expect(indexOfPath(tree, 'data')).toBe(4);
    });

    it('returns -1 for null', () => {
        expect(indexOfPath(tree, null)).toBe(-1);
    });

    it('returns -1 for a path not in the visible rows', () => {
        expect(indexOfPath(tree, 'data/hidden.bin')).toBe(-1);
    });
});

describe('stepFocus', () => {
    it('moves down one row', () => {
        expect(stepFocus(tree, 'assets', 1)).toBe('assets/icon.dds');
    });

    it('moves up one row', () => {
        expect(stepFocus(tree, 'assets', -1)).toBe('.');
    });

    it('clamps at the last row instead of wrapping', () => {
        // Trees clamp; the tab strip wraps. Wrapping a file list is disorienting
        // because there's no visual cue you've jumped to the far end.
        expect(stepFocus(tree, 'readme.txt', 1)).toBe('readme.txt');
    });

    it('clamps at the first row instead of wrapping', () => {
        expect(stepFocus(tree, '.', -1)).toBe('.');
    });

    it('enters at the first row when nothing is focused', () => {
        expect(stepFocus(tree, null, 1)).toBe('.');
    });

    it('returns null for an empty tree', () => {
        expect(stepFocus([], null, 1)).toBeNull();
    });
});

describe('edgeFocus', () => {
    it('finds the first row', () => {
        expect(edgeFocus(tree, 'first')).toBe('.');
    });

    it('finds the last row', () => {
        expect(edgeFocus(tree, 'last')).toBe('readme.txt');
    });

    it('returns null for an empty tree', () => {
        expect(edgeFocus([], 'first')).toBeNull();
    });
});

describe('rangeBetween', () => {
    it('includes both endpoints going down', () => {
        expect(rangeBetween(tree, 'assets', 'data'))
            .toEqual(['assets', 'assets/icon.dds', 'assets/sprite.dds', 'data']);
    });

    it('includes both endpoints going up', () => {
        expect(rangeBetween(tree, 'data', 'assets'))
            .toEqual(['assets', 'assets/icon.dds', 'assets/sprite.dds', 'data']);
    });

    it('is a single path when anchor equals target', () => {
        expect(rangeBetween(tree, 'data', 'data')).toEqual(['data']);
    });

    it('is empty when either end is missing', () => {
        expect(rangeBetween(tree, 'nope', 'data')).toEqual([]);
    });
});

describe('arrowRight', () => {
    it('expands a collapsed folder', () => {
        expect(arrowRight(tree, 'data')).toEqual({ kind: 'expand', path: 'data' });
    });

    it('descends into an already-expanded folder', () => {
        expect(arrowRight(tree, 'assets')).toEqual({ kind: 'focus', path: 'assets/icon.dds' });
    });

    it('does nothing on a file', () => {
        expect(arrowRight(tree, 'readme.txt')).toBeNull();
    });

    it('does nothing on an expanded folder with no visible children', () => {
        const leafDir = [row('empty', { isDirectory: true, isExpanded: true, depth: 1 })];
        expect(arrowRight(leafDir, 'empty')).toBeNull();
    });
});

describe('arrowLeft', () => {
    it('collapses an expanded folder', () => {
        expect(arrowLeft(tree, 'assets')).toEqual({ kind: 'collapse', path: 'assets' });
    });

    it('ascends to the parent from a file', () => {
        expect(arrowLeft(tree, 'assets/icon.dds')).toEqual({ kind: 'focus', path: 'assets' });
    });

    it('ascends to the parent from a collapsed folder', () => {
        expect(arrowLeft(tree, 'data')).toEqual({ kind: 'focus', path: '.' });
    });

    it('collapses the expanded root, folding the whole tree', () => {
        expect(arrowLeft(tree, '.')).toEqual({ kind: 'collapse', path: '.' });
    });

    it('does nothing on a top-level row with no parent and nothing to collapse', () => {
        const collapsedRoot = [row('.', { isDirectory: true, isExpanded: false, depth: 0 })];
        expect(arrowLeft(collapsedRoot, '.')).toBeNull();
    });
});

describe('typeToFind', () => {
    it('matches the next row by name prefix', () => {
        expect(typeToFind(tree, 're', null)).toBe('readme.txt');
    });

    it('is case-insensitive', () => {
        expect(typeToFind(tree, 'RE', null)).toBe('readme.txt');
    });

    it('searches forward from the current row', () => {
        expect(typeToFind(tree, 's', 'assets')).toBe('assets/sprite.dds');
    });

    it('wraps to the start when nothing matches below', () => {
        expect(typeToFind(tree, 'as', 'readme.txt')).toBe('assets');
    });

    it('returns null when nothing matches', () => {
        expect(typeToFind(tree, 'zzz', null)).toBeNull();
    });

    it('returns null for an empty buffer', () => {
        expect(typeToFind(tree, '', null)).toBeNull();
    });
});
