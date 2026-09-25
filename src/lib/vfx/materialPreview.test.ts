import { expect, it } from 'vitest';
import type { VfxSystem, VfxValue } from './bindings';
import { nameHash } from './binHash';
import { withMaterialPreviews } from './materialPreview';
import { readVfxSystem } from './engine/parsing/readVfxSystem';

const text = (value: string): VfxValue => ({type: 'string', value});
const list = (...items: VfxValue[]): VfxValue => ({type: 'container', items});
const struct = (name: string, fields: Record<string, VfxValue>, entry?: string): VfxValue => ({type: 'struct', classHash: nameHash(name), class: null, object: entry ? {entry, name: null} : null, fields: Object.entries(fields).map(([name, value]) => ({hash: nameHash(name), name: null, value}))});
const system = (material: VfxValue): VfxSystem => ({entry: '0x00000001', name: null, classHash: nameHash('VfxSystemDefinitionData'), class: null, materials: [], root: struct('VfxSystemDefinitionData', {complexEmitterDefinitionData: list(struct('VfxEmitterDefinitionData', {CustomMaterial: struct('VfxMaterialDefinitionData', {Material: material})}))})});

it('loads a resolved material texture and pass overrides into the particle renderer', () => {
    const material = struct('StaticMaterialDef', {
        samplerValues: list(struct('StaticMaterialShaderSamplerDef', {textureName: text('Diffuse_Texture'), texturePath: {type:'asset', path:'custom.tex', asset:{kind:'file', path:'custom.tex'}}, addressU: {type:'number', value:1}})),
        paramValues: list(struct('StaticMaterialShaderParamDef', {name:text('TintColor'), value:{type:'vector', values:[0.2,0.3,0.4,1]}})),
        techniques: list(struct('StaticMaterialTechniqueDef', {name:text('normal'), passes:list(struct('StaticMaterialPassDef', {blendEnable:{type:'bool',value:true},srcColorBlendFactor:{type:'number',value:6},dstColorBlendFactor:{type:'number',value:7},paramValues:list(struct('StaticMaterialShaderParamDef',{name:text('Alpha'),value:{type:'vector',values:[0.5,0,0,0]}}))}))})),
    }, '0x12345678');
    const result = withMaterialPreviews(system(material));
    const emitter = readVfxSystem(result).emitters[0];
    expect(emitter.texture?.path).toBe('custom.tex');
    expect(emitter.customMaterial?.base?.wrap).toEqual(['clamp','repeat']);
    expect(emitter.customMaterial?.tint).toEqual([0.2,0.3,0.4]);
    expect(emitter.customMaterial?.opacity).toBe(0.5);
    expect(emitter.customMaterial?.renderState.blending).toBe('normal');
});

it('keeps unresolved material links marked missing', () => {
    const result = withMaterialPreviews(system({type:'link', hash:'0x12345678', name:null}));
    expect(result.materials[0].missing).toBe(true);
});
