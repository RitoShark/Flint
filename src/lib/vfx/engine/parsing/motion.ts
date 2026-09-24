import { BEAM_MODE, FIXED_ORBIT, SIMPLE_ORIENTATION, TRAIL_MODE, TRAIL_SMOOTHING } from '../model/enums';
import type { BeamModel, FieldsModel, LegacySimpleModel, LingerModel, SpawnShape, TrailModel } from '../model/model';
import { components, Properties } from './properties';

export function spawnShape(p: Properties): SpawnShape {
    const volume = (p.number('flags') & 1) !== 0;
    if (p.is('VfxShapeSphere')) return { kind: 'sphere', volume, radius: p.number('radius') };
    if (p.is('VfxShapeBox')) return { kind: 'box', volume, size: p.vec3('Size') };
    if (p.is('VfxShapeCylinder')) return { kind: 'cylinder', volume, radius: p.number('radius'), height: p.number('height') };
    if (p.is('VfxShape') || p.is('VfxShapeLegacy')) {
        return {
            kind: 'legacy', offset: p.curve('emitOffset', [0, 0, 0]),
            translation: p.curve('birthTranslation', [0, 0, 0]),
            angles: p.list('emitRotationAngles').map(node => new Properties(node).asCurve()),
            axes: p.list('emitRotationAxes').flatMap(node => {
                const values = components(node);
                return values && values.length >= 3 ? [[values[0], values[1], values[2]] as [number, number, number]] : [];
            }),
        };
    }
    return { kind: 'point', offset: p.is('VfxShapePointDoNotUse') ? p.vec3('emitOffset') : [0, 0, 0] };
}

export function legacySimple(p: Properties): LegacySimpleModel | null {
    if (!p.valid) return null;
    return {
        scale: p.curve('scale', [1]), birthScale: p.curve('birthScale', [1]), scaleBias: p.vec2('scaleBias', [1, 1]),
        rotation: p.curve('rotation'), birthRotation: p.curve('birthRotation'),
        birthRotationalVelocity: p.curve('birthRotationalVelocity'),
        orientation: p.enum('orientation', SIMPLE_ORIENTATION, SIMPLE_ORIENTATION.camera),
        hasFixedOrbit: p.bool('hasFixedOrbit'), fixedOrbitType: p.enum('fixedOrbitType', FIXED_ORBIT, FIXED_ORBIT.worldY),
        particleBind: p.vec2('particleBind'), uvScrollRate: p.vec2('uvScrollRate'),
        lockedToEmitter: p.bool('lockedToEmitter'), scaleUpFromOrigin: p.bool('scaleUpFromOrigin'),
    };
}

export function linger(p: Properties): LingerModel | null {
    if (!p.valid) return null;
    return {
        scale: p.bool('UseLingerScale') ? p.curve('LingerScale', [1, 1, 1]) : null,
        rotation: p.bool('UseLingerRotation') ? p.curve('LingerRotation', [0, 0, 0]) : null,
        color: p.bool('UseSeparateLingerColor') ? p.curve('SeparateLingerColor', [1, 1, 1, 1]) : null,
        drag: p.bool('UseKeyedLingerDrag') ? p.curve('KeyedLingerDrag', [0, 0, 0]) : null,
        velocity: p.bool('UseKeyedLingerVelocity') ? p.curve('KeyedLingerVelocity', [0, 0, 0]) : null,
        acceleration: p.bool('UseKeyedLingerAcceleration') ? p.curve('KeyedLingerAcceleration', [0, 0, 0]) : null,
    };
}

export function trail(primitive: Properties): TrailModel | null {
    if (!primitive.is('VfxPrimitiveCameraTrail') && !primitive.is('VfxPrimitiveArbitraryTrail')) return null;
    const p = primitive.child('mTrail');
    return {
        tiling: p.curve('mBirthTilingSize', [0, 0, 0]), cutoff: p.number('mCutoff'),
        maxAddedPerFrame: p.number('mMaxAddedPerFrame'),
        smoothing: p.enum('mSmoothingMode', TRAIL_SMOOTHING, TRAIL_SMOOTHING.off),
        mode: p.enum('mMode', TRAIL_MODE, TRAIL_MODE.default),
    };
}

export function beam(primitive: Properties): BeamModel | null {
    if (!primitive.is('VfxPrimitiveBeam') && !primitive.is('VfxPrimitiveCameraSegmentBeam')) return null;
    const p = primitive.child('mBeam');
    return {
        mode: p.enum('mMode', BEAM_MODE, BEAM_MODE.default),
        trailMode: p.enum('mTrailMode', TRAIL_MODE, TRAIL_MODE.default), segments: p.number('mSegments'),
        sourceOffset: p.vec3('mLocalSpaceSourceOffset'), targetOffset: p.vec3('mLocalSpaceTargetOffset'),
        tiling: p.curve('mBirthTilingSize', [0, 0, 0]),
        colorByDistance: p.curve('mAnimatedColorWithDistance', [1, 1, 1, 1]),
        colorBoundToDistance: p.bool('mIsColorBindedWithDistance'),
    };
}

export function forces(p: Properties): FieldsModel | null {
    const lists: FieldsModel = {
        acceleration: p.objects('fieldAccelerationDefinitions').map(field => ({
            localSpace: field.bool('isLocalSpace', true), acceleration: field.curve('acceleration', [0, 0, 0]),
        })),
        attraction: p.objects('fieldAttractionDefinitions').map(field => ({
            radius: field.curve('radius'), position: field.curve('Position', [0, 0, 0]), acceleration: field.curve('acceleration'),
        })),
        drag: p.objects('fieldDragDefinitions').map(field => ({
            radius: field.curve('radius'), position: field.curve('Position', [0, 0, 0]), strength: field.curve('strength'),
        })),
        noise: p.objects('fieldNoiseDefinitions').map(field => ({
            radius: field.curve('radius'), position: field.curve('Position', [0, 0, 0]),
            frequency: field.curve('frequency'), velocityDelta: field.curve('velocityDelta'), axisFraction: field.vec3('axisFraction'),
        })),
        orbital: p.objects('fieldOrbitalDefinitions').map(field => ({
            direction: field.curve('direction', [0, 1, 0]), localSpace: field.bool('isLocalSpace', true),
        })),
    };
    return Object.values(lists).some(list => list.length) ? lists : null;
}
