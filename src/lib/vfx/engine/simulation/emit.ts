import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DRAG_MOTION, type DragMotion } from '../model/enums';
import type { EmitterModel, UvLayer, ValueCurve } from '../model/model';
import { turnInto } from '../utils/basis';
import type { Rng } from '../utils/Rng';
import { drawCurve, drawCurveInto } from '../utils/sampleCurve';
import type { EmitterState, SystemStep } from './integrate';
import { life01, sampleScalar } from './particleRead';
import { FRAME_SLOTS, type Pool, spawn, UV, uvAt } from './pool';
import { birth, sampleShape } from './spawnShape';

const birthColumns = [
    ['birthRotationalAcceleration', 'angularAcceleration', 3],
    ['birthDrag', 'birthDrag', 3],
    ['birthOrbitalVelocity', 'orbital', 3],
    ['birthColor', 'birthColor', 4],
] as const;
const shape = birth();
const surface = {position: new Float32Array(3), normal: new Float32Array(3)};
const point = new Float32Array(3);
const value = new Float32Array(4);
const velocity = Vector3.Zero();
const previous = Vector3.Zero();
const current = Vector3.Zero();

function scalar(curve: ValueCurve, phase: number, chance: number, fallback = 0): number {
    return drawCurve(curve, phase, chance)[0] ?? fallback;
}

function write(curve: ValueCurve, phase: number, chance: number, target: Float32Array, offset: number, width: number): void {
    for (let component = 0; component < width; component++) value[component] = target[offset + component];
    drawCurveInto(curve, phase, chance, value, 0);
    for (let component = 0; component < width; component++) target[offset + component] = value[component];
}

function batchSize(emitter: EmitterModel, state: EmitterState, rate: number): number {
    const pending = Math.trunc((state.age - state.since) * rate);
    let count = Math.min(pending, Math.trunc(rate * 0.33) + 1);
    if (!state.emitted) count = emitter.singleParticle ? Math.max(1, Math.trunc(rate) & 65535) : count === 0 ? 1 : count;
    const limit = emitter.trail?.maxAddedPerFrame ?? 0;
    return limit > 0 ? Math.min(count, limit) : count;
}

function recordDistance(state: EmitterState, step: SystemStep): void {
    point.set(state.position);
    turnInto(state.frame, point, 0);
    current.set(step.origin[0] + point[0], step.origin[1] + point[1], step.origin[2] + point[2]);
    if (state.spawnedAt) {
        Vector3.FromArrayToRef(state.spawnedAt, 0, previous);
        state.travelled += Vector3.Distance(previous, current);
        current.toArray(state.spawnedAt);
    } else state.spawnedAt = [current.x, current.y, current.z];
}

function placeParticle(pool: Pool, index: number, emitter: EmitterModel, state: EmitterState, step: SystemStep, random: Rng, phase: number, chance: number): void {
    const offset = index * 3;
    sampleShape(emitter.shape, random, phase, chance, shape);
    const onSurface = step.surfaces?.get(emitter)?.sample(state.age, random, surface) ?? false;
    for (let axis = 0; axis < 3; axis++) {
        if (onSurface) shape.offset[axis] += surface.position[axis];
        shape.offset[axis] += state.position[axis] + emitter.translationOverride[axis];
    }
    turnInto(state.frame, shape.offset, 0);
    for (let axis = 0; axis < 3; axis++) pool.position[offset + axis] = step.origin[axis] + shape.offset[axis];
    pool.frame.set(state.frame, index * FRAME_SLOTS);
    write(emitter.birthVelocity, phase, chance, pool.velocity, offset, 3);
    if (onSurface && emitter.emissionSurface?.useNormal) {
        Vector3.FromArrayToRef(pool.velocity, offset, velocity);
        const speed = velocity.length();
        for (let axis = 0; axis < 3; axis++) pool.velocity[offset + axis] = surface.normal[axis] * speed;
    }
    if (shape.turned) turnInto(shape.turn, pool.velocity, offset);
    turnInto(state.frame, pool.velocity, offset);
}

function initializeParticle(pool: Pool, index: number, emitter: EmitterModel, phase: number, chance: number, drag: DragMotion): void {
    const offset = index * 3;
    const simple = emitter.legacySimple;
    if (simple) {
        const size = scalar(simple.birthScale, phase, chance, 1);
        pool.birthScale.set([size * simple.scaleBias[0], size * simple.scaleBias[1], size], offset);
        pool.rotation[offset + 2] = scalar(simple.birthRotation, phase, chance);
        pool.angularVelocity[offset + 2] = scalar(simple.birthRotationalVelocity, phase, chance);
    } else {
        write(emitter.birthScale0, phase, chance, pool.birthScale, offset, 3);
        write(emitter.birthRotation0, phase, chance, pool.rotation, offset, 3);
        write(emitter.birthRotationalVelocity0, phase, chance, pool.angularVelocity, offset, 3);
    }
    for (const [property, column, width] of birthColumns) write(emitter[property], phase, chance, pool[column], index * width, width);
    if (drag === DRAG_MOTION.analytic) {
        for (let axis = offset; axis < offset + 3; axis++) {
            const terminal = pool.birthDrag[axis] > 0 ? pool.velocity[axis] / pool.birthDrag[axis] : 0;
            pool.dragTerminal[axis] = pool.dragOffset[axis] = terminal;
            pool.velocity[axis] = 0;
        }
    }
}

function initializeUv(target: Float32Array, offset: number, layer: UvLayer | null, phase: number, chance: number, roll: number): void {
    if (!layer) return;
    write(layer.birthOffset, phase, chance, target, offset + UV.birthOffsetX, 2);
    write(layer.birthScrollRate, phase, chance, target, offset + UV.birthScrollX, 2);
    target[offset + UV.birthRotate] = scalar(layer.birthRotateRate, phase, chance);
    target[offset + UV.phase] = layer.book.randomStart ? roll * Math.max(0, layer.book.frames) : 0;
    target[offset + UV.frameRate] = layer.book.rate * scalar(layer.book.birthRate, phase, chance);
}

export function emit(pool: Pool, emitter: EmitterModel, emitterIndex: number, state: EmitterState, step: SystemStep, random: Rng, drag: DragMotion): void {
    if (step.stopped || emitter.disabled || (emitter.singleParticle && state.emitted)) return;
    if (state.age < emitter.timeBeforeFirstEmission || (emitter.lifetime !== null && state.age > emitter.lifetime)) return;
    const phase = life01(emitter, state);
    const rate = Math.max(0, sampleScalar(emitter.rate, phase));
    if (!state.emitted) state.since = emitter.timeBeforeFirstEmission;
    const count = batchSize(emitter, state, rate);
    if (!(count > 0)) return;
    recordDistance(state, step);
    if (emitter.sharedRandom && state.chance === null) state.chance = random.unitFloat();
    for (let ordinal = 0; ordinal < count; ordinal++) {
        const roll = random.unitFloat();
        const drawnChance = state.chance ?? random.unitFloat();
        const chance = step.pinned ?? drawnChance;
        const index = spawn(pool, emitterIndex, step.now, scalar(emitter.particleLifetime, phase, chance), roll);
        if (index === null) break;
        placeParticle(pool, index, emitter, state, step, random, phase, chance);
        initializeParticle(pool, index, emitter, phase, chance, drag);
        initializeUv(pool.uv, uvAt(index, 0), emitter.uv, phase, chance, roll);
        initializeUv(pool.uv, uvAt(index, 1), emitter.multUv, phase, chance, roll);
        pool.odometer[index] = state.travelled;
        const tiling = emitter.trail?.tiling ?? emitter.beam?.tiling;
        if (tiling) write(tiling, phase, chance, pool.tiling, index * 2, 2);
    }
    state.emitted = true;
    state.since = rate > 0 ? state.since + count / rate : state.age;
}
