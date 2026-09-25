import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo';
import { VertexBuffer, Buffer } from '@babylonjs/core/Buffers/buffer';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import { GeometryData, MaterialSpec, TextureData, NoBlending, DoubleSide, BackSide } from './data';

import type { FrameState } from './types';
import { FRAME, SCENE_DEPTH, DEPTH_RANGE, VIEWPORT } from './utils/frame';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import '@babylonjs/core/Culling/ray';
export interface DrawData {
    geometry: GeometryData;
    material: MaterialSpec;
    instances?: {
        count: number;
    };
    update(state: FrameState): void;
    dispose(): void;
}
export interface Targets {
    frame: BaseTexture | null;
    depth: BaseTexture | null;
}
const FLIP_X = Matrix.Scaling(-1, 1, 1);
const FLIP_Z = Matrix.Scaling(1, 1, -1);
export function cameraState(scene: Scene): FrameState {
    const camera = scene.activeCamera!;
    const p = camera.globalPosition;
    const forward = camera.getForwardRay().direction;
    return { camera: { position: new Vector3(-p.x, p.y, p.z), up: new Vector3(-camera.upVector.x, camera.upVector.y, camera.upVector.z), getWorldDirection(out) { return out.set(-forward.x, forward.y, forward.z); } } };
}
export function mountDraw(scene: Scene, draw: DrawData, rank: number, targets: Targets, distort: boolean) {
    const engine = scene.getEngine();
    const spec = draw.material;
    const geometry = draw.geometry;
    const mesh = new Mesh('idle-vfx', scene);
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.alphaIndex = rank;
    mesh.metadata = { idleVfx: true, distort };
    mesh.renderingGroupId = distort ? 2 : 1;
    scene.setRenderingAutoClearDepthStencil(1, false);
    scene.setRenderingAutoClearDepthStencil(2, false);
    const attributes: string[] = [];
    const buffers = new Map<string, {
        buffer: Buffer;
        version: number;
    }>();
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
        const buffer = new Buffer(engine, attribute.array, true, attribute.itemSize, false, attribute.instanced);
        buffers.set(name, { buffer, version: attribute.version });
        if (name === 'instanceMatrix') {
            for (let column = 0; column < 4; column++) {
                const key = `instance${column}`;
                mesh.setVerticesBuffer(buffer.createVertexBuffer(key, column * 4, 4, 16, true));
                attributes.push(key);
            }
        }
        else {
            mesh.setVerticesBuffer(new VertexBuffer(engine, buffer, name, true, false, attribute.itemSize, attribute.instanced, 0, attribute.itemSize));
            attributes.push(name);
        }
    }
    mesh.setIndices(geometry.index.array as Uint32Array, null, true);
    let indexVersion = geometry.index.version;
    const vertexCount = geometry.attributes.position?.count ?? 4;
    mesh.releaseSubMeshes();
    const submesh = new SubMesh(0, 0, vertexCount, 0, geometry.index.count, mesh);
    const bounds = new BoundingInfo(new Vector3(-1e6, -1e6, -1e6), new Vector3(1e6, 1e6, 1e6));
    mesh.setBoundingInfo(bounds);
    submesh.setBoundingInfo(bounds);
    const hasInstances = Object.values(geometry.attributes).some(a => a.instanced);
    let vertex = spec.vertexShader;
    for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2]] as const) {
        if (!new RegExp(`attribute\\s+\\w+\\s+${name}\\s*;`).test(vertex))
            vertex = `attribute vec${size} ${name};\n` + vertex;
    }
    if (geometry.attributes.instanceMatrix)
        vertex = 'attribute vec4 instance0;\nattribute vec4 instance1;\nattribute vec4 instance2;\nattribute vec4 instance3;\n' + vertex.replaceAll('instanceMatrix', 'mat4(instance0,instance1,instance2,instance3)');
    vertex = 'uniform mat4 modelMatrix;\nuniform mat4 viewMatrix;\nuniform mat4 projectionMatrix;\nuniform mat4 modelViewMatrix;\nuniform vec3 cameraPosition;\n' + vertex;
    const declarations = new Map([...`${vertex}\n${spec.fragmentShader}`.matchAll(/uniform\s+(\w+)\s+(\w+)\s*;/g)].map(m => [m[2], m[1]]));
    const samplers = [...declarations].filter(([, type]) => type.startsWith('sampler')).map(([name]) => name);
    const material = new ShaderMaterial('idle-vfx', scene, { vertexSource: vertex, fragmentSource: spec.fragmentShader }, {
        attributes, uniforms: [...declarations.keys()].filter(n => !samplers.includes(n)), samplers,
        defines: Object.entries(spec.defines).map(([key, value]) => `#define ${key} ${value}`),
        needAlphaBlending: spec.blending !== NoBlending, needAlphaTesting: false,
    });
    material.backFaceCulling = spec.side !== DoubleSide;
    material.cullBackFaces = spec.side !== BackSide;
    material.sideOrientation = Material.CounterClockWiseSideOrientation;
    material.disableDepthWrite = !spec.depthWrite;
    material.depthFunction = spec.depthTest ? Constants.LEQUAL : Constants.ALWAYS;
    material.zOffset = spec.polygonOffsetFactor;
    material.zOffsetUnits = spec.polygonOffsetUnits;
    material.alphaMode = spec.blending === NoBlending ? Constants.ALPHA_DISABLE : Constants.ALPHA_COMBINE;
    mesh.material = material;
    material.onBindObservable.add(() => {
        engine.alphaState.alphaBlend = spec.blending !== NoBlending;
        engine.alphaState.setAlphaBlendFunctionParameters(spec.blendSrc, spec.blendDst, spec.blendSrcAlpha ?? spec.blendSrc, spec.blendDstAlpha ?? spec.blendDst);
        engine.alphaState.setAlphaEquationParameters(spec.blendEquation, spec.blendEquation);
    });
    const textures = new Map<TextureData, RawTexture>();
    const empty = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    const view = Matrix.Identity(), projection = Matrix.Identity();
    function bindUniforms() {
        const camera = scene.activeCamera!;
        FLIP_X.multiplyToRef(camera.getViewMatrix(), view);
        view.multiplyToRef(FLIP_Z, view);
        FLIP_Z.multiplyToRef(camera.getProjectionMatrix(), projection);
        material.setMatrix('modelMatrix', Matrix.IdentityReadOnly as Matrix);
        material.setMatrix('viewMatrix', view);
        material.setMatrix('modelViewMatrix', view);
        material.setMatrix('projectionMatrix', projection);
        material.setVector3('cameraPosition', cameraState(scene).camera.position);
        for (const [name, uniform] of Object.entries(spec.uniforms)) {
            let value = uniform.value;
            if (value === FRAME)
                value = targets.frame;
            if (value === SCENE_DEPTH)
                value = targets.depth;
            if (value === VIEWPORT)
                value = [engine.getRenderWidth(), engine.getRenderHeight()];
            if (value === DEPTH_RANGE)
                value = [camera.minZ, camera.maxZ];
            const type = declarations.get(name);
            if (!type)
                continue;
            if (type.startsWith('sampler')) {
                if (value instanceof TextureData) {
                    let texture = textures.get(value);
                    if (!texture) {
                        texture = RawTexture.CreateRGBATexture(value.data, value.width, value.height, scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
                        textures.set(value, texture);
                    }
                    else if (value.needsUpdate)
                        texture.update(value.data);
                    value.needsUpdate = false;
                    value = texture;
                }
                material.setTexture(name, value ?? empty);
            }
            else if (type === 'int')
                material.setInt(name, value);
            else if (type === 'float')
                material.setFloat(name, value);
            else if (type === 'vec2')
                material.setVector2(name, { x: value[0] ?? value.x, y: value[1] ?? value.y } as never);
            else if (type === 'vec3')
                material.setVector3(name, { x: value[0] ?? value.x, y: value[1] ?? value.y, z: value[2] ?? value.z } as never);
            else if (type === 'vec4')
                material.setVector4(name, { x: value[0] ?? value.x, y: value[1] ?? value.y, z: value[2] ?? value.z, w: value[3] ?? value.w } as never);
        }
    }
    return {
        mesh,
        update(state: FrameState) {
            draw.update(state);
            const count = draw.instances?.count ?? geometry.instanceCount;
            mesh.isVisible = count > 0 && geometry.drawRange.count > 0;
            if (!mesh.isVisible)
                return;
            if (hasInstances)
                mesh.forcedInstanceCount = count;
            for (const [name, attribute] of Object.entries(geometry.attributes)) {
                const held = buffers.get(name)!;
                if (held.version !== attribute.version) {
                    if (attribute.updateRanges.length)
                        for (const range of attribute.updateRanges)
                            held.buffer.updateDirectly(attribute.array.subarray(range.start, range.start + range.count), range.start);
                    else
                        held.buffer.update(attribute.array);
                    held.version = attribute.version;
                }
            }
            if (indexVersion !== geometry.index.version) {
                mesh.updateIndices(geometry.index.array as Uint32Array);
                indexVersion = geometry.index.version;
            }
            submesh.indexStart = geometry.drawRange.start;
            submesh.indexCount = Math.min(geometry.drawRange.count, geometry.index.count);
            submesh.setBoundingInfo(bounds);
            bindUniforms();
        },
        dispose() { mesh.dispose(); material.dispose(); empty.dispose(); textures.forEach(t => t.dispose()); buffers.forEach(b => b.buffer.dispose()); draw.dispose(); },
    };
}
