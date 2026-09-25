import { Color3 } from '@babylonjs/core/Maths/math.color';
import { DoubleSide, MaterialSpec, Vector4, type Side, type Texture } from '../data';
import { UV_MODE, type BlendMode, type SimpleOrientation } from '../../engine/model/enums';
import { MESH_VERTEX } from '../shaders/mesh';
import { VERTEX, FRAGMENT } from '../shaders/quad';
import { RIBBON_VERTEX, RIBBON_FRAGMENT } from '../shaders/ribbon';
import { drawState, type FragmentTests } from './blend';
import { customMaterial } from './customMaterial';
import { ALPHA_LOCK, SHEEN, OVERLAY, offsets, polygonOffsetOf, layerUniforms, layerDefines, sheenUniforms, sheenDefines, softUniforms, softDefines, groundDefines, type DepthBias, type DepthOffset, type QuadLayers } from './uniforms';
export interface QuadOrientation {
    readonly billboard: boolean; readonly directed: boolean; readonly ray: boolean;
    readonly plane: SimpleOrientation; readonly unitQuad: boolean; readonly pivotUp: boolean;
}
function build(kind: 'quad' | 'mesh' | 'ribbon', mode: BlendMode, texture: Texture | null, bias: DepthBias, layers: QuadLayers, tests: FragmentTests, side: Side): MaterialSpec {
    const mesh = kind === 'mesh';
    const inputs = mesh ? { ...layers, colorTexture: null } : layers;
    const state = drawState(mode, !!layers.distortion);
    const result = new MaterialSpec({
        ...state, ...polygonOffsetOf(bias), side, depthTest: tests.depthTest, transparent: state.transparent && !layers.ground,
        vertexShader: mesh ? MESH_VERTEX : kind === 'quad' ? VERTEX : RIBBON_VERTEX,
        fragmentShader: kind === 'ribbon' ? RIBBON_FRAGMENT : FRAGMENT,
        uniforms: { ...layerUniforms(texture, inputs, tests), ...softUniforms(mode, layers.soft) },
        defines: { ...layerDefines(texture, inputs), ...softDefines(layers.soft), ...groundDefines(layers) },
    });
    if (mesh) {
        Object.assign(result.uniforms, sheenUniforms(layers.reflection, layers.reflectionTexture));
        Object.assign(result.defines, sheenDefines(layers.reflection, layers.reflectionTexture, SHEEN.drawn));
        result.defines.LOCK_ALPHA = layers.mode === UV_MODE.lockAlpha ? ALPHA_LOCK.unscrolled : ALPHA_LOCK.none;
    }
    if (kind === 'ribbon') result.uniforms.cellSize = result.uniforms.cell;
    return result;
}
export function quadMaterial(mode: BlendMode, texture: Texture | null, depth: DepthOffset, orientation: QuadOrientation, layers: QuadLayers, tests: FragmentTests): MaterialSpec {
    const material = build('quad', mode, texture, depth.bias, layers, tests, DoubleSide);
    material.uniforms.pushPull = { value: depth.pushPull };
    material.uniforms.reach = { value: orientation.unitQuad ? 1 : 2 };
    material.uniforms.pivot = { value: orientation.pivotUp ? .5 : 0 };
    material.defines.FALLOFF = ''; material.defines.PLANE = orientation.plane;
    for (const [name, enabled] of Object.entries({ BILLBOARD: orientation.billboard, DIRECTED: orientation.directed, RAY: orientation.ray })) {
        if (enabled) material.defines[name] = '';
    }
    return customMaterial(material, layers.customMaterial);
}
export function meshMaterial(mode: BlendMode, texture: Texture | null, bias: DepthBias, layers: QuadLayers, tests: FragmentTests, side: Side): MaterialSpec {
    return customMaterial(build('mesh', mode, texture, bias, layers, tests, side), layers.customMaterial);
}
export function attachedMaterial(mode: BlendMode, texture: Texture | null, bias: DepthBias, layers: QuadLayers, tests: FragmentTests, side: Side): MaterialSpec {
    const material = meshMaterial(mode, texture, offsets(bias) ? bias : OVERLAY, { ...layers, soft: null }, tests, side);
    material.defines.SHEEN = SHEEN.texel;
    return material;
}
export function ribbonMaterial(mode: BlendMode, texture: Texture | null, bias: DepthBias, layers: QuadLayers, tests: FragmentTests): MaterialSpec {
    return customMaterial(build('ribbon', mode, texture, bias, layers, tests, DoubleSide), layers.customMaterial);
}
export function wireMaterial(solid: MaterialSpec, color: Color3, opacity: number): MaterialSpec {
    const gamma = color.toGammaSpace();
    return new MaterialSpec({
        vertexShader: solid.vertexShader, fragmentShader: solid.fragmentShader,
        defines: { ...solid.defines, WIREFRAME: '' },
        uniforms: { ...solid.uniforms, wireColor: { value: new Vector4(gamma.r, gamma.g, gamma.b, opacity) } },
        side: DoubleSide, wireframe: true, depthTest: solid.depthTest, depthWrite: false, transparent: true,
    });
}
