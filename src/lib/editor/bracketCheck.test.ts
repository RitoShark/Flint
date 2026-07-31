import { describe, it, expect } from 'vitest';
import { checkRitobinBrackets } from './bracketCheck';

/** The shape from the bug report: inline vec3 literals inside a list scope. */
const VALID_DOC = [
    '#PROP_text',                                                  // 1
    'entries: map[hash,embed] = {',                                // 2
    '    "Foo" = VfxSystemDefinitionData {',                       // 3
    '        scale0: embed = ValueVector3 {',                      // 4
    '            dynamics: pointer = VfxAnimatedVector3fVariableData {', // 5
    '                times: list[f32] = {',                        // 6
    '                    0',                                       // 7
    '                    0.2',                                     // 8
    '                    1',                                       // 9
    '                }',                                           // 10
    '                values: list[vec3] = {',                      // 11
    '                    { 0.6250996, 0.2, 0.2 }',                 // 12
    '                    { 1, 1, 1 }',                             // 13
    '                    { 1.3, 1.3, 1.3 }',                       // 14
    '                }',                                           // 15
    '            }',                                               // 16
    '        }',                                                   // 17
    '    }',                                                       // 18
    '}',                                                           // 19
].join('\n');

describe('checkRitobinBrackets — valid input', () => {
    it('accepts a document with inline vec3 literals', () => {
        const r = checkRitobinBrackets(VALID_DOC);
        expect(r.errors).toEqual([]);
        expect(r.valid).toBe(true);
    });

    it('accepts empty containers written as {}', () => {
        const doc = [
            'entries: map[hash,embed] = {',
            '    "Foo" = TestClass {',
            '        empties: list[embed] = {}',
            '        nothing: option[string] = {}',
            '    }',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    it('accepts an rgba literal', () => {
        const doc = ['a: rgba = { 255, 128, 0, 255 }'].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    it('ignores braces inside strings and comments', () => {
        const doc = [
            'entries: map[hash,embed] = {',
            '    "Foo" = TestClass {',
            '        path: string = "a{b}c"',
            '        note: string = "unclosed {"',
            '        # a comment with }',
            '        rate: f32 = 1 // trailing }',
            '    }',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });
});

describe('checkRitobinBrackets — unclosed blocks', () => {
    /* Line 5 opens VfxAnimatedVector3fVariableData and its closer was deleted. */
    const MISSING_CLOSER = [
        'entries: map[hash,embed] = {',                                // 1
        '    "Foo" = VfxSystemDefinitionData {',                       // 2
        '        scale0: embed = ValueVector3 {',                      // 3
        '            rate: f32 = 1',                                   // 4
        '            dynamics: pointer = VfxAnimatedVector3fVariableData {', // 5
        '                times: list[f32] = {',                        // 6
        '                    0',                                       // 7
        '                }',                                           // 8
        '        }',                                                   // 9
        '    }',                                                       // 10
        '}',                                                           // 11
    ].join('\n');

    it('reports the innermost block at its own header line, not at EOF', () => {
        const r = checkRitobinBrackets(MISSING_CLOSER);
        expect(r.valid).toBe(false);
        expect(r.errors[0].line).toBe(5);
        expect(r.errors[0].message).toContain('VfxAnimatedVector3fVariableData');
        expect(r.errors[0].message).toContain('never closed');
    });

    it('suggests inserting the closer at the end of the block, not the file', () => {
        const r = checkRitobinBrackets(MISSING_CLOSER);
        expect(r.errors[0].suggestLine).toBe(8);
    });

    it('names the innermost block when several are open', () => {
        const doc = [
            'a: embed = Outer {',   // 1
            '    b: embed = Inner {', // 2
            '        rate: f32 = 1',  // 3
        ].join('\n');
        const r = checkRitobinBrackets(doc);
        expect(r.errors[0].line).toBe(1);
        expect(r.errors.some(e => e.message.includes('Inner'))).toBe(true);
        expect(r.errors.some(e => e.message.includes('Outer'))).toBe(true);
    });
});

describe('checkRitobinBrackets — recovery', () => {
    it('reports two separately broken blocks, not just the first', () => {
        const doc = [
            'entries: map[hash,embed] = {',    // 1
            '    "A" = TestClass {',           // 2
            '        inner: embed = Alpha {',  // 3  <- closer deleted
            '            rate: f32 = 1',       // 4
            '    }',                           // 5
            '    "B" = TestClass {',           // 6
            '        inner: embed = Beta {',   // 7  <- closer deleted
            '            rate: f32 = 2',       // 8
            '    }',                           // 9
            '}',                               // 10
        ].join('\n');
        const r = checkRitobinBrackets(doc);
        expect(r.errors.some(e => e.message.includes('Alpha'))).toBe(true);
        expect(r.errors.some(e => e.message.includes('Beta'))).toBe(true);
    });
});
