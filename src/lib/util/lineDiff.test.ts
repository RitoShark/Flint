import { describe, expect, it } from 'vitest';
import { simpleLineDiff } from './lineDiff';

describe('simpleLineDiff', () => {
    it('returns null for identical text', () => {
        expect(simpleLineDiff('a\nb\nc', 'a\nb\nc')).toBeNull();
    });

    it('isolates a single edited line with context', () => {
        const a = 'one\ntwo\nthree\nfour\nfive\nsix';
        const b = 'one\ntwo\nthree\nFOUR\nfive\nsix';
        const diff = simpleLineDiff(a, b)!;
        expect(diff.line).toBe(4);
        expect(diff.removed).toEqual(['four']);
        expect(diff.added).toEqual(['FOUR']);
        expect(diff.context_before).toEqual(['two', 'three']);
        expect(diff.context_after).toEqual(['five', 'six']);
    });

    it('handles pure insertion', () => {
        const diff = simpleLineDiff('a\nc', 'a\nb\nc')!;
        expect(diff.removed).toEqual([]);
        expect(diff.added).toEqual(['b']);
        expect(diff.line).toBe(2);
    });

    it('handles pure removal at the end', () => {
        const diff = simpleLineDiff('a\nb\nc', 'a\nb')!;
        expect(diff.removed).toEqual(['c']);
        expect(diff.added).toEqual([]);
    });

    it('caps oversized blocks and reports the cut', () => {
        const a = Array.from({ length: 1000 }, (_, i) => `old${i}`).join('\n');
        const b = 'new';
        const diff = simpleLineDiff(a, b)!;
        expect(diff.removed.length).toBe(200);
        expect(diff.truncated_removed).toBe(800);
        expect(diff.added).toEqual(['new']);
    });
});
