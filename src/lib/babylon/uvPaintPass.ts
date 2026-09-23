import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Effect } from '@babylonjs/core/Materials/effect';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
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
        uniform float alphaCutoff;
        uniform sampler2D alphaSampler;
        void main(void) {
            // R=u, G=v, B=texId (which texture this pixel belongs to), A=1
            // (A marks "surface here" vs cleared bg A=0).
            if (alphaCutoff > 0.0 && texture2D(alphaSampler, vUV).a < alphaCutoff) discard;
            gl_FragColor = vec4(vUV.x, vUV.y, texId, 1.0);
        }`;
}

/** One texture's meshes + the id (0..N) written to the B channel for them. */
export interface UvGroup { texId: number; meshes: Mesh[]; alphaTexture?: BaseTexture; alphaCutoff?: number }

export interface UvPass {
    rtt: RenderTargetTexture;
    /** Render several texture-groups into one pass (B = texId). `through` disables
     *  depth testing so occluded/behind surfaces also write their UV. */
    renderGroups(groups: UvGroup[], through?: boolean): boolean;
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

    // FLOAT target so UVs are exact (8-bit ≈ 1/256 is too coarse).
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
        uniforms: ['worldViewProjection', 'texId', 'alphaCutoff'],
        samplers: ['alphaSampler'],
    });
    mat.backFaceCulling = false;
    mat.setFloat('texId', 0);

    // Per-mesh texId: set the uniform just before each mesh binds, so one RTT
    // render of all meshes writes the correct texId per group (depth-tested
    // together, so only the front-most surface remains).
    const groupForMesh = new Map<Mesh, UvGroup>();
    mat.onBindObservable.add((boundMesh) => {
        const group = groupForMesh.get(boundMesh as Mesh);
        const effect = mat.getEffect();
        effect?.setFloat('texId', group?.texId ?? -1);
        effect?.setFloat('alphaCutoff', group?.alphaTexture?.hasAlpha ? group.alphaCutoff ?? 0.5 : 0);
        if (group?.alphaTexture) effect?.setTexture('alphaSampler', group.alphaTexture);
    });

    return {
        rtt,
        renderGroups(groups: UvGroup[], through = false) {
            groupForMesh.clear();
            const all: Mesh[] = [];
            for (const g of groups) for (const m of g.meshes) { groupForMesh.set(m, g); all.push(m); }
            mat.disableDepthWrite = through;
            mat.depthFunction = through ? Constants.ALWAYS : 0; // 0 = engine default (LEQUAL)
            rtt.renderList = all;
            rtt.setMaterialForRendering(all, mat);
            // First-use shader compilation can be asynchronous. Never cache an empty pass.
            if (all.some(mesh => !mat.isReady(mesh))) return false;
            rtt.render();
            return true;
        },
        read(x, y, rw, rh) {
            const internal = rtt.getInternalTexture();
            if (!internal) return null;
            // Read only the requested rectangle. The painter caches one full view
            // until camera/geometry changes; dabs use that CPU lookup directly.
            const H = rtt.getSize().height;
            const raw = engine._readTexturePixelsSync(internal, rw, rh, -1, 0,
                new Float32Array(rw * rh * 4), false, false, x, H - y - rh) as Float32Array;
            const out = new Float32Array(rw * rh * 4);
            for (let row = 0; row < rh; row++) {
                out.set(raw.subarray((rh - 1 - row) * rw * 4, (rh - row) * rw * 4), row * rw * 4);
            }
            return out;
        },
        width() { return rtt.getSize().width; },
        height() { return rtt.getSize().height; },
        dispose() { rtt.dispose(); mat.dispose(); },
    };
}
