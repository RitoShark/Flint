import { describe, it, expect } from 'vitest';
import { withLayerGhosts } from './layerGhosts';
import type { FileTreeNode } from '../types';
describe('inherited layer tree', () => {
    it('adds referenced files under their layer without mutating the physical tree', () => {
        const tree: FileTreeNode = { name: 'project', path: '.', isDirectory: true, children: [] };
        const result = withLayerGhosts(tree, [{ path: 'content/red/kayn.wad.client/assets/a.tex', source: 'content/base/kayn.wad.client/assets/a.tex', layer: 'red', size: 2 }])!;
        let file = result;
        while (file.children?.length) file = file.children[0];
        expect(file.ghostLayer).toBe('red');
        expect(file.ghostSource).toContain('content/base/');
        expect(file.path).toContain('content/red/');
        expect(tree.children).toEqual([]);
    });
    it('preserves an existing override, including casing', () => {
        const tree: FileTreeNode = { name: '.', path: '.', isDirectory: true, children: [{ name: 'A.tex', path: 'A.tex', isDirectory: false }] };
        const result = withLayerGhosts(tree, [{ path: 'a.tex', source: 'base/a.tex', layer: 'red', size: 2 }])!;
        expect(result.children).toEqual(tree.children);
        expect(result.children![0].ghostSource).toBeUndefined();
    });
});
