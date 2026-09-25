import * as GPU from '../data';
import type { MaterialPreview } from '../../bindings';
import { CUSTOM_FRAGMENT } from '../shaders/custom';
import { uniforms } from './uniforms';
export function customMaterial(material: GPU.MaterialSpec, preview: MaterialPreview | null | undefined): GPU.MaterialSpec {
    if (!preview || preview.missing) return material;
    const state = preview.renderState;
    const factors = { zero: GPU.ZeroFactor, one: GPU.OneFactor, srcColor: GPU.SrcColorFactor, dstColor: GPU.DstColorFactor,
        oneMinusSrcColor: GPU.OneMinusSrcColorFactor, oneMinusDstColor: GPU.OneMinusDstColorFactor,
        srcAlpha: GPU.SrcAlphaFactor, oneMinusSrcAlpha: GPU.OneMinusSrcAlphaFactor };
    const modes = ['repeat', 'clamp', 'mirror', 'border'];
    const address = (preview.base?.wrap ?? ['repeat', 'repeat']).map(mode => modes.indexOf(mode));
    Object.assign(material, {
        fragmentShader: CUSTOM_FRAGMENT, blendEquation: GPU.AddEquation,
        blending: state.blending === 'opaque' ? GPU.NoBlending : GPU.CustomBlending,
        blendSrc: factors[state.srcFactor], blendDst: factors[state.dstFactor], blendSrcAlpha: null, blendDstAlpha: null,
        transparent: state.blending !== 'opaque' && !Object.hasOwn(material.defines, 'GROUND_LAYER'),
        depthTest: state.depthTest, depthWrite: state.depthWrite,
        side: state.doubleSided ? GPU.DoubleSide : state.inverted ? GPU.BackSide : GPU.FrontSide,
    });
    material.defines.CUSTOM_TEXTURE = Number(!!preview.base && !!material.uniforms.map.value);
    material.defines.CUSTOM_PREMULTIPLIED = Number(state.premultiplied);
    Object.assign(material.uniforms, uniforms({ materialTint: [...(preview.tint ?? [1, 1, 1]), preview.opacity ?? 1],
        materialRepeat: preview.uvRepeat ?? [1, 1], materialAddress: address, alphaRef: preview.alphaTest ?? 0 }));
    return material;
}
