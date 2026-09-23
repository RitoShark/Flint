import { describe, expect, it } from 'vitest';
import { projectFilePath, rubyBinCandidates, rubyBinLabel } from './rubyTargets';
import type { FileTreeNode } from './types';

function tree(paths: string[]): FileTreeNode {
    return {
        name: '',
        path: '',
        isDirectory: true,
        children: paths.map((path) => ({ name: path.split('/').pop()!, path, isDirectory: false })),
    };
}

const W = 'content/base/Ahri.wad.client';

describe('rubyBinCandidates', () => {
    it('offers skin and map bins only, in natural order', () => {
        const got = rubyBinCandidates(tree([
            `${W}/data/characters/ahri/skins/skin10.bin`,
            `${W}/data/characters/ahri/skins/skin2.bin`,
            `${W}/data/characters/ahri/animations/skin2.bin`,
            `${W}/data/characters/ahri/ahri.bin`,
            `${W}/data/ahri_skins_skin2_concat.bin`,
            'content/base/Map11.wad.client/data/maps/shipping/map11/map11.bin',
            'content/base/Map11.wad.client/data/maps/mapgeometry/map11/base_srx.materials.bin',
        ]));
        expect(got).toEqual([
            `${W}/data/characters/ahri/skins/skin2.bin`,
            `${W}/data/characters/ahri/skins/skin10.bin`,
            'content/base/Map11.wad.client/data/maps/shipping/map11/map11.bin',
        ]);
    });

    it('falls back to every non-animation bin', () => {
        const got = rubyBinCandidates(tree([
            `${W}/data/custom/effects.bin`,
            `${W}/data/characters/ahri/animations/skin0.bin`,
        ]));
        expect(got).toEqual([`${W}/data/custom/effects.bin`]);
    });

    it('handles backslashes, no tree, and no bins', () => {
        expect(rubyBinCandidates(tree([`${W}\\data\\characters\\ahri\\skins\\skin0.bin`])))
            .toEqual([`${W}/data/characters/ahri/skins/skin0.bin`]);
        expect(rubyBinCandidates(null)).toEqual([]);
        expect(rubyBinCandidates(tree([`${W}/assets/a.tex`]))).toEqual([]);
    });
});

describe('labels and paths', () => {
    it('name the file and its place in the WAD', () => {
        expect(rubyBinLabel(`${W}/data/characters/ahri/skins/skin2.bin`))
            .toEqual({ name: 'skin2.bin', where: 'data/characters/ahri/skins' });
        expect(rubyBinLabel('loose/x.bin')).toEqual({ name: 'x.bin', where: 'loose' });
    });

    it('build the Windows path RubyRe gets', () => {
        expect(projectFilePath('C:/Projects/Ahri', `${W}/data/x.bin`))
            .toBe('C:\\Projects\\Ahri\\content\\base\\Ahri.wad.client\\data\\x.bin');
    });
});
