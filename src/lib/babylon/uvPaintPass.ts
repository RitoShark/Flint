/**
 * uvPaintPass.ts — GPU "what UV is under this pixel" pass for projection paint.
 *
 * Renders the scene from the active camera into an offscreen RenderTargetTexture
 * where each pixel's color encodes the UV of the visible surface (R=u, G=v),
 * with the GPU depth test handling occlusion. The painter then reads back the
 * small brush region and paints each covered UV into the texture — so a round
 * brush on screen is a round mark on the model, across fragmented UVs, no CPU
 * triangle rasterization. (See spec 2026-06-09-gpu-uv-paint-design.)
 *
 * UVs are written in 8-bit RGBA (≈1/256 ≈ 8 texels on a 2048 map). If that's too
 * coarse, switch the RTT to a FLOAT type and read floats instead.
 */
import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Effect } from '@babylonjs/core/Materials/effect';
import { Constants } from '@babylonjs/core/Engines/constants';
import { Color4 } from '@babylonjs/core/Maths/math.color';

const SHADER_NAME = 'flintUvPaint';

let shaderRegistered = false;
function registerShader() {
    if (shaderRegistered) return;
    shaderRegistered = true;
    Effect.ShadersStore[`${SHADER_NAME}VertexShader`] = `
        precision highp float;
        attribute vec3 position;
        attribute vec2 uv;
        uniform mat4 worldViewProjection;
        varying vec2 vUV;
        void main(void) {
            vUV = uv;
            gl_Position = worldViewProjection * vec4(position, 1.0);
        }`;
    Effect.ShadersStore[`${SHADER_NAME}FragmentShader`] = `
        precision highp float;
        varying vec2 vUV;
        uniform float texId;
        void main(void) {
            // R=u, G=v, B=texId (which texture this pixel belongs to), A=1
            // (A marks "surface here" vs cleared bg A=0).
            gl_FragColor = vec4(vUV.x, vUV.y, texId, 1.0);
        }`;
}

/** One texture's meshes + the id (0..N) written to the B channel for them. */
export interface UvGroup { texId: number; meshes: Mesh[]; }

export interface UvPass {
    rtt: RenderTargetTexture;
    /** Render several texture-groups into one pass (B = texId). `through` disables
     *  depth testing so occluded/behind surfaces also write their UV. */
    renderGroups(groups: UvGroup[], through?: boolean): void;
    /** Read an x,y,w,h region as RGBA floats (R=u, G=v, B=texId, A>0 = surface). */
    read(x: number, y: number, w: number, h: number): Float32Array | null;
    width(): number;
    height(): number;
    dispose(): void;
}

/** Create a UV pass sized to the current render buffer. Recreate on resize. */
export function createUvPass(scene: Scene): UvPass {
    registerShader();
    const engine = scene.getEngine();
    const w = engine.getRenderWidth();
    const h = engine.getRenderHeight();

    // FLOAT target so UVs are exact (8-bit ≈ 1/256 caused a stippled lattice).
    const rtt = new RenderTargetTexture('flint-uv-pass', { width: w, height: h }, scene, {
        generateDepthBuffer: true,
        generateMipMaps: false,
        type: Constants.TEXTURETYPE_FLOAT,
        samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
    });
    // Cleared background alpha 0 = "no surface" so reads can reject it.
    rtt.clearColor = new Color4(0, 0, 0, 0);

    const mat = new ShaderMaterial('flint-uv-mat', scene, SHADER_NAME, {
        attributes: ['position', 'uv'],
        uniforms: ['worldViewProjection', 'texId'],
    });
    mat.backFaceCulling = false;
    mat.setFloat('texId', 0);

    // Per-mesh texId: set the uniform just before each mesh binds, so one RTT
    // render of all meshes writes the correct texId per group (depth-tested
    // together, so only the front-most surface remains).
    const idForMesh = new Map<Mesh, number>();
    mat.onBindObservable.add((boundMesh) => {
        const id = idForMesh.get(boundMesh as Mesh) ?? 0;
        mat.getEffect()?.setFloat('texId', id);
    });

    return {
        rtt,
        renderGroups(groups: UvGroup[], through = false) {
            idForMesh.clear();
            const all: Mesh[] = [];
            for (const g of groups) for (const m of g.meshes) { idForMesh.set(m, g.texId); all.push(m); }
            // through = paint occluded surfaces: disable depth test so a farther
            // mesh isn't culled by a nearer one (lets shadowed/behind faces get
            // painted). Default keeps depth so only the visible surface paints.
            mat.disableDepthWrite = through;
            mat.depthFunction = through ? Constants.ALWAYS : 0; // 0 = engine default (LEQUAL)
            rtt.renderList = all;
            rtt.setMaterialForRendering(all, mat);
            rtt.render();
        },
        read(x, y, rw, rh) {
            // WebGL readPixels is synchronous; use the sync variant so a fast
            // stroke can paint inline (the public readPixels returns a Promise
            // for WebGPU compat). Reads the FULL RTT, then we crop the bbox.
            const data = (rtt as unknown as {
                _readPixelsSync(f?: number, l?: number, b?: ArrayBufferView | null, fl?: boolean, n?: boolean): ArrayBufferView | null;
            })._readPixelsSync(undefined, undefined, undefined, false);
            if (!data) return null;
            const full = data as Float32Array;
            const out = new Float32Array(rw * rh * 4);
            const H = rtt.getSize().height, W = rtt.getSize().width;
            for (let row = 0; row < rh; row++) {
                const sy = y + row;
                if (sy < 0 || sy >= H) continue;
                // readPixels is bottom-up: flip Y to top-down screen coords.
                const srcRow = (H - 1 - sy) * W;
                for (let col = 0; col < rw; col++) {
                    const sx = x + col;
                    if (sx < 0 || sx >= W) continue;
                    const s = (srcRow + sx) * 4;
                    const d = (row * rw + col) * 4;
                    out[d] = full[s]; out[d + 1] = full[s + 1]; out[d + 2] = full[s + 2]; out[d + 3] = full[s + 3];
                }
            }
            return out;
        },
        width() { return rtt.getSize().width; },
        height() { return rtt.getSize().height; },
        dispose() { rtt.dispose(); mat.dispose(); },
    };
}
