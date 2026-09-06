import { describe, expect, it, vi } from 'vitest';
import { isQuotedPosition, resolveCompletionNames, type Completion } from './ritobinLspNames';

const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } };

describe('local LSP completion names', () => {
    it('resolves class/property labels and inserted names in one batch while preserving snippet edits', async () => {
        const lookup = vi.fn().mockResolvedValue({ 305419896: 'SkinData', 2882400001: 'mName' });
        const items = [
            { label: '0x12345678', kind: 7, sortText: '02~12345678', insertTextFormat: 2,
                textEdit: { insert: range, replace: range, newText: '0x12345678 {\n\t$0\n}' } },
            { label: '0xabcdef01', kind: 10, sortText: '00~abcdef01', data: '0x12345678',
                textEdit: { range, newText: '0xabcdef01: string = ' } },
        ];
        const resolved = await resolveCompletionNames(items, lookup);
        expect(lookup).toHaveBeenCalledExactlyOnceWith([305419896, 2882400001]);
        expect(resolved[0]).toMatchObject({ label: 'SkinData', filterText: 'SkinData', sortText: '02SkinData', insertTextFormat: 2,
            textEdit: { insert: range, replace: range, newText: 'SkinData {\n\t$0\n}' } });
        expect(resolved[1]).toMatchObject({ label: 'mName', sortText: '00mName', data: '0x12345678', textEdit: { range, newText: 'mName: string = ' } });
        expect(items[0].label).toBe('0x12345678');
    });

    it('leaves unknown hashes, paths, literal values and unrelated edits unchanged', async () => {
        const items: Completion[] = [
            { label: '0x00000001', kind: 10 },
            { label: '0x00000002', kind: 7 },
            { label: '0x00000003', kind: 12 },
            { label: '0x00000004', kind: 10, insertText: 'prefix 0x00000004', additionalTextEdits: [{ range, newText: '0x00000004' }] },
        ];
        const lookup = vi.fn().mockResolvedValue({ 2: 'characters/skin.bin', 3: 'DoNotReplaceValue', 4: 'mValue' });
        const result = await resolveCompletionNames(items, lookup);
        expect(lookup).toHaveBeenCalledWith([1, 2, 4]);
        expect(result.slice(0, 3)).toEqual(items.slice(0, 3));
        expect(result[3]).toMatchObject({ label: 'mValue', insertText: 'prefix 0x00000004', additionalTextEdits: items[3].additionalTextEdits });
    });

    it('does no local lookup when suggestions are already named', async () => {
        const lookup = vi.fn();
        const items = [{ label: 'entries', kind: 10 }];
        expect(await resolveCompletionNames(items, lookup)).toBe(items);
        expect(lookup).not.toHaveBeenCalled();
    });
});

describe('asset preview hover protection', () => {
    it('protects quoted paths, including escaped quotes and unfinished strings, but allows field docs', () => {
        const line = 'mPath: string = "assets/skin.tex"';
        expect(isQuotedPosition(line, line.indexOf('skin') + 1)).toBe(true);
        expect(isQuotedPosition(line, 3)).toBe(false);
        expect(isQuotedPosition('path = "assets/skin', 16)).toBe(true);
        expect(isQuotedPosition('path = "a\\"b.tex"', 14)).toBe(true);
        expect(isQuotedPosition('"root" = SkinData {', 12)).toBe(false);
    });
});
