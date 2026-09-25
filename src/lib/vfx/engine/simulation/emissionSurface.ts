import type { EmitterModel } from '../model/model';
import type { Rng } from '../utils/Rng';
export type SurfaceBirth = Readonly<{ position: Float32Array; normal: Float32Array }>;
export type EmissionSampler = { sample: (time: number, random: Rng, output: SurfaceBirth) => boolean };
export type EmissionSurfaces = ReadonlyMap<EmitterModel, EmissionSampler>;
