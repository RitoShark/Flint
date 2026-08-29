import { describe, expect, it } from 'vitest';
import { diffLines, type DiffRow } from './lineDiff';

const texts = (rows: DiffRow[], op: DiffRow['op']) => rows.filter((r) => r.op === op).map((r) => r.text);

describe('diffLines', () => {
    it('returns null for identical text', () => {
        expect(diffLines('a\nb\nc', 'a\nb\nc')).toBeNull();
    });

    it('ignores a trailing-newline-only difference in line count', () => {
        expect(diffLines('a\nb\n', 'a\nb')).toBeNull();
    });

    it('isolates a single edited line with context', () => {
        const a = 'one\ntwo\nthree\nfour\nfive\nsix';
        const b = 'one\ntwo\nthree\nFOUR\nfive\nsix';
        const diff = diffLines(a, b)!;
        expect(diff.hunks).toHaveLength(1);
        const rows = diff.hunks[0].rows;
        expect(texts(rows, 'del')).toEqual(['four']);
        expect(texts(rows, 'add')).toEqual(['FOUR']);
        expect(rows[0].text).toBe('one');
        expect(rows[rows.length - 1].text).toBe('six');
        expect(diff.added).toBe(1);
        expect(diff.removed).toBe(1);
    });

    it('reports every changed region, not just the first', () => {
        const a = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n');
        const b = a.split('\n').map((l, i) => (i === 2 || i === 40 ? `${l}!` : l)).join('\n');
        const diff = diffLines(a, b)!;
        expect(diff.hunks).toHaveLength(2);
        expect(diff.added).toBe(2);
        expect(diff.removed).toBe(2);
        expect(diff.hunks[1].aStart).toBeGreaterThan(30);
    });

    it('merges changes that share context into one hunk', () => {
        const a = 'a\nb\nc\nd\ne\nf\ng';
        const b = 'a\nB\nc\nd\nE\nf\ng';
        const diff = diffLines(a, b)!;
        expect(diff.hunks).toHaveLength(1);
    });

    it('numbers both sides independently across an insertion', () => {
        const diff = diffLines('a\nc', 'a\nb\nc')!;
        const rows = diff.hunks[0].rows;
        expect(rows.map((r) => [r.op, r.a, r.b])).toEqual([
            ['ctx', 1, 1],
            ['add', null, 2],
            ['ctx', 2, 3],
        ]);
    });

    it('handles pure removal at the end', () => {
        const diff = diffLines('a\nb\nc', 'a\nb')!;
        expect(texts(diff.hunks[0].rows, 'del')).toEqual(['c']);
        expect(diff.added).toBe(0);
    });

    it('falls back to a coarse replacement past the distance ceiling', () => {
        const a = Array.from({ length: 400 }, (_, i) => `old${i}`).join('\n');
        const b = Array.from({ length: 400 }, (_, i) => `new${i}`).join('\n');
        const diff = diffLines(a, b, { maxDistance: 8 })!;
        expect(diff.coarse).toBe(true);
        expect(diff.removed).toBe(400);
        expect(diff.added).toBe(400);
    });

    it('caps the rows it emits and reports the dropped hunks', () => {
        const a = Array.from({ length: 300 }, (_, i) => `line${i}`).join('\n');
        const b = a.split('\n').map((l, i) => (i % 10 === 0 ? `${l}!` : l)).join('\n');
        const diff = diffLines(a, b, { maxRows: 40 })!;
        expect(diff.truncatedHunks).toBeGreaterThan(0);
        expect(diff.hunks.reduce((n, h) => n + h.rows.length, 0)).toBeLessThanOrEqual(40 + 8);
    });
});

describe('diffLines whole', () => {
    it('returns one hunk covering every line', () => {
        const a = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
        const b = a.split('\n').map((l, i) => (i === 7 ? `${l}!` : l)).join('\n');
        const diff = diffLines(a, b, { whole: true })!;
        expect(diff.hunks).toHaveLength(1);
        expect(diff.hunks[0].rows).toHaveLength(51);
        expect(diff.hunks[0].aStart).toBe(1);
        expect(diff.truncatedHunks).toBe(0);
        expect(diff.added).toBe(1);
        expect(diff.removed).toBe(1);
    });

    it('ignores the row cap — everything means everything', () => {
        const a = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n');
        const b = a.split('\n').map((l, i) => (i % 10 === 0 ? `${l}!` : l)).join('\n');
        const diff = diffLines(a, b, { whole: true, maxRows: 40 })!;
        expect(diff.hunks[0].rows.length).toBe(550);
    });
});
