import { describe, expect, it } from 'vitest';
import { readableDiagnostic, suggestLspBracket } from './ritobinLspDiagnostics';
import type { LspDiagnostic } from './ritobinLspProtocol';

const diagnostic = (message: string): LspDiagnostic => ({ message, severity: 1,
    range: { start: { line: 6, character: 1 }, end: { line: 6, character: 1 } } });
const missing = diagnostic("Missing '}' for block - got end of file");
const broken = [
    'entries: map[hash,embed] = {',
    '    "example" = Example {',
    '        values: list[f32] = {',
    '            1',
    '        next: u32 = 1',
    '    }',
    '}',
].join('\n');

describe('readable LSP diagnostics', () => {
    it('translates the reported debug errors while keeping original details and locations', () => {
        for (const [message, expected] of [
            ['UnexpectedItem { span: Span { start: 24898, end: 34151 }, parent: RitoType { base: Struct, subtypes: [None, None] }, expected: Entry }', 'Expected a property name and type'],
            ['UnexpectedItem { span: Span { start: 1, end: 2 }, expected: Value }', 'Expected a list or map value'],
            ['QuotedPropertyName { span: Span { start: 1, end: 2 } }', 'A quoted name'],
            ['MissingType(Span { start: 1, end: 2 })', 'Missing a type'],
            [missing.message, 'may belong earlier'],
        ]) {
            const original = diagnostic(message);
            const result = readableDiagnostic(original);
            expect(result.message).toContain(expected);
            expect(result.rawMessage).toBe(message);
            expect(result.range).toEqual(original.range);
        }
        const warning = diagnostic("Unknown field 'birthVelocity'");
        expect(readableDiagnostic(warning)).toBe(warning);
    });
});

describe('LSP-triggered bracket suggestion', () => {
    it('suggests closing the inner block before its sibling, rather than appending at EOF', () => {
        const fix = suggestLspBracket(broken, [readableDiagnostic(missing)]);
        expect(fix).toMatchObject({ openerLine: 3, title: "Insert '}' after line 4",
            edit: { range: { start: { line: 3, character: 13 } }, newText: '\n        }' } });
        expect(fix?.explanation).toContain('after line 4, before the current line 5');
        const repaired = broken.replace('            1', '            1' + fix!.edit.newText);
        expect(suggestLspBracket(repaired, [missing])).toBeNull();
    });

    it('targets the end of a long nested block, independently of its opening line', () => {
        const lines = Array.from({ length: 270 }, () => '# header');
        lines.push('entries: map[hash,embed] = {'); // line 271
        lines.push('    "example" = Example {'); // line 272
        for (let i = 0; i < 80; i++) {
            lines.push('        value: embed = ValueData {', '            vector: vec3 = { 1, 2, 3 }', '        }');
        }
        lines.push('    "next" = Example {}', '}'); // next sibling, line 513
        const fix = suggestLspBracket(lines.join('\n'), [missing]);
        expect(fix).toMatchObject({ openerLine: 272, title: "Insert '}' after line 512",
            edit: { range: { start: { line: 511 } } } });
        expect(fix?.explanation).toContain('after line 512, before the current line 513');
        expect(fix?.explanation).not.toContain('272');
    });

    it('preserves CRLF and tabs and ignores braces in strings and comments', () => {
        const text = broken.replaceAll('    ', '\t').replace('next: u32 = 1', 'next: string = "{ }" # {').replaceAll('\n', '\r\n');
        expect(suggestLspBracket(text, [missing])?.edit.newText).toBe('\r\n\t\t}');
    });

    it('offers nothing without an LSP missing-bracket error or when the location is ambiguous', () => {
        expect(suggestLspBracket(broken, [])).toBeNull();
        expect(suggestLspBracket(broken, [diagnostic('Unknown field')])).toBeNull();
        expect(suggestLspBracket(broken, [missing, missing])).toBeNull();
        expect(suggestLspBracket('entries: map[hash,embed] = {\n"example" = Example {}', [missing])).toBeNull();
    });
});
