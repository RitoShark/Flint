import { describe, it, expect } from 'vitest';
import { ensureMaterialOverride, insertMaterialOverrideEntry } from './materialOverride';

const BASE = [
    '    skinMeshProperties: embed = SkinMeshDataProperties {',
    '        skeleton: string = "x.skl"',
    '    }',
].join('\n');

describe('ensureMaterialOverride', () => {
    it('adds an empty list under skinMeshProperties', () => {
        const out = ensureMaterialOverride(BASE).split('\n');
        expect(out[1]).toBe('        materialOverride: list[embed] = {');
        expect(out[2]).toBe('        }');
    });

    it('leaves a file that already has one untouched', () => {
        const once = ensureMaterialOverride(BASE);
        expect(ensureMaterialOverride(once)).toBe(once);
    });
});

describe('insertMaterialOverrideEntry', () => {
    it('writes a texture entry as a string property', () => {
        const out = insertMaterialOverrideEntry(BASE, 'assets/a/b.tex', 'Body', 'texture');
        expect(out).toContain('texture: file = "assets/a/b.tex"');
        expect(out).toContain('Submesh: string = "Body"');
    });

    it('writes a material entry as a link property', () => {
        const out = insertMaterialOverrideEntry(BASE, 'SomeMaterial', 'Body', 'material');
        expect(out).toContain('material: link = "SomeMaterial"');
    });

    it('creates the block first when there is none', () => {
        const out = insertMaterialOverrideEntry(BASE, 'assets/a/b.tex', 'Body', 'texture');
        expect(out).toContain('materialOverride: list[embed] = {');
    });

    it('appends inside the existing list rather than replacing it', () => {
        const first = insertMaterialOverrideEntry(BASE, 'a.tex', 'Body', 'texture');
        const second = insertMaterialOverrideEntry(first, 'b.tex', 'Hair', 'texture');
        expect(second).toContain('"a.tex"');
        expect(second).toContain('"b.tex"');
        expect(second.match(/materialOverride:/g)).toHaveLength(1);
    });
});
