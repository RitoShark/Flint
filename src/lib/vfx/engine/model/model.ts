import type { AssetRef, NamedAsset, MaterialPreview } from '../../bindings';
import type { CurveKey, ProbabilityTable } from './curve';
import { ADDRESS_MODE, type AddressMode, type BeamMode, type BlendMode, type ColorLookup, type DragMotion, type FixedOrbit, type LingerType, type QuadType, type SimpleOrientation, type StencilMode, type TrailMode, type TrailSmoothing, type UvMode } from './enums';
import type { Point } from './rig';
type Pair = readonly [number, number];
type Color = readonly [number, number, number, number];
type Curves<K extends string> = Readonly<Record<K, ValueCurve>>;
type Numbers<K extends string> = Readonly<Record<K, number>>;
type Flags<K extends string> = Readonly<Record<K, boolean>>;
export type ValueCurve = Readonly<{ constant: readonly number[]; keys: readonly CurveKey[]; tables: readonly ProbabilityTable[] }>;
export type Flipbook = Numbers<'frames' | 'start' | 'rate'> & Readonly<{ divisions: Pair; birthRate: ValueCurve; randomStart: boolean }>;
export type UvLayer = Curves<'scale' | 'rotation' | 'birthOffset' | 'birthScrollRate' | 'birthRotateRate' | 'scrollRate' | 'rotateRate'>
    & Flags<'flipU' | 'flipV' | 'scrollClamp'> & Readonly<{ book: Flipbook; emitterScrollRate: Pair; center: Pair; addressMode: AddressMode }>;
export function plainUvLayer(): UvLayer {
    const curve = (width: number, initial = 0): ValueCurve => ({ keys: [], tables: [], constant: Array(width).fill(initial) });
    return {
        center: [.5, .5], emitterScrollRate: [0, 0], addressMode: ADDRESS_MODE.wrap,
        flipU: false, flipV: false, scrollClamp: false,
        book: { start: 0, frames: 1, divisions: [1, 1], rate: 0, randomStart: false, birthRate: curve(1, 1) },
        scale: curve(2, 1), rotation: curve(1), rotateRate: curve(1), birthRotateRate: curve(1),
        birthOffset: curve(2), birthScrollRate: curve(2), scrollRate: curve(2),
    };
}
export type SpawnShape = Readonly<
    { kind: 'point'; offset: Point } | { kind: 'box'; size: Point; volume: boolean }
    | { kind: 'sphere'; radius: number; volume: boolean } | { kind: 'cylinder'; radius: number; height: number; volume: boolean }
    | { kind: 'legacy'; offset: ValueCurve; translation: ValueCurve; angles: readonly ValueCurve[]; axes: readonly Point[] }
>;
export const POINT_SHAPE: SpawnShape = { offset: [0, 0, 0], kind: 'point' };
export type TrailModel = Numbers<'maxAddedPerFrame' | 'cutoff'> & Readonly<{ mode: TrailMode; smoothing: TrailSmoothing; tiling: ValueCurve }>;
export type BeamModel = Curves<'tiling' | 'colorByDistance'> & Readonly<{ mode: BeamMode; trailMode: TrailMode; segments: number; colorBoundToDistance: boolean; sourceOffset: Point; targetOffset: Point }>;
export type LingerModel = Readonly<Record<'rotation' | 'scale' | 'color' | 'acceleration' | 'velocity' | 'drag', ValueCurve | null>>;
export type PaletteModel = Curves<'selector' | 'scrollU' | 'scrollV' | 'mix'> & Readonly<{ texture: NamedAsset | null; count: number; addressMode: AddressMode }>;
export type ErosionModel = Curves<'mixer' | 'drive'> & Numbers<'driveSource' | 'featherIn' | 'featherOut' | 'sliceWidth'> & Readonly<{ map: NamedAsset | null; addressMode: AddressMode; lingerDrive: ValueCurve | null }>;
export type DistortionModel = Numbers<'strength' | 'mode'> & Readonly<{ map: NamedAsset | null }>;
export type ReflectionModel = Numbers<'fresnel' | 'reflectionFresnel' | 'opacityDirect' | 'opacityGlancing'> & Readonly<{ fresnelColor: Color; reflectionFresnelColor: Color; map: NamedAsset | null }>;
export type SoftModel = Numbers<'beginIn' | 'deltaIn' | 'beginOut' | 'deltaOut'>;
export type LegacySimpleModel = Curves<'birthScale' | 'scale' | 'birthRotation' | 'birthRotationalVelocity' | 'rotation'>
    & Flags<'lockedToEmitter' | 'hasFixedOrbit' | 'scaleUpFromOrigin'>
    & Readonly<{ scaleBias: Pair; particleBind: Pair; uvScrollRate: Pair; fixedOrbitType: FixedOrbit; orientation: SimpleOrientation }>;
export type MeshModel = Flags<'alignPitch' | 'alignYaw' | 'skinned'> & Readonly<{
    asset: AssetRef; path: string | null; skeleton: NamedAsset | null; animation: NamedAsset | null;
    animationVariants: readonly NamedAsset[]; submeshes: readonly string[]; submeshesAlways: readonly string[];
}>;
export type EmissionSurfaceModel = Readonly<{
    kind: 'mesh' | 'skeleton'; mesh: NamedAsset | null; skeleton: NamedAsset | null; animation: NamedAsset | null;
    submeshes: readonly string[]; joints: readonly string[]; scale: number; maxJointWeights: number; useNormal: boolean;
}>;
export type InheritanceModel = Readonly<{ mode: number; offset: ValueCurve }>;
export type ChildSetModel = Readonly<{
    children: readonly (SystemModel | null)[]; bones: readonly string[]; probability: ValueCurve;
    onDeath: boolean; inheritance: InheritanceModel | null;
}>;
export type AccelerationFieldModel = Curves<'acceleration'> & Flags<'localSpace'>;
export type AttractionFieldModel = Curves<'position' | 'acceleration' | 'radius'>;
export type NoiseFieldModel = Curves<'position' | 'frequency' | 'radius' | 'velocityDelta'> & Readonly<{ axisFraction: Point }>;
export type DragFieldModel = Curves<'position' | 'radius' | 'strength'>;
export type OrbitalFieldModel = Curves<'direction'> & Flags<'localSpace'>;
export type FieldsModel = Readonly<{
    acceleration: readonly AccelerationFieldModel[]; attraction: readonly AttractionFieldModel[];
    noise: readonly NoiseFieldModel[]; drag: readonly DragFieldModel[]; orbital: readonly OrbitalFieldModel[];
}>;
type EmitterCurves = Curves<
    'rate' | 'particleLifetime' | 'birthVelocity' | 'acceleration' | 'drag' | 'birthDrag' | 'velocity' | 'worldAcceleration'
    | 'bindWeight' | 'emitterPosition' | 'rotation0' | 'birthRotation0' | 'birthRotationalVelocity0' | 'birthRotationalAcceleration'
    | 'birthOrbitalVelocity' | 'scale0' | 'birthScale0' | 'color' | 'birthColor'
>;
type EmitterFlags = Flags<
    'simple' | 'disabled' | 'singleParticle' | 'sharedRandom' | 'emitterSpace' | 'localOrientation'
    | 'particleLocalOrientation' | 'uniformScale' | 'pivotUp' | 'rotationEnabled' | 'directionOriented' | 'groundLayer' | 'backfaceCull'
>;
type EmitterNumbers = Numbers<
    'index' | 'listIndex' | 'timeBeforeFirstEmission' | 'particleLinger' | 'emitterLinger'
    | 'directionVelocityScale' | 'directionVelocityMinScale' | 'pass' | 'miscRenderFlags' | 'alphaRef' | 'stencilRef' | 'depthPushPull'
>;
export type EmitterModel = EmitterCurves & EmitterFlags & EmitterNumbers & Readonly<{
    name: string; lifetime: number | null; shape: SpawnShape;
    rotationOverride: Point; scaleOverride: Point; translationOverride: Point;
    lingerType: LingerType; linger: LingerModel | null; legacySimple: LegacySimpleModel | null;
    palette: PaletteModel | null; erosion: ErosionModel | null; distortion: DistortionModel | null;
    reflection: ReflectionModel | null; soft: SoftModel | null; customMaterial: MaterialPreview | null;
    texture: NamedAsset | null; multTexture: NamedAsset | null; colorTexture: NamedAsset | null;
    uv: UvLayer; multUv: UvLayer | null; uvMode: UvMode; blendMode: BlendMode;
    lookupX: ColorLookup; lookupY: ColorLookup; lookupOffsets: Pair; lookupScales: Pair;
    quadType: QuadType | null; stencilMode: StencilMode; primitiveClass: string | null; primitiveName: string | null;
    mesh: MeshModel | null; trail: TrailModel | null; beam: BeamModel | null;
    childSet: ChildSetModel | null; fields: FieldsModel | null; emissionSurface: EmissionSurfaceModel | null; depthBias: Pair;
}>;
export type SystemModel = Readonly<{
    emitters: readonly EmitterModel[]; entry: string | null; name: string | null;
    transform: readonly number[] | null; dragMotion: DragMotion; buildUpTime: number;
}>;
