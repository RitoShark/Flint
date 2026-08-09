import { describe, it, expect } from 'vitest';
import { parseSkinScale, applySkinScaleToText } from './skinScale';

const WITH_SCALE = [
    '    skinMeshProperties: embed = SkinMeshDataProperties {',
    '        skinScale: f32 = 1.25',
    '        skeleton: string = "x.skl"',
    '    }',
].join('\n');

const WITHOUT_SCALE = [
    '    skinMeshProperties: embed = SkinMeshDataProperties {',
    '        skeleton: string = "x.skl"',
    '    }',
].join('\n');

describe('parseSkinScale', () => {
    it('reads an existing value', () => {
        expect(parseSkinScale(WITH_SCALE)).toEqual({ value: '1.25', exists: true });
    });

    it('reports 1.0 and absent when the property is missing', () => {
        expect(parseSkinScale(WITHOUT_SCALE)).toEqual({ value: '1.0', exists: false });
    });
});

describe('applySkinScaleToText', () => {
    it('rewrites the value in place, keeping the rest of the line', () => {
        const out = applySkinScaleToText(WITH_SCALE, '2.0');
        expect(out).toContain('skinScale: f32 = 2.0');
        expect(out).toContain('skeleton: string = "x.skl"');
        expect(out.split('\n')).toHaveLength(WITH_SCALE.split('\n').length);
    });

    it('inserts the property under skinMeshProperties at the block indent', () => {
        const out = applySkinScaleToText(WITHOUT_SCALE, '0.5');
        const lines = out.split('\n');
        expect(lines[1]).toBe('        skinScale: f32 = 0.5');
    });

    it('round-trips through parse', () => {
        expect(parseSkinScale(applySkinScaleToText(WITHOUT_SCALE, '3.5'))).toEqual({
            value: '3.5',
            exists: true,
        });
    });
});
