import { describe, it, expect } from 'vitest';
import { parseSkinSlots, skinLiteRange } from './skinSlots';

const LISTING = `
<html><body>
<a href="skin0.bin">skin0.bin</a>
<a href="skin1.bin">skin1.bin</a>
<a href="skin301.bin">skin301.bin</a>
<a href="skin302.bin">skin302.bin</a>
<a href="notaskin.txt">notaskin.txt</a>
</body></html>
`;

describe('parseSkinSlots', () => {
    it('reads every slot once, ascending, from a directory listing', () => {
        expect(parseSkinSlots(LISTING)).toEqual([0, 1, 301, 302]);
    });

    it('keeps the set sparse rather than filling the gaps', () => {
        const slots = parseSkinSlots(LISTING);
        expect(slots).not.toContain(2);
        expect(slots).not.toContain(300);
    });

    it('returns nothing for a listing with no skin bins', () => {
        expect(parseSkinSlots('<html><body>empty</body></html>')).toEqual([]);
    });
});

describe('skinLiteRange', () => {
    it('is a dense range from the highest listed slot plus the margin', () => {
        const range = skinLiteRange([0, 1, 28], 99, 20);
        expect(range[0]).toBe(0);
        expect(range[range.length - 1]).toBe(48);
        expect(range).toHaveLength(49);
    });

    it('falls back to the fixed ceiling when the listing is unavailable', () => {
        const range = skinLiteRange(null, 99, 20);
        expect(range[range.length - 1]).toBe(119);
    });
});
