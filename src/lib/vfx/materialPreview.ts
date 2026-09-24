import type { BaseTexture, BlendFactor, MaterialPreview, RenderState, VfxSystem, VfxValue, Wrap } from './bindings';
import { nameHash } from './binHash';
import { Properties, components } from './engine/parsing/properties';

const colorSamplers = ['Diffuse_Texture', 'DiffuseTexture', 'Main_Texture', 'Diffuse_Color', 'Diffuse', 'Base_Texture', 'Diff_Tex', '_MainTex', 'Diffuse_Texture_Primary', 'MainItemTexture', 'TierBaseTexture', 'Glass_Diffuse_Texture', 'TextureMain', 'VoidAlbedo2', 'BAKED_DIFFUSE_TEXTURE', 'Diffuse_Sword_Texture', 'Diffuse_Texture_2', 'WP_Base_Texture'];
const tintParameters = ['TintColor', 'MainTex_TintColor', 'Diffuse_Tint', 'BaseMat_Tint', 'TintColorBase', 'Main_Color', 'Diffuse_Color_Tint'];
const alphaParameters = ['Alpha', 'Opacity', 'Diffuse_AlphaIntensity', 'Master_Alpha'];
const cutoffParameters = ['AlphaTestValue', 'AlphaClipValue', 'Alpha_Test', 'AlphaTest', 'Cutoff'];
const tileParameters = ['MainTex_Tile', 'Diffuse_Tiling', 'Base_Tile', 'MainTexUV_Tile', 'UV_Scale', 'Diffuse_UV_Scale'];
const scrollParameters = ['ScrollSpeedMainTex', 'ScrollSpeedBase', 'Diffuse_Scroll_Speed', 'Diffuse_ScrollSpeed'];
const packedShader = 'Shaders/SkinnedMesh/AlphaBlend_Additive_Scroll_Packed';
const wrapModes: Wrap[] = ['repeat', 'clamp', 'mirror', 'border'];
const blendFactors: BlendFactor[] = ['zero', 'one', 'srcColor', 'oneMinusSrcColor', 'dstColor', 'oneMinusDstColor', 'srcAlpha', 'oneMinusSrcAlpha'];
const auxiliary = /mask|noise|gradient|gredient|ramp|matcap|normal|nrm|distort|flow|dissolve|erosion|scroll|pan|alt|secondary|swap|transition|fresnel|bloom|glow|emiss|lut|remap|outline|shadow|deform|wpo|screen|rim|spec|rma|metal|alpha|opacity|overlay|pattern|tint|blend|hold|lightness|trans_/i;
const nonColor = /noise|gradient|ramp|matcap|normal|nrm|distort|flow/i;

class MaterialInputs {
    readonly parameters = new Map<string, number[]>();
    readonly macros = new Map<string, string>();
    readonly switches = new Map<string, boolean>();
    readonly samplers = new Map<string, BaseTexture>();

    constructor(material: Properties, pass: Properties, shader: Properties) {
        for (const parameter of shader.objects('parameters')) {
            const data = this.vector(parameter, 'data');
            if (!data) continue;
            const logical = parameter.objects('logicalParameters');
            for (const part of logical.length ? logical : [parameter]) {
                const mask = part.number('fields', 15);
                this.parameters.set(part.text('name'), data.filter((_, index) => Boolean(mask & (1 << index))));
            }
        }
        for (const owner of [material, pass]) {
            for (const parameter of owner.objects('paramValues')) {
                const data = this.vector(parameter, 'value');
                if (data) this.parameters.set(parameter.text('name'), data);
            }
        }
        for (const [owner, property] of [[material, 'shaderMacros'], [shader, 'featureDefines'], [pass, 'shaderMacros']] as const) {
            const map = owner.get(property);
            if (map?.type === 'map') {
                for (const entry of map.entries) this.macros.set(entry.key, entry.value.type === 'string' ? entry.value.value : '');
            }
        }
        for (const [owner, property, value] of [[shader, 'staticSwitches', 'onByDefault'], [material, 'switches', 'on']] as const) {
            for (const setting of owner.objects(property)) this.switches.set(setting.text('name'), setting.bool(value));
        }
        for (const [owner, property] of [[shader, 'textures'], [material, 'samplerValues']] as const) {
            for (const sampler of owner.objects(property)) {
                const nameNode = sampler.get('textureName');
                const name = nameNode?.type === 'string' ? nameNode.value : sampler.text('name');
                const texture = sampler.asset('texturePath') ?? sampler.asset('defaultTexturePath');
                if (!name || !texture) continue;
                this.samplers.set(name, {name, texture, rule: 'exact', wrap: [wrapModes[sampler.number('addressU')] ?? 'repeat', wrapModes[sampler.number('addressV')] ?? 'repeat']});
            }
        }
    }

    private vector(owner: Properties, property: string): number[] | null {
        const node = owner.get(property);
        return node?.type === 'vector' ? components(node) : null;
    }

    first(names: readonly string[]): number[] | null {
        for (const name of names) {
            const value = this.parameters.get(name);
            if (value) return value;
        }
        return null;
    }

    scalar(names: readonly string[], low: number, high: number, exclusive = false): number | null {
        const value = this.first(names)?.[0];
        if (value === undefined || !Number.isFinite(value)) return null;
        return (exclusive ? value > low && value < high : value >= low && value <= high) ? value : null;
    }
}

function chooseTexture(inputs: MaterialInputs, packed: boolean): BaseTexture | null {
    const exact = colorSamplers.flatMap(name => {
        const sampler = inputs.samplers.get(name);
        return sampler ? [sampler] : [];
    });
    const usable = (sampler: BaseTexture) => !/shared\/materials\/(black|white|grey|gray|flat_normal|default|transparent|blank)|\/blank\.tex$|alpha-mask\.tex$/i.test(sampler.texture.path);
    const colorPath = (sampler: BaseTexture) => /(^|[_-])(tx_cm|cm|diffuse|albedo|basecolor)([_\-.\d]|$)/i.test(sampler.texture.path.split('/').at(-1) ?? '');
    const candidates = [...inputs.samplers.values()];
    const main = inputs.samplers.get('Main_Texture');
    const rules: [BaseTexture['rule'], () => BaseTexture | undefined][] = [
        ['switchOverride', () => packed && inputs.switches.get('MAINTEX_ON') && main && usable(main) ? main : undefined],
        ['exact', () => exact.find(usable)],
        ['colorMapOverPlaceholder', () => exact.length ? candidates.find(item => usable(item) && !auxiliary.test(item.name) && colorPath(item)) : undefined],
        ['exactPlaceholder', () => exact[0]],
        ['nameLike', () => candidates.find(item => usable(item) && !auxiliary.test(item.name) && /(^|_)(diffuse|albedo|main|base|basecolor|diff|color)(_|$|tex|texture)/i.test(item.name))],
        ['colorMapPath', () => candidates.find(item => usable(item) && !auxiliary.test(item.name) && colorPath(item))],
        ['colorMapPathAnyName', () => candidates.find(item => usable(item) && !nonColor.test(item.name) && colorPath(item))],
    ];
    for (const [rule, find] of rules) {
        const match = find();
        if (match) return {...match, rule};
    }
    return null;
}

function renderState(pass: Properties, inputs: MaterialInputs, shader: string | null, packed: boolean, opacity: number | null, cutoff: number | null, authoredCutoff: number | null): RenderState {
    const enabled = pass.bool('blendEnable');
    const srcFactor = blendFactors[pass.number('srcColorBlendFactor', 1)] ?? 'one';
    const dstFactor = blendFactors[pass.number('dstColorBlendFactor')] ?? 'zero';
    let blending: RenderState['blending'] = 'opaque';
    if (enabled) {
        if (dstFactor === 'one') blending = 'additive';
        else if (dstFactor === 'zero' && srcFactor === 'oneMinusSrcColor') blending = 'modulate';
        else if (srcFactor !== 'one' || dstFactor !== 'zero') blending = 'normal';
    }
    if (inputs.macros.get('SKINNED_MATERIAL_ADDITIVE') === '1' ||
        (enabled && !packed && /additive/i.test(shader ?? '')) ||
        (packed && blending === 'normal' && inputs.switches.get('ADDITIVEALPHA_ON'))) blending = 'additive';
    const alphaSwitch = packed && ['ALPHABLEND_MAIN', 'ALPHABLEND_BLENDMAT', 'USE_MAINTEXALPHA', 'ALPHACLIP_ON'].some(name => inputs.switches.get(name));
    if (blending === 'normal' && opacity === null && cutoff === null && !alphaSwitch) blending = 'opaque';
    const depthWrite = (pass.number('writeMask', 31) & 16) !== 0;
    return {
        blending, srcFactor, dstFactor, depthWrite,
        depthTest: pass.bool('depthEnable', true),
        doubleSided: !pass.bool('cullEnable', true),
        inverted: pass.number('windingToCull', 1) !== 1,
        premultiplied: enabled ? srcFactor === 'one' && dstFactor === 'oneMinusSrcAlpha' : inputs.macros.get('PREMULTIPLIED_ALPHA') === '1',
        cutout: blending === 'normal' && depthWrite && authoredCutoff !== null && (opacity ?? 1) >= 1,
    };
}

function preview(hash: string, node: VfxValue): MaterialPreview {
    const material = new Properties(node);
    const techniques = material.objects('techniques');
    const technique = techniques.find(value => value.text('name') === 'normal') ?? techniques[0] ?? new Properties(null);
    const passes = technique.list('passes');
    const pass = new Properties(passes[0] ?? null);
    const shader = pass.child('shader');
    const shaderPath = shader.get('objectPath');
    const path = shaderPath?.type === 'string' ? shaderPath.value : null;
    const packed = Boolean(path?.toLowerCase().endsWith(packedShader.toLowerCase())) || (shader.node?.type === 'link' && shader.node.hash === nameHash(packedShader));
    const inputs = new MaterialInputs(material, pass, shader);
    const opacity = inputs.scalar(alphaParameters, 0, 1);
    const authoredCutoff = inputs.scalar(cutoffParameters, 0, 1, true);
    const masked = /alphatest|alpha_test|cutout|masked/i.test(path ?? '') || inputs.macros.get('FEATURE_MASKED') === '1';
    const alphaTest = authoredCutoff ?? (masked ? 0.5 : null);
    const color = inputs.first(tintParameters);
    let tint: MaterialPreview['tint'] = null;
    if (color && color.length >= 3 && color.slice(0, 3).every(value => value >= 0 && value <= 4)) {
        const gain = /staticmesh\/defaultenv/i.test(path ?? '') ? 2 : 1;
        tint = [color[0] * gain, color[1] * gain, color[2] * gain];
    }
    const tile = inputs.first(tileParameters);
    const scroll = inputs.first(scrollParameters);
    const warnings: MaterialPreview['warnings'] = [];
    if (!shader.valid) warnings.push({kind: 'noShaderDefs'});
    if (!passes.length) warnings.push({kind: 'noPass'});
    if (passes.length > 1) warnings.push({kind: 'secondPass'});
    return {
        hash, name: node.type === 'struct' ? node.object?.name ?? null : null,
        missing: !material.valid, animated: material.child('dynamicMaterial').valid,
        shader: path, base: chooseTexture(inputs, packed), tint, opacity, alphaTest,
        uvRepeat: tile && tile.length >= 2 && tile[0] !== 0 && tile[1] !== 0 ? [tile[0], tile[1]] : null,
        uvScroll: scroll && scroll.length >= 2 ? [scroll[0], scroll[1]] : null,
        renderState: renderState(pass, inputs, path, packed, opacity, alphaTest, authoredCutoff), warnings,
    };
}

export function withMaterialPreviews(system: VfxSystem): VfxSystem {
    const materials = new Map((system.materials ?? []).map(material => [material.hash, material]));
    const pending = [system.root];
    const visited = new Set<VfxValue>();
    while (pending.length) {
        const node = pending.pop()!;
        if (visited.has(node)) continue;
        visited.add(node);
        if (node.type === 'struct') {
            const object = new Properties(node);
            if (object.is('VfxMaterialDefinitionData')) {
                const target = object.get('Material');
                const hash = target?.type === 'link' ? target.hash : target?.type === 'struct' ? target.object?.entry : null;
                if (target && hash && !materials.has(hash)) materials.set(hash, preview(hash, target));
            }
            for (let index = node.fields.length - 1; index >= 0; index--) pending.push(node.fields[index].value);
        } else if (node.type === 'container') {
            for (let index = node.items.length - 1; index >= 0; index--) pending.push(node.items[index]);
        } else if (node.type === 'map') {
            for (let index = node.entries.length - 1; index >= 0; index--) pending.push(node.entries[index].value);
        }
    }
    return {...system, materials: [...materials.values()]};
}
