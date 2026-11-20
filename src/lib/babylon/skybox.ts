import { Scene } from '@babylonjs/core/scene';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CubeTexture } from '@babylonjs/core/Materials/Textures/cubeTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import * as api from '../api';

export interface BundledSkybox {
    mesh: Mesh;
    dispose: () => void;
}

export async function createBundledSkybox(
    scene: Scene,
    isCancelled?: () => boolean,
): Promise<BundledSkybox | null> {
    const faces = ['px', 'py', 'pz', 'nx', 'ny', 'nz'];
    const urls = await Promise.all(
        faces.map(async (f) => {
            const bytes = await api.getBundledSkyboxFace(f);
            return URL.createObjectURL(
                new Blob([bytes.buffer as ArrayBuffer], { type: 'image/webp' }),
            );
        }),
    );

    if (isCancelled?.()) {
        urls.forEach((u) => URL.revokeObjectURL(u));
        return null;
    }

    const box = CreateBox('skybox', { size: 100 }, scene);
    const mat = new StandardMaterial('skybox-mat', scene);
    mat.backFaceCulling = false;
    mat.disableLighting = true;
    mat.disableDepthWrite = true;
    mat.reflectionTexture = new CubeTexture('', scene, null, true, urls);
    mat.reflectionTexture.coordinatesMode = Texture.SKYBOX_MODE;
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    box.material = mat;
    box.infiniteDistance = true;
    box.isPickable = false;
    box.applyFog = false;
    box.renderingGroupId = 0;

    return {
        mesh: box,
        dispose: () => {
            try {
                mat.reflectionTexture?.dispose();
                mat.dispose();
                box.dispose();
            } catch {
                /* ignore */
            }
            urls.forEach((u) => URL.revokeObjectURL(u));
        },
    };
}
