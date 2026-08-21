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

    it('accepts a pasted block whose body is under-indented (rs_bin does not care)', () => {
        /* rs_bin's text parser is indentation-insensitive; a brace-balanced paste like this
           (body indented less than its own header) is valid to the real parser even though the
           indent looks "wrong". Recovery must not fire without evidence this block indents
           consistently. */
        const doc = [
            'entries: map[hash,embed] = {',
            '    "Foo" = VfxSystemDefinitionData {',
            '        complexEmitterDefinitionData: list[embed] = {',
            '            VfxEmitterDefinitionData {',
            '            emitterName: string = "pasted"',
            '            }',
            '        }',
            '    }',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    it('accepts a fully flush-left but balanced document', () => {
        const doc = [
            'entries: map[hash,embed] = {',
            '"Foo" = VfxSystemDefinitionData {',
            'scale0: embed = ValueVector3 {',
            'rate: f32 = 1',
            '}',
            '}',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    it('accepts a hand-typed sibling entry written flush-left inside an indented map', () => {
        const doc = [
            'entries: map[hash,embed] = {',
            '    "Existing" = SkinCharacterDataProperties {',
            '        skinClassification: u32 = 1',
            '    }',
            '',
            '"houndshade" = StaticMaterialDef {',
            '    Name: string = "a_unique_name"',
            '    SamplerValues: list2[embed] = {',
            '        StaticMaterialShaderSamplerDef {',
            '            TextureName: string = "Diffuse_Texture"',
            '            texturePath: string = "ASSETS/Characters/x.tex"',
            '        }',
            '    }',
            '}',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).errors).toEqual([]);
    });

    it('accepts a block whose body is dedented below its own header', () => {
        const doc = [
            'a: embed = Outer {',
            '    b: embed = Inner {',
            '        rate: f32 = 1',
            '    }',
            'c: f32 = 2',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    /*
     * rs_bin's printer emits a literal backslash as `\\`, so a string value
     * ending in a backslash prints as `"...\\"` — an escaped backslash
     * followed by a real, terminating quote. A checker that treats any
     * backslash-before-quote as an escaped quote never leaves "in string"
     * mode and misreports the enclosing block as unclosed.
     */
    it('accepts a string ending in an escaped backslash mid-path', () => {
        const doc = [
            'a: embed = C {',
            '    s: string = "ASSETS\\Foo\\\\"',
            '    r: f32 = 1',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    it('accepts a string containing only an escaped backslash', () => {
        const doc = [
            'a: embed = C {',
            '    s: string = "\\\\"',
            '    r: f32 = 1',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    it('still honours genuinely escaped quotes inside a string', () => {
        const doc = [
            'a: embed = C {',
            '    s: string = "say \\"hi\\""',
            '    r: f32 = 1',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    it('still accepts a plain string value', () => {
        const doc = [
            'a: embed = C {',
            '    s: string = "ok"',
            '    r: f32 = 1',
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

describe('checkRitobinBrackets — surplus closers', () => {
    it('reports a leftover closer when the count goes negative', () => {
        const doc = [
            'entries: map[hash,embed] = {', // 1
            '    "Foo" = TestClass {',      // 2
            '        rate: f32 = 1',        // 3
            '    }',                        // 4
            '}',                            // 5
            '}',                            // 6  <- leftover from a deleted block
        ].join('\n');
        const r = checkRitobinBrackets(doc);
        expect(r.valid).toBe(false);
        expect(r.errors[0].line).toBe(6);
        expect(r.errors[0].char).toBe('}');
        expect(r.errors[0].message).toContain('no open block');
    });

    it('reports mismatched closer kinds', () => {
        const doc = [
            'a: embed = TestClass {', // 1
            '    rate: f32 = 1',      // 2
            ']',                      // 3
        ].join('\n');
        const r = checkRitobinBrackets(doc);
        expect(r.valid).toBe(false);
        expect(r.errors.some(e => e.line === 3 && e.char === ']')).toBe(true);
    });

    it('does not flag odd but valid indentation', () => {
        const doc = [
            'entries: map[hash,embed] = {',
            '  "Foo" = TestClass {',
            '            rate: f32 = 1',
            '        }',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });
});

describe('checkRitobinBrackets — mtx44', () => {
    it('accepts the flat form rs_bin writes', () => {
        const doc = [
            'a: embed = TestClass {',
            '    Transform: mtx44 = {',
            '        1, 0, 0, 0',
            '        0, 1, 0, 0',
            '        0, 0, 1, 0',
            '        0, 0, 0, 1',
            '    }',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    it('accepts the legacy per-row form rs_bin tolerates', () => {
        const doc = [
            'a: embed = TestClass {',
            '    Transform: mtx44 = {',
            '        { 1, 0, 0, 0 }',
            '        { 0, 1, 0, 0 }',
            '        { 0, 0, 1, 0 }',
            '        { 0, 0, 0, 1 }',
            '    }',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });

    it('accepts a real mtx44 nested inside an indented struct, as rs_bin emits it', () => {
        const doc = [
            'entries: map[hash,embed] = {',
            '    "Foo" = StaticMaterialShaderData {',
            '        samplerValues: list[embed] = {',
            '            StaticMaterialShaderSamplerDefData {',
            '                textureName: string = "diffuse"',
            '                Transform: mtx44 = {',
            '                    1, 0, 0, 0',
            '                    0, 1, 0, 0',
            '                    0, 0, 1, 0',
            '                    0, 0, 0, 1',
            '                }',
            '            }',
            '        }',
            '    }',
            '}',
        ].join('\n');
        expect(checkRitobinBrackets(doc).valid).toBe(true);
    });
});

describe('checkRitobinBrackets — where the suggested closer lands', () => {
    /* A blank line between the broken block and the next sibling reads as part of the block
       on screen, so the closer belongs below it — level with the sibling's own closers. */
    it('carries the suggestion past a blank line before the next sibling', () => {
        const doc = [
            '        loadscreen: embed = CensoredImage {',       // 1
            '            image: string = "a.tex"',               // 2
            '        }',                                         // 3
            '        loadscreenVintage: embed = CensoredImage {', // 4  <- unclosed
            '            image: string = "b.tex"',               // 5
            '',                                                  // 6
            '        skinAudioProperties: embed = skinAudioProperties {', // 7
            '        }',                                         // 8
        ].join('\n');
        const r = checkRitobinBrackets(doc);
        expect(r.errors[0].line).toBe(4);
        expect(r.errors[0].suggestLine).toBe(6);
    });

    it('consumes only one line from a run of trailing blanks', () => {
        const doc = [
            'a: embed = A {',      // 1
            '    x: embed = B {',  // 2
            '        v: f32 = 1',  // 3
            '',                    // 4
            '',                    // 5
            '',                    // 6
            '    y: f32 = 2',      // 7
            '}',                   // 8
        ].join('\n');
        expect(checkRitobinBrackets(doc).errors[0].suggestLine).toBe(4);
    });

    it('keeps walking when a blank line is followed by more of the block body', () => {
        const doc = [
            'a: embed = A {',      // 1
            '    x: embed = B {',  // 2
            '        v: f32 = 1',  // 3
            '',                    // 4
            '        w: f32 = 2',  // 5
            '}',                   // 6
        ].join('\n');
        expect(checkRitobinBrackets(doc).errors[0].suggestLine).toBe(5);
    });

    it('suggests the last content line when no blank separates the sibling', () => {
        const doc = [
            'a: embed = A {',      // 1
            '    x: embed = B {',  // 2
            '        v: f32 = 1',  // 3
            '    y: embed = C {',  // 4
            '        v: f32 = 2',  // 5
            '    }',               // 6
            '}',                   // 7
        ].join('\n');
        expect(checkRitobinBrackets(doc).errors[0].suggestLine).toBe(3);
    });
});
