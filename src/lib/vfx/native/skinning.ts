import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { MeshGeometry, Pose } from './types';

export class SkinPalette {
    readonly matrices: Matrix[];
    private time = NaN;
    private readonly vertex = Vector3.Zero();
    private readonly transformed = Vector3.Zero();

    constructor(readonly pose: Pose) {
        this.matrices = Array.from(pose.influences, () => Matrix.Identity());
    }

    sample(time: number): void {
        if (time === this.time) return;
        this.pose.sample(time);
        this.pose.influences.forEach((slot, index) => {
            this.pose.inverseBind[slot].multiplyToRef(this.pose.worldMatrix(slot), this.matrices[index]);
        });
        this.time = time;
    }

    vertexInto(mesh: MeshGeometry, index: number, limit: number, output: Vector3): void {
        Vector3.FromArrayToRef(mesh.positions, index * 3, this.vertex);
        output.setAll(0);
        let total = 0;
        for (let part = 0; part < Math.min(4, Math.max(0, limit)); part++) {
            const offset = index * 4 + part;
            const influence = mesh.skinIndices?.[offset];
            const weight = mesh.skinWeights?.[offset] ?? 0;
            const matrix = influence === undefined ? undefined : this.matrices[influence];
            if (!matrix || !Number.isFinite(weight) || weight <= 0) continue;
            Vector3.TransformCoordinatesToRef(this.vertex, matrix, this.transformed);
            this.transformed.scaleAndAddToRef(weight, output);
            total += weight;
        }
        if (total > 0) output.scaleInPlace(1 / total);
        else output.copyFrom(this.vertex);
    }
}

export function normalizedWeights(mesh: MeshGeometry, influenceCount: number): Float32Array {
    const output = new Float32Array(Math.floor(mesh.positions.length / 3) * 4);
    for (let offset = 0; offset < output.length; offset += 4) {
        let total = 0;
        for (let channel = 0; channel < 4; channel++) {
            const index = mesh.skinIndices?.[offset + channel];
            const weight = mesh.skinWeights?.[offset + channel] ?? 0;
            if (index !== undefined && index >= 0 && index < influenceCount && Number.isFinite(weight) && weight > 0) {
                output[offset + channel] = weight;
                total += weight;
            }
        }
        if (total > 0) for (let channel = 0; channel < 4; channel++) output[offset + channel] /= total;
    }
    return output;
}
