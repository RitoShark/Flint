import { ADDRESS_MODE } from '../model/enums';
import type { EmitterModel, EmissionSurfaceModel, Flipbook, MeshModel, UvLayer } from '../model/model';
import { namedAsset, Properties } from './properties';

export function textureLayer(p: Properties, mult = false, shared?: Flipbook): UvLayer {
    const name = (base: string) => mult ? `${base}Mult` : base;
    return {
        book: {
            frames: shared?.frames ?? (mult ? 1 : p.number('numFrames', 1)),
            start: shared?.start ?? (mult ? 0 : p.number('startFrame')),
            rate: shared?.rate ?? (mult ? 0 : p.number('frameRate')),
            birthRate: shared?.birthRate ?? p.curve('birthFrameRate', [1]),
            randomStart: shared?.randomStart ?? (!mult && p.bool('isRandomStartFrame')),
            divisions: p.vec2(name('texDiv'), [1, 1]),
        },
        center: p.vec2(name('uvTransformCenter'), [0.5, 0.5]),
        scale: p.curve(name('uvScale'), [1, 1]), rotation: p.curve(name('uvRotation')),
        emitterScrollRate: p.vec2(name('emitterUvScrollRate')),
        birthOffset: p.curve(name('birthUVOffset'), [0, 0]),
        birthScrollRate: p.curve(name('birthUvScrollRate'), [0, 0]),
        birthRotateRate: p.curve(name('birthUvRotateRate')),
        scrollRate: p.curve(mult ? 'ParticleIntegratedUvScrollMult' : 'particleUVScrollRate', [0, 0]),
        rotateRate: p.curve(mult ? 'ParticleIntegratedUvRotateMult' : 'particleUVRotateRate'),
        flipU: p.bool(mult ? 'TextureMultFilpU' : 'TextureFlipU'),
        flipV: p.bool(mult ? 'TextureMultFilpV' : 'TextureFlipV'),
        scrollClamp: p.bool(name('uvScrollClamp')),
        addressMode: p.enum(mult ? 'texAddressModeMult' : 'texAddressModeBase', ADDRESS_MODE, ADDRESS_MODE.wrap),
    };
}

export function particleMesh(primitive: Properties): MeshModel | null {
    const p = primitive.child('mMesh');
    const skin = p.get('mMeshName');
    const rig = p.get('mMeshSkeletonName');
    const usable = (path: string) => !!path && !/(^|\/)doesnotexist\.[^/]*$/i.test(path);
    const skinned = skin?.type === 'asset' && skin.asset !== null && usable(skin.path)
        && rig?.type === 'asset' && usable(rig.path);
    const mesh = skinned ? skin : p.get('mSimpleMeshName');
    if (mesh?.type !== 'asset' || mesh.asset === null || !usable(mesh.path)) return null;
    if (!skinned && !/\.(scb|tmesh|gmesh)$/i.test(mesh.path)) return null;
    return {
        asset: mesh.asset, path: mesh.path, skinned,
        skeleton: skinned ? namedAsset(rig) : null,
        animation: p.asset('mAnimationName'),
        animationVariants: p.list('mAnimationVariants').flatMap(node => {
            const asset = namedAsset(node);
            return asset ? [asset] : [];
        }),
        alignPitch: primitive.bool('AlignPitchToCamera'), alignYaw: primitive.bool('AlignYawToCamera'),
        submeshes: p.hashes('mSubmeshesToDraw'), submeshesAlways: p.hashes('mSubmeshesToDrawAlways'),
    };
}

export function emissionSurface(p: Properties): EmissionSurfaceModel | null {
    if (!p.valid) return null;
    const nested = p.child('EmissionSurface');
    const surface = nested.valid ? nested : p;
    if (p.get('EmissionSurface') !== null && !surface.is('VfxEmissionSkeletonData') && !surface.is('VfxEmissionMeshData')) return null;
    return {
        kind: surface.is('VfxEmissionSkeletonData') ? 'skeleton' : 'mesh',
        mesh: surface.asset('meshName'), skeleton: surface.asset('skeletonName'), animation: surface.asset('AnimationName'),
        submeshes: surface.hashes('Submeshes'), joints: surface.hashes('JointMask'), scale: surface.number('meshScale', 1),
        maxJointWeights: Math.min(4, Math.max(0, Math.trunc(surface.number('maxJointWeights', 4)))),
        useNormal: surface.bool('useSurfaceNormalForBirthPhysics', true),
    };
}

type ShaderFeatures = Pick<EmitterModel, 'palette' | 'erosion' | 'distortion' | 'reflection' | 'soft'>;

export function shaderFeatures(p: Properties): ShaderFeatures {
    const palette = p.child('paletteDefinition');
    const erosion = p.child('alphaErosionDefinition');
    const distortion = p.child('distortionDefinition');
    const reflection = p.child('reflectionDefinition');
    const soft = p.child('softParticleParams');
    const address = erosion.enum('erosionMapAddressMode', ADDRESS_MODE, ADDRESS_MODE.clamp);
    return {
        palette: palette.valid ? {
            texture: palette.asset('paletteTexture'), count: palette.number('paletteCount', 1),
            selector: palette.curve('paletteSelector', [0, 0, 0]),
            mix: palette.curve('palleteSrcMixColor', [0.299, 0.587, 0.114, 0]),
            scrollU: palette.curve('PaletteUAnimationCurve'), scrollV: palette.curve('PaletteVAnimationCurve'),
            addressMode: palette.enum('PaletteTextureAddressMode', ADDRESS_MODE, ADDRESS_MODE.mirror),
        } : null,
        erosion: erosion.valid ? {
            map: erosion.asset('erosionMapName'),
            addressMode: address === ADDRESS_MODE.mirror ? ADDRESS_MODE.clamp : address === ADDRESS_MODE.clamp ? ADDRESS_MODE.mirror : address,
            drive: erosion.curve('erosionDriveCurve', [1]), mixer: erosion.curve('erosionMapChannelMixer', [0, 0, 0, 1]),
            lingerDrive: erosion.bool('UseLingerErosionDriveCurve') ? erosion.curve('LingerErosionDriveCurve', [1]) : null,
            driveSource: erosion.number('erosionDriveSource'), featherIn: erosion.number('erosionFeatherIn', 0.1),
            featherOut: erosion.number('erosionFeatherOut', 0.1), sliceWidth: erosion.number('erosionSliceWidth', 1.5),
        } : null,
        distortion: distortion.valid ? {
            map: distortion.asset('normalMapTexture'), strength: distortion.number('distortion'), mode: distortion.number('distortionMode', 1),
        } : null,
        reflection: reflection.valid ? {
            map: reflection.asset('reflectionMapTexture'), fresnel: reflection.number('fresnel', 1),
            fresnelColor: reflection.vec4('fresnelColor'), reflectionFresnel: reflection.number('reflectionFresnel', 1),
            reflectionFresnelColor: reflection.vec4('reflectionFresnelColor', [1, 1, 1, 1]),
            opacityDirect: reflection.number('reflectionOpacityDirect'), opacityGlancing: reflection.number('reflectionOpacityGlancing', 1),
        } : null,
        soft: soft.valid ? {
            beginIn: soft.number('beginIn'), deltaIn: soft.number('deltaIn'), beginOut: soft.number('beginOut'), deltaOut: soft.number('deltaOut'),
        } : null,
    };
}
