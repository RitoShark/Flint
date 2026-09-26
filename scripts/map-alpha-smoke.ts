import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { applyMapAlpha } from '../src/lib/babylon/mapAlpha';
import { createMapTerrainMaterial, DEFAULT_MAP_ENV } from '../src/lib/babylon/mapTerrainMaterial';

const canvas = document.querySelector('canvas')!;
const engine = new Engine(canvas, false, { preserveDrawingBuffer: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0, 1, 0, 1);
const camera = new FreeCamera('camera', new Vector3(0, 0, -3), scene);
camera.setTarget(Vector3.Zero());
camera.mode = 1;
camera.orthoLeft = camera.orthoBottom = -1.2;
camera.orthoRight = camera.orthoTop = 1.2;
const mesh = CreatePlane('map', { size: 2 }, scene);
mesh.setVerticesData('uv2', mesh.getVerticesData('uv')!);
const dds = new Uint8Array(160);
dds.set([68, 68, 83, 32]);
const header = new DataView(dds.buffer);
for (const [offset, value] of [[4, 124], [8, 0x81007], [12, 8], [16, 8], [20, 32], [28, 1], [76, 32], [80, 4], [108, 0x1000]]) header.setUint32(offset, value, true);
dds.set([68, 88, 84, 49], 84);
for (let i = 0; i < 4; i++) dds.set([0, 0, 0, 248, 95, 95, 95, 95], 128 + i * 8);
const diffuse = await new Promise<Texture>((resolve, reject) => {
    const tex = new Texture('cutout.dds', scene, {
        buffer: dds.buffer, forcedExtension: '.dds', invertY: false, noMipmap: true,
        samplingMode: Texture.NEAREST_SAMPLINGMODE,
        onLoad: () => resolve(tex), onError: (message, error) => reject(new Error(`${message}: ${error}`)),
    });
});
diffuse.hasAlpha = true;
const rgba = new Uint8Array(8 * 8 * 4);
for (let i = 0; i < 64; i++) rgba.set(i % 4 < 2 ? [0, 0, 0, 0] : [255, 0, 0, 255], i * 4);
const decoded = RawTexture.CreateRGBATexture(rgba, 8, 8, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
decoded.hasAlpha = true;
const lightmap = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false, false);
const output: Record<string, number> = {};
for (const [format, texture] of [['bc1', diffuse], ['rgba', decoded]] as const) {
    for (const terrain of [false, true]) {
        for (const cutoff of [0, 0.5]) {
            const mat = terrain
                ? createMapTerrainMaterial(scene, texture, lightmap, { ...DEFAULT_MAP_ENV, sun_color: [0, 0, 0] }, null, cutoff)
                : new PBRMaterial('fallback', scene);
            if (mat instanceof PBRMaterial) {
                mat.unlit = true;
                mat.albedoTexture = texture;
                mat.backFaceCulling = false;
                applyMapAlpha(mat, { path: 'cutout.tex', address_u: 0, address_v: 0, tint_color: null, translucent: false, alpha_test: cutoff });
            }
            mesh.material = mat;
            await mat.forceCompilationAsync(mesh);
            for (let frame = 0; frame < 5; frame++) {
                scene.render();
                await new Promise(requestAnimationFrame);
            }
            const pixels = await engine.readPixels(16, 16, 32, 32);
            let green = 0;
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > 200 && pixels[i] < 20 && pixels[i + 2] < 20) green++;
            output[`${format}-${terrain ? 'terrain' : 'fallback'}-${cutoff}`] = green;
            mat.dispose();
        }
    }
}
(window as unknown as { mapAlphaResult: unknown }).mapAlphaResult = output;
scene.dispose();
engine.dispose();
