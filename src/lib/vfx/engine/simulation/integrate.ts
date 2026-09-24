import { Matrix } from '@babylonjs/core/Maths/math.vector';
import { DRAG_MOTION, LINGER_TYPE } from '../model/enums';
import type { EmitterModel, SystemModel, ValueCurve } from '../model/model';
import type { Point } from '../model/rig';
import { lingerSeconds, stopWaitSeconds } from '../model/systemModel';
import { multiplyInto, standingInto, turnInto } from '../utils/basis';
import type { Rng } from '../utils/Rng';
import { sampleCurve, sampleCurveInto } from '../utils/sampleCurve';
import type { EmissionSurfaces } from './emissionSurface';
import { emit } from './emit';
import { applyFields, prepareFields, type NoiseClock, type SampledFields } from './forceFields';
import { age01, clamp01, life01, sampleScalar } from './particleRead';
import { FRAME_SLOTS, NOT_LINGERING, type Pool, retire, UV, uvAt } from './pool';
import type { Step } from './stepper';

export interface SystemStep extends Step {
    readonly surfaces?: EmissionSurfaces;
    readonly origin: Point;
    readonly moved: Point;
    readonly yaw: Float32Array;
    readonly world: Float32Array;
    readonly stopped: boolean;
    readonly pinned?: number | null;
}
export interface World { readonly basis: Float32Array; readonly offset: Point }
export interface EmitterState {
    age: number;
    emitted: boolean;
    since: number;
    position: [number, number, number];
    finishedAt: number | null;
    chance: number | null;
    travelled: number;
    spawnedAt: [number, number, number] | null;
    readonly frame: Float32Array;
    readonly noise: NoiseClock[];
}

interface MotionState {
    acceleration: Float32Array;
    drag: Float32Array;
    drift: Float32Array;
    shift: Float32Array;
    bind: number;
    fields: SampledFields | null;
}
const motions = new WeakMap<EmitterState, MotionState>();
const scratch = {
    rotation: new Float32Array(3), override: new Float32Array(FRAME_SLOTS),
    sample: new Float32Array(3), acceleration: new Float32Array(3), drift: new Float32Array(3), shift: new Float32Array(3),
    velocity: new Float32Array(3), moving: new Float32Array(3), before: new Float32Array(3), position: new Float32Array(3),
};

export function worldOf(system: SystemModel): World {
    const matrix = system.transform ? Matrix.FromArray(system.transform) : Matrix.Identity();
    const basis = new Float32Array(FRAME_SLOTS);
    for (let cell = 0; cell < FRAME_SLOTS; cell++) basis[cell] = matrix.m[(cell % 3) * 4 + Math.floor(cell / 3)];
    const translation = matrix.getTranslation();
    return {basis, offset: [translation.x, translation.y, translation.z]};
}

export function createEmitterStates(emitters: readonly EmitterModel[]): EmitterState[] {
    return emitters.map(emitter => {
        const position = sampleCurve(emitter.emitterPosition, 0);
        return {age: 0, emitted: false, since: emitter.timeBeforeFirstEmission,
            position: [position[0] ?? 0, position[1] ?? 0, position[2] ?? 0], finishedAt: null, chance: null,
            travelled: 0, spawnedAt: null, frame: new Float32Array(FRAME_SLOTS), noise: []};
    });
}

export function copyEmitterStates(states: readonly EmitterState[]): EmitterState[] {
    return states.map(state => ({...state, position: [...state.position], spawnedAt: state.spawnedAt ? [...state.spawnedAt] : null,
        frame: Float32Array.from(state.frame), noise: state.noise.map(clock => ({last: clock.last, fired: clock.fired}))}));
}

function settleEmitter(pool: Pool, emitter: EmitterModel, index: number, state: EmitterState, step: SystemStep): void {
    if (state.finishedAt !== null) return;
    const threshold = step.stopped ? stopWaitSeconds(emitter)
        : emitter.lingerType === LINGER_TYPE.fixedLifetimeAfterEmitterStops ? emitter.lifetime ?? Infinity : Infinity;
    if (!(state.age > threshold)) return;
    state.finishedAt = step.now;
    const remaining = lingerSeconds(emitter);
    for (let particle = 0; particle < pool.count; particle++) {
        if (pool.emitter[particle] !== index) continue;
        pool.lingerFrom[particle] = step.now;
        pool.lifetime[particle] = emitter.lingerType === LINGER_TYPE.maxLifetimeAfterEmitterDies
            ? Math.min(pool.lifetime[particle], remaining) : step.now - pool.birthTime[particle] + remaining;
    }
}

function sampleInto(curve: ValueCurve, phase: number, output: Float32Array): void {
    output.fill(0);
    sampleCurveInto(curve, phase, output, 0);
}

function prepareEmitter(emitter: EmitterModel, state: EmitterState, step: SystemStep): MotionState {
    let motion = motions.get(state);
    if (!motion) {
        motion = {acceleration: new Float32Array(3), drag: new Float32Array(3), drift: new Float32Array(3), shift: new Float32Array(3), bind: 0, fields: null};
        motions.set(state, motion);
    }
    scratch.rotation.set(emitter.rotationOverride);
    standingInto(scratch.rotation, 0, 0, scratch.override);
    for (let cell = 0; cell < FRAME_SLOTS; cell++) scratch.override[cell] *= emitter.scaleOverride[cell % 3];
    if (emitter.localOrientation) multiplyInto(step.yaw, scratch.override, state.frame);
    else state.frame.set(scratch.override);
    multiplyInto(step.world, state.frame, state.frame);
    const phase = life01(emitter, state);
    motion.fields = null;
    if (emitter.fields) {
        scratch.position.fill(0);
        if (emitter.emitterSpace) {
            scratch.position.set(state.position);
            turnInto(state.frame, scratch.position, 0);
        }
        const origin: Point = [step.origin[0] - step.moved[0] + scratch.position[0], step.origin[1] - step.moved[1] + scratch.position[1], step.origin[2] - step.moved[2] + scratch.position[2]];
        motion.fields = prepareFields(emitter.fields, phase, step.now, {origin, orientation: emitter.localOrientation ? step.yaw : null}, state.noise);
    }
    const linger = state.finishedAt === null ? null : emitter.linger;
    const seconds = lingerSeconds(emitter);
    const after = state.finishedAt === null || seconds <= 0 ? 1 : clamp01((step.now - state.finishedAt) / seconds);
    sampleInto(linger?.acceleration ?? emitter.acceleration, linger?.acceleration ? after : phase, motion.acceleration);
    sampleInto(linger?.drag ?? emitter.drag, linger?.drag ? after : phase, motion.drag);
    sampleInto(linger?.velocity ?? emitter.velocity, linger?.velocity ? after : phase, motion.drift);
    motion.bind = Math.fround(sampleScalar(emitter.bindWeight, phase));
    sampleInto(emitter.emitterPosition, phase, scratch.sample);
    for (let axis = 0; axis < 3; axis++) {
        motion.shift[axis] = emitter.emitterSpace ? scratch.sample[axis] - state.position[axis] : 0;
        state.position[axis] = scratch.sample[axis];
    }
    return motion;
}

function applyParticleFields(pool: Pool, index: number, fields: SampledFields | null, dt: number): void {
    if (!fields) return;
    scratch.before.set(scratch.moving);
    for (let axis = 0; axis < 3; axis++) scratch.position[axis] = pool.position[index * 3 + axis];
    applyFields(fields, scratch.moving, scratch.position, pool.serial[index], dt);
    for (let axis = 0; axis < 3; axis++) scratch.velocity[axis] += scratch.moving[axis] - scratch.before[axis];
}

function updateAppearance(pool: Pool, index: number, emitter: EmitterModel, step: Step): void {
    const age = step.now - pool.birthTime[index];
    const phase = age01(pool, index, step.now);
    const offset = index * 3;
    for (let axis = 0; axis < 3; axis++) {
        const cell = offset + axis;
        pool.rotation[cell] += (pool.angularVelocity[cell] + pool.angularAcceleration[cell] * age) * step.dt;
    }
    if (emitter.rotationEnabled) {
        const rotation = pool.lingerFrom[index] !== NOT_LINGERING ? emitter.linger?.rotation ?? emitter.rotation0 : emitter.rotation0;
        sampleInto(rotation, phase, scratch.sample);
        for (let axis = 0; axis < 3; axis++) pool.rotation[offset + axis] += scratch.sample[axis] * 60 * step.dt;
    }
    for (let layer = 0; layer < 2; layer++) {
        const uv = layer === 0 ? emitter.uv : emitter.multUv;
        if (!uv) continue;
        const slot = uvAt(index, layer);
        sampleInto(uv.scrollRate, phase, scratch.sample);
        pool.uv[slot + UV.scrollX] += scratch.sample[0] * step.dt;
        pool.uv[slot + UV.scrollY] += scratch.sample[1] * step.dt;
        pool.uv[slot + UV.rotate] += sampleScalar(uv.rotateRate, phase) * step.dt;
    }
}

function advanceParticle(pool: Pool, index: number, motion: MotionState, step: SystemStep, analytic: boolean): void {
    const offset = index * 3;
    scratch.acceleration.set(motion.acceleration);
    scratch.drift.set(motion.drift);
    scratch.shift.set(motion.shift);
    turnInto(pool.frame, scratch.acceleration, 0, index * FRAME_SLOTS);
    turnInto(pool.frame, scratch.drift, 0, index * FRAME_SLOTS);
    turnInto(pool.frame, scratch.shift, 0, index * FRAME_SLOTS);
    for (let axis = 0; axis < 3; axis++) {
        const cell = offset + axis;
        const damping = motion.drag[axis] + pool.birthDrag[cell];
        let velocity = pool.velocity[cell] + scratch.acceleration[axis] * step.dt;
        let movement = velocity + scratch.drift[axis];
        if (analytic && damping > 0) {
            if (step.dt > 0) {
                const remaining = Math.exp(-damping * (step.now - pool.birthTime[index])) * pool.dragTerminal[cell];
                movement += (pool.dragOffset[cell] - remaining) / step.dt;
                pool.dragOffset[cell] = remaining;
            }
        } else if (damping !== 0) {
            let change = -damping * movement * step.dt;
            if ((change + movement) * movement < 0) change = -movement;
            velocity += change;
            movement += change;
        }
        scratch.velocity[axis] = velocity;
        scratch.moving[axis] = movement;
    }
    applyParticleFields(pool, index, motion.fields, step.dt);
    for (let axis = 0; axis < 3; axis++) {
        const movement = scratch.moving[axis] * step.dt + motion.bind * step.moved[axis] + scratch.shift[axis];
        pool.velocity[offset + axis] = scratch.velocity[axis];
        pool.position[offset + axis] += movement;
        pool.travel[offset + axis] = step.dt > 0 ? movement / step.dt : 0;
    }
}

export function stepEmitters(pool: Pool, system: SystemModel, step: SystemStep, random: Rng, states: EmitterState[]): void {
    for (let index = 0; index < system.emitters.length; index++) {
        const state = states[index];
        state.age += step.dt;
        settleEmitter(pool, system.emitters[index], index, state, step);
        prepareEmitter(system.emitters[index], state, step);
    }
    for (let index = pool.count - 1; index >= 0; index--) {
        if (step.now - pool.birthTime[index] >= pool.lifetime[index]) {
            retire(pool, index);
            continue;
        }
        const emitterIndex = pool.emitter[index];
        const motion = motions.get(states[emitterIndex])!;
        advanceParticle(pool, index, motion, step, system.dragMotion === DRAG_MOTION.analytic);
        updateAppearance(pool, index, system.emitters[emitterIndex], step);
    }
    const newborns = pool.count;
    for (let index = 0; index < system.emitters.length; index++) emit(pool, system.emitters[index], index, states[index], step, random, system.dragMotion);
    for (let index = newborns; index < pool.count; index++) {
        const motion = motions.get(states[pool.emitter[index]])!;
        if (!motion.fields) continue;
        scratch.drift.set(motion.drift);
        turnInto(pool.frame, scratch.drift, 0, index * FRAME_SLOTS);
        for (let axis = 0; axis < 3; axis++) {
            scratch.velocity[axis] = pool.velocity[index * 3 + axis];
            scratch.moving[axis] = scratch.velocity[axis] + scratch.drift[axis];
        }
        applyParticleFields(pool, index, motion.fields, 0);
        pool.velocity.set(scratch.velocity, index * 3);
    }
}
