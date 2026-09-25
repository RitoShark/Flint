import type { Texture } from './data';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector';
export * from '../space';
export { createPose, type Pose } from './pose';
export type MeshRange = { name: string; startIndex: number; indexCount: number; startVertex?: number; vertexCount?: number };
export type MeshGeometry = {
    positions: Float32Array; indices: Uint32Array; normals: Float32Array | null; uvs: Float32Array | null;
    ranges: readonly MeshRange[]; skinIndices: Uint8Array | Uint16Array | null; skinWeights: Float32Array | null;
};
export type Bounds = Record<'min' | 'max', [number, number, number]>;
export interface Camera { position: Vector3; up: Vector3; getWorldDirection(output: Vector3): Vector3 }
export type FrameState = { camera: Camera };
export type EmitterSamplers = Record<'base' | 'mult' | 'color' | 'palette' | 'erosion' | 'normal' | 'reflection', Texture | null>;
