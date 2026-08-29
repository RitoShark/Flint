import { describe, expect, it } from 'vitest';
import {
    TOON_DEFAULTS,
    TOON_RAMP_PATH,
    buildToonMaterial,
    hasToonMaterial,
    insertToonMaterial,
    uniqueToonName,
} from './toonShading';

const opts = (over: Partial<Parameters<typeof buildToonMaterial>[1]> = {}) => ({
    ...TOON_DEFAULTS,
    name: 'flint_toon_shading_1',
    diffusePath: 'assets/characters/aurora/skins/skin01/aurora_skin01_tx_cm.dds',
    ...over,
});

const BIN = [
    '#PROP_text',
    'type: string = "PROP"',
    'version: u32 = 3',
    'entries: map[hash,embed] = {',
    '    "characters/aurora/skins/skin1" = SkinCharacterDataProperties {',
    '        skinClassification: u32 = 1',
    '    }',
    '}',
].join('\n');

describe('buildToonMaterial', () => {
    it('types texturePath as file, never string', () => {
        const text = buildToonMaterial('', opts()).join('\n');
        expect(text).toContain('texturePath: file = "assets/characters/aurora');
        expect(text).not.toContain('texturePath: string');
    });

    it('points the ramp samplers at the bundled textures', () => {
        const text = buildToonMaterial('', opts()).join('\n');
        expect(text).toContain(`texturePath: file = "${TOON_RAMP_PATH}"`);
        expect(text).toContain('TextureName: string = "ToonShadingOutlineTex"');
    });

    it('emits a switch only for the enabled features', () => {
        const off = buildToonMaterial('', opts({ rim: false, outline: false })).join('\n');
        expect(off).not.toContain('RIM_COLOR_ON');
        expect(off).not.toContain('OUTLINE_ON');

        const on = buildToonMaterial('', opts({ rim: true, outline: true })).join('\n');
        expect(on).toContain('Name: string = "RIM_COLOR_ON"');
        expect(on).toContain('Name: string = "OUTLINE_ON"');
    });

    it('zeroes the control vectors of disabled features', () => {
        const text = buildToonMaterial('', opts({ outline: false })).join('\n');
        expect(text).toMatch(/"ToonOutlineControl"\s*\n\s*Value: vec4 = \{ 0, 0, 0, 0 \}/);
        expect(text).toMatch(/"ToonRimControl"\s*\n\s*Value: vec4 = \{ 1, 0\.3, 0\.1, 0 \}/);
    });

    it('balances its braces', () => {
        const text = buildToonMaterial('', opts()).join('\n');
        const open = (text.match(/\{/g) || []).length;
        const close = (text.match(/\}/g) || []).length;
        expect(open).toBe(close);
    });
});

describe('insertToonMaterial', () => {
    it('appends inside the entries map, keeping what was there', () => {
        const out = insertToonMaterial(BIN, opts());
        expect(out).toContain('SkinCharacterDataProperties');
        expect(hasToonMaterial(out)).toBe(true);

        const lines = out.split('\n');
        const material = lines.findIndex((l) => l.includes('= StaticMaterialDef'));
        expect(material).toBeGreaterThan(lines.findIndex((l) => l.includes('entries:')));
        expect(material).toBeLessThan(lines.length - 1);

        const open = (out.match(/\{/g) || []).length;
        const close = (out.match(/\}/g) || []).length;
        expect(open).toBe(close);
    });

    it('leaves a bin without an entries block alone', () => {
        expect(insertToonMaterial('nothing here', opts())).toBe('nothing here');
    });
});

describe('uniqueToonName', () => {
    it('stamps the base name with the second', () => {
        expect(uniqueToonName('', 'toon', 1_700_000_000_000)).toBe('toon_1700000000');
    });

    it('bumps a suffix when that name is already in the bin', () => {
        const text = '"toon_1700000000" = StaticMaterialDef {}';
        expect(uniqueToonName(text, 'toon', 1_700_000_000_000)).toBe('toon_1700000000_2');
    });
});
