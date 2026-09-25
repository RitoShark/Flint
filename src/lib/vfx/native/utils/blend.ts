import { BLEND_MODE, MISC_RENDER_FLAG, type BlendMode } from '../../engine/model/enums';
import type { EmitterModel } from '../../engine/model/model';
import { AddEquation, CustomBlending, DstAlphaFactor, MaxEquation, MinEquation, NoBlending, OneFactor, OneMinusDstAlphaFactor, OneMinusSrcAlphaFactor, OneMinusSrcColorFactor, SrcAlphaFactor, ZeroFactor } from '../data';
import { distorts } from './drawKind';
export interface BlendState {
    blending: number; blendSrc: number; blendDst: number; blendEquation: number;
    blendSrcAlpha: number; blendDstAlpha: number; transparent: boolean; depthWrite: boolean;
}
export interface FragmentTests { readonly alphaRef: number; readonly depthTest: boolean }
export function blendState(mode: BlendMode): BlendState {
    const state: BlendState = { blending: CustomBlending, blendSrc: OneFactor, blendDst: OneFactor,
        blendEquation: AddEquation, blendSrcAlpha: OneFactor, blendDstAlpha: OneFactor, transparent: true, depthWrite: false };
    switch (mode) {
        case BLEND_MODE.none: state.blending = NoBlending; state.transparent = false; state.depthWrite = true; break;
        case BLEND_MODE.min: state.blendEquation = MinEquation; break;
        case BLEND_MODE.max: state.blendEquation = MaxEquation; break;
        case BLEND_MODE.alpha: state.blendSrc = state.blendSrcAlpha = SrcAlphaFactor;
            state.blendDst = state.blendDstAlpha = OneMinusSrcAlphaFactor; break;
        case BLEND_MODE.alphaAdd: state.blendSrc = state.blendSrcAlpha = SrcAlphaFactor; break;
        case BLEND_MODE.premultipliedAlpha: state.blendDst = state.blendDstAlpha = OneMinusSrcAlphaFactor; break;
        case BLEND_MODE.subtract: state.blendSrc = state.blendSrcAlpha = ZeroFactor;
            state.blendDst = OneMinusSrcColorFactor; state.blendDstAlpha = OneMinusSrcAlphaFactor; break;
        case BLEND_MODE.targetAlpha: state.blendSrc = OneMinusDstAlphaFactor; state.blendDst = DstAlphaFactor; break;
    }
    return state;
}
export const drawState = (mode: BlendMode, distortion: boolean) => blendState(distortion ? BLEND_MODE.alpha : mode);
const sortedModes = new Set<number>([BLEND_MODE.alpha, BLEND_MODE.subtract, BLEND_MODE.premultipliedAlpha, BLEND_MODE.targetAlpha]);
export const sortsBackToFront = (mode: BlendMode) => sortedModes.has(mode);
export function premultiplyInto(emitter: EmitterModel, color: Float32Array): void {
    const custom = emitter.customMaterial && !emitter.customMaterial.missing;
    if (!custom && !distorts(emitter) && (emitter.blendMode === BLEND_MODE.add || emitter.blendMode === BLEND_MODE.subtract)) {
        color.set([color[0] * color[3], color[1] * color[3], color[2] * color[3], 1]);
    }
}
export const fragmentTests = (emitter: EmitterModel): FragmentTests => ({ alphaRef: emitter.alphaRef, depthTest: !(emitter.miscRenderFlags & MISC_RENDER_FLAG.disableZBuffer) });
