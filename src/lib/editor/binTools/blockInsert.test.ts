import { describe, it, expect } from 'vitest';
import { appendToList, quote, hasProperty } from './blockInsert';

const CONTAINER = /SkinCharacterDataProperties\s*\{/;
const TARGET = { name: 'idleParticlesEffects', decl: 'list[embed]', container: CONTAINER };
const entry = (indent: string) => [`${indent}Marker {`, `${indent}    a: u32 = 1`, `${indent}}`];

describe('quote', () => {
    it('escapes backslashes before quotes so the result re-parses', () => {
        expect(quote('a\\b')).toBe('"a\\\\b"');
        expect(quote('say "hi"')).toBe('"say \\"hi\\""');
    });
});

describe('appendToList', () => {
    it('creates the list inside the container when it is absent', () => {
        const text = [
            '"Characters/Ahri/Skins/Skin0" = SkinCharacterDataProperties {',
            '    championSkinName: string = "Ahri"',
            '}',
        ].join('\n');
        const out = appendToList(text, TARGET, entry).split('\n');
        expect(out[1]).toBe('    idleParticlesEffects: list[embed] = {');
        expect(out[2]).toBe('        Marker {');
        expect(out[4]).toBe('        }');
        expect(out[5]).toBe('    }');
        expect(out).toContain('    championSkinName: string = "Ahri"');
    });

    it('appends into an existing list at the existing child indent', () => {
        const text = [
            '"x" = SkinCharacterDataProperties {',
            '    idleParticlesEffects: list[embed] = {',
            '        Existing {',
            '        }',
            '    }',
            '}',
        ].join('\n');
        const out = appendToList(text, TARGET, entry).split('\n');
        expect(out[4]).toBe('        Marker {');
        expect(out).toContain('        Existing {');
        expect(out.filter((l) => l.includes('idleParticlesEffects'))).toHaveLength(1);
    });

    it('expands a collapsed empty list', () => {
        const text = [
            '"x" = SkinCharacterDataProperties {',
            '    idleParticlesEffects: list[embed] = {}',
            '}',
        ].join('\n');
        const out = appendToList(text, TARGET, entry).split('\n');
        expect(out[1]).toBe('    idleParticlesEffects: list[embed] = {');
        expect(out[2]).toBe('        Marker {');
        expect(out[4]).toBe('        }');
        expect(out[5]).toBe('    }');
    });

    it('is a no-op when the container is missing', () => {
        const text = 'entries: map[hash,embed] = {\n}';
        expect(appendToList(text, TARGET, entry)).toBe(text);
    });

    it('is not confused by a brace inside a string value', () => {
        const text = [
            '"x" = SkinCharacterDataProperties {',
            '    idleParticlesEffects: list[embed] = {',
            '        note: string = "}"',
            '    }',
            '}',
        ].join('\n');
        const out = appendToList(text, TARGET, entry).split('\n');
        expect(out[3]).toBe('        Marker {');
    });
});

describe('hasProperty', () => {
    it('matches a property declaration, not a mention in a value', () => {
        expect(hasProperty('    Position: vec3 = { 0, 0, 0 }', 'Position')).toBe(true);
        expect(hasProperty('    note: string = "Position: 1"', 'Position')).toBe(false);
    });
});
