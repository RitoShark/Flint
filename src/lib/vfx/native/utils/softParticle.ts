import { BLEND_MODE, type BlendMode } from '../../engine/model/enums';
import type { EmitterModel, SoftModel } from '../../engine/model/model';
import { drawsFixedAlphaUv, drawsTheAttachment } from './drawKind';
type Four = readonly [number, number, number, number];
export const fadeOf = (emitter: EmitterModel): SoftModel | null => drawsFixedAlphaUv(emitter) || drawsTheAttachment(emitter) ? null : emitter.soft;
export const fades = (emitter: EmitterModel) => !!fadeOf(emitter);
export function softParams(model: SoftModel): Four {
    const end = model.beginIn + model.deltaIn + model.beginOut;
    return [model.deltaIn ? model.beginIn : -1e9, end, model.deltaIn ? 1 / model.deltaIn : 1, model.deltaOut ? 1 / model.deltaOut : 0];
}
export function softControl(mode: BlendMode): Four {
    const alpha = mode === BLEND_MODE.alpha || mode === BLEND_MODE.alphaAdd;
    const premultiplied = mode === BLEND_MODE.premultipliedAlpha;
    return [Number(alpha), Number(!alpha), Number(!alpha && !premultiplied), Number(alpha || premultiplied)];
}
