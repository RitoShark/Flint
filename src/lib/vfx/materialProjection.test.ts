import { describe, expect, it } from 'vitest';
import type { MaterialPreview, VfxSystem, VfxValue } from './bindings';
import { nameHash } from './binHash';
import { withMaterialPreviews } from './materialPreview';

const text = (value: string): VfxValue => ({type: 'string', value});
const number = (value: number): VfxValue => ({type: 'number', value});
const bool = (value: boolean): VfxValue => ({type: 'bool', value});
const vector = (...values: number[]): VfxValue => ({type: 'vector', values});
const list = (...items: VfxValue[]): VfxValue => ({type: 'container', items});
const object = (fields: Record<string, VfxValue>, className = 'StaticMaterialDef'): VfxValue => ({
    type: 'struct', class: null, classHash: nameHash(className), object: {entry: '0x1234', name: 'test'},
    fields: Object.entries(fields).map(([name, value]) => ({name, hash: nameHash(name), value})),
});
const parameter = (name: string, ...values: number[]) => object({name: text(name), value: vector(...values)});
const sampler = (name: string, path: string) => object({textureName: text(name), texturePath: text(path)});
const switchValue = (name: string, value: boolean) => object({name: text(name), on: bool(value)});
const system = (material: VfxValue): VfxSystem => ({entry: 'root', name: null, classHash: '0', class: null, materials: [],
    root: object({Material: material}, 'VfxMaterialDefinitionData')});

function project(fields: Record<string, VfxValue>, passFields: Record<string, VfxValue> = {}): MaterialPreview {
    return withMaterialPreviews(system(object({
        techniques: list(object({name: text('normal'), passes: list(object(passFields))})), ...fields,
    }))).materials[0];
}

describe('native material projection', () => {
    it('applies shader channel masks, material values and then pass overrides', () => {
        const result = project({paramValues: list(parameter('Alpha', 0.8))}, {
            shader: object({parameters: list(object({data: vector(0.2, 0.3, 0.4, 0.5), logicalParameters: list(
                object({name: text('TintColor'), fields: number(7)}), object({name: text('Alpha'), fields: number(8)}),
            )}))}),
            paramValues: list(parameter('Alpha', 0.6)),
        });
        expect(result.tint).toEqual([0.2, 0.3, 0.4]);
        expect(result.opacity).toBe(0.6);
    });

    it('selects normal technique and reports additional passes', () => {
        const result = project({techniques: list(
            object({name: text('shadow'), passes: list(object({writeMask: number(0)}))}),
            object({name: text('normal'), passes: list(object({depthEnable: bool(false)}), object({}))}),
        )});
        expect(result.renderState.depthWrite).toBe(true);
        expect(result.renderState.depthTest).toBe(false);
        expect(result.warnings).toContainEqual({kind: 'secondPass'});
    });

    it('prefers a color map over an exact placeholder but rejects noise textures', () => {
        const result = project({samplerValues: list(
            sampler('Diffuse_Texture', 'shared/materials/white.tex'),
            sampler('Noise', 'fx/particle_cm.tex'),
            sampler('Detail', 'fx/skin_tx_cm.tex'),
        )});
        expect(result.base?.name).toBe('Detail');
        expect(result.base?.rule).toBe('colorMapOverPlaceholder');
    });

    it('keeps a named placeholder when there is no suitable color map', () => {
        const result = project({samplerValues: list(sampler('Diffuse_Texture', 'shared/materials/white.tex'), sampler('Noise', 'fx/cloud.tex'))});
        expect(result.base?.rule).toBe('exactPlaceholder');
    });

    it.each([
        ['My_Base_Texture', 'fx/color.tex', 'nameLike'],
        ['Detail', 'fx/body_albedo.tex', 'colorMapPath'],
        ['Overlay', 'fx/body_cm.tex', 'colorMapPathAnyName'],
    ])('supports texture fallback %s', (name, path, rule) => {
        const result = project({samplerValues: list(sampler(name, path))});
        expect(result.base?.rule).toBe(rule);
    });

    it('resolves packed shader switches through a hashed shader link', () => {
        const result = project({
            samplerValues: list(sampler('Diffuse_Texture', 'fx/diffuse.tex'), sampler('Main_Texture', 'fx/main.tex')),
            switches: list(switchValue('MAINTEX_ON', true), switchValue('ADDITIVEALPHA_ON', true)),
        }, {
            shader: {type: 'link', hash: nameHash('Shaders/SkinnedMesh/AlphaBlend_Additive_Scroll_Packed'), name: null},
            blendEnable: bool(true), srcColorBlendFactor: number(6), dstColorBlendFactor: number(7),
        });
        expect(result.base?.texture.path).toBe('fx/main.tex');
        expect(result.base?.rule).toBe('switchOverride');
        expect(result.renderState.blending).toBe('additive');
    });

    it('uses pass macros after shader and material macros', () => {
        const macros = (value: string): VfxValue => ({type: 'map', entries: [{key: 'FEATURE_MASKED', value: text(value)}]});
        const result = project({shaderMacros: macros('1')}, {shader: object({featureDefines: macros('0')}), shaderMacros: macros('1')});
        expect(result.alphaTest).toBe(0.5);
    });

    it('projects cutout, premultiplied blending and UV motion', () => {
        const result = project({paramValues: list(parameter('Cutoff', 0.2), parameter('MainTex_Tile', 2, 3), parameter('ScrollSpeedBase', -1, 0.4))}, {
            blendEnable: bool(true), srcColorBlendFactor: number(1), dstColorBlendFactor: number(7), cullEnable: bool(false), windingToCull: number(0),
        });
        expect(result.renderState).toMatchObject({blending: 'normal', cutout: true, premultiplied: true, doubleSided: true, inverted: true});
        expect(result.uvRepeat).toEqual([2, 3]);
        expect(result.uvScroll).toEqual([-1, 0.4]);
    });

    it('avoids invalid uniforms from malformed vectors', () => {
        const result = project({paramValues: list(parameter('TintColor', 0.4), parameter('MainTex_Tile', 1), parameter('Alpha', NaN), parameter('ScrollSpeedBase', Infinity, 1))});
        expect([result.tint, result.opacity, result.uvRepeat, result.uvScroll]).toEqual([null, null, null, null]);
    });

    it('traverses cycles once and keeps existing resolved previews', () => {
        const data = system(object({}));
        if (data.root.type !== 'struct') throw new Error('fixture');
        data.root.fields.push({name: 'cycle', hash: 'cycle', value: data.root});
        const result = withMaterialPreviews(data);
        expect(result.materials).toHaveLength(1);
        const existing = result.materials[0];
        existing.name = 'resolved';
        expect(withMaterialPreviews(result).materials[0]).toBe(existing);
    });
});
