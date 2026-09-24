import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { FieldsModel, ValueCurve } from '../model/model';
import type { Point } from '../model/rig';
import { turnInto } from '../utils/basis';
import { Rng } from '../utils/Rng';
import { sampleCurve, sampleCurveInto } from '../utils/sampleCurve';

type Components = ArrayLike<number>;
export interface NoiseClock { last: number | null; fired: number }
export interface SampledReach { readonly centre: Point; readonly strength: number; readonly radius: number }
export interface SampledNoise {
    readonly centre: Point;
    readonly radius: number;
    readonly delta: number;
    readonly axes: Point;
    readonly kicks: number;
    readonly first: number;
    readonly slot: number;
}
export interface SampledFields {
    readonly acceleration: Float32Array;
    readonly attraction: readonly SampledReach[];
    readonly noise: readonly SampledNoise[];
    readonly drag: readonly SampledReach[];
    readonly orbital: readonly Point[];
    readonly origin: Point;
}
export interface FieldPlace { readonly origin: Point; readonly orientation: Float32Array | null }

export const noiseClock = (): NoiseClock => ({last: null, fired: 0});

export function impulsesOwed(clock: NoiseClock, rate: number, now: number): number {
    if (!Number.isFinite(rate) || !Number.isFinite(now)) return 0;
    let count = 1;
    if (clock.last !== null) {
        const elapsed = Math.trunc(rate * now) - Math.trunc(rate * clock.last);
        count = Number.isNaN(elapsed) ? 0 : Math.min(256, Math.max(0, elapsed));
    }
    if (count > 0) {
        clock.last = now;
        clock.fired += count;
    }
    return count;
}

export function prepareFields(fields: FieldsModel, phase: number, now: number, place: FieldPlace, clocks: NoiseClock[]): SampledFields {
    const scalar = (curve: ValueCurve) => sampleCurve(curve, phase)[0] ?? 0;
    const sampled = new Float32Array(3);
    const readDirection = (curve: ValueCurve, local = false): Float32Array => {
        sampled.fill(0);
        sampleCurveInto(curve, phase, sampled, 0);
        if (local && place.orientation) turnInto(place.orientation, sampled, 0);
        return sampled;
    };
    const centre = (curve: ValueCurve): Point => {
        readDirection(curve);
        return [place.origin[0] + sampled[0], place.origin[1] + sampled[1], place.origin[2] + sampled[2]];
    };
    const acceleration = new Float32Array(3);
    for (const field of fields.acceleration) {
        readDirection(field.acceleration, field.localSpace);
        for (let axis = 0; axis < 3; axis++) acceleration[axis] += sampled[axis];
    }
    const orbital: Point[] = [];
    const direction = Vector3.Zero();
    for (const field of fields.orbital) {
        Vector3.FromArrayToRef(readDirection(field.direction, field.localSpace), 0, direction);
        if (direction.lengthSquared() > 0) {
            direction.normalize();
            orbital.push([direction.x, direction.y, direction.z]);
        }
    }
    return {
        origin: place.origin,
        acceleration,
        orbital,
        attraction: fields.attraction.map(field => ({centre: centre(field.position), radius: scalar(field.radius), strength: scalar(field.acceleration)})),
        drag: fields.drag.map(field => ({centre: centre(field.position), radius: scalar(field.radius), strength: scalar(field.strength)})),
        noise: fields.noise.map((field, slot) => {
            const clock = clocks[slot] ??= noiseClock();
            const first = clock.fired;
            return {centre: centre(field.position), radius: scalar(field.radius), delta: scalar(field.velocityDelta), axes: field.axisFraction,
                kicks: impulsesOwed(clock, scalar(field.frequency), now), first, slot};
        }),
    };
}

const displacement = Vector3.Zero();
const velocity = Vector3.Zero();
const normal = Vector3.Zero();
const tangent = Vector3.Zero();
const perpendicular = Vector3.Zero();
const impulse = Vector3.Zero();

function difference(a: Components, b: Components, target: Vector3): void {
    target.set(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function inRange(position: Components, centre: Components, radius: number): boolean {
    difference(centre, position, displacement);
    return displacement.lengthSquared() <= radius * radius;
}

function addScaled(output: Float32Array, value: Components, factor: number): void {
    for (let component = 0; component < 3; component++) output[component] += value[component] * factor;
}

export function accelerateInto(output: Float32Array, acceleration: Components, dt: number): void {
    addScaled(output, acceleration, dt);
}

export function attractInto(output: Float32Array, position: Components, centre: Components, strength: number, radius: number, dt: number): void {
    if (!inRange(position, centre, radius)) return;
    Vector3.FromArrayToRef(output, 0, velocity);
    displacement.scaleAndAddToRef(strength * dt / Math.max(1, displacement.length()), velocity);
    velocity.toArray(output);
}

export function dragInto(output: Float32Array, position: Components, centre: Components, strength: number, radius: number, dt: number): void {
    if (!inRange(position, centre, radius)) return;
    Vector3.FromArrayToRef(output, 0, velocity);
    velocity.scaleInPlace(Math.max(0, 1 - strength * dt)).toArray(output);
}

function impulseSeed(serial: number, slot: number, ordinal: number): number {
    let hash = 2166136261;
    for (const word of [serial, slot, ordinal]) {
        for (let shift = 0; shift < 32; shift += 8) hash = Math.imul(hash ^ ((word >>> shift) & 255), 16777619);
    }
    return hash;
}

export function noiseInto(output: Float32Array, position: Components, field: SampledNoise, serial: number): void {
    if (!inRange(position, field.centre, field.radius)) return;
    const count = Math.min(256, Math.max(0, Math.trunc(field.kicks)));
    for (let index = 0; index < count; index++) {
        const random = new Rng(impulseSeed(serial, field.slot, field.first + index));
        impulse.set(random.range(-1, 1), random.range(-1, 1), random.range(-1, 1)).normalize();
        output[0] += impulse.x * field.delta * field.axes[0];
        output[1] += impulse.y * field.delta * field.axes[1];
        output[2] += impulse.z * field.delta * field.axes[2];
    }
}

export function orbitFieldInto(output: Float32Array, position: Components, centre: Components, axis: Components): void {
    normal.set(axis[0], axis[1], axis[2]);
    Vector3.FromArrayToRef(output, 0, velocity);
    const axial = Vector3.Dot(velocity, normal);
    normal.scaleToRef(axial, perpendicular);
    velocity.subtractToRef(perpendicular, perpendicular);
    const speed = perpendicular.length();
    if (speed <= 0.001) return;
    difference(position, centre, displacement);
    if (displacement.lengthSquared() === 0) return;
    displacement.normalize();
    if (Math.abs(1 - Vector3.Dot(normal, displacement)) <= 0.0001) return;
    Vector3.CrossToRef(displacement, normal, tangent);
    const length = tangent.length();
    if (length === 0) return;
    const sign = Vector3.Dot(tangent, perpendicular) < 0 ? -1 : 1;
    normal.scaleToRef(axial, velocity);
    tangent.scaleAndAddToRef(sign * speed / length, velocity);
    velocity.toArray(output);
}

export function applyFields(fields: SampledFields, output: Float32Array, position: Components, serial: number, dt: number): void {
    accelerateInto(output, fields.acceleration, dt);
    for (const field of fields.attraction) attractInto(output, position, field.centre, field.strength, field.radius, dt);
    for (const field of fields.noise) noiseInto(output, position, field, serial);
    for (const field of fields.drag) dragInto(output, position, field.centre, field.strength, field.radius, dt);
    for (const axis of fields.orbital) orbitFieldInto(output, position, fields.origin, axis);
}
