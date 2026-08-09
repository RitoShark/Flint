import { describe, it, expect } from 'vitest';
import { compileQuery, searchText, replaceAll, totalHits } from './binSearch';

const PLAIN = { caseSensitive: false, wholeWord: false, regex: false };

const TEXT = [
    'entries: map[hash,embed] = {',
    '    "Characters/Ahri/Skins/Skin0" = SkinCharacterDataProperties {',
    '        skinScale: f32 = 1.0',
    '        note: string = "skin scale is not skinScale"',
    '    }',
    '}',
].join('\n');

describe('compileQuery', () => {
    it('treats a plain query literally', () => {
        const pattern = compileQuery('f32 = 1.0', PLAIN)!;
        expect(searchText(TEXT, pattern)).toHaveLength(1);
    });

    it('does not let a dot match any character unless regex is on', () => {
        expect(searchText(TEXT, compileQuery('1x0', PLAIN)!)).toHaveLength(0);
        expect(searchText(TEXT, compileQuery('1.0', { ...PLAIN, regex: true })!).length)
            .toBeGreaterThan(0);
    });

    it('is case-insensitive by default and exact when asked', () => {
        expect(searchText(TEXT, compileQuery('skinscale', PLAIN)!)).toHaveLength(2);
        expect(searchText(TEXT, compileQuery('skinscale', { ...PLAIN, caseSensitive: true })!))
            .toHaveLength(0);
    });

    it('bounds a whole-word query at non-word characters', () => {
        const hits = searchText(TEXT, compileQuery('skin', { ...PLAIN, wholeWord: true })!);
        expect(hits).toHaveLength(1);
        expect(hits[0].line).toBe(4);
    });

    it('returns null for an invalid regex instead of throwing', () => {
        expect(compileQuery('[unclosed', { ...PLAIN, regex: true })).toBeNull();
    });

    it('returns null for an empty query', () => {
        expect(compileQuery('', PLAIN)).toBeNull();
    });
});

describe('searchText', () => {
    it('reports 1-based line and column', () => {
        const [hit] = searchText(TEXT, compileQuery('skinScale', { ...PLAIN, caseSensitive: true })!);
        expect(hit.line).toBe(3);
        expect(hit.column).toBe(9);
        expect(hit.length).toBe(9);
    });

    it('trims the preview so indentation does not eat it', () => {
        const [hit] = searchText(TEXT, compileQuery('skinScale', { ...PLAIN, caseSensitive: true })!);
        expect(hit.preview).toBe('skinScale: f32 = 1.0');
    });

    it('finds several matches on one line without looping forever', () => {
        const hits = searchText('a a a', compileQuery('a', PLAIN)!);
        expect(hits).toHaveLength(3);
    });

    it('terminates on a zero-width match', () => {
        expect(searchText('abc', compileQuery('x*', { ...PLAIN, regex: true })!).length)
            .toBeGreaterThan(0);
    });
});

describe('replaceAll', () => {
    it('replaces every match in one pass', () => {
        const out = replaceAll(TEXT, compileQuery('Skin0', PLAIN)!, 'Skin7');
        expect(out).toContain('Skins/Skin7');
        expect(out).not.toContain('Skin0');
    });

    it('supports backreferences for a regex query', () => {
        const pattern = compileQuery('Skins/(Skin\\d+)', { ...PLAIN, regex: true })!;
        expect(replaceAll(TEXT, pattern, 'Chromas/$1')).toContain('Chromas/Skin0');
    });
});

describe('totalHits', () => {
    it('sums across groups', () => {
        expect(totalHits([
            { path: 'a', label: 'a', editable: true, hits: [] },
            { path: 'b', label: 'b', editable: false, hits: [{ line: 1, column: 1, length: 1, preview: '' }] },
        ])).toBe(1);
    });
});
