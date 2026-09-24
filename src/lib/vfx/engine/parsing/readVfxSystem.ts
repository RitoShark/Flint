import type { MaterialPreview, VfxSystem, VfxValue } from '../../bindings';
import { nameHash } from '../../binHash';
import { BLEND_MODE, COLOR_LOOKUP, DRAG_MOTION, LINGER_TYPE, QUAD_TYPE, STENCIL_MODE, UV_MODE } from '../model/enums';
import type { ChildSetModel, EmitterModel, SystemModel } from '../model/model';
import { Properties, constant } from './properties';
import { emissionSurface, particleMesh, shaderFeatures, textureLayer } from './appearance';
import { beam, forces, legacySimple, linger, spawnShape, trail } from './motion';

const primitives = new Map(Object.entries(QUAD_TYPE).map(([name, value]) => [
    nameHash(`VfxPrimitive${name[0].toUpperCase()}${name.slice(1)}`), value,
]));

export function readVfxSystem(input: VfxSystem): SystemModel {
    const materials = new Map(input.materials.map(material => [material.hash, material]));
    const active = new Set<VfxValue>();

    function system(root: VfxValue, entry: string | null, name: string | null, depth: number): SystemModel {
        const p = new Properties(root);
        const emitters: EmitterModel[] = [];
        if (p.valid && depth <= 64 && !active.has(root)) {
            active.add(root);
            for (const simple of [false, true]) {
                const list = p.list(simple ? 'simpleEmitterDefinitionData' : 'complexEmitterDefinitionData');
                list.forEach((node, listIndex) => {
                    if (node.type !== 'struct') return;
                    const properties = new Properties(node);
                    const values = emitter(properties, materials);
                    emitters.push({
                        ...values, index: emitters.length, listIndex, simple,
                        childSet: children(properties.child('childParticleSetDefinition'), depth),
                    });
                });
            }
            active.delete(root);
        }
        return {
            entry, name: p.valid ? name : null, emitters,
            transform: p.matrix('transform'), buildUpTime: Math.max(0, p.number('buildUpTime')),
            dragMotion: (p.number('flags', 0xd4) & 0x100) ? DRAG_MOTION.analytic : DRAG_MOTION.stepped,
        };
    }

    function children(p: Properties, depth: number): ChildSetModel | null {
        if (!p.valid) return null;
        const inheritance = p.child('ParentInheritanceDefinition');
        return {
            onDeath: p.bool('childEmitOnDeath'), bones: p.strings('boneToSpawnAt'),
            probability: p.curve('childrenProbability'),
            inheritance: inheritance.valid ? {mode: inheritance.number('Mode'), offset: inheritance.curve('RelativeOffset', [0, 0, 0])} : null,
            children: p.list('childrenIdentifiers').map(node => {
                const identifier = new Properties(node);
                for (const key of ['effect', 'effectKey']) {
                    const root = identifier.get(key);
                    if (root?.type !== 'struct') continue;
                    if (active.has(root) || depth >= 64) return null;
                    return system(root, root.object?.entry ?? null, root.object?.name ?? null, depth + 1);
                }
                return null;
            }),
        };
    }

    return system(input.root, input.entry, input.name, 0);
}

type EmitterProperties = Omit<EmitterModel, 'index' | 'listIndex' | 'simple' | 'childSet'>;

function emitter(p: Properties, materials: ReadonlyMap<string, MaterialPreview>): EmitterProperties {
    const primitive = p.child('primitive');
    const legacy = legacySimple(p.child('LegacySimple'));
    const material = p.child('CustomMaterial').get('Material');
    const materialHash = material?.type === 'link' ? material.hash : material?.type === 'struct' ? material.object?.entry : undefined;
    const customMaterial = materials.get(materialHash ?? '') ?? null;
    const baseUv = textureLayer(p);
    const uv = legacy?.uvScrollRate.some(value => value !== 0)
        ? {...baseUv, emitterScrollRate: legacy.uvScrollRate} : baseUv;
    const mult = p.child('textureMult');
    const stencil = p.enum('stencilMode', STENCIL_MODE, STENCIL_MODE.disabled);
    const primitiveNode = primitive.node?.type === 'struct' ? primitive.node : null;
    return {
        name: p.text('emitterName'), disabled: p.bool('disabled'),
        rate: p.curve('rate'), particleLifetime: p.curve('particleLifetime', [3]),
        lifetime: p.optionalNumber('lifetime'), timeBeforeFirstEmission: p.number('timeBeforeFirstEmission'),
        singleParticle: p.bool('isSingleParticle'), sharedRandom: p.bool('ParticlesShareRandomValue'),
        birthVelocity: p.curve('birthVelocity', [0, 0, 0]), velocity: p.curve('velocity', [0, 0, 0]),
        acceleration: p.curve('acceleration', [0, 0, 0]), worldAcceleration: p.curve('worldAcceleration', [0, 0, 0]),
        drag: p.curve('drag', [0, 0, 0]), birthDrag: p.curve('birthDrag', [0, 0, 0]),
        birthOrbitalVelocity: p.curve('birthOrbitalVelocity', [0, 0, 0]),
        birthRotation0: p.curve('birthRotation0', [0, 0, 0]), rotation0: p.curve('rotation0', [0, 0, 0]),
        birthRotationalVelocity0: p.curve('birthRotationalVelocity0', [0, 0, 0]),
        birthRotationalAcceleration: p.curve('birthRotationalAcceleration', [0, 0, 0]),
        rotationOverride: p.vec3('rotationOverride'), translationOverride: p.vec3('translationOverride'), scaleOverride: p.vec3('scaleOverride', [1, 1, 1]),
        birthScale0: p.curve('birthScale0', [1, 1, 1]), scale0: p.curve('scale0', [1, 1, 1]),
        birthColor: p.curve('birthColor', [1, 1, 1, 1]), color: p.curve('Color', [1, 1, 1, 1]),
        bindWeight: legacy?.lockedToEmitter ? constant(1) : p.curve('bindWeight'),
        emitterPosition: p.curve('EmitterPosition', [0, 0, 0]), emitterSpace: !!legacy?.lockedToEmitter || p.bool('IsEmitterSpace'),
        localOrientation: p.bool('isLocalOrientation', true), particleLocalOrientation: p.bool('particleIsLocalOrientation'),
        uniformScale: p.bool('isUniformScale'), rotationEnabled: p.bool('isRotationEnabled'),
        directionOriented: p.bool('isDirectionOriented'), directionVelocityScale: p.number('directionVelocityScale'),
        directionVelocityMinScale: p.number('directionVelocityMinScale', 1), pivotUp: !!legacy?.scaleUpFromOrigin,
        legacySimple: legacy, shape: spawnShape(p.child('SpawnShape')), emissionSurface: emissionSurface(p.child('emissionSurfaceDefinition')),
        particleLinger: p.number('particleLinger'), emitterLinger: p.number('emitterLinger'),
        lingerType: p.enum('particleLingerType', LINGER_TYPE, LINGER_TYPE.maxLifetimeAfterEmitterDies), linger: linger(p.child('Linger')),
        fields: forces(p.child('fieldCollectionDefinition')),
        ...shaderFeatures(p),
        lookupX: p.enum('colorLookUpTypeX', COLOR_LOOKUP, COLOR_LOOKUP.lifetime),
        lookupY: p.enum('colorLookUpTypeY', COLOR_LOOKUP, COLOR_LOOKUP.constant),
        lookupOffsets: p.vec2('colorLookUpOffsets'), lookupScales: p.vec2('colorLookUpScales', [1, 1]),
        colorTexture: p.asset('particleColorTexture'), customMaterial,
        texture: customMaterial && !customMaterial.missing ? customMaterial.base?.texture ?? null : p.asset('texture'),
        uv, uvMode: p.enum('uvMode', UV_MODE, UV_MODE.default), multTexture: mult.asset('textureMult'),
        multUv: mult.valid ? textureLayer(mult, true, uv.book) : null,
        blendMode: p.enum('blendMode', BLEND_MODE, BLEND_MODE.add), pass: p.number('pass'), miscRenderFlags: p.number('miscRenderFlags'),
        groundLayer: p.bool('isGroundLayer'), alphaRef: p.number('alphaRef', 5) / 255,
        stencilMode: stencil, stencilRef: stencil === STENCIL_MODE.disabled ? 0 : p.number('stencilRef'),
        quadType: primitiveNode ? primitives.get(primitiveNode.classHash) ?? null : QUAD_TYPE.cameraQuad,
        primitiveClass: primitiveNode?.classHash ?? null, primitiveName: primitiveNode?.class ?? null,
        mesh: particleMesh(primitive), beam: beam(primitive), trail: trail(primitive),
        backfaceCull: !p.bool('disableBackfaceCull'), depthBias: p.vec2('depthBiasFactors'), depthPushPull: p.number('DepthPushPull'),
    };
}
