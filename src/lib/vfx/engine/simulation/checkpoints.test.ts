import { describe, expect, it, vi } from 'vitest';
import { createCheckpoints } from './checkpoints';

describe('bounded particle seek snapshots', () => {
    it('drops an oversized capture without evicting usable history', () => {
        const cache = createCheckpoints(4, 100);
        cache.keep(2, 20, () => ({step: 2, bytes: 20}));
        cache.keep(4, 20, () => ({step: 4, bytes: 200}));
        expect(cache.bytes).toBe(20);
        expect(cache.latest(4, 4)?.step).toBe(2);
    });

    it('budgets against actual capture sizes and preserves the incoming snapshot', () => {
        const cache = createCheckpoints(8, 80);
        for (let mark = 1; mark <= 8; mark++) {
            cache.keep(mark, 1, () => ({step: mark, bytes: 40}));
            expect(cache.bytes).toBeLessThanOrEqual(80);
            expect(cache.latest(mark, mark)?.step).toBe(mark);
        }
    });

    it('rejects invalid marks and sizes before allocating a snapshot', () => {
        const cache = createCheckpoints(4, 20);
        const capture = vi.fn(() => ({step: 1, bytes: 1}));
        for (const mark of [NaN, Infinity, -1, 0, 1.5, 5]) {
            expect(cache.wants(mark)).toBe(false);
            cache.keep(mark, 1, capture);
        }
        for (const bytes of [NaN, Infinity, -1, 21]) cache.keep(1, bytes, capture);
        expect(capture).not.toHaveBeenCalled();
    });

    it('supports zero-byte snapshots without an unbounded eviction loop', () => {
        const cache = createCheckpoints(2, 0);
        cache.keep(1, 0, () => ({step: 10, bytes: 0}));
        cache.keep(2, 0, () => ({step: 20, bytes: 0}));
        expect(cache.latest(2, 20)?.step).toBe(20);
        expect(cache.bytes).toBe(0);
    });

    it('leaves history intact when capture throws', () => {
        const cache = createCheckpoints(2, 20);
        cache.keep(1, 10, () => ({step: 1, bytes: 10}));
        expect(() => cache.keep(2, 20, () => {throw new Error('capture failed');})).toThrow('capture failed');
        expect(cache.latest(2, 2)?.step).toBe(1);
    });
});
