import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { AXIS_SIGN } from '../../space';
import type { Point } from '../model/rig';

export const AXIS = { x: 0, y: 1, z: 2 } as const;
const radians = Math.PI / 180;
const rotation = Quaternion.Identity();
const left = Matrix.Identity();
const right = Matrix.Identity();
const product = Matrix.Identity();
const forward = Vector3.Zero();
const across = Vector3.Zero();
const up = Vector3.Zero();
const vector = Vector3.Zero();

function readMatrix(source: Float32Array, offset: number, target: Matrix): void {
    Matrix.FromValuesToRef(
        source[offset], source[offset + 3], source[offset + 6], 0,
        source[offset + 1], source[offset + 4], source[offset + 7], 0,
        source[offset + 2], source[offset + 5], source[offset + 8], 0,
        0, 0, 0, 1, target,
    );
}

function writeMatrix(matrix: Matrix, output: Float32Array): Float32Array {
    for (let column = 0; column < 3; column++) {
        for (let row = 0; row < 3; row++) output[row * 3 + column] = matrix.m[column * 4 + row];
    }
    return output;
}

function writeAxes(x: Vector3, y: Vector3, z: Vector3, output: Float32Array): Float32Array {
    output.set([x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z]);
    return output;
}

export function standingInto(degrees: Float32Array, at: number, roll: number, out: Float32Array): Float32Array {
    Quaternion.RotationYawPitchRollToRef(degrees[at + 1] * radians, degrees[at] * radians, (degrees[at + 2] + roll) * radians, rotation);
    rotation.toRotationMatrix(product);
    return writeMatrix(product, out);
}

export function identityInto(out: Float32Array): Float32Array {
    out.fill(0, 0, 9);
    out[0] = out[4] = out[8] = 1;
    return out;
}

export function alongInto(direction: Float32Array, at: number, out: Float32Array): Float32Array {
    Vector3.FromArrayToRef(direction, at, forward);
    if (forward.lengthSquared() === 0) return identityInto(out);
    forward.normalize();
    up.set(0, 1, 0);
    Vector3.CrossToRef(up, forward, across);
    if (across.lengthSquared() < 1e-10) across.set(1, 0, 0);
    else across.normalize();
    Vector3.CrossToRef(forward, across, up);
    return writeAxes(across, up, forward, out);
}

export function axisInto(basis: Float32Array, axis: number, out: Float32Array, at: number): void {
    for (let component = 0; component < 3; component++) out[at + component] = basis[component * 3 + axis];
}

export function multiplyInto(a: Float32Array, b: Float32Array, out: Float32Array, at = 0): void {
    readMatrix(a, at, left);
    readMatrix(b, 0, right);
    right.multiplyToRef(left, product);
    writeMatrix(product, out);
}

export function turnInto(turn: Float32Array, values: Float32Array, at: number, from = 0): void {
    readMatrix(turn, from, left);
    Vector3.FromArrayToRef(values, at, vector);
    Vector3.TransformNormalToRef(vector, left, vector);
    vector.toArray(values, at);
}

export function yawInto(direction: Point, out: Float32Array): Float32Array {
    forward.set(direction[0], 0, direction[2]);
    if (forward.lengthSquared() === 0) return identityInto(out);
    forward.normalize();
    up.set(0, 1, 0);
    Vector3.CrossToRef(up, forward, across);
    return writeAxes(across, up, forward, out);
}

export function flightInto(direction: Point, out: Float32Array): Float32Array {
    forward.set(direction[0], 0, direction[2]);
    if (forward.lengthSquared() === 0) forward.set(0, 0, 1);
    else forward.normalize();
    up.set(0, -1, 0);
    Vector3.CrossToRef(forward, up, across);
    return writeAxes(across, forward, up, out);
}

export function mirrorInto(basis: Float32Array, at: number, out: Float32Array, to: number): void {
    readMatrix(basis, at, left);
    for (let cell = 0; cell < 9; cell++) {
        const row = Math.floor(cell / 3);
        const column = cell % 3;
        out[to + cell] = left.m[column * 4 + row] * AXIS_SIGN[row] * AXIS_SIGN[column];
    }
}

export function unscaleInto(basis: Float32Array, at: number, out: Float32Array, to: number, scale: Float32Array): void {
    readMatrix(basis, at, left);
    for (let column = 0; column < 3; column++) {
        Vector3.FromArrayToRef(left.m, column * 4, vector);
        const length = vector.length();
        scale[column] = length || 1;
        if (length) vector.scaleInPlace(1 / length);
        else vector.set(column === 0 ? 1 : 0, column === 1 ? 1 : 0, column === 2 ? 1 : 0);
        out[to + column] = vector.x;
        out[to + column + 3] = vector.y;
        out[to + column + 6] = vector.z;
    }
}
