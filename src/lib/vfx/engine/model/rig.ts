import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scalar } from '@babylonjs/core/Maths/math.scalar';
import { CHAMPION_HEIGHT, FORWARD } from '../../space';

export type Point = readonly [number, number, number];
export interface Anchor {
    originAt(time: number): Point;
    basisInto(time: number, out: Float32Array): Float32Array;
}
export type Joints = (name: string) => Anchor | null;
export type Motion =
    | {readonly kind: 'still'}
    | {readonly kind: 'path'; readonly from: Point; readonly to: Point; readonly speed: number}
    | {readonly kind: 'orbit'; readonly radius: number; readonly period: number}
    | {readonly kind: 'bone'; readonly anchor: Anchor; readonly target: Anchor | null};
export type RigLife = 'once' | 'loop';
export interface RigModel {
    readonly motion: Motion;
    readonly life: RigLife;
    readonly height: number;
    readonly stopAt?: number | null;
    readonly joints?: Joints | null;
}
export const STAND_HEIGHT = CHAMPION_HEIGHT / 2;
export const RIG_PRESETS = {
    still: {motion: {kind: 'still'}, life: 'once', height: STAND_HEIGHT},
    burst: {motion: {kind: 'still'}, life: 'loop', height: STAND_HEIGHT},
    missile: {motion: flightPath(CHAMPION_HEIGHT * 6, CHAMPION_HEIGHT * 8), life: 'loop', height: STAND_HEIGHT},
    trail: {motion: {kind: 'orbit', radius: CHAMPION_HEIGHT * 1.5, period: 3}, life: 'once', height: STAND_HEIGHT},
} as const satisfies Record<string, RigModel>;
export type RigPreset = keyof typeof RIG_PRESETS;
export interface RigChoice { readonly preset: RigPreset; readonly rig: RigModel }
export const FIRST_RIG: RigChoice = {preset: 'still', rig: RIG_PRESETS.still};
const start = Vector3.Zero();
const end = Vector3.Zero();
const position = Vector3.Zero();
const basis = new Float32Array(9);

function orbitAngle(motion: Extract<Motion, {kind: 'orbit'}>, time: number): number {
    return motion.period > 0 ? time / motion.period * (2 * Math.PI) : 0;
}

function setPoint(target: Vector3, point: Point): void { target.set(point[0], point[1], point[2]); }
function point(vector: Vector3, height = 0): Point { return [vector.x, vector.y + height, vector.z]; }

export function flightPath(distance: number, speed: number): Motion {
    return {kind: 'path', speed, from: [-distance / 2, 0, 0], to: [distance / 2, 0, 0]};
}

export function originAt(motion: Motion, time: number, height = 0): Point {
    switch (motion.kind) {
        case 'still': position.setAll(0); break;
        case 'bone': setPoint(position, motion.anchor.originAt(time)); break;
        case 'orbit': {
            const angle = orbitAngle(motion, time);
            position.set(motion.radius * Math.cos(angle), 0, motion.radius * Math.sin(angle));
            break;
        }
        case 'path': {
            setPoint(start, motion.from);
            setPoint(end, motion.to);
            const duration = flightTime(motion);
            Vector3.LerpToRef(start, end, duration > 0 ? Scalar.Clamp(time / duration) : 1, position);
            break;
        }
    }
    return point(position, height);
}

export function targetAt(motion: Motion, time: number, height = 0): Point {
    if (motion.kind === 'path') setPoint(position, motion.to);
    else if (motion.kind === 'orbit') position.setAll(0);
    else if (motion.kind === 'bone') {
        setPoint(position, (motion.target ?? motion.anchor).originAt(time));
        if (!motion.target) position.x += CHAMPION_HEIGHT * 3;
    } else position.set(CHAMPION_HEIGHT * 3, 0, 0);
    return point(position, height);
}

export function facingAt(motion: Motion, time: number): Point {
    switch (motion.kind) {
        case 'still': return FORWARD;
        case 'bone': {
            const rotation = motion.anchor.basisInto(time, basis);
            position.set(rotation[2], 0, rotation[8]);
            break;
        }
        case 'path': position.set(motion.to[0] - motion.from[0], 0, motion.to[2] - motion.from[2]); break;
        case 'orbit': {
            const angle = orbitAngle(motion, time);
            position.set(-Math.sin(angle), 0, Math.cos(angle));
            break;
        }
    }
    return position.lengthSquared() > 0 ? point(position.normalize()) : FORWARD;
}

export function distance(from: Point, to: Point): number {
    setPoint(start, from);
    setPoint(end, to);
    return Vector3.Distance(start, end);
}

export function displacement(from: Point, to: Point): Point {
    setPoint(start, from);
    setPoint(end, to);
    end.subtractToRef(start, position);
    return point(position);
}

export function flightTime(motion: Motion): number {
    return motion.kind === 'path' && motion.speed > 0 ? distance(motion.from, motion.to) / motion.speed : 0;
}

export function landed(motion: Motion, time: number): boolean {
    const duration = flightTime(motion);
    return duration > 0 && time >= duration;
}

export function runLength(motion: Motion, span: number, tail = 0): number {
    if (motion.kind === 'orbit') return Math.max(span, motion.period);
    const flight = flightTime(motion);
    return flight > 0 ? flight + tail : span;
}

export function phaseAt(rig: RigModel, time: number, span: number, tail = 0): number {
    const duration = runLength(rig.motion, span, tail);
    return rig.life === 'loop' && duration > 0 ? time % duration : time;
}
