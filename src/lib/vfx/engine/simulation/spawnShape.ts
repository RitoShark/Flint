import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { SpawnShape } from '../model/model';
import type { Point } from '../model/rig';
import type { Rng } from '../utils/Rng';
import { drawCurve } from '../utils/sampleCurve';

export interface Birth {
    readonly offset: Float32Array;
    readonly turn: Float32Array;
    turned: boolean;
}

export const AXES: Readonly<Record<'x' | 'y' | 'z', Point>> = {x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1]};
const scratch = new WeakMap<Birth, {rotation: Quaternion; next: Quaternion; matrix: Matrix; vector: Vector3; axis: Vector3}>();

export function birth(): Birth {
    return {offset: new Float32Array(3), turn: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1), turned: false};
}

export function sampleShape(shape: SpawnShape, rng: Rng, time: number, chance: number, output: Birth): void {
    let state = scratch.get(output);
    if (!state) {
        state = {rotation: Quaternion.Identity(), next: Quaternion.Identity(), matrix: Matrix.Identity(), vector: Vector3.Zero(), axis: Vector3.Zero()};
        scratch.set(output, state);
    }
    const {rotation, next, matrix, vector, axis} = state;
    rotation.set(0, 0, 0, 1);
    vector.setAll(0);
    output.turned = false;
    const rotate = (direction: Point, radians: number) => {
        if (radians === 0) return;
        output.turned = true;
        axis.copyFromFloats(...direction);
        if (axis.lengthSquared() === 0) return;
        Quaternion.RotationAxisToRef(axis, radians, next);
        rotation.multiplyToRef(next, rotation);
    };
    const fullTurn = 2 * Math.PI;
    switch (shape.kind) {
        case 'point':
            vector.copyFromFloats(...shape.offset);
            break;
        case 'legacy': {
            const offset = drawCurve(shape.offset, time, chance);
            const translation = drawCurve(shape.translation, time, chance);
            vector.set((offset[0] ?? 0) + (translation[0] ?? 0), (offset[1] ?? 0) + (translation[1] ?? 0), (offset[2] ?? 0) + (translation[2] ?? 0));
            shape.axes.forEach((direction, index) => {
                const angle = shape.angles[index];
                if (angle) rotate(direction, (drawCurve(angle, time, chance)[0] ?? 0) * Math.PI / 180);
            });
            break;
        }
        case 'box':
            vector.set(rng.range(-1, 1) * shape.size[0], rng.range(-1, 1) * shape.size[1], (shape.volume ? rng.range(-1, 1) : 1) * shape.size[2]);
            if (!shape.volume) {
                rotate(AXES.y, Math.floor(rng.unitFloat() * 4) * Math.PI / 2);
                rotate(AXES.z, Math.floor(rng.unitFloat() * 2) * Math.PI / 2);
            }
            break;
        case 'cylinder':
            vector.set((shape.volume ? rng.range(-1, 1) : 1) * shape.radius, rng.unitFloat() * shape.height, 0);
            rotate(AXES.y, rng.unitFloat() * fullTurn);
            break;
        case 'sphere':
            vector.x = (shape.volume ? rng.unitFloat() : 1) * shape.radius;
            rotate(AXES.y, rng.unitFloat() * fullTurn);
            rotate(AXES.z, rng.unitFloat() * fullTurn);
            break;
    }
    rotation.toRotationMatrix(matrix);
    for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++) output.turn[row * 3 + column] = matrix.m[column * 4 + row];
    }
    Vector3.TransformCoordinatesToRef(vector, matrix, vector);
    vector.toArray(output.offset);
}
