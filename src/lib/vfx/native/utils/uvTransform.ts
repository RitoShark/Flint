import type { EmitterModel, UvLayer } from '../../engine/model/model';
import { ADDRESS_MODE } from '../../engine/model/enums';
import { UV, uvAt, type Pool } from '../../engine/simulation/pool';
import { sampleCurve } from '../../engine/utils/sampleCurve';

export interface UvDraw { turn: number; scaleU: number; scaleV: number; offsetU: number; offsetV: number; cellU: number; cellV: number }
export const uvDraw = (): UvDraw => ({ turn: 0, scaleU: 1, scaleV: 1, offsetU: 0, offsetV: 0, cellU: 0, cellV: 0 });
const modulo = (value: number, period: number) => value - Math.floor(value / period) * period;
const divisions = (layer: UvLayer) => layer.book.divisions.map(value => Math.max(1, Math.round(value)));
export function cellSize(layer: UvLayer): [number, number] {
    const [columns, rows] = divisions(layer);
    return [1 / columns, 1 / rows];
}
export const layerOf = (emitter: EmitterModel, layer: number) => layer === 0 ? emitter.uv : emitter.multUv;
export function uvTransformInto(pool: Pool, index: number, layer: UvLayer, which: number, age: number, progress: number, now: number, output: UvDraw): void {
    const offset = uvAt(index, which);
    const value = (field: number) => pool.uv[offset + field];
    const scales = sampleCurve(layer.scale, progress);
    output.scaleU = scales[0] ?? 1; output.scaleV = scales[1] ?? 1;
    output.turn = Math.PI / 180 * ((sampleCurve(layer.rotation, progress)[0] ?? 0) + value(UV.rotate) + age * value(UV.birthRotate));
    const scroll = (axis: number) => {
        const birth = value(axis ? UV.birthOffsetY : UV.birthOffsetX) + age * value(axis ? UV.birthScrollY : UV.birthScrollX);
        const integrated = value(axis ? UV.scrollY : UV.scrollX);
        const start = layer.scrollClamp ? Math.max(-1, Math.min(1, birth)) : modulo(birth, 1);
        const total = start + integrated + now * layer.emitterScrollRate[axis];
        const period = layer.addressMode === ADDRESS_MODE.wrap ? 1 : layer.addressMode === ADDRESS_MODE.mirror ? 2 : 0;
        return period ? modulo(total, period) : total;
    };
    output.offsetU = scroll(0); output.offsetV = scroll(1);
    const [columns, rows] = divisions(layer);
    const elapsed = modulo(value(UV.phase) + value(UV.frameRate) * age, Math.max(1, Math.round(layer.book.frames)));
    const frame = modulo(Math.trunc(layer.book.start + elapsed), columns * rows);
    output.cellU = frame % columns / columns; output.cellV = Math.floor(frame / columns) / rows;
}
