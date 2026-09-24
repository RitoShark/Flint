import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scalar } from '@babylonjs/core/Maths/math.scalar';
import { LINGER_TYPE, QUAD_TYPE } from '../model/enums';
import type { EmitterModel, ValueCurve } from '../model/model';
import type { Point } from '../model/rig';
import { lingerSeconds } from '../model/systemModel';
import { multiplyInto, standingInto, turnInto } from '../utils/basis';
import { sampleCurveInto } from '../utils/sampleCurve';
import type { EmitterState } from './integrate';
import { FRAME_SLOTS, NOT_LINGERING, type Pool } from './pool';

export interface Source {
    readonly pool: Pool;
    readonly time: number;
    readonly elapsed: number;
    readonly origin: Point;
    readonly target: Point;
    readonly orientation: Float32Array;
}
export interface DrawFrame {
    readonly now: number;
    readonly phase: number;
    readonly origin: Point;
    readonly orientation: Float32Array;
    readonly worldAcceleration: Float32Array;
}
export interface DrawnPlace { readonly place: Float32Array; readonly turn: Float32Array; orbited: boolean }

export const SAMPLED = new Float32Array(4);
const angles = new Float32Array(3);
const parentBasis = new Float32Array(FRAME_SLOTS);
const travel = Vector3.Zero();
const side = Vector3.Zero();
const normal = Vector3.Zero();
const reference = Vector3.Zero();

export function clamp01(value: number): number { return Scalar.Clamp(value); }
export function scalar(values: readonly number[]): number { return values[0] ?? 0; }

export function sampled(curve: ValueCurve, phase: number, fill = 0): Float32Array {
    SAMPLED.fill(fill);
    sampleCurveInto(curve, phase, SAMPLED, 0);
    return SAMPLED;
}

export function sampleScalar(curve: ValueCurve, phase: number, fill = 0): number {
    return sampled(curve, phase, fill)[0];
}

function progress(start: number, duration: number, now: number): number {
    return duration > 0 ? clamp01((now - start) / duration) : 1;
}

export function age01(pool: Pool, index: number, now: number): number {
    return progress(pool.birthTime[index], pool.lifetime[index], now);
}

export function emitterPhase(emitter: EmitterModel, elapsed: number): number {
    return emitter.lifetime !== null && emitter.lifetime > 0 ? progress(0, emitter.lifetime, elapsed) : 0;
}

export function life01(emitter: EmitterModel, state: EmitterState): number {
    return emitterPhase(emitter, state.age);
}

export function linger01(pool: Pool, index: number, emitter: EmitterModel, now: number): number {
    const start = pool.lingerFrom[index];
    if (start === NOT_LINGERING) return 0;
    const duration = emitter.lingerType === LINGER_TYPE.maxLifetimeAfterEmitterDies
        ? lingerSeconds(emitter) : pool.birthTime[index] + pool.lifetime[index] - start;
    return progress(start, duration, now);
}

export function frameOf(source: Source, emitter: EmitterModel): DrawFrame {
    const phase = emitterPhase(emitter, source.elapsed);
    const worldAcceleration = new Float32Array(3);
    sampleCurveInto(emitter.worldAcceleration, phase, worldAcceleration, 0);
    return {now: source.time, phase, origin: source.origin, orientation: source.orientation, worldAcceleration};
}

export function appearance(pool: Pool, index: number, emitter: EmitterModel, now: number, output: {scale: Float32Array; color: Float32Array}): void {
    const phase = age01(pool, index, now);
    const linger = pool.lingerFrom[index] === NOT_LINGERING ? null : emitter.linger;
    const after = linger ? linger01(pool, index, emitter, now) : 0;
    scaledChannel(output.scale, pool.birthScale, index, 3, linger?.scale ?? emitter.legacySimple?.scale ?? emitter.scale0,
        linger?.scale ? after : phase, !linger?.scale && emitter.legacySimple !== null);
    scaledChannel(output.color, pool.birthColor, index, 4, linger?.color ?? emitter.color, linger?.color ? after : phase);
    if (emitter.uniformScale) output.scale.fill(output.scale[0], 1, 3);
}

function scaledChannel(output: Float32Array, birth: Float32Array, index: number, width: number, curve: ValueCurve, phase: number, uniform = false): void {
    output.fill(uniform ? sampleScalar(curve, phase, 1) : 1, 0, width);
    if (!uniform) sampleCurveInto(curve, phase, output, 0);
    for (let component = 0; component < width; component++) output[component] *= birth[index * width + component];
}

export function drawnPlace(): DrawnPlace {
    return {place: new Float32Array(3), turn: new Float32Array(FRAME_SLOTS), orbited: false};
}

export function orbitInto(pool: Pool, index: number, now: number, output: Float32Array): boolean {
    const offset = index * 3;
    Vector3.FromArrayToRef(pool.orbital, offset, travel);
    if (travel.lengthSquared() === 0) return false;
    const age = now - pool.birthTime[index];
    for (let axis = 0; axis < 3; axis++) angles[axis] = pool.orbital[offset + axis] * age * (180 / Math.PI);
    standingInto(angles, 0, 0, output);
    return true;
}

export function drawnPlaceInto(pool: Pool, index: number, frame: DrawFrame, output: DrawnPlace): void {
    for (let axis = 0; axis < 3; axis++) output.place[axis] = pool.position[index * 3 + axis];
    output.orbited = orbitInto(pool, index, frame.now, output.turn);
    if (output.orbited) {
        for (let axis = 0; axis < 3; axis++) output.place[axis] -= frame.origin[axis];
        turnInto(output.turn, output.place, 0);
        for (let axis = 0; axis < 3; axis++) output.place[axis] += frame.origin[axis];
    }
    const life = pool.lifetime[index];
    const duration = age01(pool, index, frame.now) * life * life;
    for (let axis = 0; axis < 3; axis++) output.place[axis] += frame.worldAcceleration[axis] * duration;
}

export function standingFrameInto(pool: Pool, index: number, emitter: EmitterModel, frame: DrawFrame, output: Float32Array): void {
    const source = emitter.particleLocalOrientation ? frame.orientation : pool.frame;
    const offset = emitter.particleLocalOrientation ? 0 : index * FRAME_SLOTS;
    for (let cell = 0; cell < FRAME_SLOTS; cell++) output[cell] = source[offset + cell];
}

export function particleBasisInto(pool: Pool, index: number, emitter: EmitterModel, frame: DrawFrame, output: Float32Array): void {
    Vector3.FromArrayToRef(pool.travel, index * 3, travel);
    if (emitter.directionOriented && travel.lengthSquared() > 0) {
        travel.normalize();
        reference.set(Math.abs(travel.y) < 0.99 ? 0 : 1, Math.abs(travel.y) < 0.99 ? 1 : 0, 0);
        Vector3.CrossToRef(reference, travel, side);
        side.normalize();
        Vector3.CrossToRef(side, travel, normal);
        output.set([side.x, travel.x, normal.x, side.y, travel.y, normal.y, side.z, travel.z, normal.z]);
    } else {
        standingInto(pool.rotation, index * 3, legacyRoll(pool, index, emitter, frame.now), output);
        standingFrameInto(pool, index, emitter, frame, parentBasis);
        multiplyInto(parentBasis, output, output);
    }
}

export function stretchOf(pool: Pool, index: number, emitter: EmitterModel): number {
    if (!emitter.directionOriented || emitter.quadType === QUAD_TYPE.ray || emitter.legacySimple) return 1;
    Vector3.FromArrayToRef(pool.travel, index * 3, travel);
    const speed = travel.length();
    return speed > 0 ? Math.max(emitter.directionVelocityMinScale, speed * emitter.directionVelocityScale) : 1;
}

export function legacyRoll(pool: Pool, index: number, emitter: EmitterModel, now: number): number {
    return emitter.legacySimple ? sampleScalar(emitter.legacySimple.rotation, age01(pool, index, now)) : 0;
}

export function spinOf(pool: Pool, index: number, emitter: EmitterModel, now: number): number {
    if (!emitter.legacySimple) return pool.rotation[index * 3];
    const whole = Math.trunc(pool.rotation[index * 3 + 2] + legacyRoll(pool, index, emitter, now));
    return (whole % 360 + 360) % 360;
}

export function erosionDrive(pool: Pool, index: number, emitter: EmitterModel, now: number): number {
    const erosion = emitter.erosion;
    if (!erosion) return 1;
    const lingering = pool.lingerFrom[index] !== NOT_LINGERING && erosion.lingerDrive;
    return lingering
        ? sampleScalar(lingering, linger01(pool, index, emitter, now), 1)
        : sampleScalar(erosion.drive, age01(pool, index, now), 1);
}
