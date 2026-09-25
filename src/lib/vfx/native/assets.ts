import { decodeDdsToPng } from '../../api/texture';
import { readScbMesh, readSknMesh, readSklSkeleton, type SknMeshData, type ScbMeshData } from '../../api/mesh';
import { invokeCommand } from '../../api/core';
import type { MeshGeometry } from './types';
import type { BakedAnimationDTO } from '../../babylon/animationPlayer';
import type { NamedAsset } from '../bindings';
import { createPose } from './pose';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Engines/Extensions/engine.rawTexture';
function resolveAssetPath(assetPath: string, binPath: string): Promise<string> {
    return invokeCommand('resolve_asset_path', { assetPath, binPath }, { silent: true });
}
export async function loadTexture(asset: string, context: string, scene: Scene, cube = false): Promise<BaseTexture> {
    const path = await resolveTexturePath(asset, context);
    const url = (data: string) => data.startsWith('data:') ? data : `data:image/png;base64,${data}`;
    if (cube) {
        const faces = await invokeCommand<string[]>('read_vfx_cubemap', { path });
        const images = await Promise.all(faces.map(data => new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error(`Cubemap decode failed: ${asset}`));
            image.src = url(data);
        })));
        const size = images[0].width;
        const pixels = images.map(image => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(image, 0, 0);
            return new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer);
        });
        const texture = new RawCubeTexture(scene, pixels, size, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, false, false, Texture.BILINEAR_SAMPLINGMODE);
        texture.gammaSpace = false;
        return texture;
    }
    const decoded = await decodeDdsToPng(path);
    return new Promise((resolve, reject) => {
        const texture = new Texture(url(decoded.data), scene, true, false, Texture.BILINEAR_SAMPLINGMODE, () => resolve(texture), (_message, error) => { texture.dispose(); reject(error ?? new Error(`Texture decode failed: ${asset}`)); });
        texture.gammaSpace = false;
    });
}
export async function loadPose(skeleton: NamedAsset | null, animation: NamedAsset | null, context: string) {
    if (!skeleton)
        return null;
    const [rig, clip] = await Promise.all([
        loadSkeleton(skeleton.path, context),
        animation ? loadClip(animation.path, context) : null,
    ]);
    return createPose(rig, clip);
}
export async function loadSkeleton(asset: string, context: string) {
    return readSklSkeleton(await resolveAssetPath(asset, context));
}
export async function loadClip(asset: string, context: string): Promise<BakedAnimationDTO> {
    const path = await resolveAssetPath(asset, context);
    return invokeCommand<BakedAnimationDTO>('read_animation', { path });
}
export async function resolveTexturePath(asset: string, context: string): Promise<string> {
    const resolve = (assetPath: string) => invokeCommand<string>('resolve_asset_path', { assetPath, binPath: context }, { silent: true });
    try {
        return await resolve(asset);
    }
    catch (error) {
        const alternate = /\.dds$/i.test(asset) ? asset.replace(/\.dds$/i, '.tex')
            : /\.tex$/i.test(asset) ? asset.replace(/\.tex$/i, '.dds') : asset;
        if (alternate === asset)
            throw error;
        try {
            return await resolve(alternate);
        }
        catch {
            throw error;
        }
    }
}
export function meshGeometry(data: SknMeshData | ScbMeshData): MeshGeometry {
    return {
        positions: data.positions, normals: data.normals, uvs: data.uvs, indices: Uint32Array.from(data.indices),
        ranges: data.kind === 'skn' ? data.materials.map(m => ({ name: m.name, startIndex: m.start_index, indexCount: m.index_count })) : Object.entries(data.material_ranges).map(([name, [startIndex, indexCount]]) => ({ name, startIndex, indexCount })),
        skinIndices: data.kind === 'skn' ? data.bone_indices ?? null : null,
        skinWeights: data.kind === 'skn' ? data.bone_weights ?? null : null,
    };
}
export async function loadMesh(asset: string, context: string): Promise<MeshGeometry> {
    const path = await resolveAssetPath(asset, context);
    return meshGeometry(/\.skn$/i.test(path) ? await readSknMesh(path) : await readScbMesh(path));
}
