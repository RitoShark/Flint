import { describe, expect, it } from 'vitest';
import { COMPLETION_KINDS, diagnosticsAreCurrent, toLspPosition, toMonacoRange } from './ritobinLspProtocol';

describe('ritobin LSP boundary', () => {
    it('preserves UTF-16 columns, including surrogate pairs', () => {
        const column = 'Türkçe 🦈'.length + 1;
        const position = toLspPosition({ lineNumber: 3, column });
        expect(position).toEqual({ line: 2, character: column - 1 });
        expect(toMonacoRange({ start: position, end: position }).startColumn).toBe(column);
    });
    it('maps snippets and enum members to the distinct Monaco kinds', () => {
        expect(COMPLETION_KINDS[14]).toBe(28);
        expect(COMPLETION_KINDS[19]).toBe(16);
    });
    it('rejects diagnostics for old text, including edits awaiting debounce', () => {
        expect(diagnosticsAreCurrent(2, 3, false)).toBe(false);
        expect(diagnosticsAreCurrent(3, 3, true)).toBe(false);
        expect(diagnosticsAreCurrent(undefined, 3, true)).toBe(false);
        expect(diagnosticsAreCurrent(undefined, 3, false)).toBe(false);
        expect(diagnosticsAreCurrent(3, 3, false)).toBe(true);
    });
});
