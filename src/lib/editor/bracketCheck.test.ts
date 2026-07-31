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
