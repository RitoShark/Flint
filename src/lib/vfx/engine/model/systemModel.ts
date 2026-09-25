import { DRAG_MOTION } from './enums';
import type { EmitterModel, SystemModel, ValueCurve } from './model';
export const ROTATION_RATE = 60;
export const emptySystem = (entry: string | null): SystemModel => ({ emitters: [], transform: null, name: null, entry, buildUpTime: 0, dragMotion: DRAG_MOTION.stepped });
export function addressTheSame(previous: readonly EmitterModel[], next: readonly EmitterModel[]): boolean {
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index++) {
        for (const key of ['simple', 'listIndex', 'name'] as const) if (previous[index][key] !== next[index][key]) return false;
    }
    return true;
}
export function peak(curve: ValueCurve): number {
    return [curve.constant, ...curve.keys.map(key => key.values)].reduce((maximum, values) => values.reduce((max, value) => Math.max(max, value), maximum), 0);
}
export function systemSpan(system: SystemModel): number {
    const duration = system.emitters.filter(emitter => !emitter.disabled).reduce((end, emitter) =>
        Math.max(end, emitter.timeBeforeFirstEmission + (emitter.lifetime ?? 5) + peak(emitter.particleLifetime)), 1);
    return Math.min(60, duration);
}
function cappedDelay(requested: number, lifetime: number): number { return Math.min(Math.max(0, requested), lifetime + 10); }
export const stopWaitSeconds = (emitter: EmitterModel) => cappedDelay(emitter.emitterLinger, emitter.simple ? 0 : emitter.lifetime ?? Infinity);
export const lingerSeconds = (emitter: EmitterModel) => cappedDelay(emitter.particleLinger, emitter.simple ? 0 : emitter.particleLifetime.constant[0] ?? 0);
export function lingerTail(system: SystemModel, stoppedAt: number): number {
    return system.emitters.reduce((tail, emitter) => emitter.disabled ? tail : Math.max(tail,
        Math.max(0, stopWaitSeconds(emitter) - stoppedAt - system.buildUpTime) + lingerSeconds(emitter)), 0);
}
