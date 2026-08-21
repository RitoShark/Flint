import { describe, it, expect } from 'vitest';
import {
    buildTreeNavRows, buildSearchNavRows,
    categoryNavKey, searchWadNavKey, searchFolderKey, makeFileKey,
    flattenTree, flattenSearchResults,
    buildVFSSubtree,
    type FlatRow,
} from './helpers';
import { arrowLeft, arrowRight, stepFocus } from '../../../lib/shortcuts/treeNav';
import type { WadChunk, WadExplorerWad } from '../../../lib/types';

const WAD_PATH = 'C:/wads/kayn.wad.client';

const chunk = (hash: string, path: string): WadChunk => ({ hash, path, size: 1 });

const CHUNKS = [
    chunk('0x1', 'data/characters/kayn/skin0.bin'),
    chunk('0x2', 'data/characters/kayn/skin1.bin'),
];

const WAD: WadExplorerWad = {
    path: WAD_PATH,
    name: 'kayn.wad.client',
    category: 'Champions',
    status: 'loaded',
    chunks: CHUNKS,
};

/** The tree as the explorer actually flattens it, with everything expanded. */
function fullyExpandedRows(): { rows: FlatRow[]; expandedFolders: Set<string> } {
    const subtree = buildVFSSubtree(CHUNKS, WAD_PATH);
    const expandedFolders = new Set([
        `${WAD_PATH}::data`,
        `${WAD_PATH}::data/characters`,
        `${WAD_PATH}::data/characters/kayn`,
    ]);
    const rows = flattenTree(
        [['Champions', [WAD]]],
        new Set(),
        new Set([WAD_PATH]),
        expandedFolders,
        new Map([[WAD_PATH, subtree]]),
    );
    return { rows, expandedFolders };
}

describe('buildTreeNavRows', () => {
    it('nests category above WAD above folder above file', () => {
        const { rows, expandedFolders } = fullyExpandedRows();
        const nav = buildTreeNavRows(rows, new Set(), new Set([WAD_PATH]), expandedFolders);

        const category = nav.find(r => r.path === categoryNavKey('Champions'))!;
        const wad = nav.find(r => r.path === WAD_PATH)!;
        const file = nav.find(r => r.path === makeFileKey(WAD_PATH, '0x1'))!;
        const folders = nav.filter(r => r.isDirectory && r.path !== WAD_PATH && r.path !== category.path);

        expect(category.depth).toBe(0);
        expect(wad.depth).toBe(1);
        for (const f of folders) expect(f.depth).toBeGreaterThan(wad.depth);
        expect(file.depth).toBeGreaterThan(Math.max(...folders.map(f => f.depth)));
    });

    it('walks out of a file to its folder, then up to the WAD and the category', () => {
        const { rows, expandedFolders } = fullyExpandedRows();
        const nav = buildTreeNavRows(rows, new Set(), new Set([WAD_PATH]), expandedFolders);

        let step = arrowLeft(nav, makeFileKey(WAD_PATH, '0x1'));
        expect(step).toEqual({ kind: 'focus', path: `${WAD_PATH}::data/characters/kayn` });

        // The folder is open, so Left closes it before it moves anywhere.
        step = arrowLeft(nav, step!.path);
        expect(step).toEqual({ kind: 'collapse', path: `${WAD_PATH}::data/characters/kayn` });
    });

    it('reports a collapsed WAD as expandable and an open one as steppable', () => {
        const { rows, expandedFolders } = fullyExpandedRows();
        const open = buildTreeNavRows(rows, new Set(), new Set([WAD_PATH]), expandedFolders);
        // Single-child folder chains render as ONE compacted row keyed by the deepest node.
        expect(arrowRight(open, WAD_PATH)).toEqual({ kind: 'focus', path: `${WAD_PATH}::data/characters/kayn` });

        const collapsedRows = flattenTree([['Champions', [WAD]]], new Set(), new Set(), new Set(), new Map());
        const collapsed = buildTreeNavRows(collapsedRows, new Set(), new Set(), new Set());
        expect(arrowRight(collapsed, WAD_PATH)).toEqual({ kind: 'expand', path: WAD_PATH });
    });

    it('skips the status line of a loading WAD so the cursor never lands on it', () => {
        const loading: WadExplorerWad = { ...WAD, status: 'loading', chunks: [] };
        const rows = flattenTree([['Champions', [loading]]], new Set(), new Set([WAD_PATH]), new Set(), new Map());
        expect(rows.some(r => r.kind === 'wad-loading')).toBe(true);

        const nav = buildTreeNavRows(rows, new Set(), new Set([WAD_PATH]), new Set());
        expect(nav.map(r => r.path)).toEqual([categoryNavKey('Champions'), WAD_PATH]);
    });

    it('carries the flat-list index so the cursor can be scrolled to', () => {
        const { rows, expandedFolders } = fullyExpandedRows();
        const nav = buildTreeNavRows(rows, new Set(), new Set([WAD_PATH]), expandedFolders);
        for (const r of nav) expect(rows[r.index]).toBeDefined();
        expect(nav.map(r => r.index)).toEqual([...nav.map(r => r.index)].sort((a, b) => a - b));
    });
});

describe('buildSearchNavRows', () => {
    const GROUPS = [{
        wadPath: WAD_PATH,
        wadName: 'kayn.wad.client',
        totalMatches: 2,
        folders: [{
            folderPath: 'data/characters/kayn',
            files: [
                { chunk: CHUNKS[0], fileName: 'skin0.bin' },
                { chunk: CHUNKS[1], fileName: 'skin1.bin' },
            ],
        }],
    }];

    it('nests result WAD above result folder above match', () => {
        const rows = flattenSearchResults(GROUPS, new Set(), new Set());
        const nav = buildSearchNavRows(rows, new Set(), new Set());

        expect(nav.map(r => r.path)).toEqual([
            searchWadNavKey(WAD_PATH),
            searchFolderKey(WAD_PATH, 'data/characters/kayn'),
            makeFileKey(WAD_PATH, '0x1'),
            makeFileKey(WAD_PATH, '0x2'),
        ]);
        expect(nav.map(r => r.depth)).toEqual([0, 1, 2, 2]);
    });

    it('treats a collapsed result WAD as collapsed', () => {
        const rows = flattenSearchResults(GROUPS, new Set([WAD_PATH]), new Set());
        const nav = buildSearchNavRows(rows, new Set([WAD_PATH]), new Set());

        expect(nav).toHaveLength(1);
        expect(nav[0].isExpanded).toBe(false);
        expect(arrowRight(nav, nav[0].path)).toEqual({ kind: 'expand', path: searchWadNavKey(WAD_PATH) });
    });

    it('moves the cursor down through matches', () => {
        const rows = flattenSearchResults(GROUPS, new Set(), new Set());
        const nav = buildSearchNavRows(rows, new Set(), new Set());

        expect(stepFocus(nav, null, 1)).toBe(searchWadNavKey(WAD_PATH));
        expect(stepFocus(nav, makeFileKey(WAD_PATH, '0x1'), 1)).toBe(makeFileKey(WAD_PATH, '0x2'));
        expect(stepFocus(nav, makeFileKey(WAD_PATH, '0x2'), 1)).toBe(makeFileKey(WAD_PATH, '0x2'));
    });
});
