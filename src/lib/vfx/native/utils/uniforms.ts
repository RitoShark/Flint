import type { Texture } from '../data';
import type { MaterialPreview } from '../../bindings';
import { UV_MODE, type UvMode, type BlendMode } from '../../engine/model/enums';
import type { EmitterModel, UvLayer, PaletteModel, ErosionModel, DistortionModel, ReflectionModel, SoftModel } from '../../engine/model/model';
import { sampleCurve } from '../../engine/utils/sampleCurve';
import type { EmitterSamplers } from '../types';
import type { FragmentTests } from './blend';
import { drawsFixedAlphaUv } from './drawKind';
import { FRAME, SCENE_DEPTH, VIEWPORT, DEPTH_RANGE } from './frame';
import { drawsPalette, paletteRow } from './palette';
import { fresnelLanes, reflectionLanes, reflectionTint } from './reflection';
import { fadeOf, softParams, softControl } from './softParticle';
import { cellSize } from './uvTransform';
export type DepthBias = readonly [number, number];
export interface DepthOffset { readonly bias: DepthBias; readonly pushPull: number }
export interface LayerDraws { readonly ramp: boolean; readonly sheen: boolean; readonly fade: boolean }
export interface QuadLayers {
    readonly customMaterial?: MaterialPreview | null;
    readonly base: UvLayer; readonly mult: UvLayer | null; readonly multTexture: Texture | null; readonly mode: UvMode;
    readonly colorTexture: Texture | null; readonly palette: PaletteModel | null; readonly paletteTexture: Texture | null;
    readonly erosion: ErosionModel | null; readonly erosionTexture: Texture | null;
    readonly distortion: DistortionModel | null; readonly normalTexture: Texture | null;
    readonly reflection: ReflectionModel | null; readonly reflectionTexture: Texture | null;
    readonly soft: SoftModel | null; readonly ground: boolean;
}
export type Defines = Readonly<Record<string, number | string>>;
export const OVERLAY: DepthBias = [-1, -1];
export const ALPHA_LOCK = { none: 0, corner: 1, unscrolled: 2 } as const;
export const SHEEN = { none: 0, drawn: 1, texel: 2 } as const;
export const offsets = (bias: DepthBias) => bias.some(value => value !== 0);
export const polygonOffsetOf = (bias: DepthBias) => ({ polygonOffset: offsets(bias), polygonOffsetFactor: bias[0], polygonOffsetUnits: bias[1] });
export function uniforms<T extends Record<string, unknown>>(values: T): { [K in keyof T]: { value: T[K] } } {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])) as { [K in keyof T]: { value: T[K] } };
}
function flags(values: Record<string, boolean>): Defines {
    return Object.fromEntries(Object.keys(values).filter(key => values[key]).map(key => [key, '']));
}
export function layersOf(emitter: EmitterModel, textures: EmitterSamplers, enabled: LayerDraws): QuadLayers {
    return {
        base: emitter.uv, mult: emitter.multUv, mode: emitter.uvMode, multTexture: textures.mult,
        colorTexture: enabled.ramp ? textures.color : null, customMaterial: emitter.customMaterial,
        palette: emitter.palette, paletteTexture: textures.palette,
        erosion: drawsFixedAlphaUv(emitter) ? null : emitter.erosion, erosionTexture: textures.erosion,
        reflection: enabled.sheen ? emitter.reflection : null, reflectionTexture: enabled.sheen ? textures.reflection : null,
        distortion: emitter.distortion, normalTexture: textures.normal,
        soft: enabled.fade ? fadeOf(emitter) : null, ground: emitter.groundLayer,
    };
}
export const multiplies = (layers: QuadLayers) => !!layers.mult && !!layers.multTexture;
export const groundDefines = (layers: QuadLayers) => flags({ GROUND_LAYER: layers.ground });
export function colorDefines(layers: QuadLayers): Defines {
    return flags({ HAS_PALETTE: !!layers.paletteTexture && drawsPalette(layers.palette),
        HAS_RAMP: !!layers.colorTexture && !layers.erosion && !(layers.mult && layers.mode === UV_MODE.lockAlpha),
        RAMP_AT_MULT: !!layers.mult });
}
export function colorUniforms(layers: QuadLayers) {
    const palette = layers.paletteTexture && drawsPalette(layers.palette) ? layers.palette : null;
    const mix = palette ? sampleCurve(palette.mix, 0) : [];
    return uniforms({ mapRamp: layers.colorTexture, mapPalette: layers.paletteTexture,
        addressPalette: palette?.addressMode ?? 0, paletteRow: palette ? paletteRow(palette) : 0,
        paletteMix: Array.from({ length: 4 }, (_, axis) => mix[axis] ?? 0), paletteScroll: [0, 0] });
}
export const erosionDefines = (model: ErosionModel | null, texture: Texture | null) => flags({ EROSION: !!model, HAS_MAP_EROSION: !!model && !!texture });
export function erosionUniforms(model: ErosionModel | null, texture: Texture | null) {
    const mix = model ? sampleCurve(model.mixer, 0) : [0, 0, 0, 1];
    return uniforms({ mapErosion: texture, addressErosion: model?.addressMode ?? 0,
        erosionDefault: Array(4).fill(model?.map?.asset == null ? 1 : 0) as number[],
        erosionMix: Array.from({ length: 4 }, (_, axis) => mix[axis] ?? 0),
        featherRate: [model?.featherIn ?? 0, model?.featherOut ?? 0].map(value => 1 / Math.max(.0001, value)),
        sliceWidth: model?.sliceWidth ?? 0 });
}
export const distortionDefines = (model: DistortionModel | null, texture: Texture | null) => flags({ DISTORTS: !!model, HAS_NORMAL: !!model && !!texture });
export const distortionUniforms = (model: DistortionModel | null, texture: Texture | null) => uniforms({ warp: model?.strength ?? 0, mapNormal: texture, frame: FRAME, viewport: VIEWPORT });
export const sheenDefines = (model: ReflectionModel | null, texture: Texture | null, kind: number): Defines => ({ SHEEN: kind, ...flags({ REFLECTS: !!model?.map && !!texture }) });
export const sheenUniforms = (model: ReflectionModel | null, texture: Texture | null) => uniforms({ fresnel: [...fresnelLanes(model)], reflection: [...reflectionLanes(model)], reflectionTint: [...reflectionTint(model)], mapReflection: texture });
export const softDefines = (model: SoftModel | null) => flags({ SOFT: !!model });
export const softUniforms = (mode: BlendMode, model: SoftModel | null) => uniforms({
    softParams: model ? [...softParams(model)] : [0, 0, 0, 0], softControl: [...softControl(mode)],
    sceneDepth: model ? SCENE_DEPTH : null, depthRange: DEPTH_RANGE,
});
export function layerUniforms(texture: Texture | null, layers: QuadLayers, tests: FragmentTests) {
    const uv = (layer: UvLayer | null) => ({ cell: layer ? cellSize(layer) : [1, 1], center: layer ? [...layer.center] : [.5, .5],
        flip: layer ? [Number(layer.flipU), Number(layer.flipV)] : [0, 0], address: layer?.addressMode ?? 0 });
    const base = uv(layers.base), mult = uv(layers.mult);
    return { ...uniforms({ map: texture, alphaRef: tests.alphaRef, ...base, mapMult: layers.multTexture,
        cellMult: mult.cell, centerMult: mult.center, flipMult: mult.flip, addressMult: mult.address }),
        ...colorUniforms(layers), ...erosionUniforms(layers.erosion, layers.erosionTexture),
        ...distortionUniforms(layers.distortion, layers.normalTexture), ...sheenUniforms(null, null) };
}
export function layerDefines(texture: Texture | null, layers: QuadLayers): Defines {
    return { ...flags({ HAS_MAP: !!texture, HAS_MAP_MULT: multiplies(layers) }),
        LOCK_ALPHA: layers.mode === UV_MODE.lockAlpha ? ALPHA_LOCK.corner : ALPHA_LOCK.none,
        ...colorDefines(layers), ...erosionDefines(layers.erosion, layers.erosionTexture),
        ...distortionDefines(layers.distortion, layers.normalTexture), SHEEN: SHEEN.none };
}
