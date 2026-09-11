/**
 * Baked-lit map terrain material — League's `Shaders/StaticMesh/DefaultEnv_Flat`,
 * the shader nearly every map material links:
 *
 *   lmUV   = uv2 * BAKED_LIGHT_SCALE_AND_BIAS.xy + .zw   (baked in by the backend)
 *   lm     = tex(BAKED_LIGHT, lmUV)      // rgb = indirect light, a = sun shadow mask
 *   ndl    = max(0, dot(normalize(n), SUN_LIGHT_DIRECTION))
 *   light  = ndl * min(lm.a, 1) * SUN_LIGHT_COLOR  +  lm.rgb * LIGHT_MAP_COLOR_SCALE
 *   out    = albedo.rgb * light
 *
 * This is why a map in game is colour-graded rather than raw-albedo bright: with
 * LIGHT_MAP_COLOR_SCALE at 2 on modern maps, terrain can exceed its own texture's
 * brightness in lit areas and fall far below it in shadow. Rendering the diffuse
 * unlit — what this preview used to do — flattens all of that into a pale wash.
 *
 * Alpha-tested foliage/decals `discard` in-shader, which keeps them in the OPAQUE
 * pass with depth writes instead of the transparent queue.
 */

import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Effect } from '@babylonjs/core/Materials/effect';
import { Vector2, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';

/** Sun / lightmap / fog constants for one map mode, from its `MapContainer`. */
export interface MapEnv {
    sun_color: [number, number, number];
    sun_direction: [number, number, number];
    lightmap_scale: number;
    fog_color: [number, number, number];
    fog_alt_color: [number, number, number];
    fog_start_end: [number, number];
}

export const DEFAULT_MAP_ENV: MapEnv = {
    sun_color: [1, 1, 1],
    sun_direction: [0, 1, 0],
    lightmap_scale: 1,
    fog_color: [1, 1, 1],
    fog_alt_color: [1, 1, 1],
    fog_start_end: [0, -100000],
};

const VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec2 uv2;
uniform mat4 worldViewProjection;
varying vec2 vUV;
varying vec2 vLmUV;
varying vec3 vNormal;
varying float vWorldY;
void main(void) {
    vUV = uv;
    vLmUV = uv2;
    vNormal = normal;
    vWorldY = position.y;
    gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUV;
varying vec2 vLmUV;
varying vec3 vNormal;
varying float vWorldY;
uniform sampler2D DiffuseTexture;
uniform sampler2D BakedLight;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uTint;
uniform float uLmScale;
uniform float uCutoff;
uniform vec3 uFogColor;
uniform vec3 uFogAltColor;
uniform vec2 uFogStartEnd;

void main(void) {
    vec4 albedo = texture2D(DiffuseTexture, vUV);
    if (uCutoff > 0.0 && albedo.a < uCutoff) { discard; }
    vec4 lm = texture2D(BakedLight, vLmUV);
    float ndl = max(0.0, dot(normalize(vNormal), uSunDir));
    vec3 light = ndl * min(lm.a, 1.0) * uSunColor + lm.rgb * uLmScale;
    vec3 lit = albedo.rgb * uTint * light;

    // ENV height fog: t = saturate((worldY - end) / (start - end)), smoothstepped,
    // then an exponential remap normalised to [0,1] over that range.
    float t = clamp((vWorldY - uFogStartEnd.y) / (uFogStartEnd.x - uFogStartEnd.y), 0.0, 1.0);
    float sm = t * t * (3.0 - 2.0 * t);
    float f = max(0.0, (exp(-2.0 * sm) - 0.135335) * 1.156518);
    vec3 fogMix = mix(uFogColor, uFogAltColor, f);
    gl_FragColor = vec4(mix(lit, fogMix, f), 1.0);
}
`;

let registered = false;
function registerShaders(): void {
    if (registered) return;
    Effect.ShadersStore['mapTerrainVertexShader'] = VERT;
    Effect.ShadersStore['mapTerrainFragmentShader'] = FRAG;
    registered = true;
}

/** The engine's albedo is `texture * TintColor * 2`, so an authored 0.5 is neutral.
 *  Renormalising by the peak channel keeps the hue while stopping a material that
 *  authors [1,1,1] (because its real colour comes from a tint TEXTURE this pass does
 *  not bind) from rendering at 2x. */
export function tintFactor(tint: [number, number, number] | null | undefined): Vector3 {
    if (!tint) return new Vector3(1, 1, 1);
    const [r, g, b] = [tint[0] * 2, tint[1] * 2, tint[2] * 2];
    const peak = Math.max(r, g, b, 1);
    return new Vector3(r / peak, g / peak, b / peak);
}

/** One baked-lit material for a (diffuse, atlas, tint, cutout) combination. */
export function createMapTerrainMaterial(
    scene: Scene,
    diffuse: BaseTexture,
    lightmap: BaseTexture,
    env: MapEnv,
    tint: [number, number, number] | null,
    cutoff: number,
): ShaderMaterial {
    registerShaders();
    const mat = new ShaderMaterial(
        'mapTerrain',
        scene,
        { vertex: 'mapTerrain', fragment: 'mapTerrain' },
        {
            attributes: ['position', 'normal', 'uv', 'uv2'],
            uniforms: [
                'worldViewProjection', 'uSunColor', 'uSunDir', 'uTint', 'uLmScale',
                'uCutoff', 'uFogColor', 'uFogAltColor', 'uFogStartEnd',
            ],
            samplers: ['DiffuseTexture', 'BakedLight'],
        },
    );
    mat.setTexture('DiffuseTexture', diffuse);
    mat.setTexture('BakedLight', lightmap);
    mat.setVector3('uSunColor', Vector3.FromArray(env.sun_color));
    mat.setVector3('uSunDir', Vector3.FromArray(env.sun_direction).normalize());
    mat.setVector3('uTint', tintFactor(tint));
    mat.setFloat('uLmScale', env.lightmap_scale > 0 ? env.lightmap_scale : 1);
    mat.setFloat('uCutoff', cutoff);
    mat.setVector3('uFogColor', Vector3.FromArray(env.fog_color));
    mat.setVector3('uFogAltColor', Vector3.FromArray(env.fog_alt_color));
    mat.setVector2('uFogStartEnd', new Vector2(env.fog_start_end[0], env.fog_start_end[1]));
    mat.backFaceCulling = false;
    return mat;
}
