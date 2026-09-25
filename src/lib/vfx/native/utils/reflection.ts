import type { ReflectionModel } from '../../engine/model/model';
type Four = readonly [number, number, number, number];
const rgb = (value: readonly number[]): [number, number, number] => [value[0], value[1], value[2]];
export const fresnelLanes = (model: ReflectionModel | null): Four => model ? [...rgb(model.fresnelColor), model.fresnel] : [0, 0, 0, 1];
export const reflectionLanes = (model: ReflectionModel | null): Four => [model?.reflectionFresnel ?? 1, model?.opacityDirect ?? 0, model?.opacityGlancing ?? 1, 0];
export const reflectionTint = (model: ReflectionModel | null): readonly [number, number, number] => model ? rgb(model.reflectionFresnelColor) : [1, 1, 1];
