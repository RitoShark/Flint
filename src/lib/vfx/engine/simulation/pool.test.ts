import { describe, expect, it } from 'vitest';
import { copyRows, createPool, liveByteLength, retire, rowsByteLength, spawn, writeRows } from './pool';

describe('particle storage snapshots', () => {
    it('accounts for empty pools without dividing by capacity', () => {
        const pool = createPool(0);
        expect(spawn(pool, 0, 0, 1, 0)).toBeNull();
        expect(liveByteLength(pool)).toBe(0);
        expect(rowsByteLength(copyRows(pool))).toBe(0);
        writeRows(pool, copyRows(pool));
        expect(pool.count).toBe(0);
    });

    it('restores all particle channels without replacing renderer buffers', () => {
        const pool = createPool(4);
        spawn(pool, 2, 3, 4, 0.25);
        spawn(pool, 5, 6, 7, 0.75);
        pool.frame[11] = 17;
        pool.uv[23] = 19;
        pool.angularAcceleration[5] = 21;
        const snapshot = copyRows(pool);
        const positions = pool.position;
        retire(pool, 0);
        pool.uv.fill(0);
        writeRows(pool, snapshot);
        expect(pool.position).toBe(positions);
        expect(copyRows(pool)).toEqual(snapshot);
        expect(liveByteLength(pool)).toBe(rowsByteLength(snapshot));
        pool.uv.fill(0);
        expect(snapshot.columns.some(column => column.includes(19))).toBe(true);
    });

    it('rejects malformed snapshots before changing any live data', () => {
        const pool = createPool(2);
        spawn(pool, 1, 2, 3, 0.5);
        const before = copyRows(pool);
        const broken = copyRows(pool);
        const columns = [...broken.columns];
        columns[0].fill(99);
        columns[columns.length - 1] = new Float32Array(0);
        expect(() => writeRows(pool, {...broken, columns})).toThrow(RangeError);
        expect(copyRows(pool)).toEqual(before);
        expect(() => writeRows(createPool(0), before)).toThrow(RangeError);
    });

    it('does not retire a fractional or nonfinite index', () => {
        const pool = createPool(2);
        spawn(pool, 1, 0, 1, 0);
        const snapshot = copyRows(pool);
        for (const index of [NaN, Infinity, 0.5]) retire(pool, index);
        expect(copyRows(pool)).toEqual(snapshot);
    });

    it('rejects invalid allocation sizes', () => {
        for (const capacity of [-1, NaN, Infinity, 1.5]) expect(() => createPool(capacity)).toThrow(RangeError);
    });
});
