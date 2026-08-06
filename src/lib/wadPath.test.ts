import { describe, it, expect } from 'vitest';
import { wadInternalPath, copyablePath } from './wadPath';

describe('wadInternalPath', () => {
    it('strips the layered content prefix', () => {
        expect(
            wadInternalPath('content/base/Aatrox.wad.client/assets/characters/aatrox/skins/base/aatrox.tex')
        ).toBe('assets/characters/aatrox/skins/base/aatrox.tex');
    });

    it('strips the legacy unlayered prefix', () => {
        expect(wadInternalPath('content/Aatrox.wad.client/data/characters/aatrox/aatrox.bin')).toBe(
            'data/characters/aatrox/aatrox.bin'
        );
    });

    it('handles backslash separators', () => {
        expect(wadInternalPath('content\\base\\Aatrox.wad.client\\assets\\foo.tex')).toBe('assets/foo.tex');
    });

    it('matches the wad segment case-insensitively', () => {
        expect(wadInternalPath('content/base/Aatrox.WAD.CLIENT/assets/foo.tex')).toBe('assets/foo.tex');
    });

    it('keeps nested layer folders out of the result', () => {
        expect(wadInternalPath('content/custom_layer/Map11.wad.client/assets/maps/a.tex')).toBe(
            'assets/maps/a.tex'
        );
    });

    it('returns null for the wad folder itself', () => {
        expect(wadInternalPath('content/base/Aatrox.wad.client')).toBeNull();
    });

    it('returns null outside content/', () => {
        expect(wadInternalPath('flint.json')).toBeNull();
        expect(wadInternalPath('meta/info.json')).toBeNull();
    });

    it('returns null for content paths with no wad folder', () => {
        expect(wadInternalPath('content/base/README.txt')).toBeNull();
    });
});

describe('copyablePath', () => {
    it('yields the in-wad path when there is one', () => {
        expect(copyablePath('content/base/Aatrox.wad.client/assets/foo.tex')).toBe('assets/foo.tex');
    });

    it('falls back to the project-relative path', () => {
        expect(copyablePath('flint.json')).toBe('flint.json');
    });

    it('normalises separators in the fallback', () => {
        expect(copyablePath('content\\base\\notes.txt')).toBe('content/base/notes.txt');
    });
});
