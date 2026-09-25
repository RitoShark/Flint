import { QUAD_TYPE, UV_MODE } from '../../engine/model/enums';
import type { EmitterModel } from '../../engine/model/model';
export const GROUND_ORDER = -1_000_000;
const quadKinds = new Set<number>([QUAD_TYPE.cameraQuad, QUAD_TYPE.cameraUnitQuad, QUAD_TYPE.arbitraryQuad, QUAD_TYPE.ray]);
export const drawsAsQuad = (emitter: EmitterModel) => emitter.quadType !== null && quadKinds.has(emitter.quadType);
export const drawsAsTrail = (emitter: EmitterModel) => emitter.trail !== null;
export const drawsAsBeam = (emitter: EmitterModel) => !!emitter.beam && !emitter.mesh;
export const drawsAsMesh = (emitter: EmitterModel) => emitter.quadType === QUAD_TYPE.mesh && !!emitter.mesh;
export const drawsTheAttachment = (emitter: EmitterModel) => emitter.quadType === QUAD_TYPE.attachedMesh;
export const isRay = (emitter: EmitterModel) => emitter.quadType === QUAD_TYPE.ray;
export const isUnitQuad = (emitter: EmitterModel) => emitter.quadType === QUAD_TYPE.cameraUnitQuad;
export const trailFacesTheCamera = (emitter: EmitterModel) => emitter.quadType === QUAD_TYPE.cameraTrail;
export const facesTheCamera = (emitter: EmitterModel) => emitter.quadType === QUAD_TYPE.cameraQuad || isUnitQuad(emitter);
export const drawsFixedAlphaUv = (emitter: EmitterModel) => emitter.uvMode === UV_MODE.lockAlpha && emitter.quadType !== QUAD_TYPE.mesh && !drawsTheAttachment(emitter);
export const distorts = (emitter: EmitterModel) => !(emitter.customMaterial && !emitter.customMaterial.missing) && !!emitter.distortion;
export const isUndrawn = (emitter: EmitterModel) => ![drawsAsQuad, drawsAsTrail, drawsAsMesh, drawsTheAttachment].some(test => test(emitter)) && !emitter.beam;
function priority(emitter: EmitterModel): number[] {
    return [emitter.groundLayer ? 0 : 1, emitter.pass, [1, 2, 1, 0, 2, 2, 2, 2, 3][emitter.blendMode] ?? 1, emitter.miscRenderFlags, emitter.index];
}
export function compareDrawOrder(a: EmitterModel, b: EmitterModel): number {
    const right = priority(b);
    const deltas = priority(a).map((value, index) => value - right[index]);
    return deltas.find(value => value !== 0) ?? 0;
}
export function drawRanks(emitters: readonly EmitterModel[]): ReadonlyMap<number, number> {
    return new Map(Array.from(emitters).sort(compareDrawOrder).map(({ index }, rank) => [index, rank]));
}
