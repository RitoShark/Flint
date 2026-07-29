import { describe, it, expect } from 'vitest';
import { PathIndex, normalizeDir } from './pathIndex';
import { UNKNOWN_DIR } from './types';

const rec = (path: string | null, key: string, size?: number) => ({ path, key, size });

describe('normalizeDir', () => {
    it('settles on forward slashes with no leading or trailing separator', () => {
        expect(normalizeDir('data\\characters\\jhin\\')).toBe('data/characters/jhin');
        expect(normalizeDir('/data/characters/')).toBe('data/characters');
        expect(normalizeDir('')).toBe('');
    });
});

describe('PathIndex.list', () => {
    const index = new PathIndex([
        rec('data/characters/jhin/skins/skin0.bin', 'h1', 10),
        rec('data/characters/jhin/skins/skin1.bin', 'h2', 20),
        rec('data/characters/lux/lux.bin', 'h3'),
        rec('assets/loadscreen.tex', 'h4'),
        rec('root.txt', 'h5'),
    ]);

    it('returns only direct children, not the whole subtree', () => {
        const top = index.list('').map((e) => e.name);
        expect(top).toEqual(['assets', 'data', 'root.txt']);
    });

    it('puts folders before files, each alphabetical', () => {
        const entries = index.list('');
        expect(entries.map((e) => e.isDirectory)).toEqual([true, true, false]);
    });

    it('descends one level at a time', () => {
        expect(index.list('data').map((e) => e.name)).toEqual(['characters']);
        expect(index.list('data/characters').map((e) => e.name)).toEqual(['jhin', 'lux']);
        expect(index.list('data/characters/jhin/skins').map((e) => e.name))
            .toEqual(['skin0.bin', 'skin1.bin']);
    });

    it('accepts a path in any separator or slash form', () => {
        expect(index.list('data\\characters\\jhin').map((e) => e.name)).toEqual(['skins']);
        expect(index.list('/data/characters/jhin/').map((e) => e.name)).toEqual(['skins']);
    });

    it('returns an empty list for a directory that does not exist', () => {
        expect(index.list('nope/nowhere')).toEqual([]);
    });

    it('carries size and key through to file entries', () => {
        const [skin0] = index.list('data/characters/jhin/skins');
        expect(skin0).toMatchObject({ key: 'h1', size: 10, isDirectory: false });
        expect(skin0.path).toBe('data/characters/jhin/skins/skin0.bin');
    });
});

describe('PathIndex with unresolved hashes', () => {
    // A chunk whose hash never resolved has no path; it must still be reachable
    // rather than silently dropped from the tree.
    const index = new PathIndex([
        rec('data/real.bin', 'h1'),
        rec(null, 'deadbeef'),
        rec('', 'cafef00d'),
    ]);

    it('collects pathless chunks under one synthetic folder', () => {
        const top = index.list('').map((e) => e.name);
        expect(top).toContain(UNKNOWN_DIR);
        expect(index.list(UNKNOWN_DIR).map((e) => e.name)).toEqual(['cafef00d', 'deadbeef']);
    });

    it('keeps their hash as the backing key', () => {
        const entries = index.list(UNKNOWN_DIR);
        expect(entries.map((e) => e.key)).toEqual(['cafef00d', 'deadbeef']);
    });

    it('counts them among the files', () => {
        expect(index.fileCount).toBe(3);
    });
});

describe('PathIndex.filter', () => {
    const index = new PathIndex([
        rec('data/characters/jhin/skin0.bin', 'h1'),
        rec('data/characters/lux/lux.bin', 'h2'),
        rec('assets/body.tex', 'h3'),
    ]);

    it('returns flat file matches, never directories', () => {
        const hits = index.filter((e) => e.path.includes('characters'));
        expect(hits).toHaveLength(2);
        expect(hits.every((e) => !e.isDirectory)).toBe(true);
    });

    it('sees every file regardless of depth', () => {
        expect(index.filter(() => true)).toHaveLength(3);
    });
});

describe('PathIndex directory synthesis', () => {
    it('creates each intermediate directory exactly once', () => {
        const index = new PathIndex([
            rec('a/b/c/one.txt', 'k1'),
            rec('a/b/c/two.txt', 'k2'),
            rec('a/b/other.txt', 'k3'),
        ]);
        expect(index.list('a').filter((e) => e.name === 'b')).toHaveLength(1);
        expect(index.list('a/b').map((e) => e.name)).toEqual(['c', 'other.txt']);
    });

    it('handles a file at the root with no directory at all', () => {
        const index = new PathIndex([rec('lone.txt', 'k')]);
        expect(index.list('')).toHaveLength(1);
        expect(index.list('')[0].isDirectory).toBe(false);
    });
});
